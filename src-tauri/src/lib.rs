mod index;
mod parse;
mod vault;

use index::{Backlink, Graph, NoteMeta, SearchHit, TagCount};
use notify_debouncer_mini::{
    new_debouncer, notify::RecursiveMode, DebounceEventResult, DebouncedEventBatch, Debouncer,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use vault::{Error, Result, SyncReport, Vault};

type Watcher = Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>;

#[derive(Default)]
struct AppState {
    vault: Mutex<Option<Arc<Vault>>>,
    watcher: Mutex<Option<Watcher>>,
}

impl AppState {
    fn vault(&self) -> Result<Arc<Vault>> {
        self.vault.lock().unwrap().clone().ok_or(Error::NoVault)
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Config {
    last_vault: Option<String>,
    #[serde(default)]
    recent_vaults: Vec<String>,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("config.json"))
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &Config) {
    if let Some(p) = config_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(cfg) {
            let _ = std::fs::write(p, s);
        }
    }
}

#[derive(Serialize)]
struct VaultInfo {
    path: String,
    name: String,
    notes: Vec<NoteMeta>,
    folders: Vec<String>,
}

fn vault_info(v: &Vault) -> Result<VaultInfo> {
    Ok(VaultInfo {
        path: v.root.display().to_string(),
        name: v
            .root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Vault".into()),
        notes: v.index.lock().unwrap().list_notes()?,
        folders: v.folders(),
    })
}

fn start_watcher(app: &AppHandle, vault: &Arc<Vault>) -> Option<Watcher> {
    let weak: Weak<Vault> = Arc::downgrade(vault);
    let handle = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        move |res: DebounceEventResult| {
            let Some(vault) = weak.upgrade() else { return };
            let relevant = match res {
                // Ignore churn that only touches hidden paths (.trash, .git, ...).
                Ok(DebouncedEventBatch::Events(events)) => events.iter().any(|e| {
                    let rel = e.path.strip_prefix(&vault.root).unwrap_or(&e.path);
                    !rel.components()
                        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
                }),
                // The backend missed events; a full sync covers it.
                Ok(DebouncedEventBatch::Rescan) => true,
                _ => false,
            };
            if !relevant {
                return;
            }
            if let Ok(report) = vault.sync() {
                let _ = handle.emit("vault-changed", report);
            }
        },
    )
    .ok()?;
    debouncer
        .watcher()
        .watch(&vault.root, RecursiveMode::Recursive)
        .ok()?;
    Some(debouncer)
}

#[tauri::command]
fn get_last_vault(app: AppHandle) -> Option<String> {
    load_config(&app).last_vault
}

#[tauri::command]
fn get_recent_vaults(app: AppHandle) -> Vec<String> {
    load_config(&app).recent_vaults
}

#[tauri::command]
fn default_vault_path(app: AppHandle) -> Option<String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .ok()?;
    Some(base.join("NoteForge").display().to_string())
}

const WELCOME: &str = include_str!("../welcome.md");

#[tauri::command]
fn open_vault(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    create: bool,
) -> Result<VaultInfo> {
    let root = PathBuf::from(&path);
    if create {
        std::fs::create_dir_all(&root)?;
        let empty = std::fs::read_dir(&root)?.next().is_none();
        if empty {
            std::fs::write(root.join("Welcome.md"), WELCOME)?;
        }
    }
    let vault = Arc::new(Vault::open(root)?);

    // Allow the webview to load images that live inside the vault.
    let _ = app
        .asset_protocol_scope()
        .allow_directory(&vault.root, true);

    // Drop the old watcher before starting a new one.
    *state.watcher.lock().unwrap() = None;
    *state.watcher.lock().unwrap() = start_watcher(&app, &vault);
    *state.vault.lock().unwrap() = Some(vault.clone());

    let mut cfg = load_config(&app);
    let p = vault.root.display().to_string();
    cfg.last_vault = Some(p.clone());
    cfg.recent_vaults.retain(|r| r != &p);
    cfg.recent_vaults.insert(0, p);
    cfg.recent_vaults.truncate(8);
    save_config(&app, &cfg);

    vault_info(&vault)
}

#[tauri::command]
fn close_vault(app: AppHandle, state: State<AppState>) {
    *state.watcher.lock().unwrap() = None;
    *state.vault.lock().unwrap() = None;
    let mut cfg = load_config(&app);
    cfg.last_vault = None;
    save_config(&app, &cfg);
}

#[tauri::command]
fn vault_snapshot(state: State<AppState>) -> Result<VaultInfo> {
    let v = state.vault()?;
    vault_info(&v)
}

#[tauri::command]
fn rescan(state: State<AppState>) -> Result<SyncReport> {
    state.vault()?.sync()
}

#[tauri::command]
fn read_note(state: State<AppState>, path: String) -> Result<String> {
    state.vault()?.read(&path)
}

#[tauri::command]
fn write_note(state: State<AppState>, path: String, content: String) -> Result<()> {
    state.vault()?.write(&path, &content)
}

#[tauri::command]
fn create_note(
    state: State<AppState>,
    dir: String,
    name: Option<String>,
    content: Option<String>,
) -> Result<String> {
    state
        .vault()?
        .create_note(&dir, name.as_deref(), content.as_deref())
}

#[tauri::command]
fn create_folder(state: State<AppState>, path: String) -> Result<()> {
    state.vault()?.create_folder(&path)
}

#[tauri::command]
fn rename_path(
    state: State<AppState>,
    from: String,
    to: String,
    update_links: bool,
) -> Result<Vec<String>> {
    state.vault()?.rename(&from, &to, update_links)
}

#[tauri::command]
fn trash_path(state: State<AppState>, path: String) -> Result<()> {
    state.vault()?.trash(&path)
}

#[tauri::command]
fn search(state: State<AppState>, query: String, limit: Option<usize>) -> Result<Vec<SearchHit>> {
    let v = state.vault()?;
    let hits = v
        .index
        .lock()
        .unwrap()
        .search(&query, limit.unwrap_or(50))?;
    Ok(hits)
}

#[tauri::command]
fn backlinks(state: State<AppState>, path: String) -> Result<Vec<Backlink>> {
    let v = state.vault()?;
    let bl = v.index.lock().unwrap().backlinks(&path)?;
    Ok(bl)
}

#[tauri::command]
fn tags(state: State<AppState>) -> Result<Vec<TagCount>> {
    let v = state.vault()?;
    let t = v.index.lock().unwrap().tags()?;
    Ok(t)
}

#[tauri::command]
fn graph(state: State<AppState>) -> Result<Graph> {
    let v = state.vault()?;
    let g = v.index.lock().unwrap().graph()?;
    Ok(g)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_last_vault,
            get_recent_vaults,
            default_vault_path,
            open_vault,
            close_vault,
            vault_snapshot,
            rescan,
            read_note,
            write_note,
            create_note,
            create_folder,
            rename_path,
            trash_path,
            search,
            backlinks,
            tags,
            graph,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NoteForge");
}
