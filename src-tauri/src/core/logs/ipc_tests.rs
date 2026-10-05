use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use super::commands::*;
use crate::test_support::IpcTestHarness;

fn harness() -> IpcTestHarness {
    IpcTestHarness::new(|builder| {
        builder.invoke_handler(tauri::generate_handler![read_unified_logs, export_logs])
    })
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn seed_logs(data: &Path) {
    write(
        &data.join("logs").join("app.log"),
        "[2026-09-28][12:00:05][app_lib::core][INFO] loading qwen3-8b\n\
         [2026-09-28][12:00:20][app_lib::core][WARN] token hf_AbCdEf in a log line\n",
    );
    write(
        &data.join("atomic-core").join("logs").join("core.log"),
        "[2026-09-28][12:00:05][core][INFO] load requested\n\
         [2026-09-28][12:00:10][engine:llamacpp/qwen3-8b][INFO] [stderr] loaded\n  second line\n",
    );
}

#[test]
fn read_unified_logs_returns_one_timeline_with_sources() {
    let harness = harness();
    seed_logs(harness.data_root());

    let entries: Vec<Value> = harness.invoke("read_unified_logs", json!({})).unwrap();

    assert_eq!(
        entries[0],
        json!({
            "timestamp": "2026-09-28T12:00:05Z",
            "source": "app",
            "target": "app_lib::core",
            "level": "INFO",
            "message": "loading qwen3-8b",
        })
    );
    let order: Vec<(&str, &str)> = entries
        .iter()
        .map(|e| {
            (
                e["source"].as_str().unwrap(),
                e["message"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        order,
        vec![
            ("app", "loading qwen3-8b"),
            ("core", "load requested"),
            ("core", "[stderr] loaded\n  second line"),
            ("app", "token hf_AbCdEf in a log line"),
        ]
    );
}

#[test]
fn read_unified_logs_is_empty_without_any_log() {
    let harness = harness();

    let entries: Vec<Value> = harness.invoke("read_unified_logs", json!({})).unwrap();

    assert!(entries.is_empty());
}

#[test]
fn export_logs_writes_one_scrubbed_file_and_reports_it() {
    let harness = harness();
    seed_logs(harness.data_root());
    let out = tempfile::tempdir().unwrap();
    let path = out.path().join("atomic-chat-logs-2026-09-28_12-30-00.log");

    let result: Value = harness
        .invoke("export_logs", json!({ "path": path.to_string_lossy() }))
        .unwrap();

    let text = fs::read_to_string(&path).unwrap();
    assert_eq!(result["path"], json!(path.to_string_lossy()));
    assert_eq!(result["bytes"], json!(text.len()));
    assert!(text.starts_with("# Atomic Chat logs\n"));
    assert!(
        text.contains("\n# core: unknown\n"),
        "no core and no lock:\n{text}"
    );
    assert!(text.contains("\n# timezone: UTC (local UTC"));
    assert!(text.contains("\n[2026-09-28][12:00:05][app][app_lib::core][INFO] loading qwen3-8b\n"));
    assert!(text.contains(
        "\n[2026-09-28][12:00:10][core][engine:llamacpp/qwen3-8b][INFO] [stderr] loaded\n  second line\n"
    ));
    assert!(text.contains("token <redacted> in a log line"));
}

#[test]
fn export_logs_names_the_core_version_from_its_lock() {
    let harness = harness();
    seed_logs(harness.data_root());
    write(
        &harness
            .data_root()
            .join("atomic-core")
            .join("instance.lock"),
        &json!({
            "instance_id": "i-1",
            "pid": 1,
            "protocol": 1,
            "version": "0.7.0",
            "control_host": "127.0.0.1",
            "control_port": 0,
            "state": "starting",
        })
        .to_string(),
    );
    let out = tempfile::tempdir().unwrap();
    let path = out.path().join("logs.log");

    let _: Value = harness
        .invoke("export_logs", json!({ "path": path.to_string_lossy() }))
        .unwrap();

    assert!(fs::read_to_string(&path)
        .unwrap()
        .contains("\n# core: 0.7.0\n"));
}

#[test]
fn export_logs_into_a_missing_folder_fails_without_a_file() {
    let harness = harness();
    seed_logs(harness.data_root());
    let out = tempfile::tempdir().unwrap();
    let path = out.path().join("missing").join("logs.log");

    let error = harness
        .invoke::<Value>("export_logs", json!({ "path": path.to_string_lossy() }))
        .unwrap_err();

    assert!(error.as_str().unwrap().contains("logs.log"), "{error}");
    assert!(!path.exists());
}
