//! Writing both logs into one file a user can send us.
//!
//! The file is the merged timeline behind a `# ` header that says what produced it. Every line
//! goes through the same scrubber as the log tail attached to crash reports, and the file
//! appears only once it is complete: it is written beside its destination and renamed into
//! place, so a failed export leaves nothing behind.

use std::io::Write;
use std::path::Path;

use chrono::{DateTime, FixedOffset, Utc};
use serde::Serialize;

use super::collect::{Collection, LogEntry, SourceRead};
use crate::core::telemetry::scrub::scrub;

/// What the header says about the machine and the export itself.
#[derive(Debug, Clone)]
pub struct ExportInfo {
    pub app_version: String,
    /// `None` when neither a connected core nor `instance.lock` named one.
    pub core_version: Option<String>,
    pub os: String,
    pub arch: String,
    pub exported_at: DateTime<Utc>,
    /// The user's local offset from UTC at export time.
    pub local_offset: FixedOffset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub bytes: u64,
}

/// The whole file: header, a blank line, then every entry, scrubbed line by line.
pub fn render(info: &ExportInfo, collection: &Collection) -> String {
    let mut out = String::new();
    for line in header_lines(info, collection) {
        out.push_str("# ");
        out.push_str(&line);
        out.push('\n');
    }
    out.push('\n');
    for entry in &collection.entries {
        for line in entry_text(entry).lines() {
            out.push_str(&scrub(line));
            out.push('\n');
        }
    }
    out
}

fn header_lines(info: &ExportInfo, collection: &Collection) -> Vec<String> {
    vec![
        "Atomic Chat logs".to_string(),
        format!("app: {}", info.app_version),
        format!(
            "core: {}",
            info.core_version.as_deref().unwrap_or("unknown")
        ),
        format!("os: {} {}", info.os, info.arch),
        format!(
            "exported: {}",
            info.exported_at.format("%Y-%m-%d %H:%M:%S UTC")
        ),
        format!("timezone: UTC (local {})", utc_offset(info.local_offset)),
        source_line(&collection.app, "app.log"),
        source_line(&collection.core, "core.log"),
    ]
}

/// `UTC+03:00`, `UTC-05:30`, `UTC+00:00`.
fn utc_offset(offset: FixedOffset) -> String {
    let seconds = offset.local_minus_utc();
    let sign = if seconds < 0 { '-' } else { '+' };
    let minutes = seconds.unsigned_abs() / 60;
    format!("UTC{sign}{:02}:{:02}", minutes / 60, minutes % 60)
}

fn source_line(read: &SourceRead, name: &str) -> String {
    let files = count(read.files, "file", "files");
    // A clock set back can make a file's lines go back in time, so the range is the extremes.
    let first = read.entries.iter().map(|e| &e.timestamp).min();
    let last = read.entries.iter().map(|e| &e.timestamp).max();
    match (first, last) {
        (Some(first), Some(last)) => format!(
            "{name}: {files}, {}, {} .. {} UTC",
            count(read.entries.len(), "entry", "entries"),
            readable(first),
            readable(last)
        ),
        _ => format!("{name}: {files}, no entries"),
    }
}

fn count(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// `2026-09-28T12:00:05Z` → `2026-09-28 12:00:05`.
fn readable(timestamp: &str) -> String {
    timestamp.trim_end_matches('Z').replacen('T', " ", 1)
}

/// `[date][time][app|core][target][LEVEL] message`, continuation lines as they were.
fn entry_text(entry: &LogEntry) -> String {
    let (date, time) = entry.date_and_time();
    format!(
        "[{date}][{time}][{}][{}][{}] {}",
        entry.source.as_str(),
        entry.target,
        entry.level,
        entry.message
    )
}

/// Write `content` to `path` through a temporary file in the same folder, so the destination
/// either appears complete or not at all.
pub fn write_atomically(path: &Path, content: &str) -> Result<ExportResult, String> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| format!("not a file path: {}", path.display()))?;
    let temp = dir.join(format!(
        ".{}.{}.partial",
        name.to_string_lossy(),
        std::process::id()
    ));

    let written = std::fs::File::create(&temp).and_then(|mut file| {
        file.write_all(content.as_bytes())?;
        file.sync_all()
    });
    if let Err(e) = written.and_then(|_| std::fs::rename(&temp, path)) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("could not write {}: {e}", path.display()));
    }
    Ok(ExportResult {
        path: path.to_string_lossy().into_owned(),
        bytes: content.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::logs::collect::{merge, LogSource};
    use chrono::TimeZone;

    fn entry(source: LogSource, time: &str, target: &str, level: &str, message: &str) -> LogEntry {
        LogEntry {
            timestamp: format!("2026-09-28T{time}Z"),
            source,
            target: target.into(),
            level: level.into(),
            message: message.into(),
        }
    }

    fn collection(app: Vec<LogEntry>, core: Vec<LogEntry>) -> Collection {
        Collection {
            app: SourceRead {
                source: LogSource::App,
                files: if app.is_empty() { 0 } else { 2 },
                entries: app.clone(),
            },
            core: SourceRead {
                source: LogSource::Core,
                files: if core.is_empty() { 0 } else { 1 },
                entries: core.clone(),
            },
            entries: merge(app, core),
        }
    }

    fn info(core_version: Option<&str>, offset_hours: i32) -> ExportInfo {
        ExportInfo {
            app_version: "2.1.0".into(),
            core_version: core_version.map(str::to_string),
            os: "macos".into(),
            arch: "aarch64".into(),
            exported_at: Utc.with_ymd_and_hms(2026, 9, 28, 12, 30, 0).unwrap(),
            local_offset: FixedOffset::east_opt(offset_hours * 3600).unwrap(),
        }
    }

    fn sample() -> Collection {
        collection(
            vec![
                entry(
                    LogSource::App,
                    "12:00:05",
                    "app_lib::core",
                    "INFO",
                    "loading",
                ),
                entry(LogSource::App, "12:00:20", "app_lib::core", "WARN", "slow"),
            ],
            vec![entry(
                LogSource::Core,
                "12:00:05",
                "engine:llamacpp/qwen3-8b",
                "INFO",
                "[stderr] loaded\n  second line",
            )],
        )
    }

    #[test]
    fn the_header_carries_every_field_then_a_blank_line() {
        let text = render(&info(Some("0.7.0"), 0), &sample());

        let (header, body) = text.split_once("\n\n").unwrap();
        assert_eq!(
            header.lines().collect::<Vec<_>>(),
            vec![
                "# Atomic Chat logs",
                "# app: 2.1.0",
                "# core: 0.7.0",
                "# os: macos aarch64",
                "# exported: 2026-09-28 12:30:00 UTC",
                "# timezone: UTC (local UTC+00:00)",
                "# app.log: 2 files, 2 entries, 2026-09-28 12:00:05 .. 2026-09-28 12:00:20 UTC",
                "# core.log: 1 file, 1 entry, 2026-09-28 12:00:05 .. 2026-09-28 12:00:05 UTC",
            ]
        );
        assert_eq!(
            body.lines().collect::<Vec<_>>(),
            vec![
                "[2026-09-28][12:00:05][app][app_lib::core][INFO] loading",
                "[2026-09-28][12:00:05][core][engine:llamacpp/qwen3-8b][INFO] [stderr] loaded",
                "  second line",
                "[2026-09-28][12:00:20][app][app_lib::core][WARN] slow",
            ]
        );
    }

    #[test]
    fn the_local_offset_is_written_with_its_sign() {
        assert!(render(&info(None, 3), &sample()).contains("# timezone: UTC (local UTC+03:00)\n"));
        assert!(render(&info(None, -5), &sample()).contains("# timezone: UTC (local UTC-05:00)\n"));
        assert_eq!(
            utc_offset(FixedOffset::east_opt(5 * 3600 + 30 * 60).unwrap()),
            "UTC+05:30"
        );
    }

    #[test]
    fn an_unknown_core_version_and_an_empty_source_are_said_plainly() {
        let text = render(&info(None, 0), &collection(sample().app.entries, vec![]));

        assert!(text.contains("# core: unknown\n"));
        assert!(text.contains("# core.log: 0 files, no entries\n"));
    }

    #[test]
    fn secrets_and_the_user_name_are_masked() {
        let secrets = collection(
            vec![entry(
                LogSource::App,
                "12:00:00",
                "t",
                "INFO",
                "model at /Users/alice/Library/models/q.gguf",
            )],
            vec![entry(
                LogSource::Core,
                "12:00:01",
                "core",
                "INFO",
                "Authorization: Bearer sk-123\n  retry with Bearer sk-456",
            )],
        );

        let text = render(&info(None, 0), &secrets);

        assert!(text.contains("/Users/<redacted>/Library/models/q.gguf"));
        assert!(text.contains("Authorization: Bearer <redacted>\n"));
        assert!(text.contains("  retry with Bearer <redacted>\n"));
        assert!(!text.contains("alice") && !text.contains("sk-123") && !text.contains("sk-456"));
    }

    #[test]
    fn writes_the_file_and_reports_its_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("atomic-chat-logs.log");

        let result = write_atomically(&path, "# header\n\nline\n").unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# header\n\nline\n"
        );
        assert_eq!(result.bytes, "# header\n\nline\n".len() as u64);
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "no temporary file left"
        );
    }

    #[test]
    fn a_folder_that_cannot_be_written_is_an_error_and_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let path = missing.join("atomic-chat-logs.log");

        let error = write_atomically(&path, "content").unwrap_err();

        assert!(error.contains("atomic-chat-logs.log"), "{error}");
        assert!(!path.exists());
        assert!(!missing.exists());
    }

    #[test]
    #[cfg(unix)]
    fn a_read_only_folder_is_an_error_and_leaves_no_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let path = locked.join("atomic-chat-logs.log");

        let result = write_atomically(&path, "content");

        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read_dir(&locked).unwrap().count(), 0);
    }
}
