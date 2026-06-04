"""
Main Veto guardrail class.

This is the primary entry point for using Veto. It wraps tools with validation
that is handled by the Veto Cloud API.
"""

from typing import (
    Any,
    Iterator,
    Mapping,
    Callable,
    Literal,
    Optional,
    TypeVar,
    Union,
    Awaitable,
    Protocol,
    cast,
    runtime_checkable,
)
from dataclasses import dataclass
import os
import inspect
import sys
from datetime import datetime
from pathlib import Path
import yaml

from veto.types.tool import ToolDefinition, ToolCall
from veto.types.config import (
    DecisionExportFormat,
    LogLevel,
    StreamLogMode,
    Validator,
    NamedValidator,
    ValidationContext,
    ValidationResult,
)
from veto.utils.logger import (
    DecisionStreamDecision,
    DecisionStreamEvent,
    Logger,
    create_logger,
    is_decision_stream_logger,
    parse_env_log_setting,
)
from veto.utils.id import generate_tool_call_id
from veto.core.validator import ValidationEngine, ValidationEngineOptions
from veto.core.history import HistoryTracker, HistoryTrackerOptions, HistoryStats
from veto.core.interceptor import (
    Interceptor,
    InterceptorOptions,
    InterceptionResult,
    ToolCallDeniedError,
    DenialDetails,
)
from veto.core.output_validator import (
    OutputValidationResult,
    OutputValidator,
    OutputValidatorOptions,
)
from veto.core.events import (
    EventWebhookConfig,
    EventWebhookEmitter,
    WebhookEvent,
    WebhookEventType,
    parse_event_webhook_config,
)
from veto.cloud.client import VetoCloudClient, VetoCloudConfig, ApprovalTimeoutError
from veto.cloud.types import ToolRegistration, ToolParameter, ApprovalPollOptions
from veto.cloud.policy_cache import PolicyCache
from veto.receipts import (
    DecisionOutcome,
    ReceiptSummary,
    append_receipt,
    build_decision_receipt,
    hash_canonical,
    load_last_receipt,
    receipt_summary,
)
from veto.deterministic.validator import validate_deterministic
from veto.deterministic.types import LocalValidationResult
from veto.custom import CustomClient
from veto.economic import (
    BudgetScope,
    EconomicBudgetStatus,
    EconomicContext,
    EconomicDenialDetails,
    EconomicEvaluator,
    EconomicProtocol,
    LocalBudgetEngine,
    parse_economic_budget_configs,
)
from veto.kernel import KernelClient
from veto.kernel.types import KernelResponse
from veto.providers.adapters import from_mcp
from veto.providers.types import MCPTool, MCPToolCallArgs
from veto.rules import (
    evaluate_condition_collections,
    evaluate_sequence_constraints,
    rule_applies_to_agent,
    validate_policy_ir,
    PolicySchemaError,
)
from veto.rules.feed_provider import FeedProvider


# Veto operating mode
VetoMode = Literal["strict", "log", "shadow"]
ValidationMode = Literal["cloud", "local", "kernel", "custom", "api"]

# Wrapped handler function type
WrappedHandler = Callable[[dict[str, Any]], Awaitable[Any]]

GuardSeverity = Literal["critical", "high", "medium", "low", "info"]


@dataclass
class WrappedTools:
    """Result of wrapping tools with Veto."""

    definitions: list[ToolDefinition]
    implementations: dict[str, WrappedHandler]


@dataclass
class WrappedMCPTools:
    """Result of wrapping MCP server tools with Veto validation."""

    tools: list[MCPTool]
    call_tool: Callable[[MCPToolCallArgs | dict[str, Any]], Awaitable[Any]]


@dataclass
class GuardResult:
    """Standalone validation result returned by ``guard()``."""

    decision: Literal["allow", "deny", "require_approval"]
    reason: Optional[str] = None
    rule_id: Optional[str] = None
    severity: Optional[GuardSeverity] = None
    approval_id: Optional[str] = None
    shadow: Optional[bool] = None
    shadow_decision: Optional[str] = None
    economic_denial: Optional[EconomicDenialDetails] = None
    receipt: Optional[ReceiptSummary] = None

    @property
    def economicDenial(self) -> Optional[EconomicDenialDetails]:
        """TypeScript-style alias for parity with JS examples."""
        return self.economic_denial


@dataclass
class LoadedOutputRulesState:
    all_output_rules: list[dict[str, Any]]
    output_rules_by_tool: dict[str, list[dict[str, Any]]]
    global_output_rules: list[dict[str, Any]]


@dataclass
class LoadedRulesState:
    all_rules: list[dict[str, Any]]
    rules_by_tool: dict[str, list[dict[str, Any]]]
    global_rules: list[dict[str, Any]]
    economic_policy: Optional[dict[str, Any]] = None


@dataclass
class VetoOptions:
    """Options for creating a Veto instance."""

    # API key for Veto Cloud (can also use VETO_API_KEY env var)
    api_key: Optional[str] = None
    # Base URL for Veto Cloud API
    base_url: Optional[str] = None
    # Operating mode: "strict" blocks denied calls, "log" only logs
    mode: Optional[VetoMode] = None
    # Log level for Veto operations
    log_level: Optional[LogLevel] = None
    # Decision stream formatting mode when log_level is set to "stream"
    stream_mode: Optional[StreamLogMode] = None
    # Optional session ID for tracking
    session_id: Optional[str] = None
    # Optional agent ID for tracking
    agent_id: Optional[str] = None
    # Optional user ID for tracking
    user_id: Optional[str] = None
    # Optional role for tracking
    role: Optional[str] = None
    # Path to veto directory (contains veto.config.yaml and rules/)
    config_dir: Optional[str] = None
    # Validation mode: "cloud" (default) or "local" for YAML-only local evaluation
    validation_mode: Optional[ValidationMode] = None
    # Additional validators to run (in addition to cloud validation)
    validators: Optional[list[Union[Validator, NamedValidator]]] = None
    # API timeout in milliseconds
    timeout: Optional[int] = None
    # Number of retries for API calls
    retries: Optional[int] = None
    # Callback fired when a tool call requires human approval
    on_approval_required: Optional[Callable[..., Any]] = None
    # Seconds between approval poll requests (default: 2.0)
    approval_poll_interval: Optional[float] = None
    # Max seconds to wait for approval resolution (default: 300.0)
    approval_timeout: Optional[float] = None
    # Optional local feed provider for feed-/pipeline-backed rule conditions
    feed_provider: Optional[FeedProvider] = None
    # Optional economic authorization policy.
    economic_policy: Optional[dict[str, Any]] = None
    # Optional kernel/custom clients for local model-backed validation.
    kernel_client: Optional[Any] = None
    custom_client: Optional[Any] = None
    kernel_config: Optional[dict[str, Any]] = None
    custom_config: Optional[dict[str, Any]] = None
    # Optional NDJSON receipt store for local SDK decisions.
    receipt_store: Optional[str] = None


@runtime_checkable
class ToolLike(Protocol):
    """Protocol for tool-like objects."""

    name: str


T = TypeVar("T", bound=ToolLike)


class Veto:
    """
    Veto - A guardrail system for AI agent tool calls.

    Veto wraps your tools and validates every call against policies managed
    in the Veto Cloud. Policies are auto-generated from your tool signatures
    and can be configured with constraints through the cloud dashboard.

    Example:
        >>> from veto import Veto
        >>>
        >>> # Initialize Veto (uses VETO_API_KEY env var)
        >>> veto = await Veto.init()
        >>>
        >>> # Wrap your tools (auto-registers with cloud)
        >>> wrapped_tools = veto.wrap(my_tools)
        >>>
        >>> # Pass to AI provider, validation is automatic
    """

    _BUILT_IN_POLICY_PACK_FILE_NAMES: dict[str, str] = {
        "@veto/safe-defaults": "safe-defaults.yaml",
        "@veto/coding-agent": "coding-agent.yaml",
        "@veto/crypto-trading": "crypto-trading.yaml",
        "@veto/financial": "financial.yaml",
        "@veto/browser-automation": "browser-automation.yaml",
        "@veto/data-access": "data-access.yaml",
        "@veto/communication": "communication.yaml",
        "@veto/deployment": "deployment.yaml",
        "@veto/economic-agent": "economic-agent.yaml",
        "@veto/soc2-lite": "soc2-lite.yaml",
        "@veto/hipaa-lite": "hipaa-lite.yaml",
        "@veto/eu-ai-act-starter": "eu-ai-act-starter.yaml",
    }

    @staticmethod
    def _parse_mode(value: Optional[str]) -> Optional[VetoMode]:
        if value in ("strict", "log", "shadow"):
            return cast(VetoMode, value)
        return None

    def __init__(
        self,
        options: VetoOptions,
        logger: Logger,
        cloud_client: VetoCloudClient,
        rules: LoadedRulesState,
        output_rules: LoadedOutputRulesState,
        validation_mode: ValidationMode,
        event_webhook_config: Optional[EventWebhookConfig],
    ):
        self._logger = logger
        self._mode: VetoMode = options.mode or "strict"
        self._resolved_log_level: LogLevel = options.log_level or "info"
        self._validation_mode: ValidationMode = validation_mode
        self._cloud_client = cloud_client
        self._rules = rules
        self._output_rules = output_rules
        self._event_webhook_emitter = EventWebhookEmitter(
            event_webhook_config,
            self._logger,
        )
        self._feed_provider = options.feed_provider
        self._economic_policy = (
            dict(options.economic_policy)
            if isinstance(options.economic_policy, dict)
            else rules.economic_policy
        )
        self._economic_budget_engine: Optional[LocalBudgetEngine] = None
        self._economic_evaluator: Optional[EconomicEvaluator] = None
        self._init_economic_evaluator()
        self._kernel_client = options.kernel_client
        self._custom_client = options.custom_client
        self._kernel_config = options.kernel_config
        self._custom_config = options.custom_config
        self._receipt_store = (
            Path(options.receipt_store).resolve()
            if options.receipt_store
            else None
        )
        self._custom_config_error: Optional[str] = None
        if self._validation_mode == "custom":
            if not isinstance(self._custom_config, dict) or not self._custom_config.get("provider"):
                self._custom_config_error = (
                    "Missing custom.provider for custom validation. Set custom.provider "
                    "in veto.config.yaml."
                )
            elif not self._custom_config.get("model"):
                provider = self._custom_config.get("provider")
                self._custom_config_error = (
                    f"Missing custom.model for custom provider {provider}. "
                    "Set custom.model in veto.config.yaml."
                )

        # Approval options
        self._on_approval_required = options.on_approval_required
        self._approval_poll_options = ApprovalPollOptions(
            poll_interval=options.approval_poll_interval or 2.0,
            timeout=options.approval_timeout or 300.0,
        )

        # Approval preference cache: tool_name -> "approve_all" | "deny_all"
        self._approval_preferences: dict[str, str] = {}

        # Resolve tracking options
        self._session_id = options.session_id or os.environ.get("VETO_SESSION_ID")
        self._agent_id = options.agent_id or os.environ.get("VETO_AGENT_ID")
        self._user_id = options.user_id or os.environ.get("VETO_USER_ID")
        self._role = options.role or os.environ.get("VETO_ROLE")

        self._logger.info(
            "Veto configuration loaded",
            {
                "mode": self._mode,
                "validation_mode": self._validation_mode,
                "base_url": cloud_client._base_url,
                "rules_loaded": len(rules.all_rules),
                "output_rules_loaded": len(output_rules.all_output_rules),
                "economic_enabled": self._economic_evaluator is not None,
            },
        )

        # Validate rule patterns once at load time. A rejected regex would
        # otherwise silently make the rule never match — fail-open on
        # security-relevant misconfig. We emit a loud error per offender
        # so misconfigured rules surface in startup logs.
        self._warn_about_unsafe_rule_patterns(rules.all_rules)

        # Initialize validation engine
        default_decision = "allow"
        self._validation_engine = ValidationEngine(
            ValidationEngineOptions(
                logger=self._logger, default_decision=default_decision
            )
        )

        # Add the primary rule validator based on validation mode.
        async def validate_with_mode(ctx: ValidationContext) -> ValidationResult:
            if self._validation_mode == "local":
                return await self._validate_with_local(ctx)
            if self._validation_mode == "kernel":
                return await self._validate_with_kernel(ctx)
            if self._validation_mode == "custom":
                return await self._validate_with_custom(ctx)
            return await self._validate_with_cloud(ctx)

        descriptions = {
            "local": "Validates tool calls via local YAML rules",
            "kernel": "Validates tool calls via local kernel model",
            "custom": "Validates tool calls via a custom LLM provider",
            "cloud": "Validates tool calls via Veto Cloud API",
            "api": "Validates tool calls via external API",
        }
        self._validation_engine.add_validator(
            NamedValidator(
                name="veto-rule-validator",
                description=descriptions[self._validation_mode],
                priority=50,
                validate=validate_with_mode,
            )
        )

        # Add any additional validators
        if options.validators:
            self._validation_engine.add_validators(options.validators)

        # Initialize history tracker
        self._history_tracker = HistoryTracker(
            HistoryTrackerOptions(max_size=100, logger=self._logger)
        )

        # Initialize interceptor
        self._output_validator = OutputValidator(
            OutputValidatorOptions(
                logger=self._logger,
                get_rules_for_tool=self._get_output_rules_for_tool,
            )
        )

        self._interceptor = Interceptor(
            InterceptorOptions(
                logger=self._logger,
                validation_engine=self._validation_engine,
                history_tracker=self._history_tracker,
                session_id=self._session_id,
                agent_id=self._agent_id,
                user_id=self._user_id,
                role=self._role,
                on_after_validation=self._emit_decision_event,
                output_validator=self._output_validator,
            )
        )

        # Initialize policy cache for client-side deterministic validation
        self._policy_cache = PolicyCache(self._cloud_client)

        self._logger.info("Veto initialized successfully")

    def _init_economic_evaluator(self) -> None:
        if not isinstance(self._economic_policy, dict):
            return

        budgets = parse_economic_budget_configs(self._economic_policy.get("budgets"))
        if not budgets:
            return

        budget_engine = LocalBudgetEngine(budgets=budgets, logger=self._logger)
        self._economic_budget_engine = budget_engine
        self._economic_evaluator = EconomicEvaluator(
            policy=self._economic_policy,
            budget_engine=budget_engine,
            logger=self._logger,
        )
        payer_config = self._economic_policy.get("payer")
        self._logger.info(
            "Economic evaluator initialized",
            {
                "budgets": len(budgets),
                "payer_required": isinstance(payer_config, dict)
                and payer_config.get("required") is True,
            },
        )

    async def close(self) -> None:
        await self._cloud_client.close()

    @classmethod
    async def init(cls, options: Optional[VetoOptions] = None) -> "Veto":
        """
        Initialize Veto.

        Args:
            options: Initialization options

        Returns:
            Initialized Veto instance

        Example:
            >>> # Use defaults (uses VETO_API_KEY env var)
            >>> veto = await Veto.init()
            >>>
            >>> # With explicit API key
            >>> veto = await Veto.init(VetoOptions(api_key='your-key'))
        """
        options = options or VetoOptions()

        # Determine log level. Precedence: explicit options > VETO_LOG env var
        # (which can also encode stream mode, e.g. ``stream:verbose``) >
        # VETO_LOG_LEVEL > default ``info``.
        env_log_setting = parse_env_log_setting(os.environ.get("VETO_LOG"))
        env_log_level = os.environ.get("VETO_LOG_LEVEL")
        env_level_fallback: Optional[LogLevel] = (
            env_log_level  # type: ignore[assignment]
            if env_log_level in ("debug", "info", "stream", "warn", "error", "silent")
            else None
        )
        log_level: LogLevel = (
            options.log_level
            or (env_log_setting.level if env_log_setting else None)
            or env_level_fallback
            or "info"
        )

        stream_mode: StreamLogMode = (
            options.stream_mode
            or (env_log_setting.stream_mode if env_log_setting and env_log_setting.stream_mode else None)
            or "compact"
        )

        logger = create_logger(log_level, stream_mode)

        # Create cloud client
        cloud_config = VetoCloudConfig(
            api_key=options.api_key,
            base_url=options.base_url
            or os.environ.get("VETO_API_URL", "https://api.runveto.com"),
            timeout=options.timeout or 30000,
            retries=options.retries or 2,
        )
        cloud_client = VetoCloudClient(cloud_config, logger)

        # Check for API key
        if not cloud_client._api_key:
            logger.warn(
                "No API key provided. Set VETO_API_KEY environment variable or pass api_key in options."
            )

        resolved_config_dir = Path(options.config_dir or "./veto").resolve()
        rules_dir = resolved_config_dir / "rules"
        recursive_rules = True
        config_mode: Optional[VetoMode] = None
        config_validation_mode: Optional[ValidationMode] = None
        event_webhook_config: Optional[EventWebhookConfig] = None
        config_economic_policy: Optional[dict[str, Any]] = None
        config_kernel: Optional[dict[str, Any]] = None
        config_custom: Optional[dict[str, Any]] = None

        config_path = resolved_config_dir / "veto.config.yaml"
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config_data = yaml.safe_load(f)
                if isinstance(config_data, dict):
                    raw_mode = config_data.get("mode")
                    if raw_mode in ("strict", "log", "shadow"):
                        config_mode = cast(VetoMode, raw_mode)

                    validation_config = config_data.get("validation")
                    if isinstance(validation_config, dict):
                        raw_mode = validation_config.get("mode")
                        if raw_mode in ("cloud", "local", "kernel", "custom", "api"):
                            config_validation_mode = raw_mode

                    rules_config = config_data.get("rules")
                    if isinstance(rules_config, dict):
                        rules_directory = rules_config.get("directory")
                        if isinstance(rules_directory, str) and rules_directory.strip():
                            rules_dir = (resolved_config_dir / rules_directory).resolve()
                        recursive_value = rules_config.get("recursive")
                        if isinstance(recursive_value, bool):
                            recursive_rules = recursive_value

                    events_config = config_data.get("events")
                    if isinstance(events_config, dict):
                        event_webhook_config = parse_event_webhook_config(
                            events_config.get("webhook"),
                            logger,
                        )

                    economic_config = config_data.get("economic")
                    if isinstance(economic_config, dict):
                        config_economic_policy = dict(economic_config)

                    kernel_config = config_data.get("kernel")
                    if isinstance(kernel_config, dict):
                        config_kernel = dict(kernel_config)

                    custom_config = config_data.get("custom")
                    if isinstance(custom_config, dict):
                        config_custom = dict(custom_config)
            except Exception as exc:
                logger.warn(
                    "Failed to parse veto.config.yaml for rules configuration",
                    {"error": str(exc), "path": str(config_path)},
                )

        validation_mode = (
            options.validation_mode
            or config_validation_mode
            or "cloud"
        )
        env_mode = cls._parse_mode(os.environ.get("VETO_MODE"))
        options.mode = options.mode or config_mode or env_mode or "strict"
        options.log_level = log_level
        options.kernel_config = options.kernel_config or config_kernel
        options.custom_config = options.custom_config or config_custom

        rules = cls._load_rules(
            rules_dir=rules_dir,
            recursive=recursive_rules,
            logger=logger,
        )
        if config_economic_policy is not None:
            rules.economic_policy = config_economic_policy
        output_rules = cls._load_output_rules(
            rules_dir=rules_dir,
            recursive=recursive_rules,
            logger=logger,
        )

        return cls(
            options,
            logger,
            cloud_client,
            rules,
            output_rules,
            validation_mode,
            event_webhook_config,
        )

    @classmethod
    def from_rules(
        cls,
        *,
        rules: list[dict[str, Any]],
        output_rules: Optional[list[dict[str, Any]]] = None,
        mode: Optional[VetoMode] = None,
        log_level: Optional[LogLevel] = None,
        stream_mode: Optional[StreamLogMode] = None,
        session_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        role: Optional[str] = None,
        validators: Optional[list[Union[Validator, NamedValidator]]] = None,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        timeout: Optional[int] = None,
        retries: Optional[int] = None,
        on_approval_required: Optional[Callable[..., Any]] = None,
        approval_poll_interval: Optional[float] = None,
        approval_timeout: Optional[float] = None,
        feed_provider: Optional[FeedProvider] = None,
        economic_policy: Optional[dict[str, Any]] = None,
        validation_mode: ValidationMode = "local",
        kernel_client: Optional[Any] = None,
        custom_client: Optional[Any] = None,
        kernel_config: Optional[dict[str, Any]] = None,
        custom_config: Optional[dict[str, Any]] = None,
        receipt_store: Optional[str] = None,
    ) -> "Veto":
        # Honor VETO_LOG (e.g. ``stream``, ``stream:verbose``) when no explicit
        # log_level is passed, so the env-var contract holds for from_rules too.
        env_log_setting = parse_env_log_setting(os.environ.get("VETO_LOG"))
        resolved_log_level = (
            log_level
            or (env_log_setting.level if env_log_setting else None)
            or "warn"
        )
        resolved_stream_mode = (
            stream_mode
            or (env_log_setting.stream_mode if env_log_setting and env_log_setting.stream_mode else None)
            or "compact"
        )
        resolved_mode = mode or cls._parse_mode(os.environ.get("VETO_MODE")) or "strict"
        logger = create_logger(resolved_log_level, resolved_stream_mode)

        cloud_config = VetoCloudConfig(
            api_key=api_key,
            base_url=endpoint or os.environ.get("VETO_API_URL", "https://api.runveto.com"),
            timeout=timeout or 30000,
            retries=retries or 2,
        )
        cloud_client = VetoCloudClient(cloud_config, logger)

        veto_options = VetoOptions(
            api_key=api_key,
            base_url=endpoint,
            mode=resolved_mode,
            log_level=resolved_log_level,
            stream_mode=stream_mode,
            session_id=session_id,
            agent_id=agent_id,
            user_id=user_id,
            role=role,
            validators=validators,
            timeout=timeout,
            retries=retries,
            on_approval_required=on_approval_required,
            approval_poll_interval=approval_poll_interval,
            approval_timeout=approval_timeout,
            validation_mode=validation_mode,
            feed_provider=feed_provider,
            economic_policy=economic_policy,
            kernel_client=kernel_client,
            custom_client=custom_client,
            kernel_config=kernel_config,
            custom_config=custom_config,
            receipt_store=receipt_store,
        )

        indexed_rules = cls._index_inline_rules(rules)
        if economic_policy is not None:
            indexed_rules.economic_policy = dict(economic_policy)
        indexed_output_rules = cls._index_inline_output_rules(output_rules or [])

        return cls(
            veto_options,
            logger,
            cloud_client,
            indexed_rules,
            indexed_output_rules,
            validation_mode,
            None,
        )

    @staticmethod
    def _find_yaml_files(rules_dir: Path, recursive: bool) -> list[Path]:
        if not rules_dir.exists() or not rules_dir.is_dir():
            return []

        if recursive:
            return [
                p
                for p in rules_dir.rglob("*")
                if p.is_file() and p.suffix.lower() in {".yaml", ".yml"}
            ]

        return [
            p
            for p in rules_dir.iterdir()
            if p.is_file() and p.suffix.lower() in {".yaml", ".yml"}
        ]

    @classmethod
    def _get_built_in_policy_pack_names(cls) -> list[str]:
        return list(cls._BUILT_IN_POLICY_PACK_FILE_NAMES.keys())

    @staticmethod
    def _normalize_policy_pack_name(pack_name: str) -> str:
        trimmed = pack_name.strip()
        if trimmed.startswith("@veto/"):
            return trimmed
        return f"@veto/{trimmed}"

    @classmethod
    def _resolve_policy_pack_path(cls, pack_name: str) -> Path:
        normalized_name = cls._normalize_policy_pack_name(pack_name)
        file_name = cls._BUILT_IN_POLICY_PACK_FILE_NAMES.get(normalized_name)
        if file_name is None:
            available = ", ".join(cls._get_built_in_policy_pack_names())
            raise ValueError(
                f'Unknown policy pack "{pack_name}". Available packs: {available}'
            )

        pack_dir = Path(__file__).resolve().parent.parent / "packs"
        pack_path = pack_dir / file_name
        if not pack_path.exists():
            raise ValueError(
                f'Policy pack "{normalized_name}" is bundled but missing at {pack_path}'
            )

        return pack_path

    @staticmethod
    def _as_list(value: Any) -> list[Any]:
        if not isinstance(value, list):
            return []
        return list(value)

    @staticmethod
    def _get_rule_id(rule: Any) -> Optional[str]:
        if not isinstance(rule, dict):
            return None
        rule_id = rule.get("id")
        return rule_id if isinstance(rule_id, str) else None

    @classmethod
    def _merge_rules_by_id(
        cls,
        base_rules: list[Any],
        user_rules: list[Any],
    ) -> list[Any]:
        merged_rules = list(base_rules)
        id_to_index: dict[str, int] = {}

        for index, rule in enumerate(merged_rules):
            rule_id = cls._get_rule_id(rule)
            if rule_id is not None and rule_id not in id_to_index:
                id_to_index[rule_id] = index

        for user_rule in user_rules:
            rule_id = cls._get_rule_id(user_rule)
            if rule_id is not None and rule_id in id_to_index:
                merged_rules[id_to_index[rule_id]] = user_rule
                continue

            merged_rules.append(user_rule)
            if rule_id is not None:
                id_to_index[rule_id] = len(merged_rules) - 1

        return merged_rules

    @classmethod
    def _merge_policy_with_pack(
        cls,
        pack_policy: dict[str, Any],
        user_policy: dict[str, Any],
    ) -> dict[str, Any]:
        merged_policy: dict[str, Any] = {**pack_policy, **user_policy}

        if "rules" in pack_policy or "rules" in user_policy:
            merged_policy["rules"] = cls._merge_rules_by_id(
                cls._as_list(pack_policy.get("rules")),
                cls._as_list(user_policy.get("rules")),
            )

        if "output_rules" in pack_policy or "output_rules" in user_policy:
            merged_policy["output_rules"] = cls._merge_rules_by_id(
                cls._as_list(pack_policy.get("output_rules")),
                cls._as_list(user_policy.get("output_rules")),
            )

        return merged_policy

    @classmethod
    def _resolve_policy_pack_extends(
        cls,
        policy_data: dict[str, Any],
        source: str,
    ) -> dict[str, Any]:
        raw_extends = policy_data.get("extends")
        if raw_extends is None:
            return policy_data

        if not isinstance(raw_extends, str) or raw_extends.strip() == "":
            raise ValueError(
                f'Invalid "extends" value in {source}. '
                'Expected a non-empty string like "@veto/coding-agent".'
            )

        normalized_pack_name = cls._normalize_policy_pack_name(raw_extends)
        pack_path = cls._resolve_policy_pack_path(normalized_pack_name)
        with open(pack_path, "r", encoding="utf-8") as f:
            parsed_pack = yaml.safe_load(f)

        if not isinstance(parsed_pack, dict):
            raise ValueError(
                f'Policy pack "{normalized_pack_name}" at {pack_path} is not a valid YAML object'
            )

        merged_policy = cls._merge_policy_with_pack(
            dict(parsed_pack),
            {**policy_data, "extends": normalized_pack_name},
        )
        return merged_policy

    @classmethod
    def _load_policy_document(
        cls,
        file_path: Path,
        logger: Logger,
    ) -> Optional[dict[str, Any]]:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                parsed = yaml.safe_load(f)
        except Exception as exc:
            logger.error(
                "Failed to read policy file",
                {"path": str(file_path)},
                exc,
            )
            return None

        if not isinstance(parsed, dict):
            return None

        try:
            parsed_with_extends = cls._resolve_policy_pack_extends(
                dict(parsed),
                str(file_path),
            )
        except Exception as exc:
            logger.error(
                "Skipping invalid policy file during pack resolution",
                {"path": str(file_path)},
                exc,
            )
            return None

        parsed_for_validation: dict[str, Any] = dict(parsed_with_extends)
        if (
            "rules" not in parsed_for_validation
            and "output_rules" in parsed_for_validation
        ):
            parsed_for_validation["rules"] = []

        if (
            "rules" not in parsed_for_validation
            and "output_rules" not in parsed_for_validation
        ):
            return None

        try:
            validate_policy_ir(parsed_for_validation)
        except PolicySchemaError as exc:
            logger.error(
                "Skipping invalid policy file during rule load",
                {"path": str(file_path), "error_count": len(exc.errors)},
                exc,
            )
            return None

        return parsed_for_validation

    @classmethod
    def _load_rules(
        cls,
        rules_dir: Path,
        recursive: bool,
        logger: Logger,
    ) -> LoadedRulesState:
        state = LoadedRulesState(
            all_rules=[],
            rules_by_tool={},
            global_rules=[],
            economic_policy=None,
        )

        yaml_files = cls._find_yaml_files(rules_dir, recursive)
        for file_path in yaml_files:
            parsed_for_validation = cls._load_policy_document(file_path, logger)
            if parsed_for_validation is None:
                continue

            rules_raw = parsed_for_validation.get("rules")
            if not isinstance(rules_raw, list):
                continue

            for rule in rules_raw:
                if not isinstance(rule, dict):
                    continue

                if rule.get("enabled") is False:
                    continue

                normalized_rule = dict(rule)
                normalized_rule.setdefault("enabled", True)
                normalized_rule.setdefault("severity", "medium")
                normalized_rule.setdefault("action", "block")

                state.all_rules.append(normalized_rule)

                tools = normalized_rule.get("tools")
                if isinstance(tools, list) and tools:
                    for tool_name in tools:
                        if not isinstance(tool_name, str):
                            continue
                        tool_rules = state.rules_by_tool.setdefault(tool_name, [])
                        tool_rules.append(normalized_rule)
                else:
                    state.global_rules.append(normalized_rule)

        return state

    @classmethod
    def _load_output_rules(
        cls,
        rules_dir: Path,
        recursive: bool,
        logger: Logger,
    ) -> LoadedOutputRulesState:
        state = LoadedOutputRulesState(
            all_output_rules=[],
            output_rules_by_tool={},
            global_output_rules=[],
        )

        yaml_files = cls._find_yaml_files(rules_dir, recursive)
        for file_path in yaml_files:
            parsed_for_validation = cls._load_policy_document(file_path, logger)
            if parsed_for_validation is None:
                continue

            output_rules_raw = parsed_for_validation.get("output_rules")
            if not isinstance(output_rules_raw, list):
                continue

            for output_rule in output_rules_raw:
                if not isinstance(output_rule, dict):
                    continue

                if output_rule.get("enabled") is False:
                    continue

                normalized_rule = dict(output_rule)
                normalized_rule.setdefault("enabled", True)
                normalized_rule.setdefault("severity", "medium")
                normalized_rule.setdefault("action", "log")

                state.all_output_rules.append(normalized_rule)

                tools = normalized_rule.get("tools")
                if isinstance(tools, list) and tools:
                    for tool_name in tools:
                        if not isinstance(tool_name, str):
                            continue
                        tool_rules = state.output_rules_by_tool.setdefault(tool_name, [])
                        tool_rules.append(normalized_rule)
                else:
                    state.global_output_rules.append(normalized_rule)

        return state

    def _warn_about_unsafe_rule_patterns(self, rules: list[dict[str, Any]]) -> None:
        """Surface rules whose ``matches`` regex fails the safety check.

        Such rules silently never match at evaluate time, which is a
        fail-open misconfig in security-relevant policies. We log an
        ``error`` here so the user sees the broken rule in startup output;
        runtime evaluation still treats the condition as False (the safer
        of the silent options).

        Walks both ``rule.conditions`` (a flat AND list) and
        ``rule.condition_groups`` (a list-of-lists, OR-of-AND). The latter
        was missed by the original implementation — an unsafe pattern
        inside ``condition_groups`` slipped past the load-time check and
        still failed open at runtime.
        """
        from veto.deterministic.regex_safety import is_safe_pattern

        for rule in rules:
            for cond in Veto._iter_rule_conditions(rule):
                if not isinstance(cond, dict):
                    continue
                if cond.get("operator") != "matches":
                    continue
                pattern = cond.get("value")
                if not isinstance(pattern, str):
                    continue
                if is_safe_pattern(pattern):
                    continue
                self._logger.error(
                    "Rule has an unsafe `matches` regex — it will never fire",
                    {
                        "rule_id": rule.get("id"),
                        "field": cond.get("field"),
                        "pattern": pattern[:128] + ("…" if len(pattern) > 128 else ""),
                        "hint": (
                            "pattern length, nested-quantified groups, or "
                            "overlapping `.*` alternations are rejected by "
                            "the ReDoS-safety heuristic"
                        ),
                    },
                )

    @staticmethod
    def _iter_rule_conditions(rule: dict[str, Any]) -> Iterator[Any]:
        """Yield every condition dict on a rule, regardless of whether it
        lives in ``rule.conditions`` (flat AND) or ``rule.condition_groups``
        (OR-of-AND). Tolerant of missing / malformed shapes — bad data
        just produces fewer yields, never an exception.
        """
        flat = rule.get("conditions")
        if isinstance(flat, list):
            for cond in flat:
                yield cond

        groups = rule.get("condition_groups")
        if isinstance(groups, list):
            for group in groups:
                if not isinstance(group, list):
                    continue
                for cond in group:
                    yield cond

    @classmethod
    def _index_inline_rules(
        cls,
        rules: list[dict[str, Any]],
    ) -> LoadedRulesState:
        state = LoadedRulesState(
            all_rules=[],
            rules_by_tool={},
            global_rules=[],
            economic_policy=None,
        )

        for rule in rules:
            if not isinstance(rule, dict):
                continue

            if rule.get("enabled") is False:
                continue

            normalized_rule = dict(rule)
            normalized_rule.setdefault("enabled", True)
            normalized_rule.setdefault("severity", "medium")
            normalized_rule.setdefault("action", "block")

            state.all_rules.append(normalized_rule)

            tools = normalized_rule.get("tools")
            if isinstance(tools, list) and tools:
                for tool_name in tools:
                    if not isinstance(tool_name, str):
                        continue
                    tool_rules = state.rules_by_tool.setdefault(tool_name, [])
                    tool_rules.append(normalized_rule)
            else:
                state.global_rules.append(normalized_rule)

        return state

    @classmethod
    def _index_inline_output_rules(
        cls,
        output_rules: list[dict[str, Any]],
    ) -> LoadedOutputRulesState:
        state = LoadedOutputRulesState(
            all_output_rules=[],
            output_rules_by_tool={},
            global_output_rules=[],
        )

        for output_rule in output_rules:
            if not isinstance(output_rule, dict):
                continue

            if output_rule.get("enabled") is False:
                continue

            normalized_rule = dict(output_rule)
            normalized_rule.setdefault("enabled", True)
            normalized_rule.setdefault("severity", "medium")
            normalized_rule.setdefault("action", "log")

            state.all_output_rules.append(normalized_rule)

            tools = normalized_rule.get("tools")
            if isinstance(tools, list) and tools:
                for tool_name in tools:
                    if not isinstance(tool_name, str):
                        continue
                    tool_rules = state.output_rules_by_tool.setdefault(tool_name, [])
                    tool_rules.append(normalized_rule)
            else:
                state.global_output_rules.append(normalized_rule)

        return state

    def _extract_tool_signature(self, tool: Any) -> Optional[ToolRegistration]:
        """
        Extract tool signature for registration with cloud.

        Handles various tool formats (LangChain, custom, etc.)
        """
        tool_name = getattr(tool, "name", None)
        if not tool_name:
            return None

        description = getattr(tool, "description", None)

        # Try to extract parameters from various sources
        parameters: list[ToolParameter] = []

        # Try LangChain style args_schema (Pydantic model)
        args_schema = getattr(tool, "args_schema", None)
        if args_schema:
            try:
                schema = args_schema.model_json_schema()
                props = schema.get("properties", {})
                required = schema.get("required", [])

                for prop_name, prop_info in props.items():
                    param_type = prop_info.get("type", "string")
                    # Handle anyOf for Optional types
                    if "anyOf" in prop_info:
                        for any_type in prop_info["anyOf"]:
                            if any_type.get("type") != "null":
                                param_type = any_type.get("type", "string")
                                break

                    # Normalize JSON Schema "integer" to "number"
                    if param_type == "integer":
                        param_type = "number"

                    parameters.append(
                        ToolParameter(
                            name=prop_name,
                            type=param_type,
                            description=prop_info.get("description"),
                            required=prop_name in required,
                            enum=prop_info.get("enum"),
                            minimum=prop_info.get("minimum"),
                            maximum=prop_info.get("maximum"),
                            pattern=prop_info.get("pattern"),
                        )
                    )
            except Exception:
                pass

        # Try input_schema (ToolDefinition format)
        if not parameters:
            input_schema = getattr(tool, "input_schema", None)
            if input_schema and isinstance(input_schema, dict):
                props = input_schema.get("properties", {})
                required = input_schema.get("required", [])

                for prop_name, prop_info in props.items():
                    p_type = prop_info.get("type", "string")
                    if p_type == "integer":
                        p_type = "number"
                    parameters.append(
                        ToolParameter(
                            name=prop_name,
                            type=p_type,
                            description=prop_info.get("description"),
                            required=prop_name in required,
                            enum=prop_info.get("enum"),
                            minimum=prop_info.get("minimum"),
                            maximum=prop_info.get("maximum"),
                            pattern=prop_info.get("pattern"),
                        )
                    )

        # Try function signature inspection as fallback
        if not parameters:
            func = getattr(tool, "func", None) or getattr(tool, "handler", None)
            if func and callable(func):
                try:
                    sig = inspect.signature(func)
                    for param_name, param in sig.parameters.items():
                        if param_name in ("self", "cls"):
                            continue

                        param_type = "string"  # default
                        if param.annotation != inspect.Parameter.empty:
                            ann = param.annotation
                            if ann is int:
                                param_type = "number"
                            elif ann is float:
                                param_type = "number"
                            elif ann is bool:
                                param_type = "boolean"
                            elif ann is list:
                                param_type = "array"
                            elif ann is dict:
                                param_type = "object"

                        parameters.append(
                            ToolParameter(
                                name=param_name,
                                type=param_type,
                                required=param.default == inspect.Parameter.empty,
                            )
                        )
                except Exception:
                    pass

        return ToolRegistration(
            name=tool_name,
            description=description,
            parameters=parameters,
        )

    async def _register_tools_with_cloud(self, tools: list[Any]) -> None:
        """Register tools with the cloud for policy generation."""
        registrations: list[ToolRegistration] = []

        for tool in tools:
            registration = self._extract_tool_signature(tool)
            if registration:
                registrations.append(registration)
                self._logger.debug(
                    "Extracted tool signature",
                    {
                        "name": registration.name,
                        "params": len(registration.parameters),
                    },
                )

        if registrations:
            result = await self._cloud_client.register_tools(registrations)
            if result.success:
                self._logger.info(
                    "Tools registered with cloud",
                    {"tools": result.registered_tools},
                )
            else:
                self._logger.warn(
                    "Failed to register tools with cloud",
                    {"message": result.message},
                )

    async def _register_tool_definitions_with_cloud(
        self, tools: list[ToolDefinition]
    ) -> None:
        """Register canonical tool definitions with the cloud."""
        registrations: list[ToolRegistration] = []
        for tool in tools:
            properties = tool.input_schema.get("properties", {})
            required = tool.input_schema.get("required", [])
            parameters: list[ToolParameter] = []
            if isinstance(properties, dict):
                for name, prop in properties.items():
                    if not isinstance(name, str):
                        continue
                    prop_map = prop if isinstance(prop, dict) else {}
                    p_type = prop_map.get("type", "string")
                    if p_type == "integer":
                        p_type = "number"
                    parameters.append(
                        ToolParameter(
                            name=name,
                            type=p_type if isinstance(p_type, str) else "string",
                            description=prop_map.get("description")
                            if isinstance(prop_map.get("description"), str)
                            else None,
                            required=name in required,
                            enum=prop_map.get("enum")
                            if isinstance(prop_map.get("enum"), list)
                            else None,
                            minimum=prop_map.get("minimum")
                            if isinstance(prop_map.get("minimum"), (int, float))
                            else None,
                            maximum=prop_map.get("maximum")
                            if isinstance(prop_map.get("maximum"), (int, float))
                            else None,
                            pattern=prop_map.get("pattern")
                            if isinstance(prop_map.get("pattern"), str)
                            else None,
                        )
                    )

            registrations.append(
                ToolRegistration(
                    name=tool.name,
                    description=tool.description,
                    parameters=parameters,
                )
            )

        if registrations:
            result = await self._cloud_client.register_tools(registrations)
            if result.success:
                self._logger.info(
                    "MCP tools registered with cloud",
                    {"tools": result.registered_tools},
                )
            else:
                self._logger.warn(
                    "Failed to register MCP tools with cloud",
                    {"message": result.message},
                )

    def _is_guard_evaluation(self, context: ValidationContext) -> bool:
        return context.source == "guard"

    def _should_apply_log_mode_override(self, context: ValidationContext) -> bool:
        return self._mode in ("log", "shadow") and not self._is_guard_evaluation(context)

    def _should_emit_shadow_stderr(self) -> bool:
        return self._mode == "shadow" and self._resolved_log_level != "silent"

    def _emit_shadow_stderr(
        self,
        context: ValidationContext,
        decision: Literal["deny", "require_approval"],
        rule_id: Optional[str] = None,
    ) -> None:
        if not self._should_emit_shadow_stderr():
            return

        tag = (
            "WOULD BE DENIED"
            if decision == "deny"
            else "WOULD REQUIRE APPROVAL"
        )
        rule_info = f" by {rule_id}" if rule_id else ""
        args_str = str(context.arguments)[:80]
        print(
            f"[shadow] {context.tool_name}({args_str}) - {tag}{rule_info}",
            file=sys.stderr,
        )

    def _apply_shadow_mode_override(
        self,
        context: ValidationContext,
        original_decision: Literal["deny", "require_approval"],
        original_reason: Optional[str],
        metadata: Optional[dict[str, Any]] = None,
        rule_id: Optional[str] = None,
    ) -> ValidationResult:
        self._logger.warn(
            (
                "[shadow] Tool call would be denied"
                if original_decision == "deny"
                else "[shadow] Tool call would require approval"
            ),
            {
                "tool": context.tool_name,
                "decision": original_decision,
                "reason": original_reason,
                "rule_id": rule_id,
                "shadow": True,
            },
        )
        self._emit_shadow_stderr(context, original_decision, rule_id)

        merged_metadata = {
            **(metadata or {}),
            "shadow": True,
            "shadow_decision": original_decision,
            "shadow_reason": original_reason,
            "shadow_rule_id": rule_id,
        }

        return ValidationResult(
            decision=original_decision,
            reason=original_reason,
            metadata=merged_metadata,
        )

    def _resolve_session_id(self, context: ValidationContext) -> Optional[str]:
        return (
            context.session_id
            if context.session_id is not None
            else self._session_id
        )

    def _resolve_agent_id(self, context: ValidationContext) -> Optional[str]:
        return context.agent_id if context.agent_id is not None else self._agent_id

    def _resolve_user_id(self, context: ValidationContext) -> Optional[str]:
        return context.user_id if context.user_id is not None else self._user_id

    def _resolve_role(self, context: ValidationContext) -> Optional[str]:
        return context.role if context.role is not None else self._role

    def _get_rules_for_tool(self, tool_name: str) -> list[dict[str, Any]]:
        tool_specific = self._rules.rules_by_tool.get(tool_name, [])
        return [*self._rules.global_rules, *tool_specific]

    def _get_output_rules_for_tool(self, tool_name: str) -> list[dict[str, Any]]:
        tool_specific = self._output_rules.output_rules_by_tool.get(tool_name, [])
        return [*self._output_rules.global_output_rules, *tool_specific]

    def validate_output(self, tool_name: str, output: Any) -> OutputValidationResult:
        """Validate and transform tool output against configured output rules."""
        return self._output_validator.validate(tool_name, output)

    def _validate_output_or_throw(self, tool_name: str, output: Any) -> Any:
        result = self.validate_output(tool_name, output)
        if result.decision == "block":
            raise RuntimeError(result.reason or f"Tool output blocked for {tool_name}")
        return result.output

    def _build_local_evaluation_context(
        self, context: ValidationContext
    ) -> dict[str, Any]:
        local_context: dict[str, Any] = dict(context.arguments)
        local_context["tool_name"] = context.tool_name
        local_context["arguments"] = dict(context.arguments)
        local_context["session_id"] = self._resolve_session_id(context)
        local_context["agent_id"] = self._resolve_agent_id(context)
        local_context["user_id"] = self._resolve_user_id(context)
        local_context["role"] = self._resolve_role(context)
        local_context["custom"] = context.custom
        return local_context

    def _to_local_rule_metadata(self, rule: dict[str, Any]) -> dict[str, Any]:
        return {
            "source": "local",
            "rule_id": rule.get("id"),
            "rule_name": rule.get("name"),
            "severity": rule.get("severity"),
            "policy_version": "1.0",
        }

    def _matches_local_rule(
        self,
        rule: dict[str, Any],
        context: ValidationContext,
        local_context: dict[str, Any],
    ) -> bool:
        if not rule_applies_to_agent(rule, self._resolve_agent_id(context)):
            return False

        conditions_raw = rule.get("conditions")
        conditions: Optional[list[Mapping[str, Any]]] = (
            [
                cast(Mapping[str, Any], item)
                for item in conditions_raw
                if isinstance(item, dict)
            ]
            if isinstance(conditions_raw, list)
            else None
        )

        condition_groups_raw = rule.get("condition_groups")
        condition_groups: Optional[list[list[Mapping[str, Any]]]] = None
        if isinstance(condition_groups_raw, list):
            normalized_groups: list[list[Mapping[str, Any]]] = []
            for group in condition_groups_raw:
                if not isinstance(group, list):
                    continue
                normalized_group = [
                    cast(Mapping[str, Any], condition)
                    for condition in group
                    if isinstance(condition, dict)
                ]
                if normalized_group:
                    normalized_groups.append(normalized_group)
            condition_groups = normalized_groups if normalized_groups else None

        conditions_match = evaluate_condition_collections(
            conditions=conditions,
            condition_groups=condition_groups,
            context=local_context,
            now=context.timestamp,
            feed_provider=self._feed_provider,
        )
        if not conditions_match:
            return False

        return evaluate_sequence_constraints(
            rule=rule,
            call_history=context.call_history,
            now=context.timestamp,
        )

    async def _validate_with_local(
        self, context: ValidationContext
    ) -> ValidationResult:
        """Validate a tool call locally against YAML rules."""
        rules = self._get_rules_for_tool(context.tool_name)
        if not rules:
            self._logger.debug(
                "No rules for tool, allowing",
                {"tool": context.tool_name},
            )
            return ValidationResult(decision="allow")

        local_context = self._build_local_evaluation_context(context)
        first_allow_rule: Optional[dict[str, Any]] = None

        for rule in rules:
            if not self._matches_local_rule(rule, context, local_context):
                continue

            rule_name = rule.get("name") if isinstance(rule.get("name"), str) else "Unnamed Rule"
            reason = (
                rule.get("description")
                if isinstance(rule.get("description"), str)
                else f"Matched rule: {rule_name}"
            )
            metadata = self._to_local_rule_metadata(rule)
            action = rule.get("action")

            if action == "require_payment":
                return self._validate_require_payment_rule(rule, context, metadata)

            if action == "require_approval":
                if self._should_apply_log_mode_override(context):
                    if self._mode == "shadow":
                        return self._apply_shadow_mode_override(
                            context,
                            "require_approval",
                            reason,
                            metadata,
                            cast(Optional[str], rule.get("id")),
                        )

                    self._logger.warn(
                        "Tool call would require approval locally (log mode)",
                        {
                            "tool": context.tool_name,
                            "rule_id": rule.get("id"),
                            "reason": reason,
                        },
                    )
                    return ValidationResult(
                        decision="allow",
                        reason=f"[LOG MODE] Would require approval: {reason}",
                        metadata={**metadata, "blocked_in_strict_mode": True},
                    )

                if self._is_guard_evaluation(context):
                    return ValidationResult(
                        decision="require_approval",
                        reason=reason,
                        metadata=metadata,
                    )

                self._logger.warn(
                    "Tool call blocked by local approval rule (no approval flow configured)",
                    {
                        "tool": context.tool_name,
                        "rule_id": rule.get("id"),
                        "reason": reason,
                    },
                )
                return ValidationResult(
                    decision="deny",
                    reason=f"Approval required: {reason}",
                    metadata=metadata,
                )

            if action == "block":
                if self._should_apply_log_mode_override(context):
                    if self._mode == "shadow":
                        return self._apply_shadow_mode_override(
                            context,
                            "deny",
                            reason,
                            metadata,
                            cast(Optional[str], rule.get("id")),
                        )

                    self._logger.warn(
                        "Tool call would be blocked locally (log mode)",
                        {
                            "tool": context.tool_name,
                            "rule_id": rule.get("id"),
                            "reason": reason,
                        },
                    )
                    return ValidationResult(
                        decision="allow",
                        reason=f"[LOG MODE] Would block: {reason}",
                        metadata={**metadata, "blocked_in_strict_mode": True},
                    )

                # The validator always emits this warn; the StreamLogger
                # filters it locally so it doesn't duplicate the deny row.
                # Other loggers (Console, Memory, custom) see it normally.
                self._logger.warn(
                    "Tool call blocked by local rule",
                    {
                        "tool": context.tool_name,
                        "rule_id": rule.get("id"),
                        "reason": reason,
                    },
                )
                return ValidationResult(
                    decision="deny",
                    reason=reason,
                    metadata=metadata,
                )

            if action == "allow" and first_allow_rule is None:
                first_allow_rule = rule

            if action in ("warn", "log"):
                self._logger.warn(
                    "Local rule matched with non-blocking action",
                    {
                        "tool": context.tool_name,
                        "action": action,
                        "rule_id": rule.get("id"),
                    },
                )

        if first_allow_rule:
            first_allow_reason = (
                first_allow_rule.get("description")
                if isinstance(first_allow_rule.get("description"), str)
                else f"Allowed by rule: {first_allow_rule.get('name', 'Unnamed Rule')}"
            )
            return ValidationResult(
                decision="allow",
                reason=first_allow_reason,
                metadata=self._to_local_rule_metadata(first_allow_rule),
            )

        return ValidationResult(decision="allow")

    async def _get_kernel_client(self) -> Any:
        if self._kernel_client is not None:
            return self._kernel_client
        if not isinstance(self._kernel_config, dict):
            raise RuntimeError("Kernel configuration not available")
        self._kernel_client = KernelClient(config=self._kernel_config, logger=self._logger)
        return self._kernel_client

    async def _validate_with_kernel(
        self,
        context: ValidationContext,
    ) -> ValidationResult:
        rules = self._get_rules_for_tool(context.tool_name)
        if not rules:
            self._logger.debug(
                "No rules for tool, allowing",
                {"tool": context.tool_name},
            )
            return ValidationResult(decision="allow")

        try:
            client = await self._get_kernel_client()
            response = client.evaluate(
                {"tool": context.tool_name, "arguments": context.arguments},
                rules,
            )
            if inspect.isawaitable(response):
                response = await response
            return self._handle_model_response(response, context, "Kernel")
        except Exception as exc:
            return self._handle_model_failure(
                str(exc),
                context,
                "Kernel",
                "kernel_error",
            )

    async def _get_custom_client(self) -> Any:
        if self._custom_client is not None:
            return self._custom_client
        if self._custom_config_error:
            raise RuntimeError(self._custom_config_error)
        if not isinstance(self._custom_config, dict):
            raise RuntimeError(
                'Custom validation is not configured. Set validation.mode="custom" '
                "and provide custom.provider and custom.model in veto.config.yaml"
            )
        self._custom_client = CustomClient(config=self._custom_config, logger=self._logger)
        return self._custom_client

    async def _validate_with_custom(
        self,
        context: ValidationContext,
    ) -> ValidationResult:
        rules = self._get_rules_for_tool(context.tool_name)
        if not rules:
            self._logger.debug(
                "No rules for tool, allowing",
                {"tool": context.tool_name},
            )
            return ValidationResult(decision="allow")

        try:
            client = await self._get_custom_client()
            response = client.evaluate(
                {"tool": context.tool_name, "arguments": context.arguments},
                rules,
            )
            if inspect.isawaitable(response):
                response = await response
            return self._handle_model_response(response, context, "Custom provider")
        except Exception as exc:
            return self._handle_model_failure(
                str(exc),
                context,
                "Custom provider",
                "custom_provider_failed",
            )

    def _handle_model_response(
        self,
        response: KernelResponse | Mapping[str, Any],
        context: ValidationContext,
        label: str,
    ) -> ValidationResult:
        decision: Literal["pass", "block"]
        reasoning: Optional[str]
        if isinstance(response, KernelResponse):
            decision = response.decision
            reasoning = response.reasoning
            metadata: dict[str, Any] = {
                "pass_weight": response.pass_weight,
                "block_weight": response.block_weight,
                "matched_rules": response.matched_rules,
            }
        else:
            raw_decision = response.get("decision")
            decision = (
                cast(Literal["pass", "block"], raw_decision)
                if raw_decision in ("pass", "block")
                else "block"
            )
            raw_reasoning = response.get("reasoning")
            reasoning = raw_reasoning if isinstance(raw_reasoning, str) else None
            metadata = {
                "pass_weight": response.get("pass_weight"),
                "block_weight": response.get("block_weight"),
                "matched_rules": response.get("matched_rules"),
            }

        if decision == "pass":
            return ValidationResult(
                decision="allow",
                reason=reasoning,
                metadata=metadata,
            )

        reason = reasoning or f"{label} blocked tool call"
        matched_rules = metadata.get("matched_rules")
        rule_id = (
            str(matched_rules[0])
            if isinstance(matched_rules, list) and matched_rules
            else None
        )
        if self._mode in ("log", "shadow"):
            if self._mode == "shadow":
                return self._apply_shadow_mode_override(
                    context,
                    "deny",
                    reason,
                    metadata,
                    rule_id,
                )
            return ValidationResult(
                decision="allow",
                reason=f"[LOG MODE] Would block: {reason}",
                metadata={**metadata, "blocked_in_strict_mode": True},
            )

        return ValidationResult(decision="deny", reason=reason, metadata=metadata)

    def _handle_model_failure(
        self,
        reason: str,
        context: ValidationContext,
        label: str,
        metadata_key: str,
    ) -> ValidationResult:
        if self._mode in ("log", "shadow"):
            self._logger.warn(
                f"{label} unavailable ({self._mode} mode, allowing)",
                {"reason": reason},
            )
            return ValidationResult(
                decision="allow",
                reason=f"{label} unavailable: {reason}",
                metadata={metadata_key: True},
            )

        self._logger.error(f"{label} unavailable (strict mode, blocking)", {"reason": reason})
        return ValidationResult(
            decision="deny",
            reason=f"{label} unavailable: {reason}",
            metadata={metadata_key: True},
        )

    def _validate_require_payment_rule(
        self,
        rule: dict[str, Any],
        context: ValidationContext,
        metadata: dict[str, Any],
    ) -> ValidationResult:
        payment_cfg = rule.get("payment")
        if not isinstance(payment_cfg, dict):
            self._logger.warn(
                "[veto] require_payment rule has no payment config — treating as block",
                {"rule_id": rule.get("id")},
            )
            return ValidationResult(
                decision="deny",
                reason="Payment required but payment config is missing",
                metadata=metadata,
            )

        if payment_cfg.get("protocol") == "ap2":
            self._logger.warn(
                "[veto] AP2 mandate signature verification not yet implemented. "
                "Use x402 or MPP for production payment gates."
            )

        if self._economic_evaluator is None:
            self._logger.warn(
                "[veto] require_payment rule matched but no economic evaluator configured — failing closed",
                {"rule_id": rule.get("id")},
            )
            return ValidationResult(
                decision="deny",
                reason="Payment required but no payment provider configured",
                metadata=metadata,
            )

        amount = payment_cfg.get("amount")
        currency = payment_cfg.get("currency")
        protocol = payment_cfg.get("protocol")
        if not isinstance(amount, (int, float)) or isinstance(amount, bool):
            return ValidationResult(
                decision="deny",
                reason="Payment required but amount is invalid",
                metadata=metadata,
            )
        if not isinstance(currency, str) or not isinstance(protocol, str):
            return ValidationResult(
                decision="deny",
                reason="Payment required but currency/protocol is invalid",
                metadata=metadata,
            )

        chain_id = payment_cfg.get("chain_id")
        normalized_protocol: EconomicProtocol = (
            cast(EconomicProtocol, protocol)
            if protocol in ("x402", "mpp", "ap2", "custom")
            else "custom"
        )
        economic_context = EconomicContext(
            cost=float(amount),
            currency=currency,
            protocol=normalized_protocol,
            protocol_metadata={"chain_id": chain_id}
            if chain_id is not None
            else None,
        )
        econ_result = self._economic_evaluator.evaluate(economic_context)
        if econ_result.decision != "allow":
            return ValidationResult(
                decision="deny",
                reason=(
                    econ_result.denial.reason
                    if econ_result.denial is not None
                    else "Payment required"
                ),
                metadata={
                    **metadata,
                    **self._economic_metadata(econ_result.denial),
                },
            )

        return ValidationResult(
            decision="allow",
            reason=rule.get("description")
            if isinstance(rule.get("description"), str)
            else f"Payment gate passed: {rule.get('name', 'Unnamed Rule')}",
            metadata=metadata,
        )

    def _try_local_deterministic(
        self, context: ValidationContext
    ) -> Optional[LocalValidationResult]:
        policy = self._policy_cache.get(context.tool_name)
        if policy is None:
            return None

        if policy.mode != "deterministic":
            return None
        if policy.has_session_constraints or policy.has_rate_limits:
            return None

        result = validate_deterministic(
            context.tool_name, context.arguments, policy.constraints
        )
        shadow_context = (
            {
                "shadow": True,
                "shadow_decision": result.decision,
            }
            if self._mode == "shadow"
            else {}
        )

        self._cloud_client.log_decision(
            {
                "tool_name": context.tool_name,
                "arguments": context.arguments,
                "decision": result.decision,
                "reason": result.reason,
                "mode": "deterministic",
                "latency_ms": result.latency_ms,
                "source": "client",
                "context": {
                    "session_id": self._resolve_session_id(context),
                    "agent_id": self._resolve_agent_id(context),
                    "user_id": self._resolve_user_id(context),
                    "role": self._resolve_role(context),
                    **shadow_context,
                },
            }
        )

        return result

    async def _validate_with_cloud(
        self, context: ValidationContext
    ) -> ValidationResult:
        """Validate a tool call with the Veto Cloud API."""
        # Fast path: try client-side deterministic validation
        local_result = self._try_local_deterministic(context)
        if local_result is not None:
            if local_result.decision == "allow":
                self._logger.debug(
                    "Local deterministic validation allowed",
                    {"tool": context.tool_name, "latency_ms": local_result.latency_ms},
                )
                return ValidationResult(decision="allow", reason=local_result.reason)

            if self._should_apply_log_mode_override(context):
                if self._mode == "shadow":
                    return self._apply_shadow_mode_override(
                        context,
                        "deny",
                        local_result.reason,
                        {"source": "client"},
                    )

                self._logger.warn(
                    "Tool call would be blocked locally (log mode)",
                    {"tool": context.tool_name, "reason": local_result.reason},
                )
                return ValidationResult(
                    decision="allow",
                    reason=f"[LOG MODE] Would block: {local_result.reason}",
                    metadata={"blocked_in_strict_mode": True, "source": "client"},
                )

            self._logger.warn(
                "Tool call blocked by local deterministic validation",
                {"tool": context.tool_name, "reason": local_result.reason},
            )
            return ValidationResult(
                decision="deny",
                reason=local_result.reason,
                metadata={"source": "client"},
            )

        # Build context for cloud API
        api_context: dict[str, Any] = {
            "call_id": context.call_id,
            "timestamp": context.timestamp.isoformat(),
            "session_id": self._resolve_session_id(context),
            "agent_id": self._resolve_agent_id(context),
            "user_id": self._resolve_user_id(context),
            "role": self._resolve_role(context),
        }

        if context.custom:
            api_context["custom"] = context.custom

        try:
            response = await self._cloud_client.validate(
                tool_name=context.tool_name,
                arguments=context.arguments,
                context=api_context,
            )
        except Exception as exc:
            reason = str(exc)
            if self._should_apply_log_mode_override(context):
                self._logger.warn(
                    (
                        "Cloud unavailable (shadow mode, allowing)"
                        if self._mode == "shadow"
                        else "Cloud unavailable (log mode, allowing)"
                    ),
                    {"reason": reason},
                )
                return ValidationResult(
                    decision="allow",
                    reason=f"Cloud unavailable: {reason}",
                    metadata={"cloud_error": True},
                )
            self._logger.error(
                "Cloud unavailable (strict mode, blocking)",
                {"reason": reason},
            )
            return ValidationResult(
                decision="deny",
                reason=f"Cloud unavailable: {reason}",
                metadata={"cloud_error": True},
            )

        # Build metadata
        metadata: dict[str, Any] = {}
        if response.failed_constraints:
            metadata["failed_constraints"] = [
                {
                    "parameter": fc.parameter,
                    "constraint_type": fc.constraint_type,
                    "expected": fc.expected,
                    "actual": fc.actual,
                    "message": fc.message,
                }
                for fc in response.failed_constraints
            ]
        if response.metadata:
            metadata.update(response.metadata)
        if response.receipt:
            metadata["receipt"] = response.receipt

        if response.decision == "require_approval":
            approval_reason = response.reason or "Approval required"
            if response.denial:
                metadata["denial"] = response.denial
            metadata_with_approval = dict(metadata)
            if response.approval_id:
                metadata_with_approval["approval_id"] = response.approval_id
            rule_id = self._extract_metadata_string(
                metadata_with_approval, ["ruleId", "rule_id"]
            )

            if self._should_apply_log_mode_override(context):
                if self._mode == "shadow":
                    return self._apply_shadow_mode_override(
                        context,
                        "require_approval",
                        approval_reason,
                        metadata_with_approval if metadata_with_approval else None,
                        rule_id,
                    )

                self._logger.warn(
                    "Tool call would require approval (log mode)",
                    {
                        "tool": context.tool_name,
                        "reason": approval_reason,
                        "approval_id": response.approval_id,
                        "rule_id": rule_id,
                    },
                )
                return ValidationResult(
                    decision="allow",
                    reason=f"[LOG MODE] Would require approval: {approval_reason}",
                    metadata={
                        **metadata_with_approval,
                        "blocked_in_strict_mode": True,
                    },
                )

            if self._is_guard_evaluation(context):
                return ValidationResult(
                    decision="require_approval",
                    reason=approval_reason,
                    metadata=metadata_with_approval if metadata_with_approval else None,
                )

            if response.approval_id:
                # Check approval preference cache first
                cached_pref = self._approval_preferences.get(context.tool_name)
                if cached_pref == "approve_all":
                    self._logger.info(
                        "Auto-approved via cached preference",
                        {"tool": context.tool_name},
                    )
                    return ValidationResult(
                        decision="allow",
                        reason="Auto-approved (approve all preference)",
                        metadata=metadata if metadata else None,
                    )
                elif cached_pref == "deny_all":
                    self._logger.warn(
                        "Auto-denied via cached preference",
                        {"tool": context.tool_name},
                    )
                    return ValidationResult(
                        decision="deny",
                        reason="Auto-denied (deny all preference)",
                        metadata=metadata if metadata else None,
                    )

                self._logger.info(
                    "Awaiting human approval",
                    {"tool": context.tool_name, "approval_id": response.approval_id},
                )

                # Fire on_approval_required hook with full context
                if self._on_approval_required:
                    try:
                        hook_result = self._on_approval_required(
                            context,
                            response.approval_id,
                        )
                        if inspect.isawaitable(hook_result):
                            await hook_result
                    except Exception as hook_err:
                        self._logger.warn(
                            "on_approval_required hook error",
                            {"error": str(hook_err)},
                        )

                try:
                    approval_data = await self._cloud_client.poll_approval(
                        response.approval_id,
                        options=self._approval_poll_options,
                    )
                    if approval_data.status == "approved":
                        self._logger.info(
                            "Approval granted",
                            {
                                "tool": context.tool_name,
                                "approval_id": response.approval_id,
                            },
                        )
                        return ValidationResult(
                            decision="allow",
                            reason=f"Approved by human: {approval_data.resolved_by or 'unknown'}",
                            metadata=metadata if metadata else None,
                        )
                    else:
                        self._logger.warn(
                            "Approval denied or expired",
                            {"tool": context.tool_name, "status": approval_data.status},
                        )
                        return ValidationResult(
                            decision="deny",
                            reason=f"Approval {approval_data.status}: {approval_reason}",
                            metadata=metadata if metadata else None,
                        )
                except ApprovalTimeoutError:
                    self._logger.warn(
                        "Approval timed out",
                        {"tool": context.tool_name, "approval_id": response.approval_id},
                    )
                    return ValidationResult(
                        decision="deny",
                        reason="Approval timed out waiting for human review",
                        metadata=metadata if metadata else None,
                    )

        if response.decision == "allow":
            self._logger.debug(
                "Cloud allowed tool call",
                {"tool": context.tool_name},
            )
            return ValidationResult(
                decision="allow",
                reason=response.reason,
                metadata=metadata if metadata else None,
            )
        else:
            # Cloud returned deny decision
            if self._should_apply_log_mode_override(context):
                rule_id = self._extract_metadata_string(metadata, ["ruleId", "rule_id"])
                if self._mode == "shadow":
                    return self._apply_shadow_mode_override(
                        context,
                        "deny",
                        response.reason,
                        metadata if metadata else None,
                        rule_id,
                    )

                # Log mode: log the block but allow the call
                self._logger.warn(
                    "Tool call would be blocked (log mode)",
                    {
                        "tool": context.tool_name,
                        "reason": response.reason,
                        "failed_constraints": [
                            fc.message for fc in response.failed_constraints
                        ],
                    },
                )
                return ValidationResult(
                    decision="allow",
                    reason=f"[LOG MODE] Would block: {response.reason}",
                    metadata={**metadata, "blocked_in_strict_mode": True},
                )
            else:
                # Strict mode: actually block the call
                self._logger.warn(
                    "Tool call blocked",
                    {
                        "tool": context.tool_name,
                        "reason": response.reason,
                        "failed_constraints": [
                            fc.message for fc in response.failed_constraints
                        ],
                    },
                )
                if response.denial:
                    metadata["denial"] = response.denial
                return ValidationResult(
                    decision="deny",
                    reason=response.reason,
                    metadata=metadata if metadata else None,
                )

    def wrap(self, tools: list[T]) -> list[T]:
        """
        Wrap tools with Veto validation.

        This method:
        1. Extracts tool signatures and registers them with Veto Cloud (cloud mode only)
        2. Wraps each tool to intercept calls and validate against configured policies

        Args:
            tools: Array of tools to wrap (LangChain, custom, etc.)

        Returns:
            The same tools with Veto validation injected

        Example:
            >>> from langchain.tools import tool
            >>> from veto import Veto
            >>>
            >>> @tool
            >>> def search(query: str) -> str:
            ...     return f"Results for: {query}"
            >>>
            >>> veto = await Veto.init()
            >>> wrapped_tools = veto.wrap([search])
        """
        import asyncio

        # Register tools with cloud (fire and forget, don't block wrapping)
        if self._validation_mode == "cloud":
            try:
                asyncio.get_running_loop()
                asyncio.create_task(self._register_tools_with_cloud(tools))
            except RuntimeError:
                # No running event loop — run synchronously
                asyncio.run(self._register_tools_with_cloud(tools))

        return [self.wrap_tool(tool) for tool in tools]

    def wrap_tool(self, tool: T) -> T:
        """
        Wrap a single tool with Veto validation.

        Args:
            tool: The tool to wrap

        Returns:
            The same tool with Veto validation injected
        """
        tool_name = tool.name
        veto = self

        # CrewAI BaseTool integration
        if hasattr(tool, "_run") and callable(getattr(tool, "_run")):
            try:
                from crewai.tools import BaseTool as CrewAIBaseTool
            except ImportError:
                CrewAIBaseTool = None

            if CrewAIBaseTool is not None and isinstance(tool, CrewAIBaseTool):
                try:
                    from veto.integrations.crewai import wrap_crewai_tools

                    wrapped_tool = wrap_crewai_tools(veto, [tool])[0]
                    veto._logger.debug("CrewAI tool wrapped", {"name": tool_name})
                    return cast(T, wrapped_tool)
                except Exception:
                    pass

        # For LangChain tools, we need to wrap the 'func' property
        if hasattr(tool, "func") and callable(getattr(tool, "func")):
            original_func = getattr(tool, "func")

            async def wrapped_func(input_data: dict[str, Any]) -> Any:
                # Validate with Veto
                result = await veto.validate_tool_call(
                    ToolCall(
                        id=generate_tool_call_id(),
                        name=tool_name,
                        arguments=input_data,
                    )
                )

                if not result.allowed:
                    raise ToolCallDeniedError(
                        tool_name,
                        result.original_call.id or "",
                        result.validation_result,
                        self._extract_denial(result),
                    )

                # Execute the original function with potentially modified arguments
                final_args = result.final_arguments or input_data
                if inspect.iscoroutinefunction(original_func):
                    execution_result = await original_func(final_args)
                else:
                    execution_result = original_func(final_args)
                return veto._validate_output_or_throw(tool_name, execution_result)

            # Create a copy of the tool with the wrapped function
            try:
                import copy

                wrapped = copy.copy(tool)
                object.__setattr__(wrapped, "func", wrapped_func)

                # Also wrap ainvoke if it exists (LangChain async method)
                if hasattr(tool, "ainvoke"):
                    original_ainvoke = getattr(tool, "ainvoke")

                    async def wrapped_ainvoke(
                        input_data: dict[str, Any], *args: Any, **kwargs: Any
                    ) -> Any:
                        # LangGraph passes a ToolCall dict with args nested
                        if (
                            isinstance(input_data, dict)
                            and "args" in input_data
                            and "name" in input_data
                        ):
                            call_arguments = input_data["args"]
                        else:
                            call_arguments = input_data

                        # Validate with Veto first
                        result = await veto.validate_tool_call(
                            ToolCall(
                                id=generate_tool_call_id(),
                                name=tool_name,
                                arguments=call_arguments,
                            )
                        )

                        if not result.allowed:
                            raise ToolCallDeniedError(
                                tool_name,
                                result.original_call.id or "",
                                result.validation_result,
                                self._extract_denial(result),
                            )

                        # Call original ainvoke with the original input format
                        execution_result = await original_ainvoke(
                            input_data, *args, **kwargs
                        )
                        return veto._validate_output_or_throw(
                            tool_name, execution_result
                        )

                    object.__setattr__(wrapped, "ainvoke", wrapped_ainvoke)

                # Also wrap sync invoke if it exists
                if hasattr(tool, "invoke"):
                    original_invoke = getattr(tool, "invoke")

                    def wrapped_invoke(
                        input_data: dict[str, Any], *args: Any, **kwargs: Any
                    ) -> Any:
                        # For sync invoke, we run validation in a new event loop
                        import asyncio

                        async def validate_and_invoke() -> dict[str, Any]:
                            result = await veto.validate_tool_call(
                                ToolCall(
                                    id=generate_tool_call_id(),
                                    name=tool_name,
                                    arguments=input_data,
                                )
                            )

                            if not result.allowed:
                                raise ToolCallDeniedError(
                                    tool_name,
                                    result.original_call.id or "",
                                    result.validation_result,
                                    self._extract_denial(result),
                                )

                            return result.final_arguments or input_data

                        import concurrent.futures

                        try:
                            loop = asyncio.get_running_loop()
                        except RuntimeError:
                            loop = None

                        if loop is not None and loop.is_running():
                            # Inside a running async loop — run validation
                            # in a separate thread with its own event loop
                            with concurrent.futures.ThreadPoolExecutor(
                                max_workers=1
                            ) as pool:
                                final_args = pool.submit(
                                    asyncio.run, validate_and_invoke()
                                ).result()
                            execution_result = original_invoke(
                                final_args, *args, **kwargs
                            )
                            return veto._validate_output_or_throw(
                                tool_name, execution_result
                            )

                        # No running loop — use asyncio.run directly
                        final_args = asyncio.run(validate_and_invoke())
                        execution_result = original_invoke(
                            final_args, *args, **kwargs
                        )
                        return veto._validate_output_or_throw(
                            tool_name, execution_result
                        )

                    object.__setattr__(wrapped, "invoke", wrapped_invoke)

                veto._logger.debug("Tool wrapped", {"name": tool_name})
                return wrapped
            except Exception:
                pass

        # Fallback for other tool types (handler, run, execute, etc.)
        exec_function_keys = ["handler", "run", "execute", "call", "_call"]

        for key in exec_function_keys:
            if hasattr(tool, key) and callable(getattr(tool, key)):
                original_func = getattr(tool, key)

                def create_wrapper(orig: Any) -> Any:
                    async def wrapper(*args: Any, **kwargs: Any) -> Any:
                        if len(args) == 1 and isinstance(args[0], dict):
                            call_args = args[0]
                        elif kwargs:
                            call_args = kwargs
                        else:
                            call_args = {"args": args}

                        result = await veto.validate_tool_call(
                            ToolCall(
                                id=generate_tool_call_id(),
                                name=tool_name,
                                arguments=call_args,
                            )
                        )

                        if not result.allowed:
                            raise ToolCallDeniedError(
                                tool_name,
                                result.original_call.id or "",
                                result.validation_result,
                                self._extract_denial(result),
                            )

                        final_args = result.final_arguments or call_args
                        if len(args) == 1 and isinstance(args[0], dict):
                            if inspect.iscoroutinefunction(orig):
                                execution_result = await orig(final_args)
                            else:
                                execution_result = orig(final_args)
                            return veto._validate_output_or_throw(
                                tool_name, execution_result
                            )
                        if inspect.iscoroutinefunction(orig):
                            execution_result = await orig(*args, **kwargs)
                        else:
                            execution_result = orig(*args, **kwargs)
                        return veto._validate_output_or_throw(
                            tool_name, execution_result
                        )

                    return wrapper

                try:
                    import copy

                    wrapped = copy.copy(tool)
                    object.__setattr__(wrapped, key, create_wrapper(original_func))
                    veto._logger.debug("Tool wrapped", {"name": tool_name})
                    return wrapped
                except Exception:
                    pass

        # No wrappable function found, return as-is
        veto._logger.warn("No wrappable function found on tool", {"name": tool_name})
        return tool

    def wrap_mcp_tools(
        self,
        tools: list[MCPTool],
        server_client: Any,
    ) -> WrappedMCPTools:
        """Wrap MCP tools with Veto validation.

        The tool definitions are returned unchanged for the model. Use the
        returned ``call_tool`` coroutine instead of calling the MCP server
        directly; it validates arguments before forwarding and validates the
        server result before returning.
        """
        import asyncio

        tool_definitions = [from_mcp(tool) for tool in tools]

        if self._validation_mode == "cloud":
            try:
                asyncio.get_running_loop()
                asyncio.create_task(
                    self._register_tool_definitions_with_cloud(tool_definitions)
                )
            except RuntimeError:
                asyncio.run(self._register_tool_definitions_with_cloud(tool_definitions))

        async def call_tool(args: MCPToolCallArgs | dict[str, Any]) -> Any:
            if isinstance(args, dict):
                tool_name_raw = args.get("name")
                call_args_raw = args.get("arguments")
            else:
                tool_name_raw = args.name
                call_args_raw = args.arguments

            if not isinstance(tool_name_raw, str) or not tool_name_raw:
                raise ValueError("MCP tool call requires a non-empty name")
            call_args = call_args_raw if isinstance(call_args_raw, dict) else {}

            result = await self.validate_tool_call(
                ToolCall(
                    id=generate_tool_call_id(),
                    name=tool_name_raw,
                    arguments=call_args,
                )
            )

            if not result.allowed:
                raise ToolCallDeniedError(
                    tool_name_raw,
                    result.original_call.id or "",
                    result.validation_result,
                    self._extract_denial(result),
                )

            final_args = result.final_arguments or call_args
            mcp_call = MCPToolCallArgs(name=tool_name_raw, arguments=final_args)

            if hasattr(server_client, "call_tool") and callable(
                getattr(server_client, "call_tool")
            ):
                execution_result = server_client.call_tool(mcp_call)
            elif hasattr(server_client, "callTool") and callable(
                getattr(server_client, "callTool")
            ):
                execution_result = server_client.callTool(
                    {"name": tool_name_raw, "arguments": final_args}
                )
            else:
                raise ValueError("MCP server client must expose call_tool or callTool")

            if inspect.isawaitable(execution_result):
                execution_result = await execution_result

            return self._validate_output_or_throw(tool_name_raw, execution_result)

        self._logger.debug("MCP tools wrapped", {"count": len(tools)})
        return WrappedMCPTools(tools=tools, call_tool=call_tool)

    async def validate_tool_call(self, call: ToolCall) -> InterceptionResult:
        """Validate a tool call through the interceptor pipeline.

        Used internally by ``wrap()`` and by framework integrations
        (LangChain) to validate tool calls against configured rules
        and policies.
        """
        normalized_call = ToolCall(
            id=call.id or generate_tool_call_id(),
            name=call.name,
            arguments=call.arguments,
            raw_arguments=call.raw_arguments,
        )

        return await self._interceptor.intercept(normalized_call)

    def _extract_metadata_string(
        self, metadata: Optional[dict[str, Any]], keys: list[str]
    ) -> Optional[str]:
        if not metadata:
            return None

        for key in keys:
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                return value
            if isinstance(value, (int, float, bool)):
                return str(value)

        return None

    def _extract_metadata_severity(
        self, metadata: Optional[dict[str, Any]]
    ) -> Optional[GuardSeverity]:
        if not metadata:
            return None

        raw = (
            metadata.get("severity")
            or metadata.get("ruleSeverity")
            or metadata.get("rule_severity")
        )
        if not isinstance(raw, str):
            return None

        normalized = raw.strip().lower()
        if normalized == "critical":
            return "critical"
        if normalized == "high":
            return "high"
        if normalized == "medium":
            return "medium"
        if normalized == "low":
            return "low"
        if normalized == "info":
            return "info"

        return None

    def _is_budget_exceeded_result(self, result: ValidationResult) -> bool:
        metadata = result.metadata
        if not metadata:
            return False

        raw_flag = metadata.get("budgetExceeded", metadata.get("budget_exceeded"))
        if isinstance(raw_flag, bool):
            return raw_flag

        if isinstance(raw_flag, str):
            normalized_flag = raw_flag.strip().lower()
            if normalized_flag in ("true", "1", "budget_exceeded"):
                return True

        raw_event_type = metadata.get("eventType", metadata.get("event_type"))
        return isinstance(raw_event_type, str) and raw_event_type.strip().lower() == "budget_exceeded"

    def _resolve_decision_event_type(
        self, result: ValidationResult
    ) -> Optional[WebhookEventType]:
        if self._is_budget_exceeded_result(result):
            return "budget_exceeded"

        if result.decision == "deny":
            return "deny"

        if result.decision == "require_approval":
            return "require_approval"

        return None

    def _emit_decision_event(
        self,
        context: ValidationContext,
        result: ValidationResult,
        duration_ms: Optional[float] = None,
    ) -> None:
        # Stream the row for every decision (allow / deny / await) — independent
        # of the webhook event type filter below.
        if duration_ms is not None:
            self._stream_decision_row(context, result, duration_ms)

        event_type = self._resolve_decision_event_type(result)
        if event_type is None:
            return

        severity = self._extract_metadata_severity(result.metadata)
        if event_type == "budget_exceeded" and severity is None:
            severity = "high"

        self._event_webhook_emitter.emit(
            WebhookEvent(
                event_type=event_type,
                tool_name=context.tool_name,
                arguments=context.arguments,
                decision=result.decision,
                reason=result.reason,
                rule_id=self._extract_metadata_string(
                    result.metadata, ["ruleId", "rule_id"]
                ),
                severity=severity,
                timestamp=context.timestamp.isoformat(),
                shadow=True if self._mode == "shadow" else None,
            )
        )

    def _stream_decision_row(
        self,
        context: ValidationContext,
        result: ValidationResult,
        duration_ms: float,
    ) -> None:
        """
        Emit a one-line decision row to the active stream logger (when configured
        via ``log_level='stream'`` or ``VETO_LOG=stream``). Fires for every
        decision — allow, deny, and require_approval — so developers see the
        full audit trail inline in their terminal.
        """
        if not is_decision_stream_logger(self._logger):
            return

        decision: DecisionStreamDecision = (
            "await"
            if result.decision == "require_approval"
            else "deny"
            if result.decision == "deny"
            else "allow"
        )

        rule_id = self._extract_metadata_string(
            result.metadata, ["ruleId", "rule_id"]
        )
        approval_id = self._extract_metadata_string(
            result.metadata, ["approvalId", "approval_id"]
        )
        approver = (
            self._extract_metadata_string(
                result.metadata,
                ["approver", "approverEmail", "approver_email"],
            )
            if decision == "allow"
            else None
        )

        event = DecisionStreamEvent(
            decision=decision,
            tool_name=context.tool_name,
            arguments=context.arguments,
            reason=result.reason,
            rule_id=rule_id,
            latency_ms=None if decision == "await" else duration_ms,
            approval_id=approval_id,
            approver=approver,
            timestamp=context.timestamp,
        )

        try:
            self._logger.stream_decision(event)  # type: ignore[attr-defined]
        except Exception:
            # Stream logging must never break the guard flow.
            pass

    @staticmethod
    def _extract_denial(result: InterceptionResult) -> Optional[DenialDetails]:
        """Extract DenialDetails from an interception result's metadata."""
        raw = (
            result.validation_result.metadata.get("denial")
            if result.validation_result.metadata
            else None
        )
        if raw is None:
            return None
        if isinstance(raw, DenialDetails):
            return raw
        if isinstance(raw, dict):
            return DenialDetails(
                severity=raw.get("severity"),
                suggested_fixes=raw.get("suggestedFixes", []),
                policy_id=raw.get("policyId"),
                policy_name=raw.get("policyName"),
                matched_condition=raw.get("matchedCondition"),
                docs_url=raw.get("docsUrl"),
                input=raw.get("input"),
            )
        return DenialDetails(
            severity=getattr(raw, "severity", None),
            suggested_fixes=getattr(raw, "suggested_fixes", []),
            policy_id=getattr(raw, "policy_id", None),
            policy_name=getattr(raw, "policy_name", None),
            matched_condition=getattr(raw, "matched_condition", None),
            docs_url=getattr(raw, "docs_url", None),
            input=getattr(raw, "input", None),
        )

    @staticmethod
    def _economic_metadata(
        denial: Optional[EconomicDenialDetails],
    ) -> dict[str, Any]:
        if denial is None:
            return {"source": "economic"}

        metadata: dict[str, Any] = {
            "source": "economic",
            "economic_denial": denial.to_dict(),
            "economicDenial": denial.to_dict(),
            "economic_denial_reason": denial.reason,
            "severity": "high" if denial.reason == "budget_exceeded" else "medium",
        }
        if denial.reason == "budget_exceeded":
            metadata["budget_exceeded"] = True
            metadata["event_type"] = "budget_exceeded"
        return metadata

    @staticmethod
    def _normalize_economic_context(
        economic: EconomicContext | Mapping[str, Any],
    ) -> EconomicContext:
        if isinstance(economic, EconomicContext):
            return economic
        return EconomicContext.from_mapping(economic)

    def _economic_result_to_guard_result(
        self,
        econ_result: Any,
    ) -> GuardResult:
        decision: Literal["allow", "deny", "require_approval"] = (
            "allow" if self._mode == "shadow" else econ_result.decision
        )
        return GuardResult(
            decision=decision,
            reason=(
                f"Economic: {econ_result.denial.reason}"
                if econ_result.denial is not None
                else "Economic authorization denied"
            ),
            shadow=True if self._mode == "shadow" else None,
            shadow_decision=econ_result.decision if self._mode == "shadow" else None,
            economic_denial=econ_result.denial,
        )

    def _to_guard_result(self, result: ValidationResult) -> GuardResult:
        decision: Literal["allow", "deny", "require_approval"] = "allow"
        if result.decision == "deny":
            decision = "deny"
        elif result.decision == "require_approval":
            decision = "require_approval"

        metadata = result.metadata
        economic_denial = None
        if metadata:
            raw_denial = metadata.get("economic_denial") or metadata.get("economicDenial")
            if isinstance(raw_denial, EconomicDenialDetails):
                economic_denial = raw_denial
            elif isinstance(raw_denial, dict) and isinstance(raw_denial.get("reason"), str):
                economic_denial = EconomicDenialDetails(
                    reason=raw_denial["reason"],
                    cost=float(raw_denial.get("cost", 0)),
                    currency=str(raw_denial.get("currency", "USD")),
                    budget_scope=str(raw_denial.get("budget_scope", "session")),
                    budget_limit=float(raw_denial.get("budget_limit", 0)),
                    budget_spent=float(raw_denial.get("budget_spent", 0)),
                    budget_remaining=float(raw_denial.get("budget_remaining", 0)),
                    approval_threshold=raw_denial.get("approval_threshold")
                    if isinstance(raw_denial.get("approval_threshold"), (int, float))
                    else None,
                    payer=raw_denial.get("payer")
                    if isinstance(raw_denial.get("payer"), str)
                    else None,
                    protocol=raw_denial.get("protocol")
                    if isinstance(raw_denial.get("protocol"), str)
                    else None,
                    message=raw_denial.get("message")
                    if isinstance(raw_denial.get("message"), str)
                    else None,
                    connector_name=raw_denial.get("connector_name")
                    if isinstance(raw_denial.get("connector_name"), str)
                    else None,
                    raw_error=raw_denial.get("raw_error")
                    if isinstance(raw_denial.get("raw_error"), str)
                    else None,
                )
        receipt = self._receipt_summary_from_metadata(metadata)
        return GuardResult(
            decision=decision,
            reason=result.reason,
            rule_id=self._extract_metadata_string(metadata, ["ruleId", "rule_id"]),
            severity=self._extract_metadata_severity(metadata),
            approval_id=self._extract_metadata_string(
                metadata, ["approvalId", "approval_id"]
            ),
            shadow=True if self._mode == "shadow" else None,
            shadow_decision=decision if self._mode == "shadow" and decision != "allow" else None,
            economic_denial=economic_denial,
            receipt=receipt,
        )

    def _receipt_summary_from_metadata(
        self,
        metadata: Optional[dict[str, Any]],
    ) -> Optional[ReceiptSummary]:
        if not metadata:
            return None
        raw = metadata.get("receipt")
        if isinstance(raw, ReceiptSummary):
            return raw
        if isinstance(raw, dict):
            try:
                return ReceiptSummary(
                    receipt_id=str(raw["receipt_id"]),
                    receipt_hash=str(raw["receipt_hash"]),
                    previous_receipt_hash=str(raw["previous_receipt_hash"]),
                    merkle_root=str(raw["merkle_root"]),
                )
            except Exception:
                return None
        return None

    def _build_receipt_policy_hash(
        self,
        context: ValidationContext,
        metadata: Optional[dict[str, Any]],
        policy_version: str,
    ) -> str:
        raw = self._extract_metadata_string(metadata, ["policyHash", "policy_hash"])
        if raw and raw.startswith("sha256:"):
            return raw
        return hash_canonical(
            {
                "policy_hash": raw,
                "policy_version": policy_version,
                "rules": self._get_rules_for_tool(context.tool_name),
            }
        )

    def _append_receipt_for_context(
        self,
        context: ValidationContext,
        result: ValidationResult,
    ) -> Optional[ReceiptSummary]:
        if self._receipt_store is None:
            return None

        decision: Literal["allow", "deny", "require_approval"]
        if result.decision == "deny":
            decision = "deny"
        elif result.decision == "require_approval":
            decision = "require_approval"
        else:
            decision = "allow"

        metadata = result.metadata or {}
        policy_version = (
            self._extract_metadata_string(metadata, ["policyVersion", "policy_version"])
            or "1.0"
        )
        receipt = build_decision_receipt(
            tool_name=context.tool_name,
            arguments=context.arguments,
            decision=decision,
            reason=result.reason,
            approval_id=self._extract_metadata_string(metadata, ["approvalId", "approval_id"]),
            session_id=self._resolve_session_id(context),
            agent_id=self._resolve_agent_id(context),
            policy_version=policy_version,
            policy_hash=self._build_receipt_policy_hash(context, metadata, policy_version),
            previous_receipt=load_last_receipt(self._receipt_store),
        )
        append_receipt(self._receipt_store, receipt)
        return receipt_summary(receipt)

    async def guard(
        self,
        tool_name: str,
        args: dict[str, Any],
        *,
        session_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        role: Optional[str] = None,
        custom: Optional[dict[str, Any]] = None,
        market: Optional[dict[str, Any]] = None,
        budget: Optional[dict[str, Any]] = None,
        portfolio: Optional[dict[str, Any]] = None,
        economic: Optional[EconomicContext | Mapping[str, Any]] = None,
    ) -> GuardResult:
        """Run a standalone guard check without wrapping or executing a tool."""
        explicit_economic_context: Optional[EconomicContext] = None
        implicit_economic_context: Optional[EconomicContext] = None

        if self._economic_evaluator is not None and economic is not None:
            explicit_economic_context = self._normalize_economic_context(economic)
            econ_result = self._economic_evaluator.evaluate(explicit_economic_context)
            if econ_result.decision != "allow":
                guard_result = self._economic_result_to_guard_result(econ_result)
                self._history_tracker.record(
                    tool_name,
                    args,
                    ValidationResult(
                        decision=guard_result.decision,
                        reason=guard_result.reason,
                        metadata=self._economic_metadata(econ_result.denial),
                    ),
                    None,
                )
                return guard_result

        if self._economic_evaluator is not None and explicit_economic_context is None:
            resolved_cost = self._economic_evaluator.resolve_cost(tool_name, args)
            if resolved_cost is not None and resolved_cost > 0:
                implicit_economic_context = EconomicContext(
                    cost=resolved_cost,
                    currency="USD",
                    protocol="custom",
                )
                econ_result = self._economic_evaluator.evaluate(
                    implicit_economic_context
                )
                if econ_result.decision != "allow":
                    guard_result = self._economic_result_to_guard_result(econ_result)
                    self._history_tracker.record(
                        tool_name,
                        args,
                        ValidationResult(
                            decision=guard_result.decision,
                            reason=guard_result.reason,
                            metadata=self._economic_metadata(econ_result.denial),
                        ),
                        None,
                    )
                    return guard_result

        custom_context: dict[str, Any] = dict(custom or {})
        if market is not None:
            custom_context["market"] = market
        if budget is not None:
            custom_context["budget"] = budget
        if portfolio is not None:
            custom_context["portfolio"] = portfolio

        context = ValidationContext(
            tool_name=tool_name,
            arguments=args,
            call_id=generate_tool_call_id(),
            timestamp=datetime.now(),
            call_history=self._history_tracker.get_all(),
            session_id=session_id if session_id is not None else self._session_id,
            agent_id=agent_id if agent_id is not None else self._agent_id,
            user_id=user_id if user_id is not None else self._user_id,
            role=role if role is not None else self._role,
            source="guard",
            custom=custom_context if custom_context else None,
        )

        aggregated_result = await self._validation_engine.validate(context)
        validation_result = aggregated_result.final_result
        behavioral_result = self._to_guard_result(validation_result)

        effective_economic_context = explicit_economic_context or implicit_economic_context
        if (
            behavioral_result.decision == "allow"
            and self._economic_evaluator is not None
            and effective_economic_context is not None
            and effective_economic_context.cost > 0
            and self._mode != "shadow"
        ):
            reserve_result = self._economic_evaluator.reserve_budget(
                effective_economic_context.cost,
                effective_economic_context.currency,
            )
            if reserve_result.decision != "allow":
                validation_result = ValidationResult(
                    decision=reserve_result.decision,
                    reason=(
                        f"Economic: {reserve_result.denial.reason}"
                        if reserve_result.denial is not None
                        else "Budget reservation failed"
                    ),
                    metadata=self._economic_metadata(reserve_result.denial),
                )
                self._history_tracker.record(
                    tool_name,
                    args,
                    validation_result,
                    aggregated_result.total_duration_ms,
                )
                self._emit_decision_event(
                    context,
                    validation_result,
                    aggregated_result.total_duration_ms,
                )
                guard_result = self._to_guard_result(validation_result)
                guard_result.receipt = (
                    guard_result.receipt
                    or self._append_receipt_for_context(context, validation_result)
                )
                return guard_result

        behavioral_result.receipt = (
            behavioral_result.receipt
            or self._append_receipt_for_context(context, validation_result)
        )
        self._history_tracker.record(
            tool_name,
            args,
            validation_result,
            aggregated_result.total_duration_ms,
        )

        self._emit_decision_event(
            context,
            validation_result,
            aggregated_result.total_duration_ms,
        )

        return behavioral_result

    async def validate(
        self,
        tool_name: str | Mapping[str, Any],
        arguments: Optional[dict[str, Any]] = None,
        **context: Any,
    ) -> DecisionOutcome:
        """Validate one tool call and return the CLI/SDK decision envelope."""
        if isinstance(tool_name, Mapping):
            payload = dict(tool_name)
            raw_tool_name = payload.get("toolName") or payload.get("tool_name")
            raw_arguments = payload.get("arguments")
            if raw_arguments is None:
                raw_arguments = payload.get("args")
            raw_context = payload.get("context")
            if isinstance(raw_context, Mapping):
                context = {**dict(raw_context), **context}
            if not isinstance(raw_tool_name, str) or raw_tool_name == "":
                raise ValueError("validate() requires toolName/tool_name")
            if not isinstance(raw_arguments, dict):
                raise ValueError("validate() requires arguments")
            resolved_tool_name = raw_tool_name
            resolved_arguments = raw_arguments
        else:
            if arguments is None:
                raise ValueError("validate() requires arguments")
            resolved_tool_name = tool_name
            resolved_arguments = arguments

        custom_context = context.get("custom")
        if custom_context is not None and not isinstance(custom_context, dict):
            raise ValueError("custom context must be a dict")

        result = await self.guard(
            resolved_tool_name,
            resolved_arguments,
            session_id=context.get("session_id") or context.get("sessionId"),
            agent_id=context.get("agent_id") or context.get("agentId"),
            user_id=context.get("user_id") or context.get("userId"),
            role=context.get("role"),
            custom=custom_context,
        )
        return DecisionOutcome(
            decision=result.decision,
            mode=self._validation_mode,
            reason=result.reason,
            approval_id=result.approval_id,
            receipt=result.receipt,
        )

    async def export_receipts(
        self,
        *,
        project_id: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        cursor: Optional[str | int] = None,
        limit: Optional[int] = None,
    ) -> str:
        """Export cloud receipts as canonical NDJSON."""
        return await self._cloud_client.export_receipts(
            project_id=project_id,
            start_date=start_date,
            end_date=end_date,
            cursor=cursor,
            limit=limit,
        )

    def set_approval_preference(self, tool_name: str, preference: str) -> None:
        """
        Cache an approval preference for a tool.

        When set, subsequent require_approval decisions for this tool
        are auto-resolved from the cache without polling the server.

        Args:
            tool_name: The tool to set the preference for
            preference: "approve_all" or "deny_all"
        """
        if preference not in ("approve_all", "deny_all"):
            raise ValueError(
                f"Invalid preference: {preference}. Use 'approve_all' or 'deny_all'."
            )
        self._approval_preferences[tool_name] = preference
        self._logger.info(
            "Approval preference set",
            {"tool": tool_name, "preference": preference},
        )

    def clear_approval_preferences(self, tool_name: Optional[str] = None) -> None:
        """
        Clear cached approval preferences.

        Args:
            tool_name: If provided, clear only for this tool. Otherwise clear all.
        """
        if tool_name:
            self._approval_preferences.pop(tool_name, None)
        else:
            self._approval_preferences.clear()

    def get_approval_preference(self, tool_name: str) -> Optional[str]:
        """Get the cached approval preference for a tool, if any."""
        return self._approval_preferences.get(tool_name)

    def get_history_stats(self) -> HistoryStats:
        """Get history statistics."""
        return self._history_tracker.get_stats()

    def export_decisions(self, format: DecisionExportFormat = "json") -> str:
        """Export decision history as JSON or CSV."""
        return self._history_tracker.export_decisions(format)

    def clear_history(self) -> None:
        """Clear call history."""
        self._history_tracker.clear()

    def get_economic_budget_status(
        self,
        scope: BudgetScope = "session",
    ) -> Optional[EconomicBudgetStatus]:
        """Return current economic budget status for a scope, if configured."""
        if self._economic_budget_engine is None:
            return None
        return self._economic_budget_engine.get_status(scope)

    def getEconomicBudgetStatus(
        self,
        scope: BudgetScope = "session",
    ) -> Optional[EconomicBudgetStatus]:
        """TypeScript-style alias."""
        return self.get_economic_budget_status(scope)

    def reset_economic_budget(self, scope: BudgetScope = "session") -> None:
        """Reset economic budget state for a scope."""
        if self._economic_budget_engine is not None:
            self._economic_budget_engine.reset(scope)

    def resetEconomicBudget(self, scope: BudgetScope = "session") -> None:
        """TypeScript-style alias."""
        self.reset_economic_budget(scope)


# Re-export error class
__all__ = [
    "Veto",
    "ToolCallDeniedError",
    "GuardResult",
    "VetoOptions",
    "VetoMode",
    "ValidationMode",
    "WrappedTools",
    "WrappedMCPTools",
    "WrappedHandler",
]
