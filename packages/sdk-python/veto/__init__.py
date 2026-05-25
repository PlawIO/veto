"""
Veto - A guardrail system for AI agent tool calls.

Veto sits between the AI model and tool execution, intercepting and
validating tool calls before they are executed. Policies are managed
in the Veto Cloud and validated via API.

Example:
    >>> from veto import Veto
    >>>
    >>> # Initialize Veto (uses VETO_API_KEY env var)
    >>> veto = await Veto.init()
    >>>
    >>> # Wrap your tools (auto-registers with cloud)
    >>> wrapped_tools = veto.wrap(my_tools)
    >>>
    >>> # Pass to your Agent/LLM
    >>> agent = create_agent(tools=wrapped_tools)
"""

# Main export
from veto.core.veto import (
    Veto,
    ToolCallDeniedError,
    GuardResult,
    VetoOptions,
    VetoMode,
    ValidationMode,
    WrappedTools,
    WrappedMCPTools,
    WrappedHandler,
)
from veto.core.protect import protect
from veto.admin import (
    ApiKeyInfo,
    ApiKeyCreated,
    Approval as AdminApproval,
    BatchResolveApprovalItem,
    BatchResolveApprovalResult,
    BatchResolveApprovalsResponse,
    Constraint,
    CreatePolicyDraftInput,
    CreatePolicyInput,
    CreateUpstreamInput,
    Decision as AdminDecision,
    DecisionQuery,
    DecisionStats,
    EventSubscription,
    LlmConfig,
    McpUpstream,
    Organization,
    OutputRule as AdminOutputRule,
    PaginatedResult,
    Policy,
    PolicyDraft,
    Project,
    ProjectCreated,
    SessionConstraints as AdminSessionConstraints,
    Tool as AdminTool,
    UpdatePolicyInput,
    UpstreamTestResult,
    VetoAdmin,
    VetoAdminError,
    VetoAdminEvent,
    VetoAdminOptions,
)

# Core types
from veto.types.tool import (
    ToolDefinition,
    ToolCall,
    ToolResult,
    ToolHandler,
    ExecutableTool,
    ToolInputSchema,
    JsonSchemaType,
    JsonSchemaProperty,
)

from veto.types.config import (
    DecisionExportFormat,
    DecisionExportRecord,
    LogLevel,
    StreamLogMode,
    ValidationDecision,
    ValidationResult,
    ValidationContext,
    Validator,
    NamedValidator,
    ToolCallHistoryEntry,
)

# Cloud types
from veto.cloud.types import (
    ToolRegistration,
    ToolParameter,
    ValidationRequest,
    ValidationResponse,
    FailedConstraint,
    ApprovalData,
    ApprovalPollOptions,
)
from veto.cloud.client import VetoCloudClient, VetoCloudConfig, ApprovalTimeoutError
from veto.cloud.policy_cache import PolicyCache

# Deterministic validation
from veto.deterministic.types import (
    ArgumentConstraint,
    DeterministicPolicy,
    LocalValidationResult,
    ConstraintCheckResult,
    ValidationEntry,
)
from veto.deterministic.validator import validate_deterministic
from veto.deterministic.regex_safety import is_safe_pattern

# Economic authorization
from veto.economic import (
    AP2Connector,
    BudgetCheckResult,
    BudgetEngine,
    BudgetScope,
    EconomicBudgetConfig,
    EconomicBudgetStatus,
    EconomicContext,
    EconomicDenialDetails,
    EconomicDenialReason,
    EconomicEvaluationResult,
    EconomicEvaluator,
    EconomicProtocol,
    LocalBudgetEngine,
    MPPConnector,
    ProtocolConnector,
    X402Connector,
    buildAP2ConnectorError,
    buildMPPConnectorError,
    buildX402ConnectorError,
    build_ap2_connector_error,
    build_mpp_connector_error,
    build_x402_connector_error,
    createAP2Connector,
    createMPPConnector,
    createX402Connector,
    create_ap2_connector,
    create_mpp_connector,
    create_x402_connector,
    parse_economic_budget_configs,
)
from veto.extractors import (
    ExtractedEntities,
    ExtractEntitiesOptions,
    extractEntities,
    extract_entities,
)
from veto.kernel import (
    KernelClient,
    KernelConfig,
    KernelError,
    KernelParseError,
    KernelResponse,
    KernelToolCall,
    buildPrompt,
    buildSystemPrompt,
    build_prompt,
    build_system_prompt,
    createKernelClient,
    create_kernel_client,
    formatRules,
    formatToolCall,
    format_rules,
    format_tool_call,
    parse_kernel_response,
    resolve_kernel_config,
)
from veto.custom import (
    CustomAPIKeyError,
    CustomClient,
    CustomConfig,
    CustomConfigError,
    CustomError,
    CustomParseError,
    CustomProvider,
    CustomResponse,
    CustomToolCall,
    buildProviderMessages,
    buildUserPrompt,
    build_provider_messages,
    build_user_prompt,
    createCustomClient,
    create_custom_client,
    resolve_custom_config,
)

# Interception result
from veto.core.interceptor import InterceptionResult
from veto.core.history import HistoryStats
from veto.core.output_validator import OutputValidationResult
from veto.core.events import (
    EventWebhookConfig,
    WebhookEvent,
    WebhookEventType,
    WebhookFormat,
    format_slack_payload,
    format_pagerduty_payload,
    format_generic_payload,
    format_cef_payload,
)

# Policy IR validation
from veto.rules.schema_validator import (
    validate_policy_ir,
    PolicySchemaError,
    PolicyValidationError,
)
from veto.rules.patterns import (
    OUTPUT_PATTERNS,
    OUTPUT_PATTERN_SSN,
    OUTPUT_PATTERN_CREDIT_CARD,
    OUTPUT_PATTERN_OPENAI_API_KEY,
    OUTPUT_PATTERN_GITHUB_API_KEY,
    OUTPUT_PATTERN_AWS_API_KEY,
    OUTPUT_PATTERN_EMAIL,
    OUTPUT_PATTERN_US_PHONE,
)
from veto.rules.feed_provider import (
    FeedFallback,
    FeedProvider,
    FeedSnapshot,
    InMemoryFeedProvider,
    is_condition_value_ref,
    resolve_feed_ref,
)
from veto.rules.local_evaluator import (
    LocalEvalOptions,
    LocalEvalResult,
    evaluate_rules_locally,
)
from veto.rules.pipeline_dsl import (
    PipelineBudget,
    PipelineOutput,
    PipelineSchedule,
    PipelineSpec,
    PipelineStep,
    canonicalize_json,
    compute_pipeline_id,
    parse_pipeline_spec,
    stamp_pipeline_id,
    verify_pipeline_id,
)

# Provider adapters
from veto.providers.adapters import (
    to_openai,
    from_openai,
    from_openai_tool_call,
    to_openai_tools,
    to_anthropic,
    from_anthropic,
    from_anthropic_tool_use,
    to_anthropic_tools,
    to_google_tool,
    from_google_function_call,
    to_mcp,
    from_mcp,
    from_mcp_tool_call,
    to_mcp_tools,
    is_mcp_tool,
    extract_mcp_economic_context,
)
from veto.proxy import ProxyConfig, ProxyServer, start_proxy_server

from veto.providers.types import (
    OpenAITool,
    OpenAIToolCall,
    AnthropicTool,
    AnthropicToolUse,
    GoogleTool,
    GoogleFunctionCall,
    MCPInputSchema,
    MCPTool,
    MCPToolCallArgs,
    MCPContentBlock,
    MCPToolResult,
    MCPServerClient,
)

# Rate limiting
from veto.rate_limiting.types import RateLimitEntry
from veto.rate_limiting.store import check_and_record, clear_store
from veto.rate_limiting.evaluator import evaluate_rate_limits, RateLimitStore

# Audit
from veto.audit.chain import compute_chain_hash, GENESIS_HASH

# Observability
from veto.observability.otel import (
    try_load_otel,
    VetoTracer,
    VetoSpan,
    SPAN_STATUS_OK,
    SPAN_STATUS_ERROR,
)

# Testing
from veto.testing.runner import run_tests
from veto.testing.types import (
    VetoTestCase,
    VetoTestSuite,
    VetoTestResult,
    VetoTestRunResult,
)

__all__ = [
    # Main
    "Veto",
    "ToolCallDeniedError",
    "GuardResult",
    "VetoOptions",
    "VetoMode",
    "ValidationMode",
    "WrappedTools",
    "WrappedMCPTools",
    "WrappedHandler",
    "protect",
    "VetoAdmin",
    "VetoAdminError",
    "VetoAdminOptions",
    "Policy",
    "Constraint",
    "AdminOutputRule",
    "LlmConfig",
    "AdminSessionConstraints",
    "CreatePolicyInput",
    "UpdatePolicyInput",
    "AdminDecision",
    "DecisionQuery",
    "DecisionStats",
    "PaginatedResult",
    "AdminApproval",
    "AdminTool",
    "PolicyDraft",
    "CreatePolicyDraftInput",
    "McpUpstream",
    "CreateUpstreamInput",
    "UpstreamTestResult",
    "ApiKeyInfo",
    "Organization",
    "Project",
    "ProjectCreated",
    "ApiKeyCreated",
    "VetoAdminEvent",
    "EventSubscription",
    "BatchResolveApprovalItem",
    "BatchResolveApprovalResult",
    "BatchResolveApprovalsResponse",
    # Tool types
    "ToolDefinition",
    "ToolCall",
    "ToolResult",
    "ToolHandler",
    "ExecutableTool",
    "ToolInputSchema",
    "JsonSchemaType",
    "JsonSchemaProperty",
    # Config types
    "LogLevel",
    "StreamLogMode",
    "DecisionExportFormat",
    "DecisionExportRecord",
    "ValidationDecision",
    "ValidationResult",
    "ValidationContext",
    "Validator",
    "NamedValidator",
    "ToolCallHistoryEntry",
    # Cloud types
    "ToolRegistration",
    "ToolParameter",
    "ValidationRequest",
    "ValidationResponse",
    "FailedConstraint",
    "VetoCloudClient",
    "VetoCloudConfig",
    "ApprovalData",
    "ApprovalPollOptions",
    "ApprovalTimeoutError",
    "PolicyCache",
    # Deterministic
    "ArgumentConstraint",
    "DeterministicPolicy",
    "LocalValidationResult",
    "ConstraintCheckResult",
    "ValidationEntry",
    "validate_deterministic",
    "is_safe_pattern",
    # Economic authorization
    "EconomicProtocol",
    "EconomicContext",
    "EconomicDenialReason",
    "EconomicDenialDetails",
    "BudgetScope",
    "EconomicBudgetConfig",
    "EconomicBudgetStatus",
    "BudgetCheckResult",
    "BudgetEngine",
    "EconomicEvaluationResult",
    "ProtocolConnector",
    "LocalBudgetEngine",
    "EconomicEvaluator",
    "parse_economic_budget_configs",
    "X402Connector",
    "create_x402_connector",
    "createX402Connector",
    "build_x402_connector_error",
    "buildX402ConnectorError",
    "MPPConnector",
    "create_mpp_connector",
    "createMPPConnector",
    "build_mpp_connector_error",
    "buildMPPConnectorError",
    "AP2Connector",
    "create_ap2_connector",
    "createAP2Connector",
    "build_ap2_connector_error",
    "buildAP2ConnectorError",
    # Extractors
    "ExtractedEntities",
    "ExtractEntitiesOptions",
    "extract_entities",
    "extractEntities",
    # Kernel/custom model validation
    "KernelConfig",
    "KernelToolCall",
    "KernelResponse",
    "KernelError",
    "KernelParseError",
    "parse_kernel_response",
    "resolve_kernel_config",
    "build_system_prompt",
    "buildSystemPrompt",
    "format_tool_call",
    "formatToolCall",
    "format_rules",
    "formatRules",
    "build_prompt",
    "buildPrompt",
    "KernelClient",
    "create_kernel_client",
    "createKernelClient",
    "CustomProvider",
    "CustomConfig",
    "CustomResponse",
    "CustomToolCall",
    "CustomError",
    "CustomConfigError",
    "CustomParseError",
    "CustomAPIKeyError",
    "resolve_custom_config",
    "build_user_prompt",
    "buildUserPrompt",
    "build_provider_messages",
    "buildProviderMessages",
    "CustomClient",
    "create_custom_client",
    "createCustomClient",
    # Interception
    "InterceptionResult",
    "HistoryStats",
    "OutputValidationResult",
    "EventWebhookConfig",
    "WebhookEvent",
    "WebhookEventType",
    "WebhookFormat",
    "format_slack_payload",
    "format_pagerduty_payload",
    "format_generic_payload",
    "format_cef_payload",
    # Provider adapters
    "to_openai",
    "from_openai",
    "from_openai_tool_call",
    "to_openai_tools",
    "to_anthropic",
    "from_anthropic",
    "from_anthropic_tool_use",
    "to_anthropic_tools",
    "to_google_tool",
    "from_google_function_call",
    "to_mcp",
    "from_mcp",
    "from_mcp_tool_call",
    "to_mcp_tools",
    "is_mcp_tool",
    "extract_mcp_economic_context",
    "ProxyConfig",
    "ProxyServer",
    "start_proxy_server",
    # Provider types
    "OpenAITool",
    "OpenAIToolCall",
    "AnthropicTool",
    "AnthropicToolUse",
    "GoogleTool",
    "GoogleFunctionCall",
    "MCPInputSchema",
    "MCPTool",
    "MCPToolCallArgs",
    "MCPContentBlock",
    "MCPToolResult",
    "MCPServerClient",
    # Policy IR validation
    "validate_policy_ir",
    "PolicySchemaError",
    "PolicyValidationError",
    # Output patterns
    "OUTPUT_PATTERNS",
    "OUTPUT_PATTERN_SSN",
    "OUTPUT_PATTERN_CREDIT_CARD",
    "OUTPUT_PATTERN_OPENAI_API_KEY",
    "OUTPUT_PATTERN_GITHUB_API_KEY",
    "OUTPUT_PATTERN_AWS_API_KEY",
    "OUTPUT_PATTERN_EMAIL",
    "OUTPUT_PATTERN_US_PHONE",
    "FeedFallback",
    "FeedProvider",
    "FeedSnapshot",
    "InMemoryFeedProvider",
    "is_condition_value_ref",
    "resolve_feed_ref",
    "LocalEvalOptions",
    "LocalEvalResult",
    "evaluate_rules_locally",
    "PipelineBudget",
    "PipelineOutput",
    "PipelineSchedule",
    "PipelineSpec",
    "PipelineStep",
    "canonicalize_json",
    "compute_pipeline_id",
    "parse_pipeline_spec",
    "stamp_pipeline_id",
    "verify_pipeline_id",
    # Rate limiting
    "RateLimitEntry",
    "check_and_record",
    "clear_store",
    "evaluate_rate_limits",
    "RateLimitStore",
    # Audit
    "compute_chain_hash",
    "GENESIS_HASH",
    # Observability
    "try_load_otel",
    "VetoTracer",
    "VetoSpan",
    "SPAN_STATUS_OK",
    "SPAN_STATUS_ERROR",
    # Testing
    "run_tests",
    "VetoTestCase",
    "VetoTestSuite",
    "VetoTestResult",
    "VetoTestRunResult",
]

# Framework integrations (imported on demand to avoid hard dependencies):
#
#   from veto.integrations.browser_use import wrap_browser_use
#
# See each integration's README for usage details.
