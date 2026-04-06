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
    WrappedHandler,
)
from veto.core.protect import protect

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
)

from veto.providers.types import (
    OpenAITool,
    OpenAIToolCall,
    AnthropicTool,
    AnthropicToolUse,
    GoogleTool,
    GoogleFunctionCall,
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
    "WrappedHandler",
    "protect",
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
    # Provider types
    "OpenAITool",
    "OpenAIToolCall",
    "AnthropicTool",
    "AnthropicToolUse",
    "GoogleTool",
    "GoogleFunctionCall",
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
