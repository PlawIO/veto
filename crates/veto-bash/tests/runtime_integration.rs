use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn binary_path() -> &'static str {
    env!("CARGO_BIN_EXE_veto-bash-native")
}

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let root = std::env::temp_dir().join(format!(
        "veto-bash-integration-{prefix}-{}-{millis}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

fn write_local_project(root: &Path, rules_yaml: &str) {
    let veto_dir = root.join("veto");
    let rules_dir = veto_dir.join("rules");
    fs::create_dir_all(&rules_dir).unwrap();
    fs::write(veto_dir.join("veto.config.yaml"), "mode: local\n").unwrap();
    fs::write(rules_dir.join("bash.yaml"), rules_yaml).unwrap();
}

fn run_native(args: &[&str], cwd: &Path, home: &Path) -> Output {
    Command::new(binary_path())
        .args(args)
        .current_dir(cwd)
        .env("HOME", home)
        .env("VETO_BASH_REAL_BASH", "/bin/bash")
        .output()
        .unwrap()
}

fn audit_spool_path(home: &Path) -> PathBuf {
    home.join(".veto")
        .join("audit")
        .join("veto-bash-spool.jsonl")
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn write_mcp_message(writer: &mut impl Write, value: &Value) {
    let body = serde_json::to_vec(value).unwrap();
    write!(writer, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
    writer.write_all(&body).unwrap();
    writer.flush().unwrap();
}

fn read_mcp_message(reader: &mut impl Read) -> Value {
    let mut header_bytes = Vec::new();
    let mut buffer = [0u8; 1];
    loop {
        reader.read_exact(&mut buffer).unwrap();
        header_bytes.push(buffer[0]);
        if header_bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }

    let header_text = String::from_utf8(header_bytes).unwrap();
    let content_length = header_text
        .split("\r\n")
        .find_map(|line| line.strip_prefix("Content-Length:"))
        .map(|value| value.trim().parse::<usize>().unwrap())
        .unwrap();

    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[test]
fn offline_local_allow_executes_and_spools_audit_event() {
    let root = unique_temp_dir("allow");
    let home = root.join("home");
    let workspace = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    write_local_project(
        &workspace,
        r#"rules:
  - id: allow-integration-echo
    description: allow integration echo
    action: allow
    tools: [bash]
    conditions:
      - field: arguments.command
        operator: equals
        value: echo integration-ok
"#,
    );

    let output = run_native(
        &["--offline", "-c", "echo integration-ok"],
        &workspace,
        &home,
    );

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "integration-ok\n");

    let events = read_jsonl(&audit_spool_path(&home));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["decision"], "allow");
    assert_eq!(events[0]["source"], "local");
    assert_eq!(events[0]["reason"], "allow integration echo");
    assert_eq!(events[0]["arguments"]["command"], "echo integration-ok");
    assert_eq!(events[0]["arguments"]["shellMode"], "command");
}

#[test]
fn offline_local_block_denies_without_running_command() {
    let root = unique_temp_dir("block");
    let home = root.join("home");
    let workspace = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    write_local_project(
        &workspace,
        r#"rules:
  - id: block-denied-write
    description: denied.txt writes require review
    action: block
    tools: [bash]
    conditions:
      - field: arguments.command
        operator: contains
        value: denied.txt
"#,
    );

    let denied_file = workspace.join("denied.txt");
    let output = run_native(
        &["--offline", "-c", "echo blocked > denied.txt"],
        &workspace,
        &home,
    );

    assert!(!output.status.success(), "command unexpectedly succeeded");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("denied.txt writes require review"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!denied_file.exists(), "blocked command should not execute");

    let events = read_jsonl(&audit_spool_path(&home));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["decision"], "deny");
    assert_eq!(events[0]["source"], "local");
    assert_eq!(
        events[0]["arguments"]["command"],
        "echo blocked > denied.txt"
    );
}

#[test]
fn mcp_serve_survives_invalid_request_and_executes_next_call() {
    let root = unique_temp_dir("mcp");
    let home = root.join("home");
    let workspace = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    write_local_project(
        &workspace,
        r#"rules:
  - id: allow-mcp-echo
    description: allow mcp echo
    action: allow
    tools: [bash]
    conditions:
      - field: arguments.command
        operator: equals
        value: echo mcp-ok
"#,
    );

    let mut child = Command::new(binary_path())
        .args(["mcp", "serve", "--offline"])
        .current_dir(&workspace)
        .env("HOME", &home)
        .env("VETO_BASH_REAL_BASH", "/bin/bash")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    write_mcp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "integration-test",
                    "version": "0.0.0"
                }
            }
        }),
    );
    let initialize = read_mcp_message(&mut stdout);
    assert_eq!(initialize["id"], 1);
    assert_eq!(initialize["result"]["serverInfo"]["name"], "veto-bash");

    write_mcp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "bash_exec",
                "arguments": {
                    "argv": ["-lc", 123]
                }
            }
        }),
    );
    let invalid = read_mcp_message(&mut stdout);
    assert_eq!(invalid["id"], 2);
    assert_eq!(invalid["error"]["code"], -32602);
    assert_eq!(invalid["error"]["message"], "argv entries must be strings");

    write_mcp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "bash_exec",
                "arguments": {
                    "argv": ["-lc", "echo mcp-ok"],
                    "cwd": workspace.to_string_lossy().to_string()
                }
            }
        }),
    );
    let success = read_mcp_message(&mut stdout);
    let text = success["result"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(success["id"], 3);
    assert!(success["error"].is_null());
    assert!(text.contains("exitCode: 0"), "unexpected response: {text}");
    assert!(
        text.contains("stdout:\nmcp-ok\n"),
        "unexpected response: {text}"
    );

    drop(stdin);
    let status = child.wait().unwrap();
    let mut stderr_text = String::new();
    stderr.read_to_string(&mut stderr_text).unwrap();
    assert!(status.success(), "stderr: {stderr_text}");
}
