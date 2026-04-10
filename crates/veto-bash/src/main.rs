use anyhow::{anyhow, Context, Result};
use regex::Regex;
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, IsTerminal, Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const DEFAULT_API_URL: &str = "https://api.veto.so";
const TOOL_NAME: &str = "bash";
const POLICY_FRESH_MS: u64 = 60_000;
const POLICY_MAX_MS: u64 = 300_000;
const APPROVAL_POLL_INTERVAL_MS: u64 = 2_000;
const APPROVAL_TIMEOUT_MS: u64 = 300_000;
const DECISION_CACHE_PATH: &str = ".veto/cache/veto-bash-decisions.json";
const POLICY_CACHE_PATH: &str = ".veto/cache/veto-bash-policies.json";
const AUDIT_SPOOL_PATH: &str = ".veto/audit/veto-bash-spool.jsonl";
const API_KEY_NAMESPACE_SALT: &str = "veto-bash-cache-namespace:v1";
const DEFAULT_POLICY_REFRESH_COOLDOWN_MS: u64 = 5_000;
const FILE_LOCK_TIMEOUT_MS: u64 = 5_000;
const FILE_LOCK_STALE_MS: u64 = 30_000;

#[derive(Clone, Debug)]
struct WrapperOptions {
    api_key: Option<String>,
    api_url: String,
    cache_ttl_seconds: u64,
    offline: bool,
}

#[derive(Clone, Debug)]
struct ParsedWrapperArgs {
    options: WrapperOptions,
    bash_argv: Vec<String>,
}

#[derive(Clone, Debug)]
enum Invocation {
    Interactive {
        bash_argv: Vec<String>,
    },
    Command {
        bash_argv: Vec<String>,
        command: String,
    },
    ScriptFile {
        bash_argv: Vec<String>,
        command: String,
        script_path: String,
    },
    Stdin {
        bash_argv: Vec<String>,
        command: String,
        stdin_text: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ValidationArgs {
    command: String,
    cwd: String,
    argv: Vec<String>,
    #[serde(rename = "shellMode")]
    shell_mode: String,
    #[serde(rename = "scriptPath", skip_serializing_if = "Option::is_none")]
    script_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stdin: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
struct ValidationContext {
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    cwd: String,
    #[serde(rename = "shellMode")]
    shell_mode: String,
    #[serde(rename = "bashArgv")]
    bash_argv: Vec<String>,
    #[serde(rename = "scriptPath", skip_serializing_if = "Option::is_none")]
    script_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DenialDetails {
    #[serde(rename = "policyId", default)]
    policy_id: Option<String>,
    #[serde(rename = "policyName", default)]
    policy_name: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(rename = "matchedCondition", default)]
    matched_condition: Option<String>,
    #[serde(rename = "suggestedFixes", default)]
    suggested_fixes: Vec<String>,
    #[serde(rename = "docsUrl", default)]
    docs_url: Option<String>,
    #[serde(default)]
    input: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TerminalDecision {
    decision: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    denial: Option<DenialDetails>,
    source: String,
    #[serde(default, rename = "fromApprovalFlow")]
    from_approval_flow: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedDecision {
    decision: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    denial: Option<DenialDetails>,
    source: String,
    #[serde(default, rename = "fromApprovalFlow")]
    from_approval_flow: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DecisionCacheEntry {
    #[serde(rename = "expiresAtMs")]
    expires_at_ms: u64,
    value: CachedDecision,
}

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
struct DecisionCacheStore {
    #[serde(default)]
    entries: HashMap<String, DecisionCacheEntry>,
}

#[derive(Clone, Debug, Serialize)]
struct PolicyConstraint {
    #[serde(rename = "argumentName")]
    argument_name: String,
    enabled: bool,
    #[serde(default)]
    action: Option<String>,
    #[serde(rename = "greaterThan", default)]
    greater_than: Option<f64>,
    #[serde(rename = "lessThan", default)]
    less_than: Option<f64>,
    #[serde(rename = "greaterThanOrEqual", default)]
    greater_than_or_equal: Option<f64>,
    #[serde(rename = "lessThanOrEqual", default)]
    less_than_or_equal: Option<f64>,
    #[serde(default)]
    minimum: Option<f64>,
    #[serde(default)]
    maximum: Option<f64>,
    #[serde(rename = "minLength", default)]
    min_length: Option<usize>,
    #[serde(rename = "maxLength", default)]
    max_length: Option<usize>,
    #[serde(default)]
    regex: Option<String>,
    #[serde(default)]
    enum_values: Option<Vec<String>>,
    #[serde(rename = "enum", skip_deserializing)]
    _enum_alias: Option<Vec<String>>,
    #[serde(rename = "in", default)]
    in_values: Option<Vec<Value>>,
    #[serde(rename = "notIn", default)]
    not_in_values: Option<Vec<Value>>,
    #[serde(rename = "minItems", default)]
    min_items: Option<usize>,
    #[serde(rename = "maxItems", default)]
    max_items: Option<usize>,
    #[serde(default)]
    required: Option<bool>,
    #[serde(rename = "notNull", default)]
    not_null: Option<bool>,
    #[serde(rename = "dynamicMinimum", default)]
    dynamic_minimum: Option<String>,
    #[serde(rename = "dynamicMaximum", default)]
    dynamic_maximum: Option<String>,
}

impl<'de> Deserialize<'de> for PolicyConstraint {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawPolicyConstraint {
            #[serde(rename = "argumentName")]
            argument_name: String,
            enabled: bool,
            #[serde(default)]
            action: Option<String>,
            #[serde(rename = "greaterThan", default)]
            greater_than: Option<f64>,
            #[serde(rename = "lessThan", default)]
            less_than: Option<f64>,
            #[serde(rename = "greaterThanOrEqual", default)]
            greater_than_or_equal: Option<f64>,
            #[serde(rename = "lessThanOrEqual", default)]
            less_than_or_equal: Option<f64>,
            #[serde(default)]
            minimum: Option<f64>,
            #[serde(default)]
            maximum: Option<f64>,
            #[serde(rename = "minLength", default)]
            min_length: Option<usize>,
            #[serde(rename = "maxLength", default)]
            max_length: Option<usize>,
            #[serde(default)]
            regex: Option<String>,
            #[serde(rename = "enum", default)]
            enum_values: Option<Vec<String>>,
            #[serde(rename = "in", default)]
            in_values: Option<Vec<Value>>,
            #[serde(rename = "notIn", default)]
            not_in_values: Option<Vec<Value>>,
            #[serde(rename = "minItems", default)]
            min_items: Option<usize>,
            #[serde(rename = "maxItems", default)]
            max_items: Option<usize>,
            #[serde(default)]
            required: Option<bool>,
            #[serde(rename = "notNull", default)]
            not_null: Option<bool>,
            #[serde(rename = "dynamicMinimum", default)]
            dynamic_minimum: Option<String>,
            #[serde(rename = "dynamicMaximum", default)]
            dynamic_maximum: Option<String>,
        }

        let raw = RawPolicyConstraint::deserialize(deserializer)?;
        Ok(Self {
            argument_name: raw.argument_name,
            enabled: raw.enabled,
            action: raw.action,
            greater_than: raw.greater_than,
            less_than: raw.less_than,
            greater_than_or_equal: raw.greater_than_or_equal,
            less_than_or_equal: raw.less_than_or_equal,
            minimum: raw.minimum,
            maximum: raw.maximum,
            min_length: raw.min_length,
            max_length: raw.max_length,
            regex: raw.regex,
            enum_values: raw.enum_values,
            _enum_alias: None,
            in_values: raw.in_values,
            not_in_values: raw.not_in_values,
            min_items: raw.min_items,
            max_items: raw.max_items,
            required: raw.required,
            not_null: raw.not_null,
            dynamic_minimum: raw.dynamic_minimum,
            dynamic_maximum: raw.dynamic_maximum,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CloudPolicy {
    #[serde(rename = "toolName")]
    tool_name: String,
    mode: String,
    #[serde(default)]
    constraints: Vec<PolicyConstraint>,
    version: i64,
    #[serde(rename = "sessionConstraints", default)]
    session_constraints: Option<Value>,
    #[serde(rename = "rateLimits", default)]
    rate_limits: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PolicyCacheEntry {
    policy: CloudPolicy,
    #[serde(rename = "staleAtMs")]
    stale_at_ms: u64,
    #[serde(rename = "expiredAtMs")]
    expired_at_ms: u64,
}

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
struct PolicyCacheStore {
    #[serde(default)]
    entries: HashMap<String, PolicyCacheEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CacheKeyInput {
    #[serde(rename = "requestedMode")]
    requested_mode: String,
    #[serde(rename = "apiUrl", skip_serializing_if = "Option::is_none")]
    api_url: Option<String>,
    #[serde(rename = "apiKeyNamespace", skip_serializing_if = "Option::is_none")]
    api_key_namespace: Option<String>,
    command: String,
    cwd: String,
    #[serde(rename = "bashArgv")]
    bash_argv: Vec<String>,
    #[serde(rename = "shellMode")]
    shell_mode: String,
    #[serde(rename = "scriptPath", skip_serializing_if = "Option::is_none")]
    script_path: Option<String>,
    #[serde(rename = "vetoDir", skip_serializing_if = "Option::is_none")]
    veto_dir: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PolicyCacheKey {
    #[serde(rename = "apiUrl")]
    api_url: String,
    #[serde(rename = "apiKeyNamespace")]
    api_key_namespace: String,
    #[serde(rename = "toolName")]
    tool_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ValidateResponse {
    decision: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(rename = "approval_id", default)]
    approval_id: Option<String>,
    #[serde(default)]
    denial: Option<DenialDetails>,
    #[serde(default)]
    metadata: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ApprovalRecord {
    id: String,
    status: String,
    #[serde(rename = "toolName", default)]
    tool_name: Option<String>,
    #[serde(default)]
    arguments: Option<Value>,
    #[serde(rename = "expiresAt", default)]
    expires_at: Option<String>,
    #[serde(rename = "resolvedBy", default)]
    resolved_by: Option<String>,
    #[serde(rename = "resolvedAt", default)]
    resolved_at: Option<String>,
    #[serde(rename = "createdAt", default)]
    created_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LocalConfigFile {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    rules: Option<RulesConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RulesConfig {
    #[serde(default)]
    directory: Option<String>,
    #[serde(default)]
    recursive: Option<bool>,
}

#[derive(Clone, Debug)]
struct LocalProject {
    veto_dir: PathBuf,
    rules_dir: PathBuf,
    recursive: bool,
}

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
struct LocalRuleFile {
    #[serde(default)]
    rules: Vec<LocalRule>,
    #[serde(default)]
    extends: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LocalRule {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    action: String,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    conditions: Vec<LocalCondition>,
    #[serde(rename = "condition_groups", default)]
    condition_groups: Vec<Vec<LocalCondition>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LocalCondition {
    field: String,
    operator: String,
    value: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AuditEvent {
    #[serde(rename = "timestampMs")]
    timestamp_ms: u64,
    source: String,
    decision: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(rename = "toolName")]
    tool_name: String,
    arguments: Value,
    #[serde(rename = "apiUrl", default)]
    api_url: Option<String>,
    #[serde(rename = "apiKeyNamespace", default)]
    api_key_namespace: Option<String>,
    #[serde(rename = "forwardRequest", default)]
    forward_request: Option<LogDecisionRequest>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LogDecisionRequest {
    tool_name: String,
    arguments: Value,
    decision: String,
    #[serde(default)]
    reason: Option<String>,
    mode: String,
    latency_ms: u64,
    source: String,
    #[serde(default)]
    context: Option<Value>,
}

#[derive(Clone, Debug)]
struct CaptureExecutionResult {
    status_code: i32,
    stdout: String,
    stderr: String,
}

fn default_true() -> bool {
    true
}

fn main() -> Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("mcp") => run_mcp_command(&args[1..]),
        Some("__refresh-policy") => run_internal_refresh_policy(&args[1..]),
        Some("__flush-audit") => run_internal_flush_audit(&args[1..]),
        _ => run_wrapper_command(args),
    }
}

fn run_wrapper_command(args: Vec<String>) -> Result<()> {
    let parsed = parse_wrapper_args(&args)?;
    let cwd = env::current_dir().context("Failed to determine current working directory")?;
    let invocation = resolve_invocation(&parsed.bash_argv, &cwd, true)?;
    let result =
        execute_guarded_bash(invocation, &parsed.options, cwd, ExecutionMode::Passthrough)?;
    exit_with_result(result)
}

fn run_mcp_command(args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("serve") => run_mcp_serve(&args[1..]),
        Some("init") => run_mcp_init(&args[1..]),
        Some(other) => Err(anyhow!("Unknown mcp subcommand: {other}")),
        None => Err(anyhow!("Usage: veto-bash mcp <serve|init>")),
    }
}

fn run_mcp_init(args: &[String]) -> Result<()> {
    let mut output_path: Option<PathBuf> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--output" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| anyhow!("Missing value for --output"))?;
                output_path = Some(PathBuf::from(value));
                index += 2;
            }
            other => return Err(anyhow!("Unknown mcp init flag: {other}")),
        }
    }

    let generic = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "veto-bash": {
                "command": "veto-bash",
                "args": ["mcp", "serve", "--veto-api-key", "${VETO_API_KEY}"],
                "env": {
                    "VETO_BASH_REAL_BASH": "/bin/bash"
                }
            }
        }
    }))?;

    let claude_code = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "veto-bash": {
                "command": "veto-bash",
                "args": ["mcp", "serve", "--veto-api-key", "${VETO_API_KEY}"],
                "env": {
                    "VETO_BASH_REAL_BASH": "/bin/bash"
                }
            }
        }
    }))?;

    let rendered = format!(
        "# generic MCP JSON\n{}\n\n# Claude Code MCP JSON\n{}\n",
        generic, claude_code,
    );

    if let Some(path) = output_path {
        fs::write(&path, rendered.as_bytes())
            .with_context(|| format!("Failed to write {}", path.display()))?;
        println!("Wrote MCP setup snippets to {}", path.display());
    } else {
        print!("{}", rendered);
    }

    Ok(())
}

fn run_mcp_serve(args: &[String]) -> Result<()> {
    let parsed = parse_wrapper_args(args)?;
    let current_dir =
        env::current_dir().context("Failed to determine current working directory")?;
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = stdout.lock();

    loop {
        let Some(message) = read_mcp_message(&mut reader)? else {
            break;
        };

        let id = message.get("id").cloned();
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();

        match method {
            "initialize" => {
                if let Some(id) = id {
                    write_mcp_message(
                        &mut writer,
                        &json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "protocolVersion": "2024-11-05",
                                "capabilities": { "tools": { "listChanged": false } },
                                "serverInfo": { "name": "veto-bash", "version": "0.1.0" }
                            }
                        }),
                    )?;
                }
            }
            "notifications/initialized" => {}
            "ping" => {
                if let Some(id) = id {
                    write_mcp_message(
                        &mut writer,
                        &json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                    )?;
                }
            }
            "tools/list" => {
                if let Some(id) = id {
                    write_mcp_message(
                        &mut writer,
                        &json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "tools": [{
                                    "name": "bash_exec",
                                    "description": "Execute guarded bash argv through the Veto Bash runtime. Pass bash argv without the executable, for example ['-lc', 'echo hello'] or ['script.sh']. Interactive shells are rejected in MCP mode.",
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {
                                            "argv": { "type": "array", "items": { "type": "string" } },
                                            "cwd": { "type": "string" },
                                            "stdin": { "type": "string" }
                                        },
                                        "required": ["argv"]
                                    }
                                }]
                            }
                        }),
                    )?;
                }
            }
            "tools/call" => {
                if let Some(id) = id {
                    let payload = match handle_mcp_tools_call(&message, &id, &parsed, &current_dir)
                    {
                        Ok(payload) => payload,
                        Err(McpCallError::InvalidRequest(message)) => {
                            mcp_error_response(id.clone(), -32602, &message)
                        }
                        Err(McpCallError::ToolFailure(message)) => {
                            mcp_error_response(id.clone(), -32000, &message)
                        }
                    };
                    write_mcp_message(&mut writer, &payload)?;
                }
            }
            _ => {
                if let Some(id) = id {
                    write_mcp_message(
                        &mut writer,
                        &json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32601, "message": format!("Unsupported method: {method}") }
                        }),
                    )?;
                }
            }
        }
    }

    Ok(())
}

enum McpCallError {
    InvalidRequest(String),
    ToolFailure(String),
}

fn handle_mcp_tools_call(
    message: &Value,
    id: &Value,
    parsed: &ParsedWrapperArgs,
    current_dir: &Path,
) -> std::result::Result<Value, McpCallError> {
    let params = message
        .get("params")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let tool_name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if tool_name != "bash_exec" {
        return Err(McpCallError::InvalidRequest(format!(
            "Unknown tool: {tool_name}"
        )));
    }

    let args_value = params
        .get("arguments")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let bash_argv = args_value
        .get("argv")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            McpCallError::InvalidRequest(
                "tools/call arguments.argv must be an array of strings".to_string(),
            )
        })?
        .iter()
        .map(|value| {
            value.as_str().map(str::to_string).ok_or_else(|| {
                McpCallError::InvalidRequest("argv entries must be strings".to_string())
            })
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let stdin_text = args_value
        .get("stdin")
        .and_then(Value::as_str)
        .map(str::to_string);
    let cwd = args_value
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| current_dir.to_path_buf());
    let invocation = resolve_invocation_with_supplied_stdin(&bash_argv, &cwd, stdin_text)
        .map_err(|error| McpCallError::InvalidRequest(error.to_string()))?;
    let result = execute_guarded_bash(invocation, &parsed.options, cwd, ExecutionMode::Capture)
        .map_err(|error| McpCallError::ToolFailure(error.to_string()))?;
    Ok(mcp_tools_call_result_response(id.clone(), result))
}

fn mcp_tools_call_result_response(id: Value, result: GuardedExecutionResult) -> Value {
    match result {
        GuardedExecutionResult::ExecutedCapture(data) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{
                    "type": "text",
                    "text": format!("exitCode: {}\nstdout:\n{}\nstderr:\n{}", data.status_code, data.stdout, data.stderr)
                }]
            }
        }),
        GuardedExecutionResult::Denied(message) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": message }],
                "isError": true
            }
        }),
        GuardedExecutionResult::ExecutedPassthrough(_) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": "Passthrough execution is not available in MCP mode." }],
                "isError": true
            }
        }),
    }
}

fn mcp_error_response(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

fn parse_wrapper_args(args: &[String]) -> Result<ParsedWrapperArgs> {
    let mut api_key = env::var("VETO_API_KEY").ok();
    let mut api_url = env::var("VETO_API_URL").unwrap_or_else(|_| DEFAULT_API_URL.to_string());
    let mut cache_ttl_seconds = 60_u64;
    let mut offline = false;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--" => {
                return Ok(ParsedWrapperArgs {
                    options: WrapperOptions {
                        api_key,
                        api_url,
                        cache_ttl_seconds,
                        offline,
                    },
                    bash_argv: args[index + 1..].to_vec(),
                });
            }
            "--veto-api-key" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| anyhow!("Missing value for --veto-api-key"))?;
                api_key = Some(value.clone());
                index += 2;
            }
            "--veto-api-url" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| anyhow!("Missing value for --veto-api-url"))?;
                api_url = value.trim_end_matches('/').to_string();
                index += 2;
            }
            "--cache-ttl" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| anyhow!("Missing value for --cache-ttl"))?;
                cache_ttl_seconds = value
                    .parse::<u64>()
                    .with_context(|| format!("Invalid --cache-ttl value: {value}"))?;
                index += 2;
            }
            "--offline" => {
                offline = true;
                index += 1;
            }
            _ => break,
        }
    }

    Ok(ParsedWrapperArgs {
        options: WrapperOptions {
            api_key,
            api_url,
            cache_ttl_seconds,
            offline,
        },
        bash_argv: args[index..].to_vec(),
    })
}

fn has_short_option_bundle(arg: &str) -> bool {
    arg.starts_with('-') && !arg.starts_with("--") && arg.len() > 1
}

fn bundle_includes(arg: &str, needle: char) -> bool {
    has_short_option_bundle(arg) && arg[1..].chars().any(|value| value == needle)
}

fn resolve_invocation_with_supplied_stdin(
    bash_argv: &[String],
    cwd: &Path,
    stdin_override: Option<String>,
) -> Result<Invocation> {
    resolve_invocation_internal(bash_argv, cwd, stdin_override, false)
}

fn resolve_invocation(
    bash_argv: &[String],
    cwd: &Path,
    allow_stdin_read: bool,
) -> Result<Invocation> {
    let stdin_override = if allow_stdin_read && !io::stdin().is_terminal() {
        let mut buffer = String::new();
        io::stdin().read_to_string(&mut buffer)?;
        Some(buffer)
    } else {
        None
    };
    resolve_invocation_internal(bash_argv, cwd, stdin_override, true)
}

fn resolve_invocation_internal(
    bash_argv: &[String],
    cwd: &Path,
    stdin_text: Option<String>,
    stdin_tty_fallback: bool,
) -> Result<Invocation> {
    let long_options_with_value = ["--rcfile", "--init-file"];
    let standalone_long_options = ["--debugger", "--dump-po-strings", "--dump-strings"];
    let short_options_with_value = ["-O", "+O", "-o", "+o"];
    let standalone_short_options = ["-D"];
    let mut options_ended = false;
    let mut stdin_mode = false;
    let mut index = 0;

    while index < bash_argv.len() {
        let arg = &bash_argv[index];
        if !options_ended && arg == "--" {
            options_ended = true;
            index += 1;
            continue;
        }

        if !options_ended && (arg == "-c" || bundle_includes(arg, 'c')) {
            let command = bash_argv
                .get(index + 1)
                .cloned()
                .ok_or_else(|| anyhow!("Missing command after -c"))?;
            return Ok(Invocation::Command {
                bash_argv: bash_argv.to_vec(),
                command,
            });
        }

        if !options_ended && (arg == "-s" || bundle_includes(arg, 's')) {
            stdin_mode = true;
            index += 1;
            continue;
        }

        if !options_ended && short_options_with_value.contains(&arg.as_str()) {
            index += 2;
            continue;
        }

        if !options_ended && long_options_with_value.contains(&arg.as_str()) {
            index += 2;
            continue;
        }

        if !options_ended && (arg.starts_with("--rcfile=") || arg.starts_with("--init-file=")) {
            index += 1;
            continue;
        }

        if !options_ended
            && (standalone_long_options.contains(&arg.as_str())
                || standalone_short_options.contains(&arg.as_str()))
        {
            index += 1;
            continue;
        }

        if !options_ended && arg.starts_with('-') {
            index += 1;
            continue;
        }

        if stdin_mode {
            index += 1;
            continue;
        }

        let script_path = cwd.join(arg);
        let command = fs::read_to_string(&script_path)
            .with_context(|| format!("Failed to read bash script {}", script_path.display()))?;
        return Ok(Invocation::ScriptFile {
            bash_argv: bash_argv.to_vec(),
            command,
            script_path: script_path.to_string_lossy().to_string(),
        });
    }

    if stdin_mode {
        if let Some(stdin_text) = stdin_text {
            return Ok(Invocation::Stdin {
                bash_argv: bash_argv.to_vec(),
                command: stdin_text.clone(),
                stdin_text,
            });
        }
        if stdin_tty_fallback {
            return Ok(Invocation::Interactive {
                bash_argv: bash_argv.to_vec(),
            });
        }
    }

    Ok(Invocation::Interactive {
        bash_argv: bash_argv.to_vec(),
    })
}

fn validation_args_from_invocation(invocation: &Invocation, cwd: &Path) -> Option<ValidationArgs> {
    match invocation {
        Invocation::Interactive { .. } => None,
        Invocation::Command { bash_argv, command } => Some(ValidationArgs {
            command: command.clone(),
            cwd: cwd.to_string_lossy().to_string(),
            argv: bash_argv.clone(),
            shell_mode: "command".to_string(),
            script_path: None,
            stdin: None,
        }),
        Invocation::ScriptFile {
            bash_argv,
            command,
            script_path,
        } => Some(ValidationArgs {
            command: command.clone(),
            cwd: cwd.to_string_lossy().to_string(),
            argv: bash_argv.clone(),
            shell_mode: "script-file".to_string(),
            script_path: Some(script_path.clone()),
            stdin: None,
        }),
        Invocation::Stdin {
            bash_argv, command, ..
        } => Some(ValidationArgs {
            command: command.clone(),
            cwd: cwd.to_string_lossy().to_string(),
            argv: bash_argv.clone(),
            shell_mode: "stdin".to_string(),
            script_path: None,
            stdin: Some(true),
        }),
    }
}

fn validation_context_from_args(args: &ValidationArgs) -> ValidationContext {
    ValidationContext {
        session_id: env::var("VETO_SESSION_ID").ok(),
        agent_id: env::var("VETO_AGENT_ID").ok(),
        user_id: env::var("VETO_USER_ID").ok(),
        role: env::var("VETO_ROLE").ok(),
        cwd: args.cwd.clone(),
        shell_mode: args.shell_mode.clone(),
        bash_argv: args.argv.clone(),
        script_path: args.script_path.clone(),
    }
}

enum ExecutionMode {
    Passthrough,
    Capture,
}

enum GuardedExecutionResult {
    ExecutedPassthrough(i32),
    ExecutedCapture(CaptureExecutionResult),
    Denied(String),
}

fn execute_guarded_bash(
    invocation: Invocation,
    options: &WrapperOptions,
    cwd: PathBuf,
    mode: ExecutionMode,
) -> Result<GuardedExecutionResult> {
    let current_exe = env::current_exe().context("Failed to determine current executable")?;
    let real_bash = resolve_real_bash()?;

    match (&invocation, &mode) {
        (Invocation::Interactive { bash_argv }, ExecutionMode::Passthrough) => {
            return exec_passthrough(&real_bash, bash_argv, None, &cwd)
                .map(GuardedExecutionResult::ExecutedPassthrough);
        }
        (Invocation::Interactive { .. }, _) => {
            return Ok(GuardedExecutionResult::Denied(
                "[veto-bash] Interactive bash sessions are not exposed through MCP mode."
                    .to_string(),
            ));
        }
        _ => {}
    }

    let validation_args = validation_args_from_invocation(&invocation, &cwd)
        .ok_or_else(|| anyhow!("Missing validation args"))?;
    let validation_context = validation_context_from_args(&validation_args);
    let api_key_namespace = derive_api_key_namespace(options.api_key.as_deref())?;
    let requested_mode = if options.offline {
        "offline"
    } else if options.api_key.is_some() {
        "cloud"
    } else {
        "local"
    };
    let local_project = find_local_project(&cwd)?;
    let cache_key = CacheKeyInput {
        requested_mode: requested_mode.to_string(),
        api_url: Some(options.api_url.clone()),
        api_key_namespace: api_key_namespace.clone(),
        command: validation_args.command.clone(),
        cwd: validation_args.cwd.clone(),
        bash_argv: validation_args.argv.clone(),
        shell_mode: validation_args.shell_mode.clone(),
        script_path: validation_args.script_path.clone(),
        veto_dir: local_project
            .as_ref()
            .map(|project| project.veto_dir.to_string_lossy().to_string()),
    };

    if options.cache_ttl_seconds > 0 {
        if let Some(cached) = load_cached_decision(&cache_key)? {
            return apply_terminal_decision(cached, &invocation, &real_bash, &cwd, mode);
        }
    }

    let terminal_decision = decide(
        &validation_args,
        &validation_context,
        options,
        local_project.as_ref(),
        api_key_namespace.as_deref(),
        &current_exe,
    )?;

    append_audit_event(
        &terminal_decision,
        &validation_args,
        options,
        api_key_namespace.as_deref(),
    )?;
    maybe_spawn_audit_flush(&current_exe, options, api_key_namespace.as_deref())?;

    if should_cache_decision(options.cache_ttl_seconds, &terminal_decision) {
        store_cached_decision(&cache_key, &terminal_decision, options.cache_ttl_seconds)?;
    }

    apply_terminal_decision(terminal_decision, &invocation, &real_bash, &cwd, mode)
}

fn apply_terminal_decision(
    decision: TerminalDecision,
    invocation: &Invocation,
    real_bash: &Path,
    cwd: &Path,
    mode: ExecutionMode,
) -> Result<GuardedExecutionResult> {
    if decision.decision != "allow" {
        return Ok(GuardedExecutionResult::Denied(format_decision_message(
            &decision,
        )));
    }

    let bash_argv = match invocation {
        Invocation::Interactive { bash_argv }
        | Invocation::Command { bash_argv, .. }
        | Invocation::ScriptFile { bash_argv, .. }
        | Invocation::Stdin { bash_argv, .. } => bash_argv,
    };
    let stdin_text = match invocation {
        Invocation::Stdin { stdin_text, .. } => Some(stdin_text.as_str()),
        _ => None,
    };

    match mode {
        ExecutionMode::Passthrough => exec_passthrough(real_bash, bash_argv, stdin_text, cwd)
            .map(GuardedExecutionResult::ExecutedPassthrough),
        ExecutionMode::Capture => exec_capture(real_bash, bash_argv, stdin_text, cwd)
            .map(GuardedExecutionResult::ExecutedCapture),
    }
}

fn decide(
    validation_args: &ValidationArgs,
    validation_context: &ValidationContext,
    options: &WrapperOptions,
    local_project: Option<&LocalProject>,
    api_key_namespace: Option<&str>,
    current_exe: &Path,
) -> Result<TerminalDecision> {
    if options.offline {
        let project = local_project.ok_or_else(|| {
            anyhow!("Offline mode requested but no local veto/veto.config.yaml was found.")
        })?;
        return evaluate_local_project(project, validation_args, "local");
    }

    if let Some(api_key) = options.api_key.as_deref() {
        let policy_state = maybe_get_cloud_policy(options, api_key_namespace, current_exe)?;
        if let Some(policy) = policy_state
            .as_ref()
            .and_then(|state| state.policy_if_usable())
        {
            let local_result = evaluate_cloud_policy(validation_args, policy)?;
            if let Some(decision) = local_result {
                return Ok(TerminalDecision {
                    decision: decision.decision,
                    reason: decision.reason,
                    denial: decision.denial,
                    source: "cloud-policy-cache".to_string(),
                    from_approval_flow: false,
                });
            }
        }

        match validate_with_cloud(options, api_key, validation_args, validation_context) {
            Ok(response) => return resolve_cloud_response(response, options, api_key),
            Err(error) if error.network => {
                if let Some(project) = local_project {
                    let mut decision =
                        evaluate_local_project(project, validation_args, "cloud-fallback-local")?;
                    decision.source = "cloud-fallback-local".to_string();
                    return Ok(decision);
                }
                return Err(anyhow!(
                    "Cloud validation failed and no local veto project was found: {}",
                    error.message
                ));
            }
            Err(error) => return Err(anyhow!("Cloud validation failed: {}", error.message)),
        }
    }

    if let Some(project) = local_project {
        return evaluate_local_project(project, validation_args, "local");
    }

    Err(anyhow!(
        "No Veto policy source configured. Set VETO_API_KEY or add veto/veto.config.yaml."
    ))
}

fn format_decision_message(decision: &TerminalDecision) -> String {
    let mut lines = vec![format!(
        "[veto-bash] {}",
        decision
            .reason
            .clone()
            .unwrap_or_else(|| "Blocked by policy.".to_string())
    )];
    if let Some(denial) = decision.denial.as_ref() {
        if !denial.suggested_fixes.is_empty() {
            lines.push(format!(
                "[veto-bash] fixes: {}",
                denial.suggested_fixes.join(" | ")
            ));
        }
        if let Some(docs_url) = denial.docs_url.as_ref() {
            lines.push(format!("[veto-bash] docs: {docs_url}"));
        }
    }
    format!("{}\n", lines.join("\n"))
}

fn resolve_cloud_response(
    response: ValidateResponse,
    options: &WrapperOptions,
    api_key: &str,
) -> Result<TerminalDecision> {
    match response.decision.as_str() {
        "allow" => Ok(TerminalDecision {
            decision: "allow".to_string(),
            reason: response.reason,
            denial: None,
            source: "cloud".to_string(),
            from_approval_flow: false,
        }),
        "deny" => Ok(TerminalDecision {
            decision: "deny".to_string(),
            reason: response.reason,
            denial: response.denial,
            source: "cloud".to_string(),
            from_approval_flow: false,
        }),
        "require_approval" => {
            let approval_id = response.approval_id.ok_or_else(|| {
                anyhow!("Approval required but no approval id was returned by the server.")
            })?;
            let record = poll_approval(options, api_key, &approval_id)?;
            if record.status == "approved" {
                Ok(TerminalDecision {
                    decision: "allow".to_string(),
                    reason: Some(format!(
                        "Approved by human{}",
                        record
                            .resolved_by
                            .as_ref()
                            .map(|value| format!(": {value}"))
                            .unwrap_or_default()
                    )),
                    denial: None,
                    source: "cloud".to_string(),
                    from_approval_flow: true,
                })
            } else {
                Ok(TerminalDecision {
                    decision: "deny".to_string(),
                    reason: Some(format!(
                        "Approval {}: {}",
                        record.status,
                        response
                            .reason
                            .unwrap_or_else(|| "no reason provided".to_string())
                    )),
                    denial: response.denial,
                    source: "cloud".to_string(),
                    from_approval_flow: true,
                })
            }
        }
        other => Err(anyhow!("Unsupported cloud decision: {other}")),
    }
}

struct PolicyState {
    policy: Option<CloudPolicy>,
    freshness: PolicyFreshness,
}

impl PolicyState {
    fn policy_if_usable(&self) -> Option<&CloudPolicy> {
        if self.freshness == PolicyFreshness::Missing || self.freshness == PolicyFreshness::Expired
        {
            None
        } else {
            self.policy.as_ref()
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PolicyFreshness {
    Missing,
    Fresh,
    Stale,
    Expired,
}

fn maybe_get_cloud_policy(
    options: &WrapperOptions,
    api_key_namespace: Option<&str>,
    current_exe: &Path,
) -> Result<Option<PolicyState>> {
    let Some(api_key_namespace) = api_key_namespace else {
        return Ok(None);
    };
    let key = PolicyCacheKey {
        api_url: options.api_url.clone(),
        api_key_namespace: api_key_namespace.to_string(),
        tool_name: TOOL_NAME.to_string(),
    };
    let now = now_ms();
    let entry = load_policy_entry(&key)?;
    let state = match entry {
        None => {
            spawn_policy_refresh(current_exe, options)?;
            PolicyState {
                policy: None,
                freshness: PolicyFreshness::Missing,
            }
        }
        Some(entry) if now < entry.stale_at_ms => PolicyState {
            policy: Some(entry.policy),
            freshness: PolicyFreshness::Fresh,
        },
        Some(entry) if now < entry.expired_at_ms => {
            spawn_policy_refresh(current_exe, options)?;
            PolicyState {
                policy: Some(entry.policy),
                freshness: PolicyFreshness::Stale,
            }
        }
        Some(_) => {
            spawn_policy_refresh(current_exe, options)?;
            PolicyState {
                policy: None,
                freshness: PolicyFreshness::Expired,
            }
        }
    };
    Ok(Some(state))
}

fn supported_cloud_policy(policy: &CloudPolicy) -> bool {
    policy.mode == "deterministic"
        && policy.session_constraints.is_none()
        && policy.rate_limits.is_none()
        && policy.constraints.iter().all(|constraint| {
            constraint.dynamic_minimum.is_none() && constraint.dynamic_maximum.is_none()
        })
}

fn evaluate_cloud_policy(
    validation_args: &ValidationArgs,
    policy: &CloudPolicy,
) -> Result<Option<TerminalDecision>> {
    if !supported_cloud_policy(policy) {
        return Ok(None);
    }

    let args_value = serde_json::to_value(validation_args)?;
    let mut validations = Vec::new();
    for constraint in &policy.constraints {
        if !constraint.enabled {
            continue;
        }
        let field_value = args_value.get(&constraint.argument_name).cloned();
        let outcome = evaluate_constraint(field_value.as_ref(), constraint)?;
        validations.push(outcome.clone());
        if !outcome.passed {
            if outcome.decision == "require_approval" {
                return Ok(None);
            }
            return Ok(Some(TerminalDecision {
                decision: "deny".to_string(),
                reason: Some(format!(
                    "Argument '{}' failed: {}",
                    constraint.argument_name,
                    outcome
                        .reason
                        .unwrap_or_else(|| "constraint failed".to_string())
                )),
                denial: None,
                source: "cloud-policy-cache".to_string(),
                from_approval_flow: false,
            }));
        }
    }

    let _ = validations;
    Ok(Some(TerminalDecision {
        decision: "allow".to_string(),
        reason: None,
        denial: None,
        source: "cloud-policy-cache".to_string(),
        from_approval_flow: false,
    }))
}

#[derive(Clone, Debug)]
struct ConstraintOutcome {
    passed: bool,
    decision: String,
    reason: Option<String>,
}

fn evaluate_constraint(
    value: Option<&Value>,
    constraint: &PolicyConstraint,
) -> Result<ConstraintOutcome> {
    if value.is_none() || value == Some(&Value::Null) {
        if constraint.required == Some(true) && value.is_none() {
            return Ok(ConstraintOutcome {
                passed: false,
                decision: constraint
                    .action
                    .clone()
                    .unwrap_or_else(|| "deny".to_string()),
                reason: Some("required value missing".to_string()),
            });
        }
        if constraint.not_null == Some(true) && value == Some(&Value::Null) {
            return Ok(ConstraintOutcome {
                passed: false,
                decision: constraint
                    .action
                    .clone()
                    .unwrap_or_else(|| "deny".to_string()),
                reason: Some("value cannot be null".to_string()),
            });
        }
        return Ok(ConstraintOutcome {
            passed: true,
            decision: "allow".to_string(),
            reason: None,
        });
    }

    let value = value.expect("checked above");
    if let Some(number) = value.as_f64() {
        if let Some(limit) = constraint.greater_than {
            if number <= limit {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!("value {number} must be greater than {limit}")),
                });
            }
        }
        if let Some(limit) = constraint.less_than {
            if number >= limit {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!("value {number} must be less than {limit}")),
                });
            }
        }
        if let Some(limit) = constraint.greater_than_or_equal {
            if number < limit {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!("value {number} must be >= {limit}")),
                });
            }
        }
        if let Some(limit) = constraint.less_than_or_equal {
            if number > limit {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!("value {number} must be <= {limit}")),
                });
            }
        }
        if let Some(minimum) = constraint.minimum {
            if number < minimum {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!("value {number} must be >= {minimum}")),
                });
            }
        }
        if let Some(maximum) = constraint.maximum {
            if number > maximum {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!("value {number} must be <= {maximum}")),
                });
            }
        }
    }

    if let Some(string) = value.as_str() {
        if let Some(min) = constraint.min_length {
            if string.len() < min {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!(
                        "length {} is less than minimum {min}",
                        string.len()
                    )),
                });
            }
        }
        if let Some(max) = constraint.max_length {
            if string.len() > max {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!("length {} exceeds maximum {max}", string.len())),
                });
            }
        }
        if let Some(regex_source) = constraint.regex.as_ref() {
            let regex = Regex::new(regex_source)
                .with_context(|| format!("Invalid regex pattern in policy: {regex_source}"))?;
            if !regex.is_match(string) {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!("value does not match pattern {regex_source}")),
                });
            }
        }
        if let Some(allowed) = constraint.enum_values.as_ref() {
            if !allowed.iter().any(|entry| entry == string) {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!("value '{string}' is not in allowed values")),
                });
            }
        }
    }

    if let Some(array) = value.as_array() {
        if let Some(min_items) = constraint.min_items {
            if array.len() < min_items {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!(
                        "array has {} items, minimum is {min_items}",
                        array.len()
                    )),
                });
            }
        }
        if let Some(max_items) = constraint.max_items {
            if array.len() > max_items {
                return Ok(ConstraintOutcome {
                    passed: false,
                    decision: constraint
                        .action
                        .clone()
                        .unwrap_or_else(|| "deny".to_string()),
                    reason: Some(format!(
                        "array has {} items, maximum is {max_items}",
                        array.len()
                    )),
                });
            }
        }
    }

    if let Some(in_values) = constraint.in_values.as_ref() {
        if !in_values.iter().any(|candidate| candidate == value) {
            return Ok(ConstraintOutcome {
                passed: false,
                decision: constraint
                    .action
                    .clone()
                    .unwrap_or_else(|| "deny".to_string()),
                reason: Some("value is not in allowed list".to_string()),
            });
        }
    }
    if let Some(not_in_values) = constraint.not_in_values.as_ref() {
        if not_in_values.iter().any(|candidate| candidate == value) {
            return Ok(ConstraintOutcome {
                passed: false,
                decision: constraint
                    .action
                    .clone()
                    .unwrap_or_else(|| "deny".to_string()),
                reason: Some("value is in denied list".to_string()),
            });
        }
    }

    Ok(ConstraintOutcome {
        passed: true,
        decision: "allow".to_string(),
        reason: None,
    })
}

fn evaluate_local_project(
    project: &LocalProject,
    validation_args: &ValidationArgs,
    source: &str,
) -> Result<TerminalDecision> {
    let rules = load_local_rules(project)?;
    let context = json!({ "arguments": validation_args });
    let mut first_block: Option<&LocalRule> = None;
    let mut first_approval: Option<&LocalRule> = None;
    let mut first_allow: Option<&LocalRule> = None;

    for rule in &rules {
        if !rule.enabled {
            continue;
        }
        if !rule.tools.is_empty() && !rule.tools.iter().any(|tool| tool == TOOL_NAME) {
            continue;
        }
        let matched = if !rule.conditions.is_empty() {
            rule.conditions
                .iter()
                .all(|condition| evaluate_local_condition(condition, &context))
        } else if !rule.condition_groups.is_empty() {
            rule.condition_groups.iter().any(|group| {
                group
                    .iter()
                    .all(|condition| evaluate_local_condition(condition, &context))
            })
        } else {
            true
        };
        if !matched {
            continue;
        }
        match rule.action.as_str() {
            "block" => {
                if first_block.is_none() {
                    first_block = Some(rule);
                }
            }
            "require_approval" => {
                if first_approval.is_none() {
                    first_approval = Some(rule);
                }
            }
            "allow" => {
                if first_allow.is_none() {
                    first_allow = Some(rule);
                }
            }
            _ => {}
        }
    }

    if let Some(rule) = first_block.or(first_approval).or(first_allow) {
        let reason = rule
            .description
            .clone()
            .or_else(|| rule.name.clone())
            .or_else(|| Some(rule.id.clone()));
        return Ok(match rule.action.as_str() {
            "allow" => TerminalDecision {
                decision: "allow".to_string(),
                reason,
                denial: None,
                source: source.to_string(),
                from_approval_flow: false,
            },
            "require_approval" => TerminalDecision {
                decision: "deny".to_string(),
                reason: Some(format!(
                    "Approval required: {}",
                    reason.unwrap_or_else(|| "Local rule requires human review".to_string())
                )),
                denial: Some(DenialDetails {
                    policy_id: Some(rule.id.clone()),
                    policy_name: rule.name.clone(),
                    severity: Some("require_approval".to_string()),
                    matched_condition: None,
                    suggested_fixes: Vec::new(),
                    docs_url: None,
                    input: None,
                }),
                source: source.to_string(),
                from_approval_flow: false,
            },
            _ => TerminalDecision {
                decision: "deny".to_string(),
                reason,
                denial: Some(DenialDetails {
                    policy_id: Some(rule.id.clone()),
                    policy_name: rule.name.clone(),
                    severity: Some("deny".to_string()),
                    matched_condition: None,
                    suggested_fixes: Vec::new(),
                    docs_url: None,
                    input: None,
                }),
                source: source.to_string(),
                from_approval_flow: false,
            },
        });
    }

    Ok(TerminalDecision {
        decision: "allow".to_string(),
        reason: None,
        denial: None,
        source: source.to_string(),
        from_approval_flow: false,
    })
}

fn evaluate_local_condition(condition: &LocalCondition, context: &Value) -> bool {
    let resolved = resolve_local_field(condition.field.as_str(), context);
    let Some(value) = resolved else {
        return false;
    };
    match condition.operator.as_str() {
        "equals" => value == &condition.value,
        "not_equals" => value != &condition.value,
        "contains" => value
            .as_str()
            .zip(condition.value.as_str())
            .map(|(lhs, rhs)| lhs.to_lowercase().contains(&rhs.to_lowercase()))
            .unwrap_or(false),
        "not_contains" => value
            .as_str()
            .zip(condition.value.as_str())
            .map(|(lhs, rhs)| !lhs.to_lowercase().contains(&rhs.to_lowercase()))
            .unwrap_or(false),
        "starts_with" => value
            .as_str()
            .zip(condition.value.as_str())
            .map(|(lhs, rhs)| lhs.to_lowercase().starts_with(&rhs.to_lowercase()))
            .unwrap_or(false),
        "ends_with" => value
            .as_str()
            .zip(condition.value.as_str())
            .map(|(lhs, rhs)| lhs.to_lowercase().ends_with(&rhs.to_lowercase()))
            .unwrap_or(false),
        "matches" => value
            .as_str()
            .zip(condition.value.as_str())
            .map(|(lhs, rhs)| {
                Regex::new(rhs)
                    .map(|regex| regex.is_match(lhs))
                    .unwrap_or(false)
            })
            .unwrap_or(false),
        "in" => condition
            .value
            .as_array()
            .map(|items| items.iter().any(|item| item == value))
            .unwrap_or(false),
        "not_in" => condition
            .value
            .as_array()
            .map(|items| items.iter().all(|item| item != value))
            .unwrap_or(false),
        _ => false,
    }
}

fn resolve_local_field<'a>(path: &str, context: &'a Value) -> Option<&'a Value> {
    let mut current = context;
    for part in path.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

fn load_local_rules(project: &LocalProject) -> Result<Vec<LocalRule>> {
    let mut rules = Vec::new();
    let walker = if project.recursive {
        WalkDir::new(&project.rules_dir).into_iter()
    } else {
        WalkDir::new(&project.rules_dir).max_depth(1).into_iter()
    };

    for entry in walker
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension != "yaml" && extension != "yml" {
            continue;
        }
        let raw = fs::read_to_string(path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        let file: LocalRuleFile = serde_yaml::from_str(&raw)
            .with_context(|| format!("Failed to parse {}", path.display()))?;
        if file.extends.is_some() {
            return Err(anyhow!(
                "Local policy extends is not yet supported by the Rust runtime: {}",
                path.display()
            ));
        }
        rules.extend(file.rules);
    }

    Ok(rules)
}

fn find_local_project(start_dir: &Path) -> Result<Option<LocalProject>> {
    let mut current = start_dir.to_path_buf();
    loop {
        let veto_dir = current.join("veto");
        let config_path = veto_dir.join("veto.config.yaml");
        if config_path.exists() {
            let raw = fs::read_to_string(&config_path)
                .with_context(|| format!("Failed to read {}", config_path.display()))?;
            let parsed: LocalConfigFile = serde_yaml::from_str(&raw)
                .with_context(|| format!("Failed to parse {}", config_path.display()))?;
            let rules_dir = veto_dir.join(
                parsed
                    .rules
                    .as_ref()
                    .and_then(|rules| rules.directory.clone())
                    .unwrap_or_else(|| "./rules".to_string()),
            );
            let recursive = parsed
                .rules
                .as_ref()
                .and_then(|rules| rules.recursive)
                .unwrap_or(true);
            return Ok(Some(LocalProject {
                veto_dir,
                rules_dir,
                recursive,
            }));
        }
        if !current.pop() {
            break;
        }
    }
    Ok(None)
}

struct CloudError {
    message: String,
    network: bool,
}

fn validate_with_cloud(
    options: &WrapperOptions,
    api_key: &str,
    validation_args: &ValidationArgs,
    context: &ValidationContext,
) -> std::result::Result<ValidateResponse, CloudError> {
    let request_body = json!({
        "toolName": TOOL_NAME,
        "arguments": validation_args,
        "context": context,
    });
    let url = format!("{}/v1/validate", options.api_url.trim_end_matches('/'));
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let response = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("X-Veto-API-Key", api_key)
        .send_string(&request_body.to_string());
    match response {
        Ok(resp) => resp
            .into_json::<ValidateResponse>()
            .map_err(|error| CloudError {
                message: error.to_string(),
                network: false,
            }),
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Err(CloudError {
                message: format!("API returned {status}: {body}"),
                network: false,
            })
        }
        Err(error) => Err(CloudError {
            message: error.to_string(),
            network: true,
        }),
    }
}

fn poll_approval(
    options: &WrapperOptions,
    api_key: &str,
    approval_id: &str,
) -> Result<ApprovalRecord> {
    let url = format!(
        "{}/v1/approvals/{}",
        options.api_url.trim_end_matches('/'),
        approval_id
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let deadline = now_ms() + APPROVAL_TIMEOUT_MS;
    loop {
        let response = agent.get(&url).set("X-Veto-API-Key", api_key).call();
        match response {
            Ok(resp) => {
                let record: ApprovalRecord = resp.into_json()?;
                if record.status != "pending" {
                    return Ok(record);
                }
            }
            Err(ureq::Error::Status(status, resp)) => {
                if !should_retry_approval_status(status) {
                    let body = resp.into_string().unwrap_or_default();
                    return Err(anyhow!("Approval API returned {status}: {body}"));
                }
            }
            Err(_) => {}
        }
        if now_ms() >= deadline {
            return Ok(ApprovalRecord {
                id: approval_id.to_string(),
                status: "expired".to_string(),
                tool_name: None,
                arguments: None,
                expires_at: None,
                resolved_by: None,
                resolved_at: None,
                created_at: None,
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(APPROVAL_POLL_INTERVAL_MS));
    }
}

fn should_retry_approval_status(status: u16) -> bool {
    status == 429 || status >= 500
}

fn fetch_cloud_policy(options: &WrapperOptions, api_key: &str) -> Result<Option<CloudPolicy>> {
    let url = format!(
        "{}/v1/policies/{}",
        options.api_url.trim_end_matches('/'),
        TOOL_NAME
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    match agent.get(&url).set("X-Veto-API-Key", api_key).call() {
        Ok(resp) => Ok(Some(resp.into_json::<CloudPolicy>()?)),
        Err(ureq::Error::Status(_, _)) => Ok(None),
        Err(error) => Err(anyhow!(error.to_string())),
    }
}

fn maybe_log_decision(
    options: &WrapperOptions,
    api_key: &str,
    request: &LogDecisionRequest,
) -> Result<()> {
    let url = format!("{}/v1/decisions", options.api_url.trim_end_matches('/'));
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let _ = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("X-Veto-API-Key", api_key)
        .send_string(&serde_json::to_string(request)?);
    Ok(())
}

fn append_audit_event(
    decision: &TerminalDecision,
    validation_args: &ValidationArgs,
    options: &WrapperOptions,
    api_key_namespace: Option<&str>,
) -> Result<()> {
    let forward_request = if decision.source == "cloud-policy-cache" {
        Some(LogDecisionRequest {
            tool_name: TOOL_NAME.to_string(),
            arguments: serde_json::to_value(validation_args)?,
            decision: decision.decision.clone(),
            reason: decision.reason.clone(),
            mode: "deterministic".to_string(),
            latency_ms: 0,
            source: "client".to_string(),
            context: Some(serde_json::to_value(validation_context_from_args(
                validation_args,
            ))?),
        })
    } else {
        None
    };
    let event = AuditEvent {
        timestamp_ms: now_ms(),
        source: decision.source.clone(),
        decision: decision.decision.clone(),
        reason: decision.reason.clone(),
        tool_name: TOOL_NAME.to_string(),
        arguments: serde_json::to_value(validation_args)?,
        api_url: if options.api_key.is_some() {
            Some(options.api_url.clone())
        } else {
            None
        },
        api_key_namespace: api_key_namespace.map(str::to_string),
        forward_request,
    };
    let path = home_relative(AUDIT_SPOOL_PATH)?;
    let _lock = acquire_mutation_lock(&path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{}", serde_json::to_string(&event)?)?;
    Ok(())
}

fn maybe_spawn_audit_flush(
    current_exe: &Path,
    options: &WrapperOptions,
    api_key_namespace: Option<&str>,
) -> Result<()> {
    let Some(api_key) = options.api_key.as_ref() else {
        return Ok(());
    };
    let Some(namespace) = api_key_namespace else {
        return Ok(());
    };
    let lock_path = home_relative(&format!(".veto/cache/flush-{}.lock", namespace))?;
    if lock_recent(&lock_path, DEFAULT_POLICY_REFRESH_COOLDOWN_MS)? {
        return Ok(());
    }
    touch_lock(&lock_path)?;
    Command::new(current_exe)
        .arg("__flush-audit")
        .arg("--api-key")
        .arg(api_key)
        .arg("--api-url")
        .arg(&options.api_url)
        .arg("--api-key-namespace")
        .arg(namespace)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("Failed to spawn audit flush worker")?;
    Ok(())
}

fn run_internal_flush_audit(args: &[String]) -> Result<()> {
    let mut api_key: Option<String> = None;
    let mut api_url = DEFAULT_API_URL.to_string();
    let mut namespace: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--api-key" => {
                api_key = Some(
                    args.get(index + 1)
                        .ok_or_else(|| anyhow!("Missing value for --api-key"))?
                        .clone(),
                );
                index += 2;
            }
            "--api-url" => {
                api_url = args
                    .get(index + 1)
                    .ok_or_else(|| anyhow!("Missing value for --api-url"))?
                    .clone();
                index += 2;
            }
            "--api-key-namespace" => {
                namespace = Some(
                    args.get(index + 1)
                        .ok_or_else(|| anyhow!("Missing value for --api-key-namespace"))?
                        .clone(),
                );
                index += 2;
            }
            other => return Err(anyhow!("Unknown flush flag: {other}")),
        }
    }
    let api_key = api_key.ok_or_else(|| anyhow!("Missing --api-key"))?;
    let namespace = namespace.ok_or_else(|| anyhow!("Missing --api-key-namespace"))?;
    let path = home_relative(AUDIT_SPOOL_PATH)?;
    let _lock = acquire_mutation_lock(&path)?;
    let lock_path = home_relative(&format!(".veto/cache/flush-{}.lock", namespace))?;
    let existing = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            remove_lock(&lock_path)?;
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };

    let mut retained = Vec::new();
    for line in existing.lines().filter(|line| !line.trim().is_empty()) {
        let event: AuditEvent = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if event.api_key_namespace.as_deref() != Some(namespace.as_str())
            || event.api_url.as_deref() != Some(api_url.as_str())
        {
            retained.push(line.to_string());
            continue;
        }
        if let Some(request) = event.forward_request.as_ref() {
            let options = WrapperOptions {
                api_key: Some(api_key.clone()),
                api_url: api_url.clone(),
                cache_ttl_seconds: 0,
                offline: false,
            };
            if maybe_log_decision(&options, &api_key, request).is_err() {
                retained.push(line.to_string());
            }
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    rewrite_jsonl_file(&path, &retained)?;
    remove_lock(&lock_path)?;
    Ok(())
}

fn run_internal_refresh_policy(args: &[String]) -> Result<()> {
    let parsed = parse_wrapper_args(args)?;
    let api_key = parsed
        .options
        .api_key
        .clone()
        .ok_or_else(|| anyhow!("Missing --veto-api-key"))?;
    let namespace = derive_api_key_namespace(Some(&api_key))?
        .ok_or_else(|| anyhow!("Missing api key namespace"))?;
    if let Some(policy) = fetch_cloud_policy(&parsed.options, &api_key)? {
        let key = PolicyCacheKey {
            api_url: parsed.options.api_url.clone(),
            api_key_namespace: namespace.clone(),
            tool_name: TOOL_NAME.to_string(),
        };
        store_policy_entry(&key, &policy)?;
    }
    let lock_path = home_relative(&format!(".veto/cache/policy-refresh-{}.lock", namespace))?;
    remove_lock(&lock_path)?;
    Ok(())
}

fn spawn_policy_refresh(current_exe: &Path, options: &WrapperOptions) -> Result<()> {
    let Some(api_key) = options.api_key.as_ref() else {
        return Ok(());
    };
    let namespace = derive_api_key_namespace(Some(api_key.as_str()))?
        .ok_or_else(|| anyhow!("Failed to derive api key namespace"))?;
    let lock_path = home_relative(&format!(".veto/cache/policy-refresh-{}.lock", namespace))?;
    if lock_recent(&lock_path, DEFAULT_POLICY_REFRESH_COOLDOWN_MS)? {
        return Ok(());
    }
    touch_lock(&lock_path)?;
    Command::new(current_exe)
        .arg("__refresh-policy")
        .arg("--veto-api-key")
        .arg(api_key)
        .arg("--veto-api-url")
        .arg(&options.api_url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("Failed to spawn policy refresh worker")?;
    Ok(())
}

fn resolve_real_bash() -> Result<PathBuf> {
    if let Ok(override_path) = env::var("VETO_BASH_REAL_BASH") {
        let path = PathBuf::from(override_path);
        if path.exists() {
            return Ok(path);
        }
        return Err(anyhow!("VETO_BASH_REAL_BASH does not exist."));
    }
    for candidate in ["/bin/bash", "/usr/bin/bash"] {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return Ok(path);
        }
    }
    Err(anyhow!("Unable to locate a real bash binary."))
}

fn exec_passthrough(
    real_bash: &Path,
    bash_argv: &[String],
    stdin_text: Option<&str>,
    cwd: &Path,
) -> Result<i32> {
    let mut command = Command::new(real_bash);
    command.args(bash_argv).current_dir(cwd);
    if stdin_text.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("Failed to launch {}", real_bash.display()))?;
    if let Some(stdin_text) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(stdin_text.as_bytes())?;
        }
    }
    let status = child.wait()?;
    if let Some(code) = status.code() {
        Ok(code)
    } else {
        Ok(128 + status.signal().unwrap_or(1))
    }
}

fn exec_capture(
    real_bash: &Path,
    bash_argv: &[String],
    stdin_text: Option<&str>,
    cwd: &Path,
) -> Result<CaptureExecutionResult> {
    let mut command = Command::new(real_bash);
    command
        .args(bash_argv)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_text.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("Failed to launch {}", real_bash.display()))?;
    if let Some(stdin_text) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(stdin_text.as_bytes())?;
        }
    }
    let output = child.wait_with_output()?;
    Ok(CaptureExecutionResult {
        status_code: output
            .status
            .code()
            .unwrap_or_else(|| 128 + output.status.signal().unwrap_or(1)),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn should_cache_decision(ttl_seconds: u64, decision: &TerminalDecision) -> bool {
    ttl_seconds > 0 && decision.source != "cloud-fallback-local" && !decision.from_approval_flow
}

fn load_cached_decision(key: &CacheKeyInput) -> Result<Option<TerminalDecision>> {
    let path = home_relative(DECISION_CACHE_PATH)?;
    load_cached_decision_from_path(&path, key)
}

fn load_cached_decision_from_path(
    path: &Path,
    key: &CacheKeyInput,
) -> Result<Option<TerminalDecision>> {
    let raw = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut store: DecisionCacheStore = serde_json::from_str(&raw).unwrap_or_default();
    let key_string = serde_json::to_string(key)?;
    let now = now_ms();
    let original_len = store.entries.len();
    store.entries.retain(|_, entry| entry.expires_at_ms > now);
    if store.entries.len() != original_len {
        let _ = persist_pruned_decision_cache(path, now);
    }
    if let Some(entry) = store.entries.get(&key_string) {
        return Ok(Some(TerminalDecision {
            decision: entry.value.decision.clone(),
            reason: entry.value.reason.clone(),
            denial: entry.value.denial.clone(),
            source: "cache".to_string(),
            from_approval_flow: entry.value.from_approval_flow,
        }));
    }
    Ok(None)
}

fn persist_pruned_decision_cache(path: &Path, now: u64) -> Result<()> {
    let _lock = acquire_mutation_lock(path)?;
    let mut store = read_or_default::<DecisionCacheStore>(path)?;
    let original_len = store.entries.len();
    store.entries.retain(|_, entry| entry.expires_at_ms > now);
    if store.entries.len() != original_len {
        write_json_file(path, &store)?;
    }
    Ok(())
}

fn store_cached_decision(
    key: &CacheKeyInput,
    decision: &TerminalDecision,
    ttl_seconds: u64,
) -> Result<()> {
    let path = home_relative(DECISION_CACHE_PATH)?;
    let _lock = acquire_mutation_lock(&path)?;
    let mut store = read_or_default::<DecisionCacheStore>(&path)?;
    let now = now_ms();
    store.entries.retain(|_, entry| entry.expires_at_ms > now);
    store.entries.insert(
        serde_json::to_string(key)?,
        DecisionCacheEntry {
            expires_at_ms: now + ttl_seconds * 1000,
            value: CachedDecision {
                decision: decision.decision.clone(),
                reason: decision.reason.clone(),
                denial: decision.denial.clone(),
                source: decision.source.clone(),
                from_approval_flow: decision.from_approval_flow,
            },
        },
    );
    write_json_file(&path, &store)
}

fn load_policy_entry(key: &PolicyCacheKey) -> Result<Option<PolicyCacheEntry>> {
    let path = home_relative(POLICY_CACHE_PATH)?;
    let store = read_or_default::<PolicyCacheStore>(&path)?;
    Ok(store.entries.get(&serde_json::to_string(key)?).cloned())
}

fn store_policy_entry(key: &PolicyCacheKey, policy: &CloudPolicy) -> Result<()> {
    let path = home_relative(POLICY_CACHE_PATH)?;
    let _lock = acquire_mutation_lock(&path)?;
    let mut store = read_or_default::<PolicyCacheStore>(&path)?;
    let now = now_ms();
    store.entries.insert(
        serde_json::to_string(key)?,
        PolicyCacheEntry {
            policy: policy.clone(),
            stale_at_ms: now + POLICY_FRESH_MS,
            expired_at_ms: now + POLICY_MAX_MS,
        },
    );
    write_json_file(&path, &store)
}

fn read_or_default<T>(path: &Path) -> Result<T>
where
    T: Default + for<'de> Deserialize<'de>,
{
    match fs::read_to_string(path) {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.into()),
    }
}

fn write_json_file<T>(path: &Path, value: &T) -> Result<()>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write_bytes(path, &serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn rewrite_jsonl_file(path: &Path, lines: &[String]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if lines.is_empty() {
        atomic_write_bytes(path, b"")?;
    } else {
        let mut content = lines.join("\n");
        content.push('\n');
        atomic_write_bytes(path, content.as_bytes())?;
    }
    Ok(())
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("Invalid file name for atomic write: {}", path.display()))?;
    let temp_path =
        path.with_file_name(format!(".{}.{}.{}.tmp", file_name, process::id(), now_ms()));
    fs::write(&temp_path, bytes)?;
    fs::rename(&temp_path, path)?;
    Ok(())
}

struct ExclusiveFileLock {
    path: PathBuf,
}

impl Drop for ExclusiveFileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_mutation_lock(target_path: &Path) -> Result<ExclusiveFileLock> {
    acquire_exclusive_lock(&mutation_lock_path(target_path), FILE_LOCK_TIMEOUT_MS)
}

fn acquire_exclusive_lock(lock_path: &Path, timeout_ms: u64) -> Result<ExclusiveFileLock> {
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let deadline = now_ms() + timeout_ms;
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lock_path)
        {
            Ok(mut file) => {
                writeln!(file, "{} {}", process::id(), now_ms())?;
                return Ok(ExclusiveFileLock {
                    path: lock_path.to_path_buf(),
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if is_stale_lock(lock_path, FILE_LOCK_STALE_MS)? {
                    remove_lock(lock_path)?;
                    continue;
                }
                if now_ms() >= deadline {
                    return Err(anyhow!(
                        "Timed out acquiring file lock: {}",
                        lock_path.display()
                    ));
                }
                thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn mutation_lock_path(target_path: &Path) -> PathBuf {
    let file_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("lock");
    target_path.with_file_name(format!(".{file_name}.lock"))
}

fn is_stale_lock(path: &Path, max_age_ms: u64) -> Result<bool> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(age >= max_age_ms)
}

fn derive_api_key_namespace(api_key: Option<&str>) -> Result<Option<String>> {
    let Some(api_key) = api_key else {
        return Ok(None);
    };
    let params = ScryptParams::recommended();
    let mut output = [0u8; 32];
    scrypt(
        api_key.as_bytes(),
        API_KEY_NAMESPACE_SALT.as_bytes(),
        &params,
        &mut output,
    )
    .map_err(|error| anyhow!(error.to_string()))?;
    Ok(Some(
        output
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    ))
}

fn home_relative(path: &str) -> Result<PathBuf> {
    let home = env::var("HOME").context("HOME environment variable is not set")?;
    Ok(PathBuf::from(home).join(path))
}

fn lock_recent(path: &Path, max_age_ms: u64) -> Result<bool> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(age < max_age_ms)
}

fn touch_lock(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    File::create(path)?;
    Ok(())
}

fn remove_lock(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn exit_with_result(result: GuardedExecutionResult) -> Result<()> {
    match result {
        GuardedExecutionResult::ExecutedPassthrough(code) => {
            process::exit(code);
        }
        GuardedExecutionResult::ExecutedCapture(data) => {
            print!("{}", data.stdout);
            eprint!("{}", data.stderr);
            process::exit(data.status_code);
        }
        GuardedExecutionResult::Denied(message) => {
            eprint!("{}", message);
            process::exit(1);
        }
    }
}

fn read_mcp_message(reader: &mut impl Read) -> Result<Option<Value>> {
    let mut header_bytes = Vec::new();
    let mut buffer = [0u8; 1];
    loop {
        let bytes = reader.read(&mut buffer)?;
        if bytes == 0 {
            if header_bytes.is_empty() {
                return Ok(None);
            }
            return Err(anyhow!("Unexpected EOF while reading MCP headers"));
        }
        header_bytes.push(buffer[0]);
        if header_bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let header_text = String::from_utf8(header_bytes)?;
    let mut content_length: Option<usize> = None;
    for line in header_text.split("\r\n") {
        if let Some(rest) = line.strip_prefix("Content-Length:") {
            content_length = Some(rest.trim().parse::<usize>()?);
        }
    }
    let length = content_length.ok_or_else(|| anyhow!("Missing Content-Length header"))?;
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn write_mcp_message(writer: &mut impl Write, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_skips_value_taking_options_before_c() {
        let cwd = PathBuf::from("/tmp");
        let invocation = resolve_invocation_with_supplied_stdin(
            &vec![
                "--init-file".into(),
                "/tmp/customrc".into(),
                "-c".into(),
                "echo ok".into(),
            ],
            &cwd,
            None,
        )
        .unwrap();
        match invocation {
            Invocation::Command { command, .. } => assert_eq!(command, "echo ok"),
            other => panic!("unexpected invocation: {:?}", other),
        }
    }

    #[test]
    fn parser_skips_short_option_value_before_script() {
        let root = std::env::temp_dir().join(format!("veto-bash-test-{}", now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("script.sh");
        std::fs::write(&script, "echo hi\n").unwrap();
        let invocation = resolve_invocation_with_supplied_stdin(
            &vec![
                "-o".into(),
                "pipefail".into(),
                script.to_string_lossy().to_string(),
            ],
            &root,
            None,
        )
        .unwrap();
        match invocation {
            Invocation::ScriptFile { script_path, .. } => {
                assert_eq!(script_path, script.to_string_lossy())
            }
            other => panic!("unexpected invocation: {:?}", other),
        }
    }

    #[test]
    fn api_key_namespace_differs_by_key() {
        let a = derive_api_key_namespace(Some("tenant-a")).unwrap().unwrap();
        let b = derive_api_key_namespace(Some("tenant-b")).unwrap().unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn cache_key_is_namespaced_by_api_key() {
        let namespace_a = derive_api_key_namespace(Some("tenant-a")).unwrap().unwrap();
        let namespace_b = derive_api_key_namespace(Some("tenant-b")).unwrap().unwrap();
        let key_a = CacheKeyInput {
            requested_mode: "cloud".into(),
            api_url: Some("https://api.veto.so".into()),
            api_key_namespace: Some(namespace_a),
            command: "echo ok".into(),
            cwd: "/tmp".into(),
            bash_argv: vec!["-c".into(), "echo ok".into()],
            shell_mode: "command".into(),
            script_path: None,
            veto_dir: None,
        };
        let key_b = CacheKeyInput {
            requested_mode: "cloud".into(),
            api_url: Some("https://api.veto.so".into()),
            api_key_namespace: Some(namespace_b),
            command: "echo ok".into(),
            cwd: "/tmp".into(),
            bash_argv: vec!["-c".into(), "echo ok".into()],
            shell_mode: "command".into(),
            script_path: None,
            veto_dir: None,
        };

        assert_ne!(
            serde_json::to_string(&key_a).unwrap(),
            serde_json::to_string(&key_b).unwrap()
        );
    }

    #[test]
    fn fallback_local_decisions_are_not_cacheable() {
        let decision = TerminalDecision {
            decision: "allow".into(),
            reason: None,
            denial: None,
            source: "cloud-fallback-local".into(),
            from_approval_flow: false,
        };

        assert!(!should_cache_decision(60, &decision));
        assert!(!should_cache_decision(
            0,
            &TerminalDecision {
                source: "cloud".into(),
                ..decision
            }
        ));
    }

    #[test]
    fn approval_retry_policy_matches_retriable_statuses() {
        assert!(should_retry_approval_status(429));
        assert!(should_retry_approval_status(503));
        assert!(!should_retry_approval_status(403));
        assert!(!should_retry_approval_status(404));
    }

    #[test]
    fn approval_flow_allows_are_not_cacheable() {
        let decision = TerminalDecision {
            decision: "allow".into(),
            reason: Some("Approved by human: reviewer".into()),
            denial: None,
            source: "cloud".into(),
            from_approval_flow: true,
        };

        assert!(!should_cache_decision(60, &decision));
    }

    #[test]
    fn rewrite_jsonl_file_preserves_trailing_newline_for_future_appends() {
        let root = std::env::temp_dir().join(format!("veto-bash-jsonl-{}", now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("spool.jsonl");

        rewrite_jsonl_file(&path, &[r#"{"a":1}"#.to_string()]).unwrap();

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", r#"{"b":2}"#).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.ends_with('\n'));

        let lines = contents
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(first["a"], json!(1));
        assert_eq!(second["b"], json!(2));
    }

    #[test]
    fn rewrite_jsonl_file_with_empty_lines_writes_empty_file() {
        let root = std::env::temp_dir().join(format!("veto-bash-jsonl-empty-{}", now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("spool.jsonl");

        rewrite_jsonl_file(&path, &[]).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    }

    #[test]
    fn exclusive_file_lock_serializes_writers() {
        let root = std::env::temp_dir().join(format!("veto-bash-lock-{}", now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let lock_path = root.join(".cache.lock");

        let first = acquire_exclusive_lock(&lock_path, 20).unwrap();
        let second = acquire_exclusive_lock(&lock_path, 20);
        assert!(second.is_err());

        drop(first);

        let third = acquire_exclusive_lock(&lock_path, 20);
        assert!(third.is_ok());
    }

    #[test]
    fn atomic_write_bytes_replaces_file_contents() {
        let root = std::env::temp_dir().join(format!("veto-bash-atomic-{}", now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("cache.json");

        atomic_write_bytes(&path, br#"{"a":1}"#).unwrap();
        atomic_write_bytes(&path, br#"{"b":2}"#).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"b":2}"#);
    }

    #[test]
    fn load_cached_decision_persists_pruned_entries() {
        let root = std::env::temp_dir().join(format!("veto-bash-cache-prune-{}", now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("decisions.json");
        let key = CacheKeyInput {
            requested_mode: "cloud".into(),
            api_url: Some("https://api.veto.so".into()),
            api_key_namespace: Some("tenant".into()),
            command: "echo ok".into(),
            cwd: "/tmp".into(),
            bash_argv: vec!["-c".into(), "echo ok".into()],
            shell_mode: "command".into(),
            script_path: None,
            veto_dir: None,
        };
        let expired_key = CacheKeyInput {
            command: "echo stale".into(),
            bash_argv: vec!["-c".into(), "echo stale".into()],
            ..key.clone()
        };
        let now = now_ms();
        let store = DecisionCacheStore {
            entries: HashMap::from([
                (
                    serde_json::to_string(&key).unwrap(),
                    DecisionCacheEntry {
                        expires_at_ms: now + 60_000,
                        value: CachedDecision {
                            decision: "allow".into(),
                            reason: None,
                            denial: None,
                            source: "cloud".into(),
                            from_approval_flow: false,
                        },
                    },
                ),
                (
                    serde_json::to_string(&expired_key).unwrap(),
                    DecisionCacheEntry {
                        expires_at_ms: now - 1,
                        value: CachedDecision {
                            decision: "deny".into(),
                            reason: Some("stale".into()),
                            denial: None,
                            source: "cloud".into(),
                            from_approval_flow: false,
                        },
                    },
                ),
            ]),
        };
        write_json_file(&path, &store).unwrap();

        let loaded = load_cached_decision_from_path(&path, &key).unwrap();
        assert!(loaded.is_some());

        let persisted: DecisionCacheStore =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(persisted.entries.len(), 1);
        assert!(persisted
            .entries
            .contains_key(&serde_json::to_string(&key).unwrap()));
        assert!(!persisted
            .entries
            .contains_key(&serde_json::to_string(&expired_key).unwrap()));
    }

    #[test]
    fn mcp_tools_call_invalid_argv_returns_request_error() {
        let parsed = ParsedWrapperArgs {
            options: WrapperOptions {
                api_key: None,
                api_url: DEFAULT_API_URL.to_string(),
                cache_ttl_seconds: 60,
                offline: true,
            },
            bash_argv: Vec::new(),
        };
        let message = json!({
            "params": {
                "name": "bash_exec",
                "arguments": {
                    "argv": ["-lc", 123]
                }
            }
        });

        let error = handle_mcp_tools_call(&message, &json!(1), &parsed, Path::new("/tmp"))
            .expect_err("expected invalid request");
        match error {
            McpCallError::InvalidRequest(message) => {
                assert!(message.contains("argv entries must be strings"))
            }
            other => panic!("unexpected error: {:?}", other_type_name(&other)),
        }
    }

    #[test]
    fn mcp_tools_call_unknown_tool_returns_request_error() {
        let parsed = ParsedWrapperArgs {
            options: WrapperOptions {
                api_key: None,
                api_url: DEFAULT_API_URL.to_string(),
                cache_ttl_seconds: 60,
                offline: true,
            },
            bash_argv: Vec::new(),
        };
        let message = json!({
            "params": {
                "name": "nope",
                "arguments": {
                    "argv": ["-lc", "echo ok"]
                }
            }
        });

        let error = handle_mcp_tools_call(&message, &json!(1), &parsed, Path::new("/tmp"))
            .expect_err("expected invalid request");
        match error {
            McpCallError::InvalidRequest(message) => {
                assert!(message.contains("Unknown tool"))
            }
            other => panic!("unexpected error: {:?}", other_type_name(&other)),
        }
    }

    fn other_type_name(error: &McpCallError) -> &'static str {
        match error {
            McpCallError::InvalidRequest(_) => "InvalidRequest",
            McpCallError::ToolFailure(_) => "ToolFailure",
        }
    }
}
