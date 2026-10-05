//! Reading the app's and the core's log files into one timeline.
//!
//! Both sources write the same line format — `[YYYY-MM-DD][HH:MM:SS][target][LEVEL] message`,
//! UTC, to the second — and rotate the same way, so one reader serves both: the tail of the
//! active `<stem>.log`, then the newest `<stem>_*.log` archives until the byte budget is spent.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

/// Where an entry came from. The derived order is the merge order within one second: the app's
/// entries come before the core's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogSource {
    App,
    Core,
}

impl LogSource {
    pub fn as_str(self) -> &'static str {
        match self {
            LogSource::App => "app",
            LogSource::Core => "core",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    /// `YYYY-MM-DDTHH:MM:SSZ`, taken from the line header as written, never converted.
    pub timestamp: String,
    pub source: LogSource,
    pub target: String,
    /// `TRACE`, `DEBUG`, `INFO`, `WARN` or `ERROR`, as in the file.
    pub level: String,
    /// The first line's text after the header, then any continuation lines, joined by `\n`.
    pub message: String,
}

impl LogEntry {
    /// `[date]`, `[time]` as the file header wrote them.
    pub fn date_and_time(&self) -> (&str, &str) {
        (&self.timestamp[..10], &self.timestamp[11..19])
    }
}

/// One source's share of a collection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRead {
    pub source: LogSource,
    /// Files that contributed bytes, the active one included.
    pub files: usize,
    pub entries: Vec<LogEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collection {
    pub app: SourceRead,
    pub core: SourceRead,
    /// Both sources, merged.
    pub entries: Vec<LogEntry>,
}

pub fn app_logs_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("logs")
}

pub fn core_logs_dir(data_folder: &Path) -> PathBuf {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let core_dir = crate::core::atomic_core::lock::core_dir(data_folder);
    // The mobile targets ship no core; the path only has to exist for the reader to find nothing.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let core_dir = data_folder.join("atomic-core");
    core_dir.join("logs")
}

/// The merged timeline of both sources, the freshest `budget_per_source` bytes of each.
pub fn collect(data_folder: &Path, budget_per_source: u64) -> Vec<LogEntry> {
    collect_sources(data_folder, budget_per_source).entries
}

pub fn collect_sources(data_folder: &Path, budget_per_source: u64) -> Collection {
    let app = read_source(
        &app_logs_dir(data_folder),
        "app",
        LogSource::App,
        budget_per_source,
    );
    let core = read_source(
        &core_logs_dir(data_folder),
        "core",
        LogSource::Core,
        budget_per_source,
    );
    let entries = merge(app.entries.clone(), core.entries.clone());
    Collection { app, core, entries }
}

/// Read one source: the tail of `<dir>/<stem>.log`, then its archives newest first, until
/// `budget` bytes have been read. A missing directory or file is an empty source.
pub fn read_source(dir: &Path, stem: &str, source: LogSource, budget: u64) -> SourceRead {
    let mut files = vec![dir.join(format!("{stem}.log"))];
    files.extend(archives(dir, stem));

    // Newest first while reading, oldest first when parsing.
    let mut chunks: Vec<String> = Vec::new();
    let mut remaining = budget;
    for path in files {
        if remaining == 0 {
            break;
        }
        let Ok(Some((text, read))) = read_tail(&path, remaining) else {
            continue;
        };
        remaining = remaining.saturating_sub(read);
        chunks.push(text);
    }
    let files = chunks.len();
    chunks.reverse();

    let mut entries = Vec::new();
    for chunk in &chunks {
        parse_into(chunk, source, &mut entries);
    }
    SourceRead {
        source,
        files,
        entries,
    }
}

/// `<stem>_*.log` in `dir`, newest first. The archive names embed their rotation time as
/// `YYYY-MM-DD_HH-MM-SS`, so name order is age order.
fn archives(dir: &Path, stem: &str) -> Vec<PathBuf> {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let prefix = format!("{stem}_");
    let mut names: Vec<String> = read_dir
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(&prefix) && name.ends_with(".log"))
        .collect();
    names.sort_unstable_by(|a, b| b.cmp(a));
    names.into_iter().map(|name| dir.join(name)).collect()
}

/// The last `budget` bytes of a file, cut to whole lines, and how many bytes were read.
/// `Ok(None)` when the file does not exist or is empty.
fn read_tail(path: &Path, budget: u64) -> std::io::Result<Option<(String, u64)>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(None);
    }
    let start = len.saturating_sub(budget);
    // One byte before the cut says whether it fell on a line boundary.
    let seek_to = start.saturating_sub(1);
    file.seek(SeekFrom::Start(seek_to))?;
    let mut bytes = Vec::with_capacity((len - seek_to) as usize);
    file.take(len - seek_to).read_to_end(&mut bytes)?;
    let read = bytes.len() as u64;
    let bytes = if start > 0 {
        // Drop the partial line in front of the cut (or just the newline that ends before it).
        match bytes.iter().position(|b| *b == b'\n') {
            Some(newline) => &bytes[newline + 1..],
            None => &bytes[bytes.len()..],
        }
    } else {
        &bytes[..]
    };
    Ok(Some((String::from_utf8_lossy(bytes).into_owned(), read)))
}

fn header() -> &'static Regex {
    static HEADER: OnceLock<Regex> = OnceLock::new();
    HEADER.get_or_init(|| {
        Regex::new(
            r"^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\]\[([^\]]*)\]\[(TRACE|DEBUG|INFO|WARN|ERROR)\] (.*)$",
        )
        .expect("log header pattern")
    })
}

/// A line that starts an entry, or `None` for a continuation line. Only a real calendar date
/// and time of day count: `[2026-13-45]` is text, not a header.
pub fn parse_header(line: &str, source: LogSource) -> Option<LogEntry> {
    let captures = header().captures(line)?;
    let (date, time) = (&captures[1], &captures[2]);
    chrono::NaiveDateTime::parse_from_str(&format!("{date} {time}"), "%Y-%m-%d %H:%M:%S").ok()?;
    Some(LogEntry {
        timestamp: format!("{date}T{time}Z"),
        source,
        target: captures[3].to_string(),
        level: captures[4].to_string(),
        message: captures[5].to_string(),
    })
}

/// Split text into entries. A line without a header continues the entry before it; lines
/// before the first header belong to an entry cut off by the budget and are dropped.
fn parse_into(text: &str, source: LogSource, entries: &mut Vec<LogEntry>) {
    let mut current: Option<LogEntry> = None;
    for line in text.lines() {
        if let Some(entry) = parse_header(line, source) {
            entries.extend(current.replace(entry));
        } else if let Some(entry) = current.as_mut() {
            entry.message.push('\n');
            entry.message.push_str(line);
        }
    }
    entries.extend(current);
}

/// One timeline, ordered by (time, app before core, position within the source).
pub fn merge(app: Vec<LogEntry>, core: Vec<LogEntry>) -> Vec<LogEntry> {
    let mut keyed: Vec<(usize, LogEntry)> = app
        .into_iter()
        .enumerate()
        .chain(core.into_iter().enumerate())
        .collect();
    keyed.sort_by(|(ia, a), (ib, b)| {
        a.timestamp
            .cmp(&b.timestamp)
            .then(a.source.cmp(&b.source))
            .then(ia.cmp(ib))
    });
    keyed.into_iter().map(|(_, entry)| entry).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A copy of `atomic-chat-core/test/fixtures/core-log/sample.log` at core commit 8c6f262
    /// ("Pin the core.log file format as a core -> app contract"). The core owns this format;
    /// refresh the copy from there when it changes.
    const CORE_SAMPLE: &str = include_str!("testdata/core-sample.log");

    fn line(time: &str, target: &str, level: &str, message: &str) -> String {
        format!("[2026-09-28][{time}][{target}][{level}] {message}\n")
    }

    fn write(dir: &Path, name: &str, text: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(name), text).unwrap();
    }

    fn messages(entries: &[LogEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.message.as_str()).collect()
    }

    #[test]
    fn reads_a_header_as_written_without_converting_the_time() {
        let entry = parse_header(
            "[2026-09-28][12:00:05][app_lib::core][WARN] slow start",
            LogSource::App,
        )
        .unwrap();

        assert_eq!(entry.timestamp, "2026-09-28T12:00:05Z");
        assert_eq!(entry.target, "app_lib::core");
        assert_eq!(entry.level, "WARN");
        assert_eq!(entry.message, "slow start");
        assert_eq!(entry.date_and_time(), ("2026-09-28", "12:00:05"));
    }

    #[test]
    fn a_header_needs_a_real_date_a_known_level_and_the_first_column() {
        for text in [
            "[2026-13-45][12:00:05][core][INFO] month 13",
            "[2026-09-28][25:00:05][core][INFO] hour 25",
            "[2026-09-28][12:00:05][core][NOTICE] unknown level",
            "[2026-09-28][12:00:05][core][INFO]no space",
            " [2026-09-28][12:00:05][core][INFO] indented",
            "  | [2026-09-28][12:00:05][core][ERROR] quoted tail line",
        ] {
            assert_eq!(parse_header(text, LogSource::Core), None, "{text}");
        }
    }

    #[test]
    fn a_message_that_starts_with_a_bracket_does_not_split_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "app.log",
            &format!(
                "{}[stderr] not a header\n[2026-09-28] not one either\n",
                line("12:00:00", "t", "INFO", "[a][b] bracketed")
            ),
        );

        let read = read_source(dir.path(), "app", LogSource::App, 1 << 20);

        assert_eq!(
            messages(&read.entries),
            vec!["[a][b] bracketed\n[stderr] not a header\n[2026-09-28] not one either"]
        );
    }

    #[test]
    fn reads_the_newest_archive_when_the_active_file_is_short() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "app_2026-09-27_10-00-00.log",
            &line("10:00:00", "t", "INFO", "oldest"),
        );
        write(
            dir.path(),
            "app_2026-09-28_11-00-00.log",
            &line("11:00:00", "t", "INFO", "archived"),
        );
        write(
            dir.path(),
            "app.log",
            &line("12:00:00", "t", "INFO", "fresh"),
        );

        let read = read_source(dir.path(), "app", LogSource::App, 1 << 20);

        assert_eq!(messages(&read.entries), vec!["oldest", "archived", "fresh"]);
        assert_eq!(read.files, 3);
    }

    #[test]
    fn a_just_rotated_log_shows_the_archive_and_the_new_lines() {
        let dir = tempfile::tempdir().unwrap();
        let archived: String = (0..50)
            .map(|i| line("11:00:00", "t", "INFO", &format!("archived {i}")))
            .collect();
        write(dir.path(), "app_2026-09-28_11-59-59.log", &archived);
        write(
            dir.path(),
            "app.log",
            &(line("12:00:00", "t", "INFO", "new 1") + &line("12:00:01", "t", "INFO", "new 2")),
        );

        let read = read_source(dir.path(), "app", LogSource::App, 1 << 20);

        assert_eq!(read.entries.len(), 52);
        assert_eq!(read.entries[0].message, "archived 0");
        assert_eq!(read.entries[51].message, "new 2");
    }

    #[test]
    fn stops_at_the_budget_and_keeps_the_freshest_lines() {
        let dir = tempfile::tempdir().unwrap();
        let one = line("12:00:00", "t", "INFO", "x");
        write(
            dir.path(),
            "app_2026-09-28_11-00-00.log",
            &line("11:00:00", "t", "INFO", "never read"),
        );
        let active: String = (0..10)
            .map(|i| line(&format!("12:00:{i:02}"), "t", "INFO", "x"))
            .collect();
        write(dir.path(), "app.log", &active);

        // Three whole lines, plus a partial one in front of them.
        let read = read_source(
            dir.path(),
            "app",
            LogSource::App,
            (one.len() * 3 + 5) as u64,
        );

        let times: Vec<&str> = read.entries.iter().map(|e| e.date_and_time().1).collect();
        assert_eq!(times, vec!["12:00:07", "12:00:08", "12:00:09"]);
        assert_eq!(read.files, 1, "the budget ran out inside the active file");
    }

    #[test]
    fn a_cut_on_a_line_boundary_keeps_that_line() {
        let dir = tempfile::tempdir().unwrap();
        let first = line("12:00:00", "t", "INFO", "first");
        let second = line("12:00:01", "t", "INFO", "second");
        write(dir.path(), "app.log", &(first + &second));

        let read = read_source(dir.path(), "app", LogSource::App, second.len() as u64);

        assert_eq!(messages(&read.entries), vec!["second"]);
    }

    #[test]
    fn drops_continuation_lines_left_over_from_a_cut_entry() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "core.log",
            &format!(
                "  cause: out of memory\n  hint: smaller quant\n{}",
                line("12:00:00", "core", "INFO", "next")
            ),
        );

        let read = read_source(dir.path(), "core", LogSource::Core, 1 << 20);

        assert_eq!(messages(&read.entries), vec!["next"]);
    }

    #[test]
    fn without_core_log_only_the_app_is_collected() {
        let data = tempfile::tempdir().unwrap();
        write(
            &data.path().join("logs"),
            "app.log",
            &line("12:00:00", "t", "INFO", "app only"),
        );

        let collection = collect_sources(data.path(), 1 << 20);

        assert_eq!(messages(&collection.entries), vec!["app only"]);
        assert_eq!(collection.core.files, 0);
        assert!(collect(&data.path().join("missing"), 1 << 20).is_empty());
    }

    #[test]
    fn within_one_second_the_app_comes_first_and_each_source_keeps_its_order() {
        let entry = |source, time: &str, message: &str| LogEntry {
            timestamp: format!("2026-09-28T{time}Z"),
            source,
            target: "t".into(),
            level: "INFO".into(),
            message: message.into(),
        };
        let app = vec![
            entry(LogSource::App, "12:00:05", "app b"),
            entry(LogSource::App, "12:00:05", "app a"),
            entry(LogSource::App, "12:00:06", "app c"),
        ];
        let core = vec![
            entry(LogSource::Core, "12:00:04", "core 0"),
            entry(LogSource::Core, "12:00:05", "core b"),
            entry(LogSource::Core, "12:00:05", "core a"),
        ];

        let merged = merge(app, core);

        assert_eq!(
            messages(&merged),
            vec!["core 0", "app b", "app a", "core b", "core a", "app c"]
        );
    }

    #[test]
    fn a_multi_line_entry_stays_whole_through_the_merge() {
        let data = tempfile::tempdir().unwrap();
        write(
            &data.path().join("logs"),
            "app.log",
            &line("12:00:10", "t", "INFO", "app"),
        );
        write(
            &data.path().join("atomic-core").join("logs"),
            "core.log",
            &format!(
                "{}  cause: one\n  hint: two\n",
                line("12:00:10", "core", "ERROR", "load failed")
            ),
        );

        let entries = collect(data.path(), 1 << 20);

        assert_eq!(
            messages(&entries),
            vec!["app", "load failed\n  cause: one\n  hint: two"]
        );
        assert_eq!(entries[1].source, LogSource::Core);
    }

    #[test]
    fn reads_the_core_contract_fixture() {
        let data = tempfile::tempdir().unwrap();
        write(
            &data.path().join("atomic-core").join("logs"),
            "core.log",
            CORE_SAMPLE,
        );

        let entries = collect(data.path(), 1 << 20);

        let summary: Vec<(&str, &str, &str)> = entries
            .iter()
            .map(|e| (e.date_and_time().1, e.target.as_str(), e.level.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("12:00:00", "core", "INFO"),
                ("12:00:05", "core", "WARN"),
                ("12:00:10", "core", "ERROR"),
                ("12:00:15", "engine:llamacpp/qwen3-8b", "INFO"),
                ("12:00:20", "engine:llamacpp/qwen3-8b", "INFO"),
            ]
        );
        assert_eq!(
            entries[2].message,
            "model load failed: qwen3-8b\n  cause: out of memory allocating KV cache\n  hint: reduce --ctx-size or use a smaller quant"
        );
        assert!(entries[3]
            .message
            .starts_with("[stderr] llama_model_loader"));
        assert!(entries[4]
            .message
            .starts_with("[stdout] main: server is listening"));
        assert!(entries.iter().all(|e| e.source == LogSource::Core));
    }
}
