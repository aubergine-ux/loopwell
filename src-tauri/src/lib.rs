//! The desktop shell around Loopwell. The instrument itself is the same web
//! app; this adds what a browser tab can't do: browsing sample folders on
//! disk, opening project files handed over by the operating system, and
//! saving exports through a native dialog.

mod files;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use files::{AudioFile, Library};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Folders the user has chosen, and files the system asked us to open.
struct Shell {
    library: Mutex<Library>,
    /// Project files passed on the command line or by "Open with", waiting for the window to take them.
    opened: Mutex<Vec<PathBuf>>,
    /// Every project file the system has handed us; only these may be read.
    allowed: Mutex<HashSet<PathBuf>>,
}

fn library_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("folders.json"))
}

#[tauri::command]
fn sample_folders(shell: State<Shell>) -> Vec<String> {
    shell.library.lock().unwrap().folders()
}

/// Shows a folder picker and remembers the choice. Returns the folder, or nothing if cancelled.
#[tauri::command]
async fn add_sample_folder(app: AppHandle, shell: State<'_, Shell>) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().set_title("Choose a folder of samples").blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let mut lib = shell.library.lock().unwrap();
    let added = lib.add(&path)?;
    if let Some(file) = library_file(&app) {
        lib.save(&file);
    }
    Ok(Some(added))
}

#[tauri::command]
fn remove_sample_folder(app: AppHandle, shell: State<Shell>, folder: String) {
    let mut lib = shell.library.lock().unwrap();
    lib.remove(&folder);
    if let Some(file) = library_file(&app) {
        lib.save(&file);
    }
}

#[tauri::command]
fn list_samples(shell: State<Shell>, folder: String) -> Result<Vec<AudioFile>, String> {
    shell.library.lock().unwrap().list(&folder)
}

#[tauri::command]
fn read_sample(shell: State<Shell>, path: String) -> Result<tauri::ipc::Response, String> {
    shell.library.lock().unwrap().read(&path).map(tauri::ipc::Response::new)
}

/// Project files waiting to be opened (from the command line or the file manager). Each is handed out once.
#[tauri::command]
fn take_opened(shell: State<Shell>) -> Vec<String> {
    shell.opened.lock().unwrap().drain(..).map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Reads a project file. Only files the system asked us to open can be read this way.
#[tauri::command]
fn read_project(shell: State<Shell>, path: String) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    if !shell.allowed.lock().unwrap().contains(&path) {
        return Err("That file was not opened with Loopwell.".into());
    }
    files::read_project(&path).map(tauri::ipc::Response::new)
}

/// Asks where to save, then writes the file. Returns false if the dialog was cancelled.
#[tauri::command]
async fn save_file(app: AppHandle, name: String, data: Vec<u8>) -> Result<bool, String> {
    let ext = name.rsplit('.').next().unwrap_or("").to_string();
    let mut dialog = app.dialog().file().set_file_name(&name);
    if !ext.is_empty() && ext != name {
        dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
    }
    let Some(target) = dialog.blocking_save_file() else { return Ok(false) };
    let path = target.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(true)
}

/// A line from the app for the terminal, shown when LOOPWELL_LOG is set. Handy when audio won't start on some machine.
#[tauri::command]
fn log(message: String) {
    if std::env::var_os("LOOPWELL_LOG").is_some() {
        eprintln!("[loopwell] {message}");
    }
}

fn queue_opened(app: &AppHandle, paths: Vec<PathBuf>) {
    let projects: Vec<PathBuf> = paths.into_iter().filter(|p| files::is_project(p)).collect();
    if projects.is_empty() {
        return;
    }
    let shell = app.state::<Shell>();
    shell.allowed.lock().unwrap().extend(projects.iter().cloned());
    shell.opened.lock().unwrap().extend(projects);
    // the window may not be listening yet; it also asks with take_opened when it starts
    let _ = app.emit("opened", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let library = library_file(app.handle()).map(|f| Library::load(&f)).unwrap_or_default();
            app.manage(Shell { library: Mutex::new(library), opened: Mutex::new(Vec::new()), allowed: Mutex::new(HashSet::new()) });
            // Windows and Linux pass a double-clicked project file as an argument
            let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
            queue_opened(app.handle(), args);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sample_folders,
            add_sample_folder,
            remove_sample_folder,
            list_samples,
            read_sample,
            take_opened,
            read_project,
            save_file,
            log
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Loopwell window");

    app.run(|_app, _event| {
        // macOS delivers "Open with" as an event rather than an argument
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let paths = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
            queue_opened(_app, paths);
        }
    });
}
