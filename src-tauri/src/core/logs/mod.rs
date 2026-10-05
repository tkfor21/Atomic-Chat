//! One place for the app's and the core's logs (change `add-unified-logs`).
//!
//! The app writes `<data>/logs/app.log`; the core it starts writes
//! `<data>/atomic-core/logs/core.log` itself, because it outlives the app and a pipe to it would
//! not. Both use the same line format and rotation, so the Logs window and the export read both
//! files from disk and merge them here, whether or not the core is running.

pub mod collect;
pub mod commands;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod export;
#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod ipc_tests;

use chrono::{DateTime, Utc};

/// `[YYYY-MM-DD][HH:MM:SS][target][LEVEL] ` in UTC: the header `app.log` has always had, and the
/// one the core writes in `core.log`. Spelled out rather than left to `tauri-plugin-log`, whose
/// `timezone_strategy` would also swap the target and level columns.
pub fn line_header(now: DateTime<Utc>, target: &str, level: log::Level) -> String {
    format!("{}[{target}][{level}] ", now.format("[%Y-%m-%d][%H:%M:%S]"))
}

#[cfg(test)]
mod tests {
    use super::collect::{parse_header, LogSource};
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn the_app_log_header_is_the_one_the_reader_expects() {
        let now = Utc.with_ymd_and_hms(2026, 9, 28, 12, 0, 5).unwrap();

        let line = format!(
            "{}started",
            line_header(now, "app_lib::core", log::Level::Warn)
        );

        assert_eq!(line, "[2026-09-28][12:00:05][app_lib::core][WARN] started");
        let entry = parse_header(&line, LogSource::App).unwrap();
        assert_eq!(entry.timestamp, "2026-09-28T12:00:05Z");
        assert_eq!(
            (entry.target.as_str(), entry.level.as_str()),
            ("app_lib::core", "WARN")
        );
    }

    #[test]
    fn every_level_is_written_the_way_the_reader_accepts_it() {
        let now = Utc.with_ymd_and_hms(2026, 9, 28, 12, 0, 5).unwrap();
        for level in [
            log::Level::Trace,
            log::Level::Debug,
            log::Level::Info,
            log::Level::Warn,
            log::Level::Error,
        ] {
            let line = format!("{}x", line_header(now, "t", level));
            assert!(parse_header(&line, LogSource::App).is_some(), "{line}");
        }
    }
}
