export const POLICY_IR_V1_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://veto.dev/schemas/policy-ir-v1.json',
  title: 'Veto Policy IR v1',
  description: 'Canonical intermediate representation for Veto policies. Consumed by TypeScript and Python SDK loaders.',
  type: 'object',
  required: ['version'],
  anyOf: [
    { required: ['rules'] },
    { required: ['output_rules'] },
    { required: ['extends'] },
    { required: ['economic'] },
  ],
  properties: {
    version: {
      const: '1.0',
      description: 'Schema version. Must be "1.0" for this version of the IR.',
    },
    name: {
      type: 'string',
      minLength: 1,
      description: 'Human-readable name for this policy set.',
    },
    description: {
      type: 'string',
      description: 'Detailed description of this policy set.',
    },
    extends: {
      type: 'string',
      minLength: 1,
      description: 'Optional built-in policy pack name to inherit from (e.g., "@veto/coding-agent").',
    },
    rules: {
      type: 'array',
      items: { $ref: '#/$defs/Rule' },
      description: 'Ordered list of rules in this policy.',
    },
    output_rules: {
      type: 'array',
      items: { $ref: '#/$defs/OutputRule' },
      description: 'Ordered list of output rules in this policy.',
    },
    settings: {
      $ref: '#/$defs/Settings',
    },
    economic: {
      $ref: '#/$defs/EconomicPolicy',
    },
  },
  additionalProperties: false,
  $defs: {
    Rule: {
      type: 'object',
      required: ['id', 'name', 'action'],
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          description: 'Unique identifier for this rule.',
        },
        name: {
          type: 'string',
          minLength: 1,
          description: 'Human-readable name for this rule.',
        },
        description: {
          type: 'string',
          description: 'Detailed description of what this rule does.',
        },
        enabled: {
          type: 'boolean',
          default: true,
          description: 'Whether this rule is active.',
        },
        severity: {
          $ref: '#/$defs/Severity',
        },
        action: {
          $ref: '#/$defs/Action',
        },
        tools: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Tools this rule applies to. Empty or absent means all tools.',
        },
        agents: {
          $ref: '#/$defs/AgentScope',
        },
        conditions: {
          type: 'array',
          items: { $ref: '#/$defs/Condition' },
          description: 'Conditions that must ALL be met for the rule to trigger (AND logic).',
        },
        condition_groups: {
          type: 'array',
          items: {
            type: 'array',
            items: { $ref: '#/$defs/Condition' },
          },
          description: 'Alternative condition groups (OR between groups, AND within each group).',
        },
        blocked_by: {
          type: 'array',
          items: { $ref: '#/$defs/SequenceConstraint' },
          description: 'Block if any matching historical call is present.',
        },
        requires: {
          type: 'array',
          items: { $ref: '#/$defs/SequenceConstraint' },
          description: 'Block unless each required historical call is present.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization.',
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description: 'Arbitrary key-value metadata attached to this rule.',
        },
      },
      additionalProperties: false,
    },
    OutputRule: {
      type: 'object',
      required: ['id', 'name', 'action'],
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          description: 'Unique identifier for this output rule.',
        },
        name: {
          type: 'string',
          minLength: 1,
          description: 'Human-readable name for this output rule.',
        },
        description: {
          type: 'string',
          description: 'Detailed description of what this output rule does.',
        },
        enabled: {
          type: 'boolean',
          default: true,
          description: 'Whether this output rule is active.',
        },
        severity: {
          $ref: '#/$defs/Severity',
        },
        action: {
          $ref: '#/$defs/OutputAction',
        },
        tools: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Tools this output rule applies to. Empty or absent means all tools.',
        },
        output_conditions: {
          type: 'array',
          items: { $ref: '#/$defs/Condition' },
          description: 'Conditions that must ALL be met for the output rule to trigger (AND logic).',
        },
        output_condition_groups: {
          type: 'array',
          items: {
            type: 'array',
            items: { $ref: '#/$defs/Condition' },
          },
          description: 'Alternative output condition groups (OR between groups, AND within each group).',
        },
        redact_with: {
          type: 'string',
          description: 'Replacement string used for redact action.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization.',
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description: 'Arbitrary key-value metadata attached to this output rule.',
        },
      },
      additionalProperties: false,
    },
    Condition: {
      type: 'object',
      required: ['field', 'operator', 'value'],
      properties: {
        field: {
          type: 'string',
          minLength: 1,
          description: 'Dot-notation path to the field to evaluate (e.g. "arguments.amount").',
        },
        operator: {
          $ref: '#/$defs/Operator',
        },
        value: {
          description: 'The value to compare the field against.',
        },
        reference: {
          type: 'string',
          minLength: 1,
          description: 'Optional dot-notation reference path used by dynamic operators.',
        },
      },
      allOf: [
        {
          if: {
            properties: {
              operator: {
                enum: ['within_hours', 'outside_hours'],
              },
            },
          },
          then: {
            properties: {
              value: { $ref: '#/$defs/TimeWindowValue' },
            },
          },
        },
        {
          if: {
            properties: {
              operator: {
                const: 'percent_of',
              },
            },
          },
          then: {
            required: ['reference'],
            properties: {
              value: {
                type: 'number',
                exclusiveMinimum: 0,
              },
            },
          },
        },
      ],
      additionalProperties: false,
    },
    TimeWindowValue: {
      type: 'object',
      required: ['start', 'end', 'timezone'],
      properties: {
        start: {
          type: 'string',
          pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
          description: 'Start time in HH:MM 24-hour format.',
        },
        end: {
          type: 'string',
          pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
          description: 'End time in HH:MM 24-hour format.',
        },
        timezone: {
          type: 'string',
          minLength: 1,
          description: 'IANA timezone identifier (e.g., "America/New_York").',
        },
        days: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
          },
          description: 'Optional day filter. If omitted, applies every day.',
        },
      },
      additionalProperties: false,
    },
    AgentScope: {
      oneOf: [
        {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Rule applies only to these agents.',
        },
        {
          type: 'object',
          required: ['not'],
          properties: {
            not: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              description: 'Rule applies to all agents except those listed here.',
            },
          },
          additionalProperties: false,
        },
      ],
      description: 'Optional agent scope filter for this rule.',
    },
    SequenceConstraint: {
      type: 'object',
      required: ['tool'],
      properties: {
        tool: {
          type: 'string',
          minLength: 1,
          description: 'Historical tool name to match.',
        },
        conditions: {
          type: 'array',
          items: { $ref: '#/$defs/Condition' },
          description: 'Conditions that must ALL match on the historical call context.',
        },
        condition_groups: {
          type: 'array',
          items: {
            type: 'array',
            items: { $ref: '#/$defs/Condition' },
          },
          description: 'Alternative condition groups (OR between groups, AND within each group).',
        },
        within: {
          type: 'number',
          minimum: 0,
          description: 'Optional time window in seconds relative to the current call.',
        },
      },
      additionalProperties: false,
    },
    Operator: {
      type: 'string',
      enum: [
        'equals',
        'not_equals',
        'contains',
        'not_contains',
        'starts_with',
        'ends_with',
        'matches',
        'greater_than',
        'less_than',
        'percent_of',
        'length_greater_than',
        'in',
        'not_in',
        'outside_hours',
        'within_hours',
      ],
      description: 'Comparison operator.',
    },
    Severity: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low', 'info'],
      default: 'medium',
      description: 'Severity level of the rule.',
    },
    Action: {
      type: 'string',
      enum: ['block', 'warn', 'log', 'allow', 'require_approval'],
      description: 'Action to take when the rule matches.',
    },
    OutputAction: {
      type: 'string',
      enum: ['block', 'redact', 'log'],
      description: 'Action to take when the output rule matches.',
    },
    Settings: {
      type: 'object',
      properties: {
        default_action: {
          $ref: '#/$defs/Action',
        },
        fail_mode: {
          type: 'string',
          enum: ['open', 'closed'],
          description: 'Behavior on validation errors: "open" allows, "closed" blocks.',
        },
        global_tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags applied to all rules in this set.',
        },
      },
      additionalProperties: false,
    },
    EconomicPolicy: {
      type: 'object',
      description: 'Economic authorization policy for x402, MPP, and AP2 protocols.',
      properties: {
        budgets: {
          type: 'array',
          items: { $ref: '#/$defs/EconomicBudget' },
          description: 'Budget configurations per scope.',
        },
        cost_extraction: {
          type: 'object',
          properties: {
            default: {
              type: 'string',
              description: 'Default dot-notation path to extract cost from tool arguments.',
            },
            overrides: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Per-tool cost extraction path overrides.',
            },
          },
          additionalProperties: false,
        },
        payer: {
          type: 'object',
          properties: {
            required: {
              type: 'boolean',
              description: 'Whether a payer identity is required.',
            },
            approved: {
              type: 'array',
              items: { type: 'string' },
              description: 'Allowlist of approved payer identifiers.',
            },
          },
          additionalProperties: false,
        },
        denial_reasons: {
          type: 'object',
          description: 'Custom denial message templates. Keys are denial reason codes, values are message templates with {variable} placeholders.',
          properties: {
            budget_exceeded: { type: 'string' },
            approval_required: { type: 'string' },
            payer_missing: { type: 'string' },
            payer_unauthorized: { type: 'string' },
            currency_mismatch: { type: 'string' },
            connector_error: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    EconomicBudget: {
      type: 'object',
      required: ['scope', 'limit', 'currency', 'window'],
      properties: {
        scope: {
          type: 'string',
          enum: ['session', 'agent', 'user', 'global'],
          description: 'Budget scope.',
        },
        limit: {
          type: 'number',
          minimum: 0,
          description: 'Maximum spend limit.',
        },
        currency: {
          type: 'string',
          minLength: 1,
          description: 'Currency code (e.g., "USD").',
        },
        approval_threshold: {
          type: 'number',
          minimum: 0,
          description: 'Cost above which approval is required.',
        },
        window: {
          type: 'string',
          description: 'Budget time window (e.g., "session", "24h").',
        },
      },
      additionalProperties: false,
    },
  },
} as const;
