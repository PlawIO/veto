export const NVIDIA_GLINER_PII_PROVIDER = 'nvidia-gliner-pii' as const;

export const DEFAULT_NVIDIA_GLINER_PII_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_NVIDIA_GLINER_PII_MODEL = 'nvidia/gliner-pii';
export const DEFAULT_NVIDIA_GLINER_PII_THRESHOLD = 0.45;
export const DEFAULT_NVIDIA_GLINER_PII_CHUNK_LENGTH = 384;
export const DEFAULT_NVIDIA_GLINER_PII_OVERLAP = 128;
export const DEFAULT_NVIDIA_GLINER_PII_FLAT_NER = false;
export const DEFAULT_NVIDIA_GLINER_PII_TIMEOUT_MS = 5000;

export const DEFAULT_NVIDIA_GLINER_PII_LABELS = [
  'email',
  'phone_number',
  'ssn',
  'credit_debit_card',
  'cvv',
  'account_number',
  'bank_routing_number',
  'tax_id',
  'api_key',
  'password',
  'pin',
  'http_cookie',
  'first_name',
  'last_name',
  'street_address',
  'city',
  'state',
  'postcode',
  'date_of_birth',
  'medical_record_number',
  'health_plan_beneficiary_number',
  'employee_id',
  'customer_id',
  'national_id',
  'ipv4',
  'ipv6',
  'mac_address',
  'url',
] as const;

export interface NvidiaGlinerPiiConfig {
  provider?: typeof NVIDIA_GLINER_PII_PROVIDER;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  threshold?: number;
  labels?: string[];
  chunkLength?: number;
  overlap?: number;
  flatNer?: boolean;
  timeoutMs?: number;
}

export interface NvidiaGlinerPiiDetectOptions {
  labels?: string[];
  threshold?: number;
}

export interface NvidiaGlinerPiiEntity {
  text: string;
  label: string;
  start: number;
  end: number;
  score?: number;
}

export type NvidiaGlinerPiiErrorCode =
  | 'missing_api_key'
  | 'timeout'
  | 'http_error'
  | 'empty_response'
  | 'malformed_response';

export class NvidiaGlinerPiiError extends Error {
  readonly code: NvidiaGlinerPiiErrorCode;
  readonly status?: number;

  constructor(message: string, code: NvidiaGlinerPiiErrorCode, status?: number) {
    super(message);
    this.name = 'NvidiaGlinerPiiError';
    this.code = code;
    this.status = status;
  }
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

interface RawEntity {
  text?: unknown;
  value?: unknown;
  label?: unknown;
  suggested_label?: unknown;
  start?: unknown;
  end?: unknown;
  start_position?: unknown;
  end_position?: unknown;
  score?: unknown;
}

interface ParsedGlinerResponse {
  total_entities?: unknown;
  entities?: unknown;
}

export class NvidiaGlinerPiiClient {
  readonly provider = NVIDIA_GLINER_PII_PROVIDER;
  readonly model: string;
  readonly baseUrl: string;
  readonly threshold: number;
  readonly labels: string[];

  private readonly apiKey: string;
  private readonly chunkLength: number;
  private readonly overlap: number;
  private readonly flatNer: boolean;
  private readonly timeoutMs: number;

  constructor(config: NvidiaGlinerPiiConfig) {
    const apiKey = config.apiKey.trim();
    if (apiKey.length === 0) {
      throw new NvidiaGlinerPiiError('NVIDIA GLiNER PII API key is required', 'missing_api_key');
    }

    this.apiKey = apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_NVIDIA_GLINER_PII_BASE_URL).replace(/\/$/, '');
    this.model = config.model ?? DEFAULT_NVIDIA_GLINER_PII_MODEL;
    this.threshold = normalizeNumber(config.threshold, DEFAULT_NVIDIA_GLINER_PII_THRESHOLD);
    this.labels = normalizeLabels(config.labels, [...DEFAULT_NVIDIA_GLINER_PII_LABELS]);
    this.chunkLength = normalizeInteger(config.chunkLength, DEFAULT_NVIDIA_GLINER_PII_CHUNK_LENGTH);
    this.overlap = normalizeInteger(config.overlap, DEFAULT_NVIDIA_GLINER_PII_OVERLAP);
    this.flatNer = config.flatNer ?? DEFAULT_NVIDIA_GLINER_PII_FLAT_NER;
    this.timeoutMs = normalizeInteger(config.timeoutMs, DEFAULT_NVIDIA_GLINER_PII_TIMEOUT_MS);
  }

  async detect(text: string, options: NvidiaGlinerPiiDetectOptions = {}): Promise<NvidiaGlinerPiiEntity[]> {
    const labels = normalizeLabels(options.labels, this.labels);
    const threshold = normalizeNumber(options.threshold, this.threshold);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: text }],
          labels,
          threshold,
          chunk_length: this.chunkLength,
          overlap: this.overlap,
          flat_ner: this.flatNer,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new NvidiaGlinerPiiError(
          `NVIDIA GLiNER PII request failed with status ${response.status}`,
          'http_error',
          response.status
        );
      }

      const payload = await parseResponseJson(response);
      return this.parseEntities(payload, text);
    } catch (error) {
      if (error instanceof NvidiaGlinerPiiError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new NvidiaGlinerPiiError('NVIDIA GLiNER PII request timed out', 'timeout');
      }

      throw new NvidiaGlinerPiiError('NVIDIA GLiNER PII response was malformed', 'malformed_response');
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseEntities(payload: unknown, sourceText: string): NvidiaGlinerPiiEntity[] {
    const completion = payload as ChatCompletionResponse;
    const content = completion.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      throw new NvidiaGlinerPiiError('NVIDIA GLiNER PII response was empty', 'empty_response');
    }

    const parsed = parseContent(content);
    if (!Array.isArray(parsed.entities)) {
      throw new NvidiaGlinerPiiError('NVIDIA GLiNER PII response was malformed', 'malformed_response');
    }

    return parsed.entities.flatMap((entity) => normalizeEntity(entity, sourceText));
  }
}

async function parseResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new NvidiaGlinerPiiError('NVIDIA GLiNER PII response was malformed', 'malformed_response');
  }
}

function parseContent(content: unknown): ParsedGlinerResponse {
  if (typeof content === 'object' && content !== null) {
    return content as ParsedGlinerResponse;
  }

  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new NvidiaGlinerPiiError('NVIDIA GLiNER PII response was empty', 'empty_response');
  }

  const trimmed = stripJsonFence(content.trim());
  try {
    return JSON.parse(trimmed) as ParsedGlinerResponse;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new NvidiaGlinerPiiError('NVIDIA GLiNER PII response was malformed', 'malformed_response');
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as ParsedGlinerResponse;
    } catch {
      throw new NvidiaGlinerPiiError('NVIDIA GLiNER PII response was malformed', 'malformed_response');
    }
  }
}

function stripJsonFence(value: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match?.[1]?.trim() ?? value;
}

function normalizeEntity(entity: unknown, sourceText: string): NvidiaGlinerPiiEntity[] {
  if (!entity || typeof entity !== 'object') {
    return [];
  }

  const raw = entity as RawEntity;
  const label = typeof raw.label === 'string'
    ? raw.label
    : typeof raw.suggested_label === 'string'
      ? raw.suggested_label
      : undefined;
  const start = normalizePosition(raw.start ?? raw.start_position);
  const end = normalizePosition(raw.end ?? raw.end_position);

  if (!label || start === null || end === null || end <= start) {
    return [];
  }

  const boundedStart = Math.max(0, Math.min(sourceText.length, start));
  const boundedEnd = Math.max(boundedStart, Math.min(sourceText.length, end));
  if (boundedEnd <= boundedStart) {
    return [];
  }

  const rawText = typeof raw.text === 'string'
    ? raw.text
    : typeof raw.value === 'string'
      ? raw.value
      : sourceText.slice(boundedStart, boundedEnd);
  const score = typeof raw.score === 'number' && Number.isFinite(raw.score)
    ? raw.score
    : undefined;

  return [{
    text: rawText,
    label,
    start: boundedStart,
    end: boundedEnd,
    score,
  }];
}

function normalizePosition(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.trunc(value);
}

function normalizeLabels(value: string[] | undefined, fallback: string[]): string[] {
  const labels = value
    ?.filter((label) => typeof label === 'string')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);

  return labels && labels.length > 0 ? [...new Set(labels)] : fallback;
}

function normalizeNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
