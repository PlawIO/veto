import type { Logger } from '../../utils/logger.js';
import { CustomError } from '../types.js';

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 100;
const TRANSIENT_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'APIConnectionError',
  'APIConnectionTimeoutError',
]);

type ProviderErrorKind = 'timeout' | 'auth' | 'rate_limit' | 'server' | 'network' | 'other';

interface ProviderErrorClassification {
  kind: ProviderErrorKind;
  retryable: boolean;
  status?: number;
  code?: string;
}

export interface ProviderRetryOptions {
  providerLabel: string;
  timeoutMs: number;
  logger: Logger;
  maxRetries?: number;
  retryDelayMs?: number;
}

function getErrorRecord(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return {};
  }
  return error as Record<string, unknown>;
}

function getStatus(error: unknown): number | undefined {
  const record = getErrorRecord(error);
  const status = record.status ?? record.statusCode;
  if (typeof status === 'number') {
    return status;
  }

  const response = record.response;
  if (response && typeof response === 'object') {
    const responseStatus = (response as Record<string, unknown>).status;
    if (typeof responseStatus === 'number') {
      return responseStatus;
    }
  }

  return undefined;
}

function getCode(error: unknown): string | undefined {
  const record = getErrorRecord(error);
  const code = record.code ?? record.name ?? record.type;
  return typeof code === 'string' ? code : undefined;
}

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown, code?: string): boolean {
  const message = getMessage(error).toLowerCase();
  const normalizedCode = code?.toLowerCase() ?? '';
  return normalizedCode.includes('timeout')
    || normalizedCode === 'etimedout'
    || normalizedCode === 'aborterror'
    || message.includes('timed out')
    || message.includes('timeout');
}

function isNetworkError(error: unknown, code?: string): boolean {
  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return true;
  }

  const message = getMessage(error).toLowerCase();
  return message.includes('fetch failed')
    || message.includes('network')
    || message.includes('socket hang up')
    || message.includes('connection reset');
}

function classifyProviderError(error: unknown): ProviderErrorClassification {
  const status = getStatus(error);
  const code = getCode(error);

  if (isTimeoutError(error, code)) {
    return { kind: 'timeout', retryable: true, status, code };
  }

  if (status === 401 || status === 403) {
    return { kind: 'auth', retryable: false, status, code };
  }

  if (status === 429) {
    return { kind: 'rate_limit', retryable: true, status, code };
  }

  if (status !== undefined && status >= 500) {
    return { kind: 'server', retryable: true, status, code };
  }

  if (isNetworkError(error, code)) {
    return { kind: 'network', retryable: true, status, code };
  }

  return { kind: 'other', retryable: false, status, code };
}

function buildProviderError(
  error: unknown,
  classification: ProviderErrorClassification,
  providerLabel: string,
  timeoutMs: number,
  attempts: number
): CustomError {
  const cause = error instanceof Error ? error : undefined;
  const attemptSuffix = attempts > 1 ? ` after ${attempts} attempts` : '';

  switch (classification.kind) {
    case 'timeout':
      return new CustomError(
        `${providerLabel} request timed out after ${timeoutMs}ms${attemptSuffix}.`,
        cause
      );
    case 'auth':
      return new CustomError(
        `${providerLabel} authentication failed with status ${classification.status}. Check the configured API key and provider permissions.`,
        cause
      );
    case 'rate_limit':
      return new CustomError(
        `${providerLabel} rate limited the request with status 429${attemptSuffix}.`,
        cause
      );
    case 'server':
      return new CustomError(
        `${providerLabel} provider server error with status ${classification.status}${attemptSuffix}.`,
        cause
      );
    case 'network':
      return new CustomError(
        `${providerLabel} transient network error${attemptSuffix}: ${getMessage(error)}`,
        cause
      );
    case 'other':
      return new CustomError(
        `${providerLabel} API call failed: ${getMessage(error)}`,
        cause
      );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  options: ProviderRetryOptions
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      const classification = classifyProviderError(error);
      const attempts = attempt + 1;

      if (!classification.retryable || attempt >= maxRetries) {
        throw buildProviderError(
          error,
          classification,
          options.providerLabel,
          options.timeoutMs,
          attempts
        );
      }

      options.logger.warn(`${options.providerLabel} request failed, retrying`, {
        attempt: attempts,
        maxRetries,
        status: classification.status,
        code: classification.code,
      });
      attempt += 1;
      await delay(retryDelayMs);
    }
  }
}
