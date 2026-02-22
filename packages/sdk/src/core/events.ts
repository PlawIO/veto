import type { RuleSeverity } from '../rules/types.js';
import type { ValidationDecision } from '../types/config.js';
import type { Logger } from '../utils/logger.js';

export type VetoWebhookEventType = 'deny' | 'require_approval' | 'budget_exceeded';
export type VetoWebhookFormat = 'slack' | 'pagerduty' | 'generic' | 'cef';

export interface VetoWebhookEvent {
  eventType: VetoWebhookEventType;
  toolName: string;
  arguments: Record<string, unknown>;
  decision: ValidationDecision;
  reason?: string;
  ruleId?: string;
  severity?: RuleSeverity;
  timestamp: string;
}

export interface EventWebhookConfig {
  url: string;
  on: VetoWebhookEventType[];
  minSeverity: RuleSeverity;
  format: VetoWebhookFormat;
}

const VALID_EVENT_TYPES: readonly VetoWebhookEventType[] = [
  'deny',
  'require_approval',
  'budget_exceeded',
];
const VALID_FORMATS: readonly VetoWebhookFormat[] = ['slack', 'pagerduty', 'generic', 'cef'];
const VALID_SEVERITIES: readonly RuleSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK: Record<RuleSeverity, number> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

type RawEventWebhookConfig = {
  url?: unknown;
  on?: unknown;
  min_severity?: unknown;
  format?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEventType(value: unknown): value is VetoWebhookEventType {
  return typeof value === 'string' && (VALID_EVENT_TYPES as readonly string[]).includes(value);
}

function isWebhookFormat(value: unknown): value is VetoWebhookFormat {
  return typeof value === 'string' && (VALID_FORMATS as readonly string[]).includes(value);
}

function isRuleSeverity(value: unknown): value is RuleSeverity {
  return typeof value === 'string' && (VALID_SEVERITIES as readonly string[]).includes(value);
}

function mapPagerDutySeverity(
  severity: RuleSeverity | undefined
): 'critical' | 'error' | 'warning' | 'info' {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'info';
}

function mapCefSeverity(severity: RuleSeverity | undefined): number {
  if (severity === 'critical') return 10;
  if (severity === 'high') return 8;
  if (severity === 'medium') return 5;
  if (severity === 'low') return 3;
  return 1;
}

function escapeCef(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/=/g, '\\=')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

export function resolveEventWebhookConfig(
  config: unknown,
  logger: Logger
): EventWebhookConfig | null {
  if (!isRecord(config)) return null;

  const webhook = config as RawEventWebhookConfig;
  if (typeof webhook.url !== 'string' || webhook.url.trim().length === 0) {
    logger.warn('events.webhook.url must be a non-empty string');
    return null;
  }

  let on: VetoWebhookEventType[] = ['deny'];
  if (Array.isArray(webhook.on)) {
    const parsed = webhook.on.filter((eventType) => isEventType(eventType));
    if (parsed.length > 0) {
      on = parsed;
    } else {
      logger.warn('events.webhook.on contained no valid event types, defaulting to ["deny"]');
    }
  } else if (webhook.on !== undefined) {
    logger.warn('events.webhook.on must be an array of event types');
  }

  let minSeverity: RuleSeverity = 'info';
  if (webhook.min_severity !== undefined) {
    if (isRuleSeverity(webhook.min_severity)) {
      minSeverity = webhook.min_severity;
    } else {
      logger.warn('events.webhook.min_severity is invalid, defaulting to "info"');
    }
  }

  let format: VetoWebhookFormat = 'generic';
  if (webhook.format !== undefined) {
    if (isWebhookFormat(webhook.format)) {
      format = webhook.format;
    } else {
      logger.warn('events.webhook.format is invalid, defaulting to "generic"');
    }
  }

  return {
    url: webhook.url.trim(),
    on,
    minSeverity,
    format,
  };
}

export function formatGenericPayload(
  event: VetoWebhookEvent
): Record<string, unknown> {
  return {
    event_type: event.eventType,
    tool_name: event.toolName,
    arguments: event.arguments,
    decision: event.decision,
    reason: event.reason ?? null,
    rule_id: event.ruleId ?? null,
    severity: event.severity ?? null,
    timestamp: event.timestamp,
  };
}

export function formatSlackPayload(
  event: VetoWebhookEvent
): Record<string, unknown> {
  const reason = event.reason ?? 'No reason provided';

  return {
    text: `Veto ${event.eventType}: ${event.toolName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Veto ${event.eventType}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Tool*\n\`${event.toolName}\`` },
          { type: 'mrkdwn', text: `*Decision*\n\`${event.decision}\`` },
          { type: 'mrkdwn', text: `*Severity*\n\`${event.severity ?? 'unknown'}\`` },
          { type: 'mrkdwn', text: `*Rule ID*\n\`${event.ruleId ?? 'n/a'}\`` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Reason*\n${reason}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Timestamp: ${event.timestamp}`,
          },
        ],
      },
    ],
  };
}

export function formatPagerDutyPayload(
  event: VetoWebhookEvent
): Record<string, unknown> {
  const generic = formatGenericPayload(event);

  return {
    event_action: 'trigger',
    dedup_key: `veto-${event.eventType}-${event.ruleId ?? event.toolName}`,
    payload: {
      summary: `[Veto] ${event.eventType} on ${event.toolName}`,
      source: 'veto-sdk',
      severity: mapPagerDutySeverity(event.severity),
      timestamp: event.timestamp,
      custom_details: generic,
    },
  };
}

export function formatCefPayload(event: VetoWebhookEvent): string {
  const name = `Veto ${event.eventType}`;
  const signatureId = event.ruleId ?? event.eventType;
  const reason = event.reason ?? 'No reason provided';
  const extensionFields = [
    `eventType=${escapeCef(event.eventType)}`,
    `toolName=${escapeCef(event.toolName)}`,
    `decision=${escapeCef(event.decision)}`,
    `reason=${escapeCef(reason)}`,
    `ruleId=${escapeCef(event.ruleId ?? '')}`,
    `severity=${escapeCef(event.severity ?? '')}`,
    `timestamp=${escapeCef(event.timestamp)}`,
    `arguments=${escapeCef(JSON.stringify(event.arguments))}`,
  ].join(' ');

  return [
    'CEF:0',
    'Veto',
    'SDK',
    '1.0',
    escapeCef(signatureId),
    escapeCef(name),
    String(mapCefSeverity(event.severity)),
    extensionFields,
  ].join('|');
}

export class EventWebhookEmitter {
  private readonly config: EventWebhookConfig | null;
  private readonly logger: Logger;

  constructor(config: EventWebhookConfig | null, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  emit(event: VetoWebhookEvent): void {
    if (!this.config) return;
    if (!this.shouldEmit(event)) return;

    const payload = this.formatPayload(event);
    const contentType = typeof payload === 'string'
      ? 'text/plain; charset=utf-8'
      : 'application/json';
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);

    this.logger.debug('Dispatching webhook event', {
      eventType: event.eventType,
      toolName: event.toolName,
      decision: event.decision,
      format: this.config.format,
      url: this.config.url,
    });

    try {
      void fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
        },
        body,
      })
        .then((response) => {
          if (!response.ok) {
            this.logger.warn('Webhook endpoint returned non-success status', {
              status: response.status,
              eventType: event.eventType,
              toolName: event.toolName,
            });
          }
        })
        .catch((error) => {
          this.logger.warn('Webhook event dispatch failed', {
            eventType: event.eventType,
            toolName: event.toolName,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    } catch (error) {
      this.logger.warn('Webhook event dispatch failed before request start', {
        eventType: event.eventType,
        toolName: event.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private shouldEmit(event: VetoWebhookEvent): boolean {
    if (!this.config) return false;
    if (!this.config.on.includes(event.eventType)) return false;

    const eventSeverity = event.severity ?? 'info';
    return SEVERITY_RANK[eventSeverity] >= SEVERITY_RANK[this.config.minSeverity];
  }

  private formatPayload(event: VetoWebhookEvent): Record<string, unknown> | string {
    if (!this.config) return formatGenericPayload(event);

    switch (this.config.format) {
      case 'slack':
        return formatSlackPayload(event);
      case 'pagerduty':
        return formatPagerDutyPayload(event);
      case 'cef':
        return formatCefPayload(event);
      case 'generic':
      default:
        return formatGenericPayload(event);
    }
  }
}
