use tauri::{AppHandle, Runtime};

use super::collect::{collect, LogEntry};
use crate::core::app::commands::get_jan_data_folder_path;

/// Per source, for the Logs window. It polls every 3 s, so only tails are read.
pub const WINDOW_BUDGET: u64 = 2 * 1024 * 1024;
/// Per source, for an export: enough to hold the last incident even when engine output is chatty.
pub const EXPORT_BUDGET: u64 = 10 * 1024 * 1024;

/// The app's and the core's logs as one timeline, read from disk: the core does not have to be
/// running for its history to show.
#[tauri::command]
pub async fn read_unified_logs<R: Runtime>(app: AppHandle<R>) -> Result<Vec<LogEntry>, String> {
    let data_folder = get_jan_data_folder_path(app);
    tauri::async_runtime::spawn_blocking(move || collect(&data_folder, WINDOW_BUDGET))
        .await
        .map_err(|e| e.to_string())
}

/// Write both logs, scrubbed, into the one file at `path`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn export_logs<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<super::export::ExportResult, String> {
    use super::collect::collect_sources;
    use super::export::{render, write_atomically, ExportInfo};

    let data_folder = get_jan_data_folder_path(app.clone());
    let info = ExportInfo {
        app_version: app.package_info().version.to_string(),
        core_version: core_version(&app, &data_folder).await,
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        exported_at: chrono::Utc::now(),
        local_offset: *chrono::Local::now().offset(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let collection = collect_sources(&data_folder, EXPORT_BUDGET);
        write_atomically(std::path::Path::new(&path), &render(&info, &collection))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The connected core's version; failing that, the one its lock names — the core that wrote the
/// newest `core.log` lines, even if it has stopped since.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn core_version<R: Runtime>(
    app: &AppHandle<R>,
    data_folder: &std::path::Path,
) -> Option<String> {
    use crate::core::atomic_core::{commands::AtomicCoreClient, lock};
    use tauri::Manager;

    if let Some(client) = app.try_state::<AtomicCoreClient>() {
        if let Some(attached) = client.supervisor().current().await {
            return Some(attached.version.clone());
        }
    }
    let text = std::fs::read_to_string(lock::instance_lock_path(data_folder)).ok()?;
    lock::parse_lock(&text).map(|record| record.version)
}
