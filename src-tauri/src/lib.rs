use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::ErrorKind,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Sender, SyncSender, TryRecvError, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tungstenite::{
    accept_hdr_with_config,
    handshake::server::{ErrorResponse, Request, Response},
    protocol::{Message, WebSocketConfig},
};

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 5242;
const SCRIPT_API_PORT: u16 = 5243;
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_INVENTORY_ITEMS: usize = 500;
const MAX_INVENTORY_NODES: usize = 4_096;
const MAX_BINARY_NODES: usize = MAX_INVENTORY_NODES * 2 + 16;
const MAX_CACHED_INVENTORIES: usize = 1_000;
const COMMAND_QUEUE_CAPACITY: usize = 1;
const COMMAND_MIN_INTERVAL: Duration = Duration::from_secs(1);
const COMMAND_SEND_TIMEOUT: Duration = Duration::from_secs(3);
const HEARTBEAT_UI_UPDATE_INTERVAL: Duration = Duration::from_secs(10);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(16);
const SCRIPT_API_MIN_INTERVAL: Duration = Duration::from_millis(500);
const SCRIPT_API_TIMEOUT: Duration = Duration::from_secs(5);
const SCRIPT_API_MAX_CONNECTIONS: usize = 4;
const MAX_AGENT_CONNECTIONS: usize = 256;
const MAX_DELETED_AGENT_IDS: usize = 4_096;
const BUILTIN_LOCALES: [(&str, &str, &str); 3] = [
    (
        "en-US",
        "en",
        include_str!("../../config/locales/en-US.json"),
    ),
    (
        "th-TH",
        "th",
        include_str!("../../config/locales/th-TH.json"),
    ),
    (
        "vi-VN",
        "vn",
        include_str!("../../config/locales/vi-VN.json"),
    ),
];

fn locale_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("Locales"))
        .map_err(|error| format!("Could not locate the application data directory: {error}"))
}

fn ensure_builtin_locales(directory: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create locale directory: {error}"))?;
    for (code, legacy_code, contents) in BUILTIN_LOCALES {
        let path = directory.join(format!("{code}.json"));
        if !path.exists() {
            let legacy_path = directory.join(format!("{legacy_code}.json"));
            if legacy_path.exists() {
                fs::rename(&legacy_path, &path).map_err(|error| {
                    format!("Could not migrate the {legacy_code} locale to {code}: {error}")
                })?;
            } else {
                fs::write(&path, contents)
                    .map_err(|error| format!("Could not install the {code} locale: {error}"))?;
                continue;
            }
        }

        let existing_source = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read the {code} locale: {error}"))?;
        let has_duplicate_keys = contains_duplicate_json_keys(&existing_source);
        let mut existing: Value = serde_json::from_str(&existing_source)
            .map_err(|error| format!("Could not parse the {code} locale: {error}"))?;
        let defaults: Value = serde_json::from_str(contents)
            .map_err(|error| format!("Bundled {code} locale is invalid: {error}"))?;
        let mut changed = merge_missing_locale_keys(&mut existing, &defaults);
        changed |= repair_locale_value_types(&mut existing, &defaults);
        changed |= repair_locale_placeholder_mismatches(&mut existing, &defaults);
        changed |= remove_obsolete_agent_locale_keys(&mut existing);
        changed |= remove_moved_websocket_locale_keys(&mut existing);
        changed |= replace_luau_locale_terms(&mut existing);
        if changed || has_duplicate_keys {
            let updated = serde_json::to_string_pretty(&existing)
                .map_err(|error| format!("Could not update the {code} locale: {error}"))?;
            fs::write(&path, updated)
                .map_err(|error| format!("Could not update the {code} locale: {error}"))?;
        }
    }
    Ok(())
}

fn locale_placeholders(value: &str) -> Vec<&str> {
    let mut placeholders = Vec::new();
    let mut rest = value;
    while let Some(open) = rest.find('{') {
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('}') else {
            break;
        };
        let name = &after_open[..close];
        if !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            placeholders.push(name);
        }
        rest = &after_open[close + 1..];
    }
    placeholders.sort_unstable();
    placeholders
}

fn repair_locale_placeholder_mismatches(existing: &mut Value, defaults: &Value) -> bool {
    match (existing, defaults) {
        (Value::Object(existing), Value::Object(defaults)) => {
            defaults.iter().fold(false, |changed, (key, default)| {
                match (existing.get_mut(key), default) {
                    (Some(value), default) => {
                        repair_locale_placeholder_mismatches(value, default) | changed
                    }
                    _ => changed,
                }
            })
        }
        (Value::Array(existing), Value::Array(defaults)) => {
            existing
                .iter_mut()
                .zip(defaults)
                .fold(false, |changed, (value, default)| {
                    repair_locale_placeholder_mismatches(value, default) | changed
                })
        }
        (Value::String(existing), Value::String(default)) => {
            if locale_placeholders(existing) != locale_placeholders(default) {
                *existing = default.clone();
                true
            } else {
                false
            }
        }
        _ => false,
    }
}

fn contains_duplicate_json_keys(source: &str) -> bool {
    fn skip_whitespace(bytes: &[u8], index: &mut usize) {
        while bytes.get(*index).is_some_and(u8::is_ascii_whitespace) {
            *index += 1;
        }
    }

    fn scan_string(bytes: &[u8], index: &mut usize) -> bool {
        if bytes.get(*index) != Some(&b'"') {
            return false;
        }
        *index += 1;
        while let Some(byte) = bytes.get(*index) {
            match byte {
                b'\\' => *index += 2,
                b'"' => {
                    *index += 1;
                    return true;
                }
                _ => *index += 1,
            }
        }
        false
    }

    fn scan_value(source: &str, index: &mut usize) -> bool {
        let bytes = source.as_bytes();
        skip_whitespace(bytes, index);
        match bytes.get(*index) {
            Some(b'{') => {
                *index += 1;
                let mut keys = HashSet::new();
                let mut duplicate = false;
                loop {
                    skip_whitespace(bytes, index);
                    if bytes.get(*index) == Some(&b'}') {
                        *index += 1;
                        return duplicate;
                    }
                    let key_start = *index;
                    if !scan_string(bytes, index) {
                        return duplicate;
                    }
                    let key = match serde_json::from_str::<String>(&source[key_start..*index]) {
                        Ok(key) => key,
                        Err(_) => return duplicate,
                    };
                    duplicate |= !keys.insert(key);
                    skip_whitespace(bytes, index);
                    if bytes.get(*index) != Some(&b':') {
                        return duplicate;
                    }
                    *index += 1;
                    duplicate |= scan_value(source, index);
                    skip_whitespace(bytes, index);
                    match bytes.get(*index) {
                        Some(b',') => *index += 1,
                        Some(b'}') => {
                            *index += 1;
                            return duplicate;
                        }
                        _ => return duplicate,
                    }
                }
            }
            Some(b'[') => {
                *index += 1;
                let mut duplicate = false;
                loop {
                    skip_whitespace(bytes, index);
                    if bytes.get(*index) == Some(&b']') {
                        *index += 1;
                        return duplicate;
                    }
                    duplicate |= scan_value(source, index);
                    skip_whitespace(bytes, index);
                    match bytes.get(*index) {
                        Some(b',') => *index += 1,
                        Some(b']') => {
                            *index += 1;
                            return duplicate;
                        }
                        _ => return duplicate,
                    }
                }
            }
            Some(b'"') => scan_string(bytes, index) && false,
            Some(_) => {
                while bytes.get(*index).is_some_and(|byte| {
                    !byte.is_ascii_whitespace() && !matches!(byte, b',' | b'}' | b']')
                }) {
                    *index += 1;
                }
                false
            }
            None => false,
        }
    }

    let mut index = 0;
    scan_value(source, &mut index)
}

fn remove_moved_websocket_locale_keys(locale: &mut Value) -> bool {
    let Some(settings) = locale.get_mut("settings").and_then(Value::as_object_mut) else {
        return false;
    };
    [
        "websocketPort",
        "websocketPortApply",
        "websocketPortApplying",
        "websocketPortDescription",
        "websocketPortFailed",
        "websocketPortInvalid",
        "websocketPortLoadFailed",
        "websocketPortSaved",
    ]
    .iter()
    .fold(false, |changed, key| {
        settings.remove(*key).is_some() | changed
    })
}

fn replace_luau_locale_terms(value: &mut Value) -> bool {
    match value {
        Value::String(text) => {
            let updated = text.replace("Luau", "Lua").replace("luau", "lua");
            if *text != updated {
                *text = updated;
                true
            } else {
                false
            }
        }
        Value::Array(values) => values.iter_mut().fold(false, |changed, value| {
            replace_luau_locale_terms(value) | changed
        }),
        Value::Object(values) => values.values_mut().fold(false, |changed, value| {
            replace_luau_locale_terms(value) | changed
        }),
        _ => false,
    }
}

fn merge_missing_locale_keys(existing: &mut Value, defaults: &Value) -> bool {
    let (Some(existing), Some(defaults)) = (existing.as_object_mut(), defaults.as_object()) else {
        return false;
    };

    let mut changed = false;
    for (key, default_value) in defaults {
        match existing.get_mut(key) {
            Some(existing_value) => {
                changed |= merge_missing_locale_keys(existing_value, default_value);
            }
            None => {
                existing.insert(key.clone(), default_value.clone());
                changed = true;
            }
        }
    }
    changed
}

fn repair_locale_value_types(existing: &mut Value, defaults: &Value) -> bool {
    match (existing, defaults) {
        (Value::Object(existing), Value::Object(defaults)) => {
            defaults.iter().fold(false, |changed, (key, default)| {
                existing.get_mut(key).map_or(changed, |value| {
                    repair_locale_value_types(value, default) | changed
                })
            })
        }
        (Value::Array(existing), Value::Array(defaults)) => existing
            .iter_mut()
            .zip(defaults)
            .fold(false, |changed, (value, default)| {
                repair_locale_value_types(value, default) | changed
            }),
        (Value::String(_), Value::String(_)) => false,
        (existing, defaults) => {
            *existing = defaults.clone();
            true
        }
    }
}

fn remove_obsolete_agent_locale_keys(locale: &mut Value) -> bool {
    let Some(agents) = locale.get_mut("agents").and_then(Value::as_object_mut) else {
        return false;
    };
    let previous_len = agents.len();
    agents.retain(|key, _| key != "liveLog" && !key.starts_with("status."));
    agents.len() != previous_len
}

fn valid_locale_code(code: &str) -> bool {
    (2..=16).contains(&code.len())
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InventoryItem {
    name: String,
    quantity: u64,
    item_id: Option<String>,
    #[serde(default)]
    category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedInventory {
    player_id: String,
    account_id: String,
    custom_game_id: String,
    agent_id: String,
    agent_name: String,
    categories: Vec<String>,
    items: Vec<InventoryItem>,
    updated_at: u64,
    online: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InventoryCacheUpdated {
    #[serde(flatten)]
    snapshot: CachedInventory,
    message_size_bytes: usize,
    max_message_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMeta {
    custom_game_id: String,
    account_id: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSession {
    agent_id: String,
    agent_name: String,
    world: String,
    place_id: Option<String>,
    job_id: String,
    updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WorkspaceInventory {
    #[serde(flatten)]
    categories: HashMap<String, Value>,
}

impl Default for WorkspaceInventory {
    fn default() -> Self {
        let categories = ["fruits", "swords", "guns", "accessories", "materials"]
            .into_iter()
            .map(|category| (category.to_string(), empty_object()))
            .collect();
        Self { categories }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecord {
    meta: WorkspaceMeta,
    session: WorkspaceSession,
    #[serde(default = "empty_object")]
    profile: Value,
    #[serde(default)]
    world_progress: HashMap<String, Value>,
    #[serde(default)]
    inventory: WorkspaceInventory,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPersistedInventory {
    agent_name: String,
    items: Vec<InventoryItem>,
    updated_at: u64,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

struct WorkspaceReport {
    custom_game_id: String,
    account_id: String,
    world: String,
    profile: Option<Value>,
    world_progress: Option<HashMap<String, Value>>,
    inventory: Option<HashMap<String, Value>>,
    inventory_delta: bool,
    inventory_snapshot: bool,
    removed_inventory_items: HashMap<String, Vec<String>>,
    inventory_changes: Vec<InventoryDeltaChange>,
}

struct InventoryDeltaChange {
    category: String,
    name: String,
    path: Vec<String>,
    value: Option<Value>,
    remove: bool,
}

fn load_workspaces(workspace_path: &PathBuf) -> Result<HashMap<String, WorkspaceRecord>, String> {
    let mut workspaces = HashMap::new();
    let game_dirs = match fs::read_dir(workspace_path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(workspaces),
        Err(error) => return Err(format!("Could not read workspace folder: {error}")),
    };
    for game_entry in game_dirs {
        let game_entry =
            game_entry.map_err(|error| format!("Could not read workspace entry: {error}"))?;
        if !game_entry
            .file_type()
            .map_err(|error| format!("Could not inspect workspace entry: {error}"))?
            .is_dir()
        {
            continue;
        }
        let custom_game_id = game_entry.file_name().to_string_lossy().into_owned();
        if !is_safe_file_id(&custom_game_id) {
            continue;
        }
        let account_files = fs::read_dir(game_entry.path())
            .map_err(|error| format!("Could not read game workspace folder: {error}"))?;
        for account_entry in account_files {
            let account_entry = account_entry
                .map_err(|error| format!("Could not read account workspace: {error}"))?;
            if !account_entry
                .file_type()
                .map_err(|error| format!("Could not inspect account workspace: {error}"))?
                .is_file()
                || account_entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    != Some("json")
            {
                continue;
            }
            let account_id = account_entry
                .path()
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default()
                .to_string();
            if !is_safe_file_id(&account_id) {
                continue;
            }
            let file_path = account_entry.path();
            let bytes = fs::read(&file_path)
                .map_err(|error| format!("Could not read account workspace: {error}"))?;
            let mut stored_value: Value = serde_json::from_slice(&bytes)
                .map_err(|error| format!("Could not load account workspace: {error}"))?;
            let has_legacy_game_name = stored_value
                .get("meta")
                .and_then(Value::as_object)
                .is_some_and(|meta| meta.contains_key("gameName"));
            let record: WorkspaceRecord = serde_json::from_value(stored_value.clone())
                .map_err(|error| format!("Could not load account workspace: {error}"))?;
            if record.meta.custom_game_id != custom_game_id || record.meta.account_id != account_id
            {
                return Err(format!(
                    "Workspace identity does not match its path: {}/{}.json",
                    custom_game_id, account_id
                ));
            }
            if has_legacy_game_name {
                stored_value
                    .get_mut("meta")
                    .and_then(Value::as_object_mut)
                    .expect("validated workspace metadata object")
                    .remove("gameName");
                let serialized = serde_json::to_vec_pretty(&stored_value)
                    .map_err(|error| format!("Could not migrate workspace metadata: {error}"))?;
                fs::write(&file_path, serialized).map_err(|error| {
                    format!("Could not migrate workspace metadata file: {error}")
                })?;
            }
            workspaces.insert(workspace_key(&custom_game_id, &account_id), record);
        }
    }
    Ok(workspaces)
}

fn migrate_legacy_inventory(workspace_path: &PathBuf) -> Result<(), String> {
    let Some(legacy_path) = workspace_path
        .parent()
        .and_then(std::path::Path::parent)
        .map(|app_data| app_data.join("server-script-inventory.json"))
    else {
        return Ok(());
    };
    let bytes = match fs::read(&legacy_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read legacy inventory cache: {error}")),
    };
    let legacy: HashMap<String, LegacyPersistedInventory> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not load legacy inventory cache: {error}"))?;
    for (agent_id, cached) in legacy {
        if !is_safe_file_id(&agent_id) {
            continue;
        }
        let game_dir = workspace_path.join("LEGACY");
        fs::create_dir_all(&game_dir)
            .map_err(|error| format!("Could not create migrated workspace folder: {error}"))?;
        let destination = game_dir.join(format!("{agent_id}.json"));
        if destination.exists() {
            continue;
        }
        let mut materials = serde_json::Map::new();
        for item in cached.items {
            materials.insert(
                item.name,
                serde_json::json!({
                    "quantity": item.quantity,
                    "itemId": item.item_id,
                }),
            );
        }
        let timestamp = cached.updated_at;
        let mut inventory = WorkspaceInventory::default();
        inventory
            .categories
            .insert("materials".to_string(), Value::Object(materials));
        let record = WorkspaceRecord {
            meta: WorkspaceMeta {
                custom_game_id: "LEGACY".to_string(),
                account_id: agent_id.clone(),

                created_at: timestamp,
                updated_at: timestamp,
            },
            session: WorkspaceSession {
                agent_id,
                agent_name: cached.agent_name,
                world: "Unknown".to_string(),
                place_id: None,
                job_id: String::new(),
                updated_at: timestamp,
            },
            profile: empty_object(),
            world_progress: HashMap::new(),
            inventory,
        };
        let serialized = serde_json::to_vec_pretty(&record)
            .map_err(|error| format!("Could not serialize migrated workspace: {error}"))?;
        fs::write(destination, serialized)
            .map_err(|error| format!("Could not save migrated workspace: {error}"))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptApiRequest {
    #[serde(alias = "functionName")]
    function: String,
    #[serde(alias = "gameId")]
    custom_game_id: String,
    #[serde(default)]
    args: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptApiInvocation {
    request_id: String,
    function: String,
    custom_game_id: String,
    args: Value,
}

struct ScriptApiResponse {
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectedAgent {
    id: String,
    name: String,
    status: String,
    server: String,
    place_id: Option<String>,
    connected_at: u64,
    last_seen_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    running: bool,
    host: String,
    port: u16,
    connected_agents: usize,
    error: Option<String>,
}

#[derive(Clone)]
struct AgentEntry {
    info: ConnectedAgent,
    connection_token: u64,
    command_sender: SyncSender<AgentCommand>,
    last_command_at: Option<Instant>,
}

struct AgentCommand {
    message: String,
    response: Sender<Result<(), String>>,
    deadline: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentCommandResult {
    agent_id: String,
    error: Option<String>,
}

struct AgentConnectionGuard(Arc<AtomicUsize>);

impl Drop for AgentConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn try_acquire_agent_connection_slot(active: &AtomicUsize) -> bool {
    let mut current = active.load(Ordering::Acquire);
    loop {
        if current >= MAX_AGENT_CONNECTIONS {
            return false;
        }
        match active.compare_exchange_weak(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

#[derive(Clone, Default)]
struct DeletedAgentIds {
    ids: HashSet<String>,
    insertion_order: VecDeque<String>,
}

impl DeletedAgentIds {
    fn from_ids(ids: impl IntoIterator<Item = String>) -> Self {
        let mut deleted = Self::default();
        for id in ids {
            deleted.insert(id);
        }
        deleted
    }

    fn contains(&self, id: &str) -> bool {
        self.ids.contains(id)
    }

    fn insert(&mut self, id: String) {
        if self.ids.remove(&id) {
            self.insertion_order.retain(|existing| existing != &id);
        }
        self.ids.insert(id.clone());
        self.insertion_order.push_back(id);
        while self.insertion_order.len() > MAX_DELETED_AGENT_IDS {
            if let Some(expired) = self.insertion_order.pop_front() {
                self.ids.remove(&expired);
            }
        }
    }

    fn as_ordered_ids(&self) -> Vec<String> {
        self.insertion_order.iter().cloned().collect()
    }
}

struct AxionServer {
    running: AtomicBool,
    server_port: AtomicU16,
    server_thread: Mutex<Option<JoinHandle<()>>>,
    port_restart_lock: Mutex<()>,
    api_running: AtomicBool,
    api_port: AtomicU16,
    api_thread: Mutex<Option<JoinHandle<()>>>,
    api_error: Mutex<Option<String>>,
    next_connection: AtomicU64,
    next_api_request: AtomicU64,
    agents: Mutex<HashMap<String, AgentEntry>>,
    api_token: Mutex<Option<String>>,
    api_last_request_at: Mutex<Option<Instant>>,
    pending_api_requests: Mutex<HashMap<String, Sender<ScriptApiResponse>>>,
    workspaces: Mutex<HashMap<String, WorkspaceRecord>>,
    workspace_path: PathBuf,
    server_port_path: PathBuf,
    api_port_path: PathBuf,
    deleted_agent_ids: Mutex<DeletedAgentIds>,
    deleted_agents_path: PathBuf,
    error: Mutex<Option<String>>,
}

impl AxionServer {
    fn new(workspace_path: PathBuf) -> Result<Self, String> {
        let server_port_path = workspace_path.join("websocket-port.json");
        let api_port_path = workspace_path.join("server-script-api-port.json");
        let server_port = match fs::read(&server_port_path) {
            Ok(bytes) => serde_json::from_slice::<u16>(&bytes)
                .map_err(|error| format!("Could not load WebSocket port: {error}"))?,
            Err(error) if error.kind() == ErrorKind::NotFound => SERVER_PORT,
            Err(error) => return Err(format!("Could not read WebSocket port: {error}")),
        };
        let api_port = match fs::read(&api_port_path) {
            Ok(bytes) => serde_json::from_slice::<u16>(&bytes)
                .map_err(|error| format!("Could not load Server Scripts API port: {error}"))?,
            Err(error) if error.kind() == ErrorKind::NotFound => SCRIPT_API_PORT,
            Err(error) => return Err(format!("Could not read Server Scripts API port: {error}")),
        };
        validate_server_port(server_port, api_port)?;
        validate_script_api_port(api_port, server_port)?;
        let deleted_agents_path = workspace_path
            .parent()
            .and_then(std::path::Path::parent)
            .or_else(|| workspace_path.parent())
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("deleted-agents.json");
        migrate_legacy_inventory(&workspace_path)?;
        let workspaces = load_workspaces(&workspace_path)?;
        let deleted_agent_ids = match fs::read(&deleted_agents_path) {
            Ok(bytes) => {
                let loaded_ids: Vec<String> = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("Could not load deleted agent list: {error}"))?;
                let deleted = DeletedAgentIds::from_ids(loaded_ids.iter().cloned());
                let bounded_ids = deleted.as_ordered_ids();
                if bounded_ids.len() != loaded_ids.len() {
                    let serialized = serde_json::to_vec(&bounded_ids).map_err(|error| {
                        format!("Could not serialize deleted agent list: {error}")
                    })?;
                    fs::write(&deleted_agents_path, serialized).map_err(|error| {
                        format!("Could not save bounded deleted agent list: {error}")
                    })?;
                }
                deleted
            }
            Err(error) if error.kind() == ErrorKind::NotFound => DeletedAgentIds::default(),
            Err(error) => return Err(format!("Could not read deleted agent list: {error}")),
        };
        Ok(Self {
            running: AtomicBool::new(false),
            server_port: AtomicU16::new(server_port),
            server_thread: Mutex::new(None),
            port_restart_lock: Mutex::new(()),
            api_running: AtomicBool::new(false),
            api_port: AtomicU16::new(api_port),
            api_thread: Mutex::new(None),
            api_error: Mutex::new(None),
            next_connection: AtomicU64::new(1),
            next_api_request: AtomicU64::new(1),
            agents: Mutex::new(HashMap::new()),
            api_token: Mutex::new(None),
            api_last_request_at: Mutex::new(None),
            pending_api_requests: Mutex::new(HashMap::new()),
            workspaces: Mutex::new(workspaces),
            workspace_path,
            server_port_path,
            api_port_path,
            deleted_agent_ids: Mutex::new(deleted_agent_ids),
            deleted_agents_path,
            error: Mutex::new(None),
        })
    }

    fn add_inventory_item(
        &self,
        custom_game_id: &str,
        account_id: &str,
        category: &str,
        name: &str,
        quantity: u64,
        item_id: Option<&str>,
    ) -> Result<CachedInventory, String> {
        if !is_safe_file_id(custom_game_id) || !is_safe_file_id(account_id) {
            return Err("Invalid workspace identity".to_string());
        }
        if !is_inventory_category(category) {
            return Err("Invalid inventory category name".to_string());
        }
        let name = name.trim();
        if name.is_empty() || name.len() > 80 {
            return Err("Item name must contain 1-80 bytes".to_string());
        }
        if quantity > 1_000_000_000 {
            return Err("Item quantity cannot exceed 1000000000".to_string());
        }
        if item_id.is_some_and(|item_id| item_id.len() > 128) {
            return Err("Item ID cannot exceed 128 bytes".to_string());
        }
        let key = workspace_key(custom_game_id, account_id);
        let mut workspaces = self.workspaces.lock().expect("workspace lock poisoned");
        let record = workspaces
            .get(&key)
            .ok_or_else(|| "Workspace cache entry no longer exists".to_string())?;
        let mut updated = record.clone();
        if flatten_inventory(&updated.inventory).len() >= MAX_INVENTORY_ITEMS {
            return Err(format!(
                "Inventory is limited to {MAX_INVENTORY_ITEMS} items"
            ));
        }
        let items = inventory_category_mut(&mut updated.inventory, category)?
            .as_object_mut()
            .ok_or_else(|| "Cached inventory category is invalid".to_string())?;
        if items.contains_key(name) {
            return Err(format!(
                "An item named {name} already exists in this category"
            ));
        }
        let mut details = serde_json::Map::new();
        details.insert("name".to_string(), Value::String(name.to_string()));
        details.insert("quantity".to_string(), Value::from(quantity));
        if let Some(item_id) = item_id.filter(|item_id| !item_id.is_empty()) {
            details.remove("ItemId");
            details.insert("itemId".to_string(), Value::String(item_id.to_string()));
        }
        items.insert(name.to_string(), Value::Object(details));
        updated.meta.updated_at = now_ms();

        let file_path = self
            .workspace_path
            .join(custom_game_id)
            .join(format!("{account_id}.json"));
        let serialized = serde_json::to_vec_pretty(&updated)
            .map_err(|error| format!("Could not serialize workspace: {error}"))?;
        fs::write(&file_path, serialized)
            .map_err(|error| format!("Could not write workspace file: {error}"))?;
        workspaces.insert(key, updated.clone());
        drop(workspaces);

        let online = self
            .agents
            .lock()
            .expect("agent lock poisoned")
            .contains_key(&updated.session.agent_id);
        Ok(CachedInventory {
            player_id: updated.session.agent_id.clone(),
            account_id: updated.meta.account_id,
            custom_game_id: updated.meta.custom_game_id,
            agent_id: updated.session.agent_id,
            agent_name: updated.session.agent_name,
            categories: inventory_category_names(&updated.inventory),
            items: flatten_inventory(&updated.inventory),
            updated_at: updated.meta.updated_at,
            online,
        })
    }

    fn delete_inventory_item(
        &self,
        custom_game_id: &str,
        account_id: &str,
        category: &str,
        name: &str,
        quantity: u64,
        item_id: Option<&str>,
    ) -> Result<CachedInventory, String> {
        if !is_safe_file_id(custom_game_id) || !is_safe_file_id(account_id) {
            return Err("Invalid workspace identity".to_string());
        }
        if !is_inventory_category(category) {
            return Err("Invalid inventory category name".to_string());
        }

        let key = workspace_key(custom_game_id, account_id);
        let mut workspaces = self.workspaces.lock().expect("workspace lock poisoned");
        let record = workspaces
            .get(&key)
            .ok_or_else(|| "Workspace cache entry no longer exists".to_string())?;
        let mut updated = record.clone();
        let items = inventory_category_mut(&mut updated.inventory, category)?
            .as_object_mut()
            .ok_or_else(|| "Cached inventory category is invalid".to_string())?;
        let item_key = items.iter().find_map(|(key, value)| {
            let details = value.as_object();
            let item_name = details
                .and_then(|details| details.get("name").or_else(|| details.get("Name")))
                .and_then(Value::as_str)
                .unwrap_or(key);
            let item_quantity = details
                .and_then(|details| {
                    details
                        .get("quantity")
                        .or_else(|| details.get("Quantity"))
                        .or_else(|| details.get("count"))
                        .or_else(|| details.get("Count"))
                })
                .and_then(Value::as_u64)
                .or_else(|| value.as_u64())
                .unwrap_or(1);
            let item_id_value = details
                .and_then(|details| details.get("itemId").or_else(|| details.get("ItemId")))
                .and_then(Value::as_str);
            (item_name == name && item_quantity == quantity && item_id_value == item_id)
                .then(|| key.clone())
        });
        let item_key = item_key.ok_or_else(|| {
            "The selected inventory item has changed; refresh and try again".to_string()
        })?;
        items.remove(&item_key);
        updated.meta.updated_at = now_ms();

        let file_path = self
            .workspace_path
            .join(custom_game_id)
            .join(format!("{account_id}.json"));
        let serialized = serde_json::to_vec_pretty(&updated)
            .map_err(|error| format!("Could not serialize workspace: {error}"))?;
        fs::write(&file_path, serialized)
            .map_err(|error| format!("Could not write workspace file: {error}"))?;
        workspaces.insert(key, updated.clone());
        drop(workspaces);

        let online = self
            .agents
            .lock()
            .expect("agent lock poisoned")
            .contains_key(&updated.session.agent_id);
        Ok(CachedInventory {
            player_id: updated.session.agent_id.clone(),
            account_id: updated.meta.account_id,
            custom_game_id: updated.meta.custom_game_id,
            agent_id: updated.session.agent_id,
            agent_name: updated.session.agent_name,
            categories: inventory_category_names(&updated.inventory),
            items: flatten_inventory(&updated.inventory),
            updated_at: updated.meta.updated_at,
            online,
        })
    }

    fn delete_account_workspace(
        &self,
        custom_game_id: &str,
        account_id: &str,
    ) -> Result<(), String> {
        if !is_safe_file_id(custom_game_id) || !is_safe_file_id(account_id) {
            return Err("Invalid workspace identity".to_string());
        }

        let key = workspace_key(custom_game_id, account_id);
        let mut workspaces = self.workspaces.lock().expect("workspace lock poisoned");
        if !workspaces.contains_key(&key) {
            return Err("Workspace cache entry no longer exists".to_string());
        }

        let file_path = self
            .workspace_path
            .join(custom_game_id)
            .join(format!("{account_id}.json"));
        fs::remove_file(&file_path)
            .map_err(|error| format!("Could not remove account workspace: {error}"))?;
        workspaces.remove(&key);
        Ok(())
    }

    fn start(self: &Arc<Self>, app: AppHandle) {
        if self.running.load(Ordering::Acquire) {
            return;
        }

        let port = self.server_port.load(Ordering::Acquire);
        let listener = match TcpListener::bind((SERVER_HOST, port)) {
            Ok(listener) => listener,
            Err(error) => {
                *self.error.lock().expect("server error lock poisoned") =
                    Some(format!("Could not listen on {SERVER_HOST}:{port}: {error}"));
                return;
            }
        };

        if let Err(error) = listener.set_nonblocking(true) {
            *self.error.lock().expect("server error lock poisoned") =
                Some(format!("Could not configure AXION listener: {error}"));
            return;
        }

        self.running.store(true, Ordering::Release);
        *self.error.lock().expect("server error lock poisoned") = None;

        let server = Arc::clone(self);
        let active_connections = Arc::new(AtomicUsize::new(0));
        let handle = thread::Builder::new()
            .name("axion-websocket-listener".to_string())
            .spawn(move || {
                while server.running.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            if !try_acquire_agent_connection_slot(&active_connections) {
                                let _ = stream.write_all(
                                    b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                                );
                                continue;
                            }
                            let connection_counter = Arc::clone(&active_connections);
                            let connection_server = Arc::clone(&server);
                            let connection_app = app.clone();
                            let spawned = thread::Builder::new()
                                .name("axion-agent-connection".to_string())
                                .spawn(move || {
                                    let _connection_guard =
                                        AgentConnectionGuard(connection_counter);
                                    handle_connection(stream, connection_app, connection_server);
                                });
                            if let Err(error) = spawned {
                                active_connections.fetch_sub(1, Ordering::AcqRel);
                                *server.error.lock().expect("server error lock poisoned") = Some(
                                    format!("Could not start agent connection thread: {error}"),
                                );
                            }
                        }
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(40));
                        }
                        Err(error) => {
                            *server.error.lock().expect("server error lock poisoned") =
                                Some(format!("AXION listener failed: {error}"));
                            server.running.store(false, Ordering::Release);
                        }
                    }
                }
            })
            .map_err(|error| {
                self.running.store(false, Ordering::Release);
                *self.error.lock().expect("server error lock poisoned") =
                    Some(format!("Could not start AXION listener thread: {error}"));
                format!("Could not start AXION listener thread: {error}")
            });
        if let Ok(handle) = handle {
            *self
                .server_thread
                .lock()
                .expect("AXION listener thread lock poisoned") = Some(handle);
        }
    }

    fn set_server_port(self: &Arc<Self>, app: AppHandle, port: u16) -> Result<(), String> {
        let _restart_guard = self
            .port_restart_lock
            .lock()
            .expect("listener port restart lock poisoned");
        validate_server_port(port, self.api_port.load(Ordering::Acquire))?;
        if self.server_port.load(Ordering::Acquire) == port && self.running.load(Ordering::Acquire)
        {
            return Ok(());
        }

        self.running.store(false, Ordering::Release);
        if let Some(handle) = self
            .server_thread
            .lock()
            .expect("AXION listener thread lock poisoned")
            .take()
        {
            handle
                .join()
                .map_err(|_| "AXION WebSocket listener thread panicked".to_string())?;
        }

        let previous_port = self.server_port.load(Ordering::Acquire);
        self.server_port.store(port, Ordering::Release);
        self.start(app.clone());
        if self.running.load(Ordering::Acquire) {
            match self.persist_server_port(port) {
                Ok(()) => Ok(()),
                Err(error) => {
                    self.stop_server_listener()?;
                    self.server_port.store(previous_port, Ordering::Release);
                    self.start(app);
                    Err(format!(
                        "WebSocket port was changed but could not be saved: {error}"
                    ))
                }
            }
        } else {
            let error = self
                .error
                .lock()
                .expect("server error lock poisoned")
                .clone()
                .unwrap_or_else(|| "AXION WebSocket listener did not start".to_string());
            self.server_port.store(previous_port, Ordering::Release);
            *self.error.lock().expect("server error lock poisoned") = None;
            self.start(app);
            Err(format!(
                "{error}; restored the previous port {previous_port}"
            ))
        }
    }

    fn stop_server_listener(&self) -> Result<(), String> {
        self.running.store(false, Ordering::Release);
        if let Some(handle) = self
            .server_thread
            .lock()
            .expect("AXION listener thread lock poisoned")
            .take()
        {
            handle
                .join()
                .map_err(|_| "AXION WebSocket listener thread panicked".to_string())?;
        }
        Ok(())
    }

    fn persist_server_port(&self, port: u16) -> Result<(), String> {
        let parent = self
            .server_port_path
            .parent()
            .ok_or_else(|| "WebSocket port path has no parent folder".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create WebSocket settings folder: {error}"))?;
        let bytes = serde_json::to_vec(&port)
            .map_err(|error| format!("Could not serialize WebSocket port: {error}"))?;
        fs::write(&self.server_port_path, bytes)
            .map_err(|error| format!("Could not save WebSocket port: {error}"))
    }

    fn status(&self) -> ServerStatus {
        ServerStatus {
            running: self.running.load(Ordering::Acquire),
            host: SERVER_HOST.to_string(),
            port: self.server_port.load(Ordering::Acquire),
            connected_agents: self.agents.lock().expect("agent lock poisoned").len(),
            error: self
                .error
                .lock()
                .expect("server error lock poisoned")
                .clone(),
        }
    }

    fn start_script_api(self: &Arc<Self>, app: AppHandle) {
        if self.api_running.load(Ordering::Acquire) {
            return;
        }
        let port = self.api_port.load(Ordering::Acquire);
        let listener = match TcpListener::bind((SERVER_HOST, port)) {
            Ok(listener) => listener,
            Err(error) => {
                *self.api_error.lock().expect("API error lock poisoned") =
                    Some(format!("Could not listen on {SERVER_HOST}:{port}: {error}"));
                return;
            }
        };
        if let Err(error) = listener.set_nonblocking(true) {
            *self.api_error.lock().expect("API error lock poisoned") =
                Some(format!("Could not configure Server Scripts API: {error}"));
            return;
        }

        self.api_running.store(true, Ordering::Release);
        let server = Arc::clone(self);
        let handle = thread::Builder::new()
            .name("axion-server-script-api".to_string())
            .spawn(move || {
                let active_connections = Arc::new(AtomicU64::new(0));
                while server.api_running.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let active = active_connections.load(Ordering::Acquire);
                            if active >= SCRIPT_API_MAX_CONNECTIONS as u64 {
                                let _ = write_http_response(
                                    stream,
                                    503,
                                    serde_json::json!({"ok": false, "error": "Server Scripts API is busy"}),
                                );
                                continue;
                            }
                            active_connections.fetch_add(1, Ordering::AcqRel);
                            let connection_server = Arc::clone(&server);
                            let connection_app = app.clone();
                            let connection_count = Arc::clone(&active_connections);
                            if let Err(error) = thread::Builder::new()
                                .name("axion-server-script-request".to_string())
                                .spawn(move || {
                                    handle_script_api_connection(
                                        stream,
                                        connection_app,
                                        connection_server,
                                    );
                                    connection_count.fetch_sub(1, Ordering::AcqRel);
                                })
                            {
                                active_connections.fetch_sub(1, Ordering::AcqRel);
                                *server.api_error.lock().expect("API error lock poisoned") =
                                    Some(format!("Could not start Server Scripts request: {error}"));
                            }
                        }
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(40));
                        }
                        Err(error) => {
                            *server.api_error.lock().expect("API error lock poisoned") = Some(
                                format!("Server Scripts API listener failed: {error}"),
                            );
                            server.api_running.store(false, Ordering::Release);
                        }
                    }
                }
            })
            .map_err(|error| {
                self.api_running.store(false, Ordering::Release);
                *self.api_error.lock().expect("API error lock poisoned") =
                    Some(format!("Could not start Server Scripts API: {error}"));
            });
        match handle {
            Ok(handle) => {
                *self.api_thread.lock().expect("API thread lock poisoned") = Some(handle);
                *self.api_error.lock().expect("API error lock poisoned") = None;
            }
            Err(()) => {}
        }
    }

    fn set_script_api_port(self: &Arc<Self>, app: AppHandle, port: u16) -> Result<(), String> {
        let _restart_guard = self
            .port_restart_lock
            .lock()
            .expect("listener port restart lock poisoned");
        validate_script_api_port(port, self.server_port.load(Ordering::Acquire))?;
        if self.api_port.load(Ordering::Acquire) == port && self.api_running.load(Ordering::Acquire)
        {
            return Ok(());
        }

        self.api_running.store(false, Ordering::Release);
        if let Some(handle) = self
            .api_thread
            .lock()
            .expect("API thread lock poisoned")
            .take()
        {
            handle
                .join()
                .map_err(|_| "Server Scripts API listener thread panicked".to_string())?;
        }

        let previous_port = self.api_port.load(Ordering::Acquire);
        self.api_port.store(port, Ordering::Release);
        *self.api_error.lock().expect("API error lock poisoned") = None;
        self.start_script_api(app.clone());
        if self.api_running.load(Ordering::Acquire) {
            match self.persist_script_api_port(port) {
                Ok(()) => Ok(()),
                Err(error) => {
                    self.stop_script_api_listener()?;
                    self.api_port.store(previous_port, Ordering::Release);
                    *self.api_error.lock().expect("API error lock poisoned") = None;
                    self.start_script_api(app);
                    Err(format!(
                        "Server Scripts API port was changed but could not be saved: {error}"
                    ))
                }
            }
        } else {
            let error = self
                .api_error
                .lock()
                .expect("API error lock poisoned")
                .clone()
                .unwrap_or_else(|| "Server Scripts API did not start".to_string());
            self.api_port.store(previous_port, Ordering::Release);
            *self.api_error.lock().expect("API error lock poisoned") = None;
            self.start_script_api(app);
            Err(format!(
                "{error}; restored the previous port {previous_port}"
            ))
        }
    }

    fn stop_script_api_listener(&self) -> Result<(), String> {
        self.api_running.store(false, Ordering::Release);
        if let Some(handle) = self
            .api_thread
            .lock()
            .expect("API thread lock poisoned")
            .take()
        {
            handle
                .join()
                .map_err(|_| "Server Scripts API listener thread panicked".to_string())?;
        }
        Ok(())
    }

    fn persist_script_api_port(&self, port: u16) -> Result<(), String> {
        let parent = self
            .api_port_path
            .parent()
            .ok_or_else(|| "Server Scripts API port path has no parent folder".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create API settings folder: {error}"))?;
        let bytes = serde_json::to_vec(&port)
            .map_err(|error| format!("Could not serialize Server Scripts API port: {error}"))?;
        fs::write(&self.api_port_path, bytes)
            .map_err(|error| format!("Could not save Server Scripts API port: {error}"))
    }

    fn list_agents(&self) -> Vec<ConnectedAgent> {
        let mut agents: Vec<_> = self
            .agents
            .lock()
            .expect("agent lock poisoned")
            .values()
            .map(|entry| entry.info.clone())
            .collect();
        agents.sort_by(|left, right| left.name.cmp(&right.name));
        agents
    }

    fn delete_agent(&self, agent_id: &str) -> Result<(), String> {
        if agent_id.trim().is_empty() {
            return Err("Agent ID cannot be empty".to_string());
        }

        let mut deleted_agent_ids = self
            .deleted_agent_ids
            .lock()
            .expect("deleted agent lock poisoned");
        let mut next_deleted_agent_ids = deleted_agent_ids.clone();
        next_deleted_agent_ids.insert(agent_id.to_string());
        let serialized_deleted_ids =
            serde_json::to_vec(&next_deleted_agent_ids.as_ordered_ids())
                .map_err(|error| format!("Could not serialize deleted agent list: {error}"))?;
        if let Some(parent) = self.deleted_agents_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create deleted agent list folder: {error}"))?;
        }
        fs::write(&self.deleted_agents_path, serialized_deleted_ids)
            .map_err(|error| format!("Could not save deleted agent list: {error}"))?;
        *deleted_agent_ids = next_deleted_agent_ids;
        drop(deleted_agent_ids);

        self.agents
            .lock()
            .expect("agent lock poisoned")
            .remove(agent_id);

        let mut workspaces = self.workspaces.lock().expect("workspace lock poisoned");
        let matching = workspaces
            .iter()
            .filter(|(_, record)| record.session.agent_id == agent_id)
            .map(|(key, record)| {
                (
                    key.clone(),
                    record.meta.custom_game_id.clone(),
                    record.meta.account_id.clone(),
                )
            })
            .collect::<Vec<_>>();
        for (key, custom_game_id, account_id) in matching {
            let path = self
                .workspace_path
                .join(custom_game_id)
                .join(format!("{account_id}.json"));
            fs::remove_file(&path)
                .map_err(|error| format!("Could not remove account workspace: {error}"))?;
            workspaces.remove(&key);
        }
        Ok(())
    }

    fn send_agent_command(&self, agent_id: &str, command: &str) -> Result<(), String> {
        let message = encode_agent_command(command)?;
        self.send_agent_message(agent_id, &message)
    }

    fn send_agent_message(&self, agent_id: &str, message: &str) -> Result<(), String> {
        if message.len() > MAX_MESSAGE_BYTES {
            return Err(format!(
                "AXION WebSocket message exceeds the {} KiB limit",
                MAX_MESSAGE_BYTES / 1024
            ));
        }
        let (response_sender, response_receiver) = mpsc::channel();
        let now = Instant::now();
        let mut agents = self.agents.lock().expect("agent lock poisoned");
        let agent = agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {agent_id} is not connected"))?;
        ensure_command_rate_limit(agent.last_command_at, now, agent_id)?;
        agent
            .command_sender
            .try_send(AgentCommand {
                message: message.to_string(),
                response: response_sender,
                deadline: now + COMMAND_SEND_TIMEOUT,
            })
            .map_err(|error| match error {
                TrySendError::Full(_) => {
                    format!("Agent {agent_id} command queue is full; wait for the current send")
                }
                TrySendError::Disconnected(_) => {
                    format!("Agent {agent_id} connection is no longer available")
                }
            })?;
        agent.last_command_at = Some(now);
        drop(agents);
        response_receiver
            .recv_timeout(COMMAND_SEND_TIMEOUT)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => {
                    format!("Timed out sending a command to Agent {agent_id}")
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    format!("Agent {agent_id} connection closed before confirming the send")
                }
            })?
    }

    fn send_agent_messages(
        &self,
        agent_ids: &[String],
        message: &str,
    ) -> Result<Vec<AgentCommandResult>, String> {
        if message.len() > MAX_MESSAGE_BYTES {
            return Err(format!(
                "AXION WebSocket message exceeds the {} KiB limit",
                MAX_MESSAGE_BYTES / 1024
            ));
        }

        let now = Instant::now();
        let mut results = Vec::with_capacity(agent_ids.len());
        let mut pending = Vec::with_capacity(agent_ids.len());
        let mut seen = HashSet::with_capacity(agent_ids.len());
        {
            let mut agents = self.agents.lock().expect("agent lock poisoned");
            for agent_id in agent_ids {
                if !seen.insert(agent_id) {
                    continue;
                }
                let Some(agent) = agents.get_mut(agent_id) else {
                    results.push(AgentCommandResult {
                        agent_id: agent_id.clone(),
                        error: Some(format!("Agent {agent_id} is not connected")),
                    });
                    continue;
                };
                if let Err(error) = ensure_command_rate_limit(agent.last_command_at, now, agent_id)
                {
                    results.push(AgentCommandResult {
                        agent_id: agent_id.clone(),
                        error: Some(error),
                    });
                    continue;
                }

                let (response_sender, response_receiver) = mpsc::channel();
                match agent.command_sender.try_send(AgentCommand {
                    message: message.to_string(),
                    response: response_sender,
                    deadline: now + COMMAND_SEND_TIMEOUT,
                }) {
                    Ok(()) => {
                        agent.last_command_at = Some(now);
                        pending.push((agent_id.clone(), response_receiver));
                    }
                    Err(TrySendError::Full(_)) => results.push(AgentCommandResult {
                        agent_id: agent_id.clone(),
                        error: Some(format!(
                            "Agent {agent_id} command queue is full; wait for the current send"
                        )),
                    }),
                    Err(TrySendError::Disconnected(_)) => results.push(AgentCommandResult {
                        agent_id: agent_id.clone(),
                        error: Some(format!(
                            "Agent {agent_id} connection is no longer available"
                        )),
                    }),
                }
            }
        }

        for (agent_id, response_receiver) in pending {
            let error = response_receiver
                .recv_timeout(COMMAND_SEND_TIMEOUT)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => {
                        format!("Timed out sending a command to Agent {agent_id}")
                    }
                    mpsc::RecvTimeoutError::Disconnected => {
                        format!("Agent {agent_id} connection closed before confirming the send")
                    }
                })
                .and_then(|result| result)
                .err();
            results.push(AgentCommandResult { agent_id, error });
        }

        Ok(results)
    }

    fn set_agent_status(&self, agent_id: &str, status: &str) -> Result<ConnectedAgent, String> {
        if !matches!(status, "online" | "busy" | "idle") {
            return Err(format!("Unsupported agent status: {status}"));
        }
        let mut agents = self.agents.lock().expect("agent lock poisoned");
        let agent = agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {agent_id} is not connected"))?;
        agent.info.status = status.to_string();
        agent.info.last_seen_at = now_ms();
        Ok(agent.info.clone())
    }

    fn set_api_token(&self, token: String) -> Result<(), String> {
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(
                "Server Scripts API token must be a 64-character hexadecimal value".to_string(),
            );
        }
        *self.api_token.lock().expect("API token lock poisoned") = Some(token);
        Ok(())
    }

    fn check_script_api_rate_limit(&self, now: Instant) -> Result<(), Duration> {
        let mut last_request_at = self
            .api_last_request_at
            .lock()
            .expect("API request rate lock poisoned");
        if let Some(last) = *last_request_at {
            let elapsed = now.duration_since(last);
            if elapsed < SCRIPT_API_MIN_INTERVAL {
                return Err(SCRIPT_API_MIN_INTERVAL - elapsed);
            }
        }
        *last_request_at = Some(now);
        Ok(())
    }

    fn list_inventories(&self) -> Vec<CachedInventory> {
        let agents = self.agents.lock().expect("agent lock poisoned");
        let mut inventories = self
            .workspaces
            .lock()
            .expect("workspace lock poisoned")
            .iter()
            .map(|(_, record)| CachedInventory {
                player_id: record.session.agent_id.clone(),
                account_id: record.meta.account_id.clone(),
                custom_game_id: record.meta.custom_game_id.clone(),
                agent_id: record.session.agent_id.clone(),
                agent_name: record.session.agent_name.clone(),
                categories: inventory_category_names(&record.inventory),
                items: flatten_inventory(&record.inventory),
                updated_at: record.meta.updated_at,
                online: agents.contains_key(&record.session.agent_id),
            })
            .collect::<Vec<_>>();
        inventories.sort_by(|left, right| left.agent_name.cmp(&right.agent_name));
        inventories
    }

    fn update_inventory_item(
        &self,
        custom_game_id: &str,
        account_id: &str,
        old_category: &str,
        old_name: &str,
        old_quantity: u64,
        old_item_id: Option<&str>,
        new_category: &str,
        new_name: &str,
        new_quantity: u64,
        new_item_id: Option<&str>,
    ) -> Result<CachedInventory, String> {
        if !is_safe_file_id(custom_game_id) || !is_safe_file_id(account_id) {
            return Err("Invalid workspace identity".to_string());
        }
        if !is_inventory_category(old_category) || !is_inventory_category(new_category) {
            return Err("Invalid inventory category name".to_string());
        }
        if new_name.trim().is_empty() || new_name.trim().len() > 80 {
            return Err("Item name must contain 1-80 bytes".to_string());
        }
        if new_quantity > 1_000_000_000 {
            return Err("Item quantity cannot exceed 1000000000".to_string());
        }
        if new_item_id.is_some_and(|item_id| item_id.len() > 128) {
            return Err("Item ID cannot exceed 128 bytes".to_string());
        }
        let key = workspace_key(custom_game_id, account_id);
        let mut workspaces = self.workspaces.lock().expect("workspace lock poisoned");
        let record = workspaces
            .get(&key)
            .ok_or_else(|| "Workspace cache entry no longer exists".to_string())?;
        let mut updated = record.clone();
        replace_workspace_inventory_item(
            &mut updated.inventory,
            old_category,
            old_name,
            old_quantity,
            old_item_id,
            new_category,
            new_name.trim(),
            new_quantity,
            new_item_id,
        )?;
        updated.meta.updated_at = now_ms();

        let file_path = self
            .workspace_path
            .join(custom_game_id)
            .join(format!("{account_id}.json"));
        let serialized = serde_json::to_vec_pretty(&updated)
            .map_err(|error| format!("Could not serialize workspace: {error}"))?;
        fs::write(&file_path, serialized)
            .map_err(|error| format!("Could not write workspace file: {error}"))?;
        workspaces.insert(key, updated.clone());
        drop(workspaces);

        let online = self
            .agents
            .lock()
            .expect("agent lock poisoned")
            .contains_key(&updated.session.agent_id);
        Ok(CachedInventory {
            player_id: updated.session.agent_id.clone(),
            account_id: updated.meta.account_id,
            custom_game_id: updated.meta.custom_game_id,
            agent_id: updated.session.agent_id,
            agent_name: updated.session.agent_name,
            categories: inventory_category_names(&updated.inventory),
            items: flatten_inventory(&updated.inventory),
            updated_at: updated.meta.updated_at,
            online,
        })
    }

    fn store_workspace_report(
        &self,
        agent: &ConnectedAgent,
        payload: &Value,
    ) -> Result<CachedInventory, String> {
        let report = parse_workspace_report(payload)?;
        let now = now_ms();
        let mut workspaces = self.workspaces.lock().expect("workspace lock poisoned");
        let key = workspace_key(&report.custom_game_id, &report.account_id);
        let existing = workspaces.get(&key);
        if existing.is_none() && workspaces.len() >= MAX_CACHED_INVENTORIES {
            return Err(format!(
                "Workspace cache is full; maximum is {MAX_CACHED_INVENTORIES} accounts"
            ));
        }
        let mut record = existing.cloned().unwrap_or_else(|| WorkspaceRecord {
            meta: WorkspaceMeta {
                custom_game_id: report.custom_game_id.clone(),
                account_id: report.account_id.clone(),
                created_at: now,
                updated_at: now,
            },
            session: WorkspaceSession {
                agent_id: agent.id.clone(),
                agent_name: agent.name.clone(),
                world: String::new(),
                place_id: None,
                job_id: agent.server.clone(),
                updated_at: now,
            },
            profile: empty_object(),
            world_progress: HashMap::new(),
            inventory: WorkspaceInventory::default(),
        });

        record.meta.updated_at = now;
        record.session = WorkspaceSession {
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            world: report.world.clone(),
            place_id: agent.place_id.clone(),
            job_id: agent.server.clone(),
            updated_at: now,
        };
        if let Some(profile) = report.profile {
            record.profile = profile;
        }
        if let Some(world_progress) = report.world_progress {
            for (world, progress) in world_progress {
                record.world_progress.insert(world, progress);
            }
        }
        if let Some(inventory) = report.inventory {
            merge_inventory(
                &mut record.inventory,
                inventory,
                report.inventory_delta,
                report.inventory_snapshot,
                report.removed_inventory_items,
            );
            if report.inventory_delta {
                apply_inventory_changes(&mut record.inventory, report.inventory_changes);
            }
            if flatten_inventory(&record.inventory).len() > MAX_INVENTORY_ITEMS {
                return Err(format!(
                    "Inventory is limited to {MAX_INVENTORY_ITEMS} items"
                ));
            }
        }

        let game_dir = self.workspace_path.join(&report.custom_game_id);
        fs::create_dir_all(&game_dir)
            .map_err(|error| format!("Could not create workspace folder: {error}"))?;
        let file_path = game_dir.join(format!("{}.json", report.account_id));
        let serialized = serde_json::to_vec_pretty(&record)
            .map_err(|error| format!("Could not serialize workspace: {error}"))?;
        fs::write(&file_path, serialized)
            .map_err(|error| format!("Could not write workspace file: {error}"))?;
        workspaces.insert(key, record.clone());
        Ok(CachedInventory {
            player_id: agent.id.clone(),
            account_id: record.meta.account_id,
            custom_game_id: record.meta.custom_game_id,
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            categories: inventory_category_names(&record.inventory),
            items: flatten_inventory(&record.inventory),
            updated_at: record.meta.updated_at,
            online: true,
        })
    }

    fn dispatch_script_call(
        &self,
        app: &AppHandle,
        function: String,
        custom_game_id: String,
        args: Value,
    ) -> Result<Value, String> {
        if !is_safe_file_id(&custom_game_id) {
            return Err("customGameId must contain 1-64 letters, numbers, _ or -".to_string());
        }
        if function.is_empty()
            || function.len() > 128
            || !function
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err("Function name contains unsupported characters".to_string());
        }
        let request_id = self
            .next_api_request
            .fetch_add(1, Ordering::Relaxed)
            .to_string();
        let (sender, receiver) = mpsc::channel();
        self.pending_api_requests
            .lock()
            .expect("pending request lock poisoned")
            .insert(request_id.clone(), sender);
        if let Err(error) = app.emit(
            "axion-server-script-invoke",
            ScriptApiInvocation {
                request_id: request_id.clone(),
                function,
                custom_game_id,
                args,
            },
        ) {
            self.pending_api_requests
                .lock()
                .expect("pending request lock poisoned")
                .remove(&request_id);
            return Err(format!("Could not notify Server Scripts runtime: {error}"));
        }
        let response = receiver.recv_timeout(SCRIPT_API_TIMEOUT);
        self.pending_api_requests
            .lock()
            .expect("pending request lock poisoned")
            .remove(&request_id);
        match response {
            Ok(response) => match (response.result, response.error) {
                (Some(result), None) => Ok(result),
                (None, Some(error)) => Err(error),
                _ => Err("Server Script returned an invalid response".to_string()),
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("Server Script did not respond within 5 seconds".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("Server Script request was cancelled".to_string())
            }
        }
    }
}

#[derive(Debug)]
struct AgentIdentity {
    id: String,
    name: String,
    job_id: String,
}

#[derive(Debug, Deserialize)]
struct LegacyMessage {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Payload")]
    payload: Option<Value>,
}

struct BinaryValueDecoder<'a> {
    bytes: &'a [u8],
    offset: usize,
    nodes: usize,
}

impl BinaryValueDecoder<'_> {
    fn read_exact(&mut self, length: usize) -> Result<&[u8], String> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| "Truncated AXION binary packet".to_string())?;
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let bytes: [u8; 4] = self
            .read_exact(4)?
            .try_into()
            .map_err(|_| "Invalid AXION binary integer".to_string())?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_value(&mut self, depth: usize) -> Result<Value, String> {
        self.nodes += 1;
        if self.nodes > MAX_BINARY_NODES || depth > 32 {
            return Err("AXION binary packet exceeds structural limits".to_string());
        }
        match self.read_exact(1)?[0] {
            0 => Ok(Value::Null),
            1 => Ok(Value::Bool(false)),
            2 => Ok(Value::Bool(true)),
            3 => {
                let bytes: [u8; 8] = self
                    .read_exact(8)?
                    .try_into()
                    .map_err(|_| "Invalid AXION binary number".to_string())?;
                let number = f64::from_le_bytes(bytes);
                Number::from_f64(number)
                    .map(Value::Number)
                    .ok_or_else(|| "AXION binary number must be finite".to_string())
            }
            4 => {
                let length = self.read_u32()? as usize;
                let value = self.read_exact(length)?;
                let value = std::str::from_utf8(value)
                    .map_err(|_| "AXION binary string is not valid UTF-8".to_string())?;
                Ok(Value::String(value.to_string()))
            }
            5 => {
                let count = self.read_u32()? as usize;
                if count > MAX_BINARY_NODES.saturating_sub(self.nodes) {
                    return Err("AXION binary array exceeds structural limits".to_string());
                }
                let mut values = Vec::with_capacity(count);
                for _ in 0..count {
                    values.push(self.read_value(depth + 1)?);
                }
                Ok(Value::Array(values))
            }
            6 => {
                let count = self.read_u32()? as usize;
                if count > MAX_BINARY_NODES.saturating_sub(self.nodes) {
                    return Err("AXION binary object exceeds structural limits".to_string());
                }
                let mut values = serde_json::Map::new();
                for _ in 0..count {
                    let key = self.read_value(depth + 1)?;
                    let Value::String(key) = key else {
                        return Err("AXION binary object keys must be strings".to_string());
                    };
                    let value = self.read_value(depth + 1)?;
                    if values.insert(key, value).is_some() {
                        return Err("AXION binary object contains duplicate keys".to_string());
                    }
                }
                Ok(Value::Object(values))
            }
            _ => Err("AXION binary packet contains an unknown value type".to_string()),
        }
    }
}

fn decode_binary_agent_message(bytes: &[u8]) -> Result<LegacyMessage, String> {
    if bytes.len() < 5 || &bytes[..4] != b"AXIB" || bytes[4] != 1 {
        return Err("Unsupported AXION binary protocol header or version".to_string());
    }
    let mut decoder = BinaryValueDecoder {
        bytes,
        offset: 5,
        nodes: 0,
    };
    let value = decoder.read_value(0)?;
    if decoder.offset != bytes.len() {
        return Err("AXION binary packet contains trailing bytes".to_string());
    }
    serde_json::from_value(value).map_err(|error| format!("Invalid AXION binary message: {error}"))
}

#[tauri::command]
fn get_computer_name() -> Result<String, String> {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .map_err(|_| "Unable to read the computer name from the environment".to_string())?;
    let name = name.trim();

    if name.is_empty() {
        return Err("The computer name is empty".to_string());
    }

    Ok(name.to_string())
}

#[tauri::command]
fn axion_list_locales(app: AppHandle) -> Result<Vec<String>, String> {
    let directory = locale_directory(&app)?;
    ensure_builtin_locales(&directory)?;
    let mut locales = fs::read_dir(&directory)
        .map_err(|error| format!("Could not read locale directory: {error}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file()
                || path.extension().and_then(|extension| extension.to_str()) != Some("json")
            {
                return None;
            }
            let code = path.file_stem()?.to_str()?;
            valid_locale_code(code).then(|| code.to_string())
        })
        .collect::<Vec<_>>();
    locales.sort();
    locales.dedup();
    Ok(locales)
}

#[tauri::command]
fn axion_read_locale(locale: String, app: AppHandle) -> Result<String, String> {
    if !valid_locale_code(&locale) {
        return Err(
            "Locale code must contain 2-16 letters, digits, hyphens, or underscores".to_string(),
        );
    }
    let directory = locale_directory(&app)?;
    ensure_builtin_locales(&directory)?;
    fs::read_to_string(directory.join(format!("{locale}.json")))
        .map_err(|error| format!("Could not read locale {locale}: {error}"))
}

#[tauri::command]
fn axion_open_locale_folder(app: AppHandle) -> Result<(), String> {
    let directory = locale_directory(&app)?;
    ensure_builtin_locales(&directory)?;
    tauri_plugin_opener::open_path(directory, None::<&str>)
        .map_err(|error| format!("Could not open locale directory: {error}"))
}

#[tauri::command]
fn axion_server_status(server: State<'_, Arc<AxionServer>>) -> ServerStatus {
    server.status()
}

#[tauri::command]
fn axion_server_set_port(
    port: u16,
    app: AppHandle,
    server: State<'_, Arc<AxionServer>>,
) -> Result<(), String> {
    server.set_server_port(app, port)
}

#[tauri::command]
fn axion_list_agents(server: State<'_, Arc<AxionServer>>) -> Vec<ConnectedAgent> {
    server.list_agents()
}

#[tauri::command]
fn axion_delete_agent(
    agent_id: String,
    app: AppHandle,
    server: State<'_, Arc<AxionServer>>,
) -> Result<(), String> {
    server.delete_agent(&agent_id)?;
    app.emit("axion-agent-deleted", serde_json::json!({ "id": agent_id }))
        .map_err(|error| format!("Agent was deleted but the UI could not be notified: {error}"))
}

#[tauri::command]
fn axion_kill_agent_instance(
    agent_id: String,
    server: State<'_, Arc<AxionServer>>,
) -> Result<(), String> {
    server.send_agent_command(&agent_id, "KillInstance")
}

#[tauri::command]
fn axion_execute_script(
    agent_id: String,
    script: String,
    server: State<'_, Arc<AxionServer>>,
) -> Result<(), String> {
    let message = encode_agent_script(&script)?;
    server.send_agent_message(&agent_id, &message)
}

#[tauri::command]
fn axion_execute_scripts(
    agent_ids: Vec<String>,
    script: String,
    server: State<'_, Arc<AxionServer>>,
) -> Result<Vec<AgentCommandResult>, String> {
    let message = encode_agent_script(&script)?;
    server.send_agent_messages(&agent_ids, &message)
}

#[tauri::command]
fn axion_set_agent_status(
    agent_id: String,
    status: String,
    server: State<'_, Arc<AxionServer>>,
) -> Result<ConnectedAgent, String> {
    server.set_agent_status(&agent_id, &status)
}

#[tauri::command]
fn axion_server_script_api_status(server: State<'_, Arc<AxionServer>>) -> Value {
    serde_json::json!({
        "running": server.api_running.load(Ordering::Acquire),
        "host": SERVER_HOST,
        "port": server.api_port.load(Ordering::Acquire),
        "error": server.api_error.lock().expect("API error lock poisoned").clone(),
    })
}

#[tauri::command]
fn axion_server_script_set_port(
    port: u16,
    app: AppHandle,
    server: State<'_, Arc<AxionServer>>,
) -> Result<(), String> {
    server.set_script_api_port(app, port)
}

#[tauri::command]
fn axion_server_script_set_token(
    token: String,
    server: State<'_, Arc<AxionServer>>,
) -> Result<(), String> {
    server.set_api_token(token)
}

#[tauri::command]
fn axion_server_script_respond(
    request_id: String,
    result: Value,
    error: Option<String>,
    server: State<'_, Arc<AxionServer>>,
) -> Result<(), String> {
    let sender = server
        .pending_api_requests
        .lock()
        .expect("pending request lock poisoned")
        .get(&request_id)
        .cloned()
        .ok_or_else(|| "Server Script request has expired".to_string())?;
    sender
        .send(ScriptApiResponse {
            result: if error.is_none() { Some(result) } else { None },
            error,
        })
        .map_err(|_| "Server Script request has expired".to_string())
}

#[tauri::command]
fn axion_item_cache_list(server: State<'_, Arc<AxionServer>>) -> Vec<CachedInventory> {
    server.list_inventories()
}

#[tauri::command]
fn save_server_script_profile(path: String, contents: String) -> Result<(), String> {
    let output_path = PathBuf::from(path);
    if output_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("json")
    {
        return Err("Profile export path must end in .json".to_string());
    }
    fs::write(output_path, contents).map_err(|error| format!("Could not save profile: {error}"))
}

#[tauri::command]
fn axion_item_cache_update(
    custom_game_id: String,
    account_id: String,
    old_category: String,
    old_name: String,
    old_quantity: u64,
    old_item_id: Option<String>,
    new_category: String,
    new_name: String,
    new_quantity: u64,
    new_item_id: Option<String>,
    server: State<'_, Arc<AxionServer>>,
) -> Result<CachedInventory, String> {
    server.update_inventory_item(
        &custom_game_id,
        &account_id,
        &old_category,
        &old_name,
        old_quantity,
        old_item_id.as_deref(),
        &new_category,
        &new_name,
        new_quantity,
        new_item_id.as_deref(),
    )
}

#[tauri::command]
fn axion_item_cache_add(
    custom_game_id: String,
    account_id: String,
    category: String,
    name: String,
    quantity: u64,
    item_id: Option<String>,
    server: State<'_, Arc<AxionServer>>,
) -> Result<CachedInventory, String> {
    server.add_inventory_item(
        &custom_game_id,
        &account_id,
        &category,
        &name,
        quantity,
        item_id.as_deref(),
    )
}

#[tauri::command]
fn axion_item_cache_delete(
    custom_game_id: String,
    account_id: String,
    category: String,
    name: String,
    quantity: u64,
    item_id: Option<String>,
    server: State<'_, Arc<AxionServer>>,
) -> Result<CachedInventory, String> {
    server.delete_inventory_item(
        &custom_game_id,
        &account_id,
        &category,
        &name,
        quantity,
        item_id.as_deref(),
    )
}

#[tauri::command]
fn axion_item_cache_delete_workspace(
    custom_game_id: String,
    account_id: String,
    server: State<'_, Arc<AxionServer>>,
) -> Result<(), String> {
    server.delete_account_workspace(&custom_game_id, &account_id)
}

fn handle_connection(stream: TcpStream, app: AppHandle, server: Arc<AxionServer>) {
    if let Err(error) = stream.set_nonblocking(false) {
        *server.error.lock().expect("server error lock poisoned") = Some(format!(
            "Could not configure AXION connection blocking mode: {error}"
        ));
        return;
    }
    if let Err(error) = stream.set_read_timeout(Some(Duration::from_secs(15))) {
        *server.error.lock().expect("server error lock poisoned") = Some(format!(
            "Could not configure AXION connection timeout: {error}"
        ));
        return;
    }
    if let Err(error) = stream.set_write_timeout(Some(COMMAND_SEND_TIMEOUT)) {
        *server.error.lock().expect("server error lock poisoned") =
            Some(format!("Could not configure AXION send timeout: {error}"));
        return;
    }

    let identity = Arc::new(Mutex::new(None::<AgentIdentity>));
    let handshake_identity = Arc::clone(&identity);
    let handshake_server = Arc::clone(&server);
    let config = WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..WebSocketConfig::default()
    };
    let websocket = accept_hdr_with_config(
        stream,
        move |request: &Request, response: Response| match parse_agent_identity(request) {
            Ok(parsed) => {
                if handshake_server
                    .deleted_agent_ids
                    .lock()
                    .expect("deleted agent lock poisoned")
                    .contains(&parsed.id)
                {
                    return Err(ErrorResponse::new(Some(
                        "This AXION account has been deleted".to_string(),
                    )));
                }
                *handshake_identity.lock().expect("identity lock poisoned") = Some(parsed);
                Ok(response)
            }
            Err(message) => Err(ErrorResponse::new(Some(message))),
        },
        Some(config),
    );

    let mut socket = match websocket {
        Ok(socket) => socket,
        Err(_) => return,
    };
    if let Err(error) = socket
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(1)))
    {
        *server.error.lock().expect("server error lock poisoned") =
            Some(format!("Could not configure AXION agent timeout: {error}"));
        return;
    }
    let identity = match identity.lock().expect("identity lock poisoned").take() {
        Some(identity) => identity,
        None => return,
    };
    let deleted_agent_ids = server
        .deleted_agent_ids
        .lock()
        .expect("deleted agent lock poisoned");
    if deleted_agent_ids.contains(&identity.id) {
        let _ = socket.close(None);
        return;
    }
    let connection_token = server.next_connection.fetch_add(1, Ordering::Relaxed);
    let connected_at = now_ms();
    let agent = ConnectedAgent {
        id: identity.id.clone(),
        name: identity.name,
        status: "online".to_string(),
        server: identity.job_id,
        place_id: None,
        connected_at,
        last_seen_at: connected_at,
    };
    let (command_sender, command_receiver) =
        mpsc::sync_channel::<AgentCommand>(COMMAND_QUEUE_CAPACITY);

    let mut agents = server.agents.lock().expect("agent lock poisoned");
    agents.insert(
        agent.id.clone(),
        AgentEntry {
            info: agent.clone(),
            connection_token,
            command_sender,
            last_command_at: None,
        },
    );
    drop(agents);
    drop(deleted_agent_ids);
    let _ = app.emit("axion-agent-connected", &agent);
    for cached in server
        .workspaces
        .lock()
        .expect("workspace lock poisoned")
        .values()
        .filter(|record| record.session.agent_id == agent.id)
    {
        let _ = app.emit(
            "axion-item-cache-updated",
            CachedInventory {
                player_id: agent.id.clone(),
                account_id: cached.meta.account_id.clone(),
                custom_game_id: cached.meta.custom_game_id.clone(),
                agent_id: agent.id.clone(),
                agent_name: cached.session.agent_name.clone(),
                categories: inventory_category_names(&cached.inventory),
                items: flatten_inventory(&cached.inventory),
                updated_at: cached.meta.updated_at,
                online: true,
            },
        );
    }

    let mut last_heartbeat_ui_update = Instant::now();
    let mut last_message_at = Instant::now();
    'connection: loop {
        if !server.running.load(Ordering::Acquire) {
            break;
        }
        loop {
            match command_receiver.try_recv() {
                Ok(command) => {
                    if Instant::now() >= command.deadline {
                        let _ = command.response.send(Err(
                            "AXION command expired before it could be sent; please retry"
                                .to_string(),
                        ));
                        continue;
                    }
                    let result = socket
                        .send(Message::Text(command.message.clone().into()))
                        .map_err(|error| format!("Could not send AXION command: {error}"));
                    let _ = command.response.send(result.clone());
                    if let Err(error) = result {
                        let _ = app.emit(
                            "axion-agent-protocol-error",
                            serde_json::json!({
                                "agentId": agent.id,
                                "message": error,
                            }),
                        );
                        break 'connection;
                    }
                    let _ = app.emit(
                        "axion-agent-command-sent",
                        serde_json::json!({
                            "agentId": agent.id,
                            "timestamp": now_ms(),
                        }),
                    );
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
        let incoming = match socket.read() {
            Ok(Message::Text(text)) => {
                if text.len() > MAX_MESSAGE_BYTES {
                    Err("AXION message exceeds the 16 KiB limit".to_string())
                } else {
                    serde_json::from_str::<LegacyMessage>(&text)
                        .map(|message| (message, text.len()))
                        .map_err(|error| format!("Invalid AXION message: {error}"))
                }
            }
            Ok(Message::Binary(bytes)) => {
                if bytes.len() > MAX_MESSAGE_BYTES {
                    Err("AXION binary message exceeds the 16 KiB limit".to_string())
                } else {
                    decode_binary_agent_message(&bytes).map(|message| (message, bytes.len()))
                }
            }
            Ok(Message::Ping(payload)) => {
                if socket.send(Message::Pong(payload)).is_err() {
                    break;
                }
                continue;
            }
            Ok(Message::Close(frame)) => {
                let _ = socket.close(frame);
                break;
            }
            Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => continue,
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                if heartbeat_expired(last_message_at, Instant::now()) {
                    break 'connection;
                }
                continue;
            }
            Err(_) => break,
        };
        let (message, message_size_bytes) = match incoming {
            Ok(incoming) => incoming,
            Err(error) => {
                let _ = app.emit(
                    "axion-agent-protocol-error",
                    serde_json::json!({
                        "agentId": agent.id,
                        "message": error,
                    }),
                );
                let _ = socket.close(None);
                break;
            }
        };
        last_message_at = Instant::now();
        let heartbeat_at = {
            let mut agents = server.agents.lock().expect("agent lock poisoned");
            agents.get_mut(&agent.id).and_then(|entry| {
                if entry.connection_token == connection_token {
                    let timestamp = now_ms();
                    entry.info.last_seen_at = timestamp;
                    Some(timestamp)
                } else {
                    None
                }
            })
        };
        if message.name == "ping"
            && heartbeat_update_due(&mut last_heartbeat_ui_update, Instant::now())
        {
            if let Some(last_seen_at) = heartbeat_at {
                let _ = app.emit(
                    "axion-agent-heartbeat",
                    serde_json::json!({
                        "id": agent.id,
                        "lastSeenAt": last_seen_at,
                    }),
                );
            }
        }
        if message.name == "ping" {
            let ack = match encode_agent_heartbeat_ack() {
                Ok(ack) => ack,
                Err(_) => break,
            };
            if socket.send(Message::Text(ack.into())).is_err() {
                break;
            }
        }
        process_agent_message(&app, &server, &agent.id, message, message_size_bytes);
    }

    let disconnected = {
        let mut agents = server.agents.lock().expect("agent lock poisoned");
        if agents
            .get(&agent.id)
            .is_some_and(|entry| entry.connection_token == connection_token)
        {
            agents.remove(&agent.id);
            true
        } else {
            false
        }
    };
    if disconnected {
        let _ = app.emit(
            "axion-item-cache-offline",
            serde_json::json!({ "playerId": agent.id }),
        );
        let _ = app.emit(
            "axion-agent-disconnected",
            serde_json::json!({ "id": agent.id }),
        );
    }
}

fn handle_script_api_connection(mut stream: TcpStream, app: AppHandle, server: Arc<AxionServer>) {
    if let Err(error) = stream.set_nonblocking(false) {
        *server.api_error.lock().expect("API error lock poisoned") = Some(format!(
            "Could not configure Server Scripts connection blocking mode: {error}"
        ));
        return;
    }
    let _ = stream.set_read_timeout(Some(SCRIPT_API_TIMEOUT + Duration::from_secs(1)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));

    let request = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err((status, message)) => {
            let _ = write_http_response(
                stream,
                status,
                serde_json::json!({"ok": false, "error": message}),
            );
            return;
        }
    };

    if request.method == "OPTIONS" {
        let _ = write_http_response(stream, 204, Value::Null);
        return;
    }
    if request.method != "POST" || request.path != "/api/v1/call" {
        let _ = write_http_response(
            stream,
            404,
            serde_json::json!({"ok": false, "error": "Unknown Server Scripts API route"}),
        );
        return;
    }

    let token = server
        .api_token
        .lock()
        .expect("API token lock poisoned")
        .clone();
    let Some(expected_token) = token else {
        let _ = write_http_response(
            stream,
            503,
            serde_json::json!({"ok": false, "error": "Server Scripts API has not been initialized"}),
        );
        return;
    };
    let provided_token = request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(provided_token.as_bytes(), expected_token.as_bytes()) {
        let _ = write_http_response(
            stream,
            401,
            serde_json::json!({"ok": false, "error": "Invalid Server Scripts API token"}),
        );
        return;
    }
    if let Err(wait) = server.check_script_api_rate_limit(Instant::now()) {
        let _ = write_http_response(
            stream,
            429,
            serde_json::json!({
                "ok": false,
                "error": format!("Server Scripts API is rate limited; retry in {} ms", wait.as_millis()),
            }),
        );
        return;
    }
    if !request
        .headers
        .get("content-type")
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("application/json"))
    {
        let _ = write_http_response(
            stream,
            415,
            serde_json::json!({"ok": false, "error": "Content-Type must be application/json"}),
        );
        return;
    }
    let api_request: ScriptApiRequest = match serde_json::from_slice(&request.body) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_http_response(
                stream,
                400,
                serde_json::json!({"ok": false, "error": format!("Invalid JSON request: {error}")}),
            );
            return;
        }
    };
    match server.dispatch_script_call(
        &app,
        api_request.function,
        api_request.custom_game_id,
        api_request.args,
    ) {
        Ok(result) => {
            let response = serde_json::json!({"ok": true, "result": result});
            let serialized = match serde_json::to_vec(&response) {
                Ok(serialized) => serialized,
                Err(error) => {
                    let _ = write_http_response(
                        stream,
                        500,
                        serde_json::json!({"ok": false, "error": format!("Could not encode Server Script response: {error}")}),
                    );
                    return;
                }
            };
            if serialized.len() > MAX_MESSAGE_BYTES {
                let _ = write_http_response(
                    stream,
                    413,
                    serde_json::json!({"ok": false, "error": "Server Script result exceeds the 16 KiB limit"}),
                );
            } else {
                let _ = write_http_body(stream, 200, &serialized);
            }
        }
        Err(error) => {
            let _ = write_http_response(
                stream,
                422,
                serde_json::json!({"ok": false, "error": error}),
            );
        }
    }
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, (u16, String)> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if bytes.len() > 8 * 1024 {
            return Err((413, "HTTP headers exceed the 8 KiB limit".to_string()));
        }
        let count = stream
            .read(&mut buffer)
            .map_err(|error| (400, format!("Could not read HTTP request: {error}")))?;
        if count == 0 {
            return Err((400, "HTTP request ended before its headers".to_string()));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > 8 * 1024 + MAX_MESSAGE_BYTES {
            return Err((
                413,
                "HTTP request exceeds the 16 KiB body limit".to_string(),
            ));
        }
    };
    let header_text = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| (400, "HTTP headers must be valid UTF-8".to_string()))?;
    let mut lines = header_text.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();
    if method.is_empty() || path.is_empty() {
        return Err((400, "Malformed HTTP request line".to_string()));
    }
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| (400, "Malformed HTTP header".to_string()))?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    let content_length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| (400, "Invalid Content-Length header".to_string()))?
        .unwrap_or(0);
    if content_length > MAX_MESSAGE_BYTES {
        return Err((
            413,
            "HTTP request body exceeds the 16 KiB limit".to_string(),
        ));
    }
    let body_start = header_end;
    while bytes.len() - body_start < content_length {
        let count = stream
            .read(&mut buffer)
            .map_err(|error| (400, format!("Could not read HTTP request body: {error}")))?;
        if count == 0 {
            return Err((400, "HTTP request body ended unexpectedly".to_string()));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(HttpRequest {
        method,
        path,
        headers,
        body: bytes[body_start..body_start + content_length].to_vec(),
    })
}

fn write_http_response(stream: TcpStream, status: u16, value: Value) -> std::io::Result<()> {
    let body = if status == 204 {
        Vec::new()
    } else {
        serde_json::to_vec(&value)
            .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?
    };
    write_http_body(stream, status, &body)
}

fn write_http_body(mut stream: TcpStream, status: u16, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn workspace_key(custom_game_id: &str, account_id: &str) -> String {
    format!("{custom_game_id}/{account_id}")
}

fn validate_server_port(port: u16, api_port: u16) -> Result<(), String> {
    if !(1024..=u16::MAX).contains(&port) || port == api_port {
        return Err(format!(
            "WebSocket port must be between 1024 and 65535 and cannot match the Server Scripts API port {api_port}"
        ));
    }
    Ok(())
}

fn validate_script_api_port(port: u16, server_port: u16) -> Result<(), String> {
    if !(1024..=u16::MAX).contains(&port) || port == server_port {
        return Err(format!(
            "Server Scripts API port must be between 1024 and 65535 and cannot match the WebSocket port {server_port}"
        ));
    }
    Ok(())
}

fn is_safe_file_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn parse_workspace_report(payload: &Value) -> Result<WorkspaceReport, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "InventoryUpdate payload must be an object".to_string())?;
    let required_id = |camel: &str, pascal: &str| -> Result<String, String> {
        let value = object
            .get(camel)
            .or_else(|| object.get(pascal))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| is_safe_file_id(value))
            .ok_or_else(|| {
                format!(
                    "InventoryUpdate must include a valid {camel} (letters, numbers, _ or -, up to 64 characters)"
                )
            })?;
        Ok(value.to_string())
    };
    let custom_game_id = required_id("customGameId", "CustomGameId")?;
    let account_id = required_id("accountId", "AccountId")?;
    let world = object
        .get("world")
        .or_else(|| object.get("World"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 80)
        .ok_or_else(|| "InventoryUpdate must include a valid world name".to_string())?
        .to_string();
    let profile = object
        .get("profile")
        .or_else(|| object.get("Profile"))
        .map(|value| {
            if value.is_object() {
                Ok(value.clone())
            } else if value.as_array().is_some_and(Vec::is_empty) {
                Ok(empty_object())
            } else {
                Err("InventoryUpdate profile must be an object".to_string())
            }
        })
        .transpose()?;
    let world_progress = object
        .get("worldProgress")
        .or_else(|| object.get("WorldProgress"))
        .map(|value| {
            if let Some(map) = value.as_object() {
                Ok(map
                    .iter()
                    .map(|(world, progress)| (world.clone(), progress.clone()))
                    .collect::<HashMap<_, _>>())
            } else if value.as_array().is_some_and(Vec::is_empty) {
                Ok(HashMap::new())
            } else {
                Err("InventoryUpdate worldProgress must be an object".to_string())
            }
        })
        .transpose()?;
    let inventory = object
        .get("inventory")
        .or_else(|| object.get("Inventory"))
        .map(|value| {
            let Some(categories) = value.as_object() else {
                if value.as_array().is_some_and(Vec::is_empty) {
                    return Ok(HashMap::new());
                }
                return Err("InventoryUpdate inventory must be an object".to_string());
            };
            for category in categories.keys() {
                if !is_inventory_category(category) {
                    return Err(format!(
                        "InventoryUpdate contains invalid inventory category name: {category}"
                    ));
                }
                if categories.get(category).is_some_and(|items| {
                    !items.is_object() && !items.as_array().is_some_and(Vec::is_empty)
                }) {
                    return Err(format!(
                        "InventoryUpdate inventory.{category} must be an object"
                    ));
                }
            }
            Ok(categories
                .iter()
                .map(|(category, items)| {
                    let items = if items.as_array().is_some_and(Vec::is_empty) {
                        empty_object()
                    } else {
                        items.clone()
                    };
                    (category.clone(), items)
                })
                .collect::<HashMap<_, _>>())
        })
        .transpose()?;
    let inventory_delta = object
        .get("inventoryDelta")
        .or_else(|| object.get("InventoryDelta"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let inventory_snapshot = object
        .get("inventorySnapshot")
        .or_else(|| object.get("InventorySnapshot"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let removed_inventory_items = object
        .get("inventoryRemoved")
        .or_else(|| object.get("InventoryRemoved"))
        .map(|value| {
            let categories = value
                .as_object()
                .ok_or_else(|| "InventoryUpdate inventoryRemoved must be an object".to_string())?;
            let mut removed = HashMap::new();
            for (category, names) in categories {
                if !is_inventory_category(category) {
                    return Err(format!(
                        "InventoryUpdate contains invalid removed inventory category name: {category}"
                    ));
                }
                let names = names.as_array().ok_or_else(|| {
                    format!("InventoryUpdate inventoryRemoved.{category} must be an array")
                })?;
                let mut parsed_names = Vec::with_capacity(names.len());
                for name in names {
                    let name = name.as_str().filter(|name| !name.is_empty()).ok_or_else(|| {
                        format!("InventoryUpdate inventoryRemoved.{category} must contain item names")
                    })?;
                    parsed_names.push(name.to_string());
                }
                removed.insert(category.clone(), parsed_names);
            }
            Ok(removed)
        })
        .transpose()?
        .unwrap_or_default();
    let inventory_changes = object
        .get("inventoryChanges")
        .or_else(|| object.get("InventoryChanges"))
        .map(|value| {
            let changes = value
                .as_array()
                .ok_or_else(|| "InventoryUpdate inventoryChanges must be an array".to_string())?;
            if changes.len() > MAX_INVENTORY_ITEMS {
                return Err(format!(
                    "Inventory reports are limited to {MAX_INVENTORY_ITEMS} changed values"
                ));
            }
            changes
                .iter()
                .map(|change| {
                    let change = change
                        .as_object()
                        .ok_or_else(|| "InventoryUpdate changes must be objects".to_string())?;
                    let category = change
                        .get("category")
                        .and_then(Value::as_str)
                        .filter(|category| is_inventory_category(category))
                        .ok_or_else(|| {
                            "InventoryUpdate change has an invalid category".to_string()
                        })?
                        .to_string();
                    let name = change
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty() && name.len() <= 80)
                        .ok_or_else(|| {
                            "InventoryUpdate change has an invalid item name".to_string()
                        })?
                        .to_string();
                    let path = change
                        .get("path")
                        .and_then(Value::as_array)
                        .ok_or_else(|| "InventoryUpdate change path must be an array".to_string())?
                        .iter()
                        .map(|key| {
                            key.as_str()
                                .filter(|key| !key.is_empty() && key.len() <= 128)
                                .map(str::to_string)
                                .ok_or_else(|| {
                                    "InventoryUpdate change path must contain valid object keys"
                                        .to_string()
                                })
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if path.len() > 32 {
                        return Err("InventoryUpdate change path cannot exceed 32 keys".to_string());
                    }
                    let remove = change
                        .get("remove")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if change
                        .get("remove")
                        .is_some_and(|remove| !remove.is_boolean())
                    {
                        return Err("InventoryUpdate change remove must be a boolean".to_string());
                    }
                    let value = change.get("value").cloned();
                    if path.is_empty() && remove {
                        return Err(
                            "InventoryUpdate cannot remove an item with an empty change path"
                                .to_string(),
                        );
                    }
                    if remove == value.is_some() {
                        return Err(
                            "InventoryUpdate changes must include either a value or remove=true"
                                .to_string(),
                        );
                    }
                    Ok(InventoryDeltaChange {
                        category,
                        name,
                        path,
                        value,
                        remove,
                    })
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?
        .unwrap_or_default();
    if inventory_delta && inventory_snapshot {
        return Err("Inventory report cannot be both a snapshot and a delta".to_string());
    }
    if (!inventory_delta && !inventory_changes.is_empty())
        || (inventory_delta && inventory_snapshot)
    {
        return Err("Inventory changes require a delta report".to_string());
    }
    if inventory_snapshot && !removed_inventory_items.is_empty() {
        return Err("Inventory snapshots cannot include item removals".to_string());
    }
    if let Some(inventory) = &inventory {
        let item_count = inventory.values().map(count_items).sum::<usize>();
        let removed_count = removed_inventory_items
            .values()
            .map(Vec::len)
            .sum::<usize>();
        if item_count > MAX_INVENTORY_ITEMS || removed_count > MAX_INVENTORY_ITEMS {
            return Err(format!(
                "Inventory reports are limited to {MAX_INVENTORY_ITEMS} items"
            ));
        }
    } else if inventory_delta
        || inventory_snapshot
        || !removed_inventory_items.is_empty()
        || !inventory_changes.is_empty()
    {
        return Err("Inventory delta must include an inventory object".to_string());
    }
    if !inventory_delta && (!removed_inventory_items.is_empty() || !inventory_changes.is_empty()) {
        return Err("Inventory removals and changes require an inventory delta".to_string());
    }
    Ok(WorkspaceReport {
        custom_game_id,
        account_id,
        world,
        profile,
        world_progress,
        inventory,
        inventory_delta,
        inventory_snapshot,
        removed_inventory_items,
        inventory_changes,
    })
}

fn count_items(value: &Value) -> usize {
    value.as_object().map_or(0, serde_json::Map::len)
}

fn merge_inventory(
    target: &mut WorkspaceInventory,
    values: HashMap<String, Value>,
    delta: bool,
    snapshot: bool,
    removed_items: HashMap<String, Vec<String>>,
) {
    if snapshot {
        target.categories = values;
        return;
    }
    if delta {
        for (category, items) in values {
            let target_items = target
                .categories
                .entry(category)
                .or_insert_with(empty_object);
            if !target_items.is_object() {
                *target_items = empty_object();
            }
            let target_items = target_items
                .as_object_mut()
                .expect("inventory category was normalized to an object");
            if let Some(items) = items.as_object() {
                for (name, item) in items {
                    target_items.insert(name.clone(), item.clone());
                }
            }
        }
        for (category, names) in removed_items {
            let category_is_empty = if let Some(items) = target
                .categories
                .get_mut(&category)
                .and_then(Value::as_object_mut)
            {
                for name in names {
                    items.remove(&name);
                }
                items.is_empty()
            } else {
                false
            };
            if category_is_empty {
                target.categories.remove(&category);
            }
        }
        return;
    }
    for (category, items) in values {
        target.categories.insert(category, items);
    }
}

fn apply_inventory_changes(target: &mut WorkspaceInventory, changes: Vec<InventoryDeltaChange>) {
    for change in changes {
        let items = target
            .categories
            .entry(change.category)
            .or_insert_with(empty_object);
        if !items.is_object() {
            *items = empty_object();
        }
        let items = items
            .as_object_mut()
            .expect("inventory category was normalized to an object");
        if change.path.is_empty() {
            if let Some(value) = change.value {
                items.insert(change.name, value);
            }
            continue;
        }

        let item = items.entry(change.name).or_insert_with(empty_object);
        apply_inventory_value_change(item, &change.path, change.value, change.remove);
    }
}

fn apply_inventory_value_change(
    target: &mut Value,
    path: &[String],
    value: Option<Value>,
    remove: bool,
) {
    if remove && !target.is_object() {
        return;
    }
    let Some((key, remaining)) = path.split_first() else {
        return;
    };
    if !target.is_object() {
        *target = empty_object();
    }
    let object = target
        .as_object_mut()
        .expect("inventory item was normalized to an object");
    if remaining.is_empty() {
        if remove {
            object.remove(key);
        } else if let Some(value) = value {
            object.insert(key.clone(), value);
        }
        return;
    }
    if remove && !object.contains_key(key) {
        return;
    }
    let child = object.entry(key.clone()).or_insert_with(empty_object);
    apply_inventory_value_change(child, remaining, value, remove);
}

fn is_inventory_category(category: &str) -> bool {
    (1..=64).contains(&category.chars().count())
        && category.chars().all(|character| {
            if character.is_ascii() {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            } else {
                !character.is_control() && !character.is_whitespace()
            }
        })
}

fn inventory_category_mut<'a>(
    inventory: &'a mut WorkspaceInventory,
    category: &str,
) -> Result<&'a mut Value, String> {
    if !is_inventory_category(category) {
        return Err("Invalid inventory category name".to_string());
    }
    Ok(inventory
        .categories
        .entry(category.to_string())
        .or_insert_with(empty_object))
}

fn inventory_category<'a>(
    inventory: &'a WorkspaceInventory,
    category: &str,
) -> Result<&'a Value, String> {
    inventory
        .categories
        .get(category)
        .ok_or_else(|| "Inventory category does not exist".to_string())
}

fn replace_workspace_inventory_item(
    inventory: &mut WorkspaceInventory,
    old_category: &str,
    old_name: &str,
    old_quantity: u64,
    old_item_id: Option<&str>,
    new_category: &str,
    new_name: &str,
    new_quantity: u64,
    new_item_id: Option<&str>,
) -> Result<(), String> {
    let source_items = inventory_category(inventory, old_category)?
        .as_object()
        .ok_or_else(|| "Cached inventory category is invalid".to_string())?;
    let old_key = source_items
        .iter()
        .find_map(|(key, value)| {
            let details = value.as_object();
            let name = details
                .and_then(|details| details.get("name").or_else(|| details.get("Name")))
                .and_then(Value::as_str)
                .unwrap_or(key);
            let quantity = details
                .and_then(|details| {
                    details
                        .get("quantity")
                        .or_else(|| details.get("Quantity"))
                        .or_else(|| details.get("count"))
                        .or_else(|| details.get("Count"))
                })
                .and_then(Value::as_u64)
                .or_else(|| value.as_u64())
                .unwrap_or(1);
            let item_id = details
                .and_then(|details| details.get("itemId").or_else(|| details.get("ItemId")))
                .and_then(Value::as_str);
            (name == old_name && quantity == old_quantity && item_id == old_item_id)
                .then(|| key.clone())
        })
        .ok_or_else(|| {
            "The selected inventory item has changed; refresh and try again".to_string()
        })?;
    let target_contains_item = inventory
        .categories
        .get(new_category)
        .map(|items| {
            items
                .as_object()
                .ok_or_else(|| "Cached inventory category is invalid".to_string())
        })
        .transpose()?
        .is_some_and(|items| items.contains_key(new_name));
    if target_contains_item && !(old_category == new_category && old_key == new_name) {
        return Err(format!(
            "An item named {new_name} already exists in this category"
        ));
    }
    let mut value = inventory_category_mut(inventory, old_category)?
        .as_object_mut()
        .and_then(|items| items.remove(&old_key))
        .ok_or_else(|| "The selected inventory item no longer exists".to_string())?;
    if !value.is_object() {
        value = serde_json::json!({});
    }
    let details = value
        .as_object_mut()
        .ok_or_else(|| "Cached inventory item is invalid".to_string())?;
    details.insert("name".to_string(), Value::String(new_name.to_string()));
    details.insert("quantity".to_string(), Value::from(new_quantity));
    if let Some(item_id) = new_item_id.filter(|item_id| !item_id.is_empty()) {
        details.remove("ItemId");
        details.insert("itemId".to_string(), Value::String(item_id.to_string()));
    } else {
        details.remove("itemId");
        details.remove("ItemId");
    }
    inventory_category_mut(inventory, new_category)?
        .as_object_mut()
        .ok_or_else(|| "Cached inventory category is invalid".to_string())?
        .insert(new_name.to_string(), value);
    Ok(())
}

fn flatten_inventory(inventory: &WorkspaceInventory) -> Vec<InventoryItem> {
    let mut items = Vec::new();
    for (category, values) in &inventory.categories {
        if let Some(values) = values.as_object() {
            for (name, value) in values {
                let (item_name, quantity, item_id, item_value) =
                    if let Some(details) = value.as_object() {
                        let item_name = details
                            .get("name")
                            .or_else(|| details.get("Name"))
                            .and_then(Value::as_str)
                            .unwrap_or(name)
                            .to_string();
                        let quantity = details
                            .get("quantity")
                            .or_else(|| details.get("Quantity"))
                            .or_else(|| details.get("count"))
                            .or_else(|| details.get("Count"))
                            .and_then(Value::as_u64)
                            .unwrap_or(1);
                        let item_id = details
                            .get("itemId")
                            .or_else(|| details.get("ItemId"))
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let item_value = details
                            .get("value")
                            .or_else(|| details.get("Value"))
                            .and_then(|value| {
                                (value.is_string() || value.is_number() || value.is_boolean())
                                    .then(|| value.clone())
                            });
                        (item_name, quantity, item_id, item_value)
                    } else {
                        (name.clone(), value.as_u64().unwrap_or(1), None, None)
                    };
                items.push(InventoryItem {
                    name: item_name,
                    quantity,
                    item_id,
                    category: category.to_string(),
                    value: item_value,
                });
            }
        }
    }
    items.sort_by(|left, right| left.name.cmp(&right.name));
    items
}

fn inventory_category_names(inventory: &WorkspaceInventory) -> Vec<String> {
    let mut categories = inventory.categories.keys().cloned().collect::<Vec<_>>();
    categories.sort();
    categories
}

fn parse_agent_identity(request: &Request) -> Result<AgentIdentity, String> {
    if request.uri().path() != "/AXION" {
        return Err("Only the /AXION WebSocket route is available".to_string());
    }
    let query = request.uri().query().unwrap_or_default();
    let values = query
        .split('&')
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            Some((decode_query_component(key), decode_query_component(value)))
        })
        .collect::<HashMap<_, _>>();

    let id = values.get("id").filter(|value| !value.trim().is_empty());
    let name = values.get("name").filter(|value| !value.trim().is_empty());
    let job_id = values.get("jobId").cloned().unwrap_or_default();
    match (id, name) {
        (Some(id), Some(name)) => Ok(AgentIdentity {
            id: id.clone(),
            name: name.clone(),
            job_id,
        }),
        _ => Err("The AXION URL must include non-empty name and id query parameters".to_string()),
    }
}

fn decode_query_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let high = hex_value(bytes[index + 1]);
                let low = hex_value(bytes[index + 2]);
                if let (Some(high), Some(low)) = (high, low) {
                    decoded.push((high << 4) | low);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn process_agent_message(
    app: &AppHandle,
    server: &AxionServer,
    agent_id: &str,
    message: LegacyMessage,
    message_size_bytes: usize,
) {
    match message.name.as_str() {
        "ping" => {
            if let Some(payload) = heartbeat_workspace_report(message.payload) {
                process_workspace_report(app, server, agent_id, payload, message_size_bytes);
            }
        }
        "Log" => {
            if let Some(content) = message
                .payload
                .as_ref()
                .and_then(|payload| payload.get("Content"))
                .and_then(Value::as_str)
            {
                let _ = app.emit(
                    "axion-agent-log",
                    serde_json::json!({
                        "agentId": agent_id,
                        "message": content.chars().take(8_192).collect::<String>(),
                        "timestamp": now_ms(),
                    }),
                );
            }
        }
        "SetPlaceId" | "SetJobId" => {
            if let Some(value) = message
                .payload
                .as_ref()
                .and_then(|payload| payload_identifier(payload, message.name.as_str()))
            {
                let mut agents = server.agents.lock().expect("agent lock poisoned");
                if let Some(agent) = agents.get_mut(agent_id) {
                    if message.name == "SetPlaceId" {
                        agent.info.place_id = Some(value);
                    } else {
                        agent.info.server = value;
                    }
                    agent.info.last_seen_at = now_ms();
                    let _ = app.emit("axion-agent-updated", &agent.info);
                }
            }
        }
        "Echo" => {
            let _ = app.emit(
                "axion-agent-message",
                serde_json::json!({
                    "agentId": agent_id,
                    "name": message.name,
                    "payload": message.payload,
                }),
            );
        }
        "InventoryUpdate" => {
            process_workspace_report(
                app,
                server,
                agent_id,
                message.payload.unwrap_or(Value::Null),
                message_size_bytes,
            );
        }
        _ => {
            let _ = app.emit(
                "axion-agent-protocol-error",
                serde_json::json!({
                    "agentId": agent_id,
                    "message": format!("Unsupported agent message type: {}", message.name),
                }),
            );
        }
    }
}

fn process_workspace_report(
    app: &AppHandle,
    server: &AxionServer,
    agent_id: &str,
    payload: Value,
    message_size_bytes: usize,
) {
    let connected_agent = {
        let agents = server.agents.lock().expect("agent lock poisoned");
        let Some(agent) = agents.get(agent_id) else {
            return;
        };
        agent.info.clone()
    };
    match server.store_workspace_report(&connected_agent, &payload) {
        Ok(snapshot) => {
            let _ = app.emit(
                "axion-item-cache-updated",
                InventoryCacheUpdated {
                    snapshot,
                    message_size_bytes,
                    max_message_bytes: MAX_MESSAGE_BYTES,
                },
            );
        }
        Err(error) => {
            let _ = app.emit(
                "axion-agent-protocol-error",
                serde_json::json!({ "agentId": agent_id, "message": error }),
            );
        }
    }
}

fn heartbeat_workspace_report(payload: Option<Value>) -> Option<Value> {
    payload.filter(|payload| payload.get("inventory").is_some())
}

fn payload_identifier(payload: &Value, message_name: &str) -> Option<String> {
    let field_names = if message_name == "SetPlaceId" {
        [
            "PlaceId", "placeId", "Id", "id", "Value", "value", "Content", "content",
        ]
    } else {
        [
            "JobId", "jobId", "Id", "id", "Value", "value", "Content", "content",
        ]
    };
    let value = payload
        .as_object()
        .and_then(|object| field_names.iter().find_map(|key| object.get(*key)))
        .unwrap_or(payload);
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn encode_agent_command(command: &str) -> Result<String, String> {
    let name = match command {
        "KillInstance" => "KillInstance",
        _ => return Err(format!("Unsupported agent command: {command}")),
    };
    serde_json::to_string(&serde_json::json!({ "Name": name, "Payload": {} }))
        .map_err(|error| format!("Could not encode agent command: {error}"))
}

fn encode_agent_heartbeat_ack() -> Result<String, String> {
    serde_json::to_string(&serde_json::json!({ "Name": "pong" }))
        .map_err(|error| format!("Could not encode AXION heartbeat response: {error}"))
}

fn encode_agent_script(script: &str) -> Result<String, String> {
    if script.trim().is_empty() {
        return Err("Script cannot be empty".to_string());
    }
    let message = format!("execute {script}");
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(format!(
            "Script exceeds the {} byte AXION WebSocket message limit",
            MAX_MESSAGE_BYTES
        ));
    }
    Ok(message)
}

fn ensure_command_rate_limit(
    last_command_at: Option<Instant>,
    now: Instant,
    agent_id: &str,
) -> Result<(), String> {
    if let Some(last_command_at) = last_command_at {
        let elapsed = now.duration_since(last_command_at);
        if elapsed < COMMAND_MIN_INTERVAL {
            return Err(format!(
                "AXION is rate limited for Agent {agent_id}; wait {} ms before sending another command",
                (COMMAND_MIN_INTERVAL - elapsed).as_millis()
            ));
        }
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn copy_missing_files(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create AXION data directory: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read existing application data: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not read application data entry: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_missing_files(&source_path, &destination_path)?;
        } else if !destination_path.exists() {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not create AXION data folder: {error}"))?;
            }
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Could not migrate existing AXION data: {error}"))?;
        }
    }
    Ok(())
}

fn heartbeat_update_due(last_update: &mut Instant, now: Instant) -> bool {
    if now.duration_since(*last_update) < HEARTBEAT_UI_UPDATE_INTERVAL {
        return false;
    }
    *last_update = now;
    true
}

fn heartbeat_expired(last_message_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_message_at) >= HEARTBEAT_TIMEOUT
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            app.handle().plugin(tauri_plugin_dialog::init())?;
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| std::io::Error::new(ErrorKind::NotFound, "main window not found"))?;
            window.set_icon(icon)?;

            let app_data_dir = app.path().app_data_dir()?;
            ensure_builtin_locales(&app_data_dir.join("Locales"))
                .map_err(|error| std::io::Error::new(ErrorKind::Other, error))?;
            if let Some(app_data_parent) = app_data_dir.parent() {
                let legacy_data_dir = app_data_parent.join("com.autohub.app");
                copy_missing_files(&legacy_data_dir, &app_data_dir)
                    .map_err(|error| std::io::Error::new(ErrorKind::Other, error))?;
            }
            let workspace_path = app_data_dir.join("Database").join("Workspace");
            let server = Arc::new(
                AxionServer::new(workspace_path)
                    .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?,
            );
            server.start(app.handle().clone());
            server.start_script_api(app.handle().clone());
            app.manage(server);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_computer_name,
            axion_list_locales,
            axion_read_locale,
            axion_open_locale_folder,
            axion_server_status,
            axion_server_set_port,
            axion_list_agents,
            axion_delete_agent,
            axion_kill_agent_instance,
            axion_execute_script,
            axion_execute_scripts,
            axion_set_agent_status,
            axion_server_script_api_status,
            axion_server_script_set_port,
            axion_server_script_set_token,
            axion_server_script_respond,
            axion_item_cache_list,
            axion_item_cache_update,
            axion_item_cache_add,
            axion_item_cache_delete,
            axion_item_cache_delete_workspace,
            save_server_script_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleted_agent_registry_keeps_only_the_most_recent_ids() {
        let mut deleted = DeletedAgentIds::default();
        for index in 0..=MAX_DELETED_AGENT_IDS {
            deleted.insert(format!("agent-{index}"));
        }

        assert_eq!(deleted.ids.len(), MAX_DELETED_AGENT_IDS);
        assert!(!deleted.contains("agent-0"));
        assert!(deleted.contains(&format!("agent-{MAX_DELETED_AGENT_IDS}")));
    }

    #[test]
    fn websocket_connection_threads_are_bounded() {
        let active = AtomicUsize::new(0);
        for _ in 0..MAX_AGENT_CONNECTIONS {
            assert!(try_acquire_agent_connection_slot(&active));
        }
        assert!(!try_acquire_agent_connection_slot(&active));
        assert_eq!(active.load(Ordering::Acquire), MAX_AGENT_CONNECTIONS);

        let counter = Arc::new(AtomicUsize::new(1));
        drop(AgentConnectionGuard(counter.clone()));
        assert_eq!(counter.load(Ordering::Acquire), 0);
    }

    fn encode_binary_test_value(value: &Value, bytes: &mut Vec<u8>) {
        match value {
            Value::Null => bytes.push(0),
            Value::Bool(false) => bytes.push(1),
            Value::Bool(true) => bytes.push(2),
            Value::Number(number) => {
                bytes.push(3);
                bytes.extend(
                    number
                        .as_f64()
                        .expect("test number should fit f64")
                        .to_le_bytes(),
                );
            }
            Value::String(value) => {
                bytes.push(4);
                bytes.extend((value.len() as u32).to_le_bytes());
                bytes.extend(value.as_bytes());
            }
            Value::Array(values) => {
                bytes.push(5);
                bytes.extend((values.len() as u32).to_le_bytes());
                for value in values {
                    encode_binary_test_value(value, bytes);
                }
            }
            Value::Object(values) => {
                bytes.push(6);
                bytes.extend((values.len() as u32).to_le_bytes());
                for (key, value) in values {
                    encode_binary_test_value(&Value::String(key.clone()), bytes);
                    encode_binary_test_value(value, bytes);
                }
            }
        }
    }

    fn binary_test_packet(value: &Value) -> Vec<u8> {
        let mut bytes = b"AXIB\x01".to_vec();
        encode_binary_test_value(value, &mut bytes);
        bytes
    }

    #[test]
    fn decodes_binary_agent_envelopes_with_nested_json_values() {
        let packet = binary_test_packet(&serde_json::json!({
            "Name": "ping",
            "Payload": {
                "items": [null, false, true, 123.5, "héllo"],
                "state": {"ready": true}
            }
        }));

        let message = decode_binary_agent_message(&packet).expect("valid binary envelope");

        assert_eq!(message.name, "ping");
        assert_eq!(
            message.payload,
            Some(serde_json::json!({
                "items": [null, false, true, 123.5, "héllo"],
                "state": {"ready": true}
            }))
        );
    }

    #[test]
    fn rejects_malformed_binary_agent_packets() {
        let mut invalid_header = binary_test_packet(&serde_json::json!({"Name": "ping"}));
        invalid_header[4] = 2;
        assert!(decode_binary_agent_message(&invalid_header).is_err());

        let mut trailing_data = binary_test_packet(&serde_json::json!({"Name": "ping"}));
        trailing_data.push(0);
        assert!(decode_binary_agent_message(&trailing_data).is_err());

        let mut truncated_string = b"AXIB\x01\x04\x02\x00\x00\x00x".to_vec();
        assert!(decode_binary_agent_message(&truncated_string).is_err());
        truncated_string.pop();
        assert!(decode_binary_agent_message(&truncated_string).is_err());

        let invalid_utf8 = b"AXIB\x01\x04\x01\x00\x00\x00\xff".to_vec();
        assert!(decode_binary_agent_message(&invalid_utf8).is_err());
    }

    #[test]
    fn limits_binary_agent_packet_structure() {
        let mut too_deep = serde_json::json!({"Name": "ping"});
        for _ in 0..34 {
            too_deep = serde_json::json!([too_deep]);
        }
        assert!(decode_binary_agent_message(&binary_test_packet(&too_deep)).is_err());

        let mut too_many = b"AXIB\x01\x05".to_vec();
        too_many.extend(((MAX_BINARY_NODES + 1) as u32).to_le_bytes());
        assert!(decode_binary_agent_message(&too_many).is_err());
    }

    #[test]
    fn repairs_outdated_builtin_locale_values() {
        let directory = std::env::temp_dir().join(format!("axion-stale-locale-test-{}", now_ms()));
        fs::create_dir_all(&directory).expect("locale test directory should be created");
        fs::write(
            directory.join("th-TH.json"),
            r#"{"agents":{"liveLog":"Old log label","status":{"online":{"label":"Online"},"busy":4},"status.online":"Old online","status.busy":"Old busy","status.idle":"Old idle","status.offline":"Old offline","status.error":"Old error"},"player":{"durationSeconds":false}}"#,
        )
        .expect("stale locale should be writable");

        ensure_builtin_locales(&directory).expect("stale locale values should be repaired");

        let repaired: Value = serde_json::from_str(
            &fs::read_to_string(directory.join("th-TH.json"))
                .expect("repaired locale should be readable"),
        )
        .expect("repaired locale should remain valid JSON");
        let defaults: Value = serde_json::from_str(include_str!("../../config/locales/th-TH.json"))
            .expect("bundled Thai locale should be valid JSON");
        assert!(repaired["agents"].get("liveLog").is_none());
        for key in [
            "status.online",
            "status.busy",
            "status.idle",
            "status.offline",
            "status.error",
        ] {
            assert!(repaired["agents"].get(key).is_none());
        }
        assert_eq!(
            repaired["agents"]["status"]["online"],
            defaults["agents"]["status"]["online"]
        );
        assert_eq!(
            repaired["agents"]["status"]["busy"],
            defaults["agents"]["status"]["busy"]
        );
        assert_eq!(
            repaired["player"]["durationSeconds"],
            defaults["player"]["durationSeconds"]
        );
        assert_eq!(
            repaired["player"]["durationHoursMinutesSeconds"],
            defaults["player"]["durationHoursMinutesSeconds"]
        );
        assert_eq!(
            repaired["player"]["durationMinutesSeconds"],
            defaults["player"]["durationMinutesSeconds"]
        );
        fs::remove_dir_all(directory).expect("locale test directory should be removed");
    }

    #[test]
    fn removes_duplicate_keys_from_installed_locale_files() {
        let directory =
            std::env::temp_dir().join(format!("axion-duplicate-locale-test-{}", now_ms()));
        let duplicate_source = include_str!("../../config/locales/en-US.json").replacen(
            r#""connected": "Connected","#,
            r#""connected": "Connected", "connected": "Duplicate value","#,
            1,
        );
        assert!(contains_duplicate_json_keys(&duplicate_source));
        fs::create_dir_all(&directory).expect("locale test directory should be created");
        fs::write(directory.join("en-US.json"), &duplicate_source)
            .expect("duplicate locale should be writable");

        ensure_builtin_locales(&directory).expect("duplicate locale should be normalized");

        let normalized = fs::read_to_string(directory.join("en-US.json"))
            .expect("normalized locale should be readable");
        assert!(!contains_duplicate_json_keys(&normalized));
        let parsed: Value =
            serde_json::from_str(&normalized).expect("normalized locale should be valid JSON");
        assert_eq!(parsed["player"]["connected"], "Duplicate value");
        fs::remove_dir_all(directory).expect("locale test directory should be removed");
    }

    #[test]
    fn locale_files_are_installed_once_and_codes_are_restricted() {
        let directory = std::env::temp_dir().join(format!("axion-locales-test-{}", now_ms()));
        ensure_builtin_locales(&directory).expect("built-in locales should be installed");
        fs::write(
            directory.join("en-US.json"),
            r#"{"console":{"search":"My custom search translation"},"custom":{"keep":"value"}}"#,
        )
        .expect("custom locale should be writable");
        ensure_builtin_locales(&directory).expect("existing locales should be merged");
        let updated: Value = serde_json::from_str(
            &fs::read_to_string(directory.join("en-US.json")).expect("locale should be readable"),
        )
        .expect("merged locale should remain valid JSON");
        assert_eq!(updated["console"]["search"], "My custom search translation");
        assert_eq!(
            updated["console"]["noMatches"],
            "No entries match your filters"
        );
        assert_eq!(updated["custom"]["keep"], "value");
        fs::write(
            directory.join("th-TH.json"),
            r#"{"description":"Luau SDK Central Management","custom":"Keep Luau as entered","settings":{"websocketPort":"Old port label","websocketPortApply":"Old apply","websocketPortApplying":"Old applying","websocketPortDescription":"Old address {host}:{port}","websocketPortFailed":"Old failure {detail}","websocketPortInvalid":"Old invalid","websocketPortLoadFailed":"Old load failure {detail}","websocketPortSaved":"Old saved {host}:{port}","customSetting":"Keep this"}}"#,
        )
        .expect("stale locale should be writable");
        ensure_builtin_locales(&directory).expect("stale locale wording should be migrated");
        let migrated: Value = serde_json::from_str(
            &fs::read_to_string(directory.join("th-TH.json")).expect("locale should be readable"),
        )
        .expect("migrated locale should remain valid JSON");
        assert_eq!(migrated["description"], "Lua SDK Central Management");
        assert_eq!(migrated["custom"], "Keep Lua as entered");
        assert_eq!(migrated["settings"]["customSetting"], "Keep this");
        assert!(migrated["settings"].get("websocketPort").is_none());
        assert!(migrated["settings"].get("websocketPortApply").is_none());
        assert!(migrated["settings"].get("websocketPortSaved").is_none());
        assert!(migrated["serverScript"]["websocketPortOnline"].is_string());
        assert!(migrated["serverScript"]["websocketPortOffline"].is_string());
        assert!(valid_locale_code("ja"));
        assert!(valid_locale_code("zh-Hant"));
        assert!(!valid_locale_code("../en"));
        assert!(!valid_locale_code(""));
        fs::remove_dir_all(directory).expect("locale test directory should be removed");
    }

    #[test]
    fn migrates_legacy_builtin_locale_filenames_and_keeps_custom_translations() {
        let directory =
            std::env::temp_dir().join(format!("axion-locale-filename-migration-{}", now_ms()));
        fs::create_dir_all(&directory).expect("locale directory should be created");
        for (legacy, _) in [("en", "en-US"), ("th", "th-TH"), ("vn", "vi-VN")] {
            fs::write(
                directory.join(format!("{legacy}.json")),
                r#"{"custom":{"preserved":"custom translation"}}"#,
            )
            .expect("legacy locale should be writable");
        }

        ensure_builtin_locales(&directory).expect("legacy locale files should be migrated");

        for (legacy, current) in [("en", "en-US"), ("th", "th-TH"), ("vn", "vi-VN")] {
            let current_path = directory.join(format!("{current}.json"));
            let locale: Value = serde_json::from_str(
                &fs::read_to_string(&current_path).expect("migrated locale should be readable"),
            )
            .expect("migrated locale should be valid JSON");
            assert_eq!(locale["custom"]["preserved"], "custom translation");
            assert!(!directory.join(format!("{legacy}.json")).exists());
        }
        fs::remove_dir_all(directory).expect("locale migration directory should be removed");
    }

    #[test]
    fn repairs_builtin_translation_placeholder_mismatches() {
        let directory =
            std::env::temp_dir().join(format!("axion-locale-placeholder-test-{}", now_ms()));
        fs::create_dir_all(&directory).expect("locale directory should be created");
        let mut thai: Value = serde_json::from_str(include_str!("../../config/locales/th-TH.json"))
            .expect("built-in Thai locale should parse");
        thai["serverScript"]["scopeSaveFailed"] =
            Value::String("Game scope could not be saved.".to_string());
        fs::write(
            directory.join("th-TH.json"),
            serde_json::to_vec(&thai).expect("stale locale should serialize"),
        )
        .expect("stale locale should be writable");

        ensure_builtin_locales(&directory).expect("placeholder mismatch should be repaired");

        let repaired: Value = serde_json::from_slice(
            &fs::read(directory.join("th-TH.json")).expect("repaired locale should be readable"),
        )
        .expect("repaired locale should parse");
        assert_eq!(
            repaired["serverScript"]["scopeSaveFailed"],
            "เปลี่ยน Game Scope แล้ว แต่บันทึกค่าที่เลือกไว้ในอุปกรณ์นี้ไม่สำเร็จ: {detail}"
        );
        fs::remove_dir_all(directory).expect("locale test directory should be removed");
    }

    #[test]
    fn migrates_legacy_app_data_without_overwriting_axion_data() {
        let test_dir = std::env::temp_dir().join(format!("axion-migration-test-{}", now_ms()));
        let source = test_dir.join("com.autohub.app");
        let destination = test_dir.join("com.axion.app");
        fs::create_dir_all(source.join("Database"))
            .expect("legacy application data directory should be created");
        fs::create_dir_all(&destination)
            .expect("AXION application data directory should be created");
        fs::write(source.join("Database").join("workspace.json"), "legacy")
            .expect("legacy workspace should be written");
        fs::write(destination.join("settings.json"), "new")
            .expect("existing AXION settings should be written");

        copy_missing_files(&source, &destination).expect("legacy application data should migrate");

        assert_eq!(
            fs::read_to_string(destination.join("Database").join("workspace.json"))
                .expect("migrated workspace should be readable"),
            "legacy"
        );
        assert_eq!(
            fs::read_to_string(destination.join("settings.json"))
                .expect("existing AXION settings should remain readable"),
            "new"
        );
        fs::remove_dir_all(test_dir).expect("migration test directory should be removed");
    }

    #[test]
    fn throttles_online_heartbeat_ui_updates_to_ten_seconds() {
        let start = Instant::now();
        let mut last_update = start;
        assert!(!heartbeat_update_due(
            &mut last_update,
            start + Duration::from_secs(9)
        ));
        assert!(heartbeat_update_due(
            &mut last_update,
            start + Duration::from_secs(10)
        ));
        assert!(!heartbeat_update_due(
            &mut last_update,
            start + Duration::from_secs(19)
        ));
        assert!(heartbeat_update_due(
            &mut last_update,
            start + Duration::from_secs(20)
        ));
    }

    #[test]
    fn expires_agent_connection_after_missed_heartbeats() {
        let last_message = Instant::now();
        assert!(!heartbeat_expired(
            last_message,
            last_message + HEARTBEAT_TIMEOUT - Duration::from_millis(1)
        ));
        assert!(heartbeat_expired(
            last_message,
            last_message + HEARTBEAT_TIMEOUT
        ));
    }

    #[test]
    fn parses_agent_metadata_from_lua_script_url() {
        let request = tungstenite::handshake::client::Request::builder()
            .uri("/AXION?name=Worker+One&id=123&jobId=server-abc")
            .header("Host", "localhost")
            .body(())
            .expect("valid request");
        let parsed = parse_agent_identity(&request).expect("identity should parse");
        assert_eq!(parsed.id, "123");
        assert_eq!(parsed.name, "Worker One");
        assert_eq!(parsed.job_id, "server-abc");
    }

    #[test]
    fn rejects_wrong_routes_and_missing_identity() {
        let wrong_route = tungstenite::handshake::client::Request::builder()
            .uri("/other?name=Worker&id=123")
            .header("Host", "localhost")
            .body(())
            .expect("valid request");
        assert!(parse_agent_identity(&wrong_route).is_err());

        let missing_id = tungstenite::handshake::client::Request::builder()
            .uri("/AXION?name=Worker")
            .header("Host", "localhost")
            .body(())
            .expect("valid request");
        assert!(parse_agent_identity(&missing_id).is_err());
    }

    #[test]
    fn accepts_only_valid_json_message_shapes() {
        let message: LegacyMessage =
            serde_json::from_str(r#"{"Name":"Log","Payload":{"Content":"ready"}}"#)
                .expect("legacy Lua message should parse");
        assert_eq!(message.name, "Log");
        assert_eq!(
            message.payload.and_then(|payload| payload
                .get("Content")
                .and_then(Value::as_str)
                .map(str::to_string)),
            Some("ready".to_string())
        );
        assert!(serde_json::from_str::<LegacyMessage>(r#"{"Name":12}"#).is_err());
    }

    #[test]
    fn heartbeat_only_contains_workspace_report_when_inventory_is_present() {
        assert!(heartbeat_workspace_report(None).is_none());
        assert!(heartbeat_workspace_report(Some(serde_json::json!({"status": "alive"}))).is_none());
        let report = serde_json::json!({
            "customGameId": "AXION_TEST",
            "accountId": "12345",
            "world": "Unknown",
            "inventory": {"materials": {"Ore": {"quantity": 2}}}
        });
        assert_eq!(
            heartbeat_workspace_report(Some(report.clone())),
            Some(report)
        );
    }

    #[test]
    fn validates_workspace_ids_and_inventory_categories() {
        let valid = serde_json::json!({
            "customGameId": "BLOX_FRUITS",
            "accountId": "12345",
            "world": "Sea 1",
            "profile": {"level": 100},
            "worldProgress": {"Sea 1": {"bosses": []}},
            "inventory": {"fruits": {"Dragon": 1}}
        });
        let report = parse_workspace_report(&valid).expect("valid workspace should parse");
        assert_eq!(report.custom_game_id, "BLOX_FRUITS");
        assert_eq!(report.account_id, "12345");
        assert_eq!(report.world, "Sea 1");
        assert!(parse_workspace_report(&serde_json::json!({
            "customGameId": "../BLOX_FRUITS",
            "accountId": "12345",
            "world": "Sea 1"
        }))
        .is_err());
        let custom_category_report = parse_workspace_report(&serde_json::json!({
            "customGameId": "BLOX_FRUITS",
            "accountId": "12345",
            "world": "Sea 1",
            "inventory": {
                "custom_category-2": {"item": 1},
                "pets🎒": {"pet": {"quantity": 1, "value": "Mythical"}},
                "หมวด🐉": {"item": 3}
            }
        }))
        .expect("valid custom inventory categories should be accepted");
        let mut custom_inventory = WorkspaceInventory::default();
        merge_inventory(
            &mut custom_inventory,
            custom_category_report.inventory.unwrap(),
            false,
            false,
            HashMap::new(),
        );
        assert_eq!(custom_inventory.categories["custom_category-2"]["item"], 1);
        assert_eq!(
            custom_inventory.categories["pets🎒"]["pet"]["value"],
            "Mythical"
        );
        assert_eq!(custom_inventory.categories["หมวด🐉"]["item"], 3);
        let serialized =
            serde_json::to_value(&custom_inventory).expect("custom inventory should serialize");
        let restored: WorkspaceInventory =
            serde_json::from_value(serialized).expect("custom inventory should deserialize");
        assert_eq!(restored.categories["custom_category-2"]["item"], 1);
        assert_eq!(restored.categories["pets🎒"]["pet"]["value"], "Mythical");
        let pet = flatten_inventory(&restored)
            .into_iter()
            .find(|item| item.name == "pet")
            .expect("flattened inventory should include custom item value");
        assert_eq!(pet.value, Some(Value::String("Mythical".to_string())));
        assert_eq!(restored.categories["หมวด🐉"]["item"], 3);
        assert!(is_inventory_category(&"🎒".repeat(64)));
        assert!(!is_inventory_category(&"🎒".repeat(65)));

        let legacy_inventory: WorkspaceInventory = serde_json::from_value(serde_json::json!({
            "fruits": {},
            "swords": {},
            "guns": {},
            "accessories": {},
            "materials": {}
        }))
        .expect("legacy inventory categories should deserialize");
        assert_eq!(inventory_category_names(&legacy_inventory).len(), 5);

        for invalid_category in [
            "",
            "has space",
            "has\u{00a0}space",
            "bad/name",
            &"x".repeat(65),
        ] {
            let invalid_report = serde_json::json!({
                "customGameId": "BLOX_FRUITS",
                "accountId": "12345",
                "world": "Sea 1",
                "inventory": {(invalid_category): {"item": 1}}
            });
            assert!(
                parse_workspace_report(&invalid_report).is_err(),
                "invalid category {invalid_category:?} should be rejected"
            );
        }

        let lua_empty_tables = parse_workspace_report(&serde_json::json!({
            "customGameId": "AXION_TEST",
            "accountId": "12345_TEST",
            "world": "Test World",
            "profile": [],
            "worldProgress": [],
            "inventory": {
                "fruits": [],
                "swords": [],
                "guns": [],
                "accessories": [],
                "materials": {"AXION_TEST_ITEM": {"quantity": 7}}
            }
        }))
        .expect("empty Lua tables should be accepted as empty JSON objects");
        assert_eq!(lua_empty_tables.profile, Some(empty_object()));
        assert!(lua_empty_tables.world_progress.unwrap().is_empty());
        let inventory = lua_empty_tables.inventory.unwrap();
        assert_eq!(inventory["fruits"], empty_object());
        assert_eq!(inventory["swords"], empty_object());
        assert_eq!(inventory["guns"], empty_object());
        assert_eq!(inventory["accessories"], empty_object());
        assert!(parse_workspace_report(&serde_json::json!({
            "customGameId": "AXION_TEST",
            "accountId": "12345_TEST",
            "world": "Test World",
            "inventory": {"fruits": [{"unexpected": "item"}]}
        }))
        .is_err());
    }

    #[test]
    fn merges_inventory_deltas_and_replaces_automatic_snapshots() {
        let mut inventory = WorkspaceInventory::default();
        merge_inventory(
            &mut inventory,
            HashMap::from([(
                "materials".to_string(),
                serde_json::json!({"Ore": {"quantity": 2}, "Wood": {"quantity": 1}}),
            )]),
            false,
            false,
            HashMap::new(),
        );

        merge_inventory(
            &mut inventory,
            HashMap::from([(
                "materials".to_string(),
                serde_json::json!({"Ore": {"quantity": 5}, "Gem": {"quantity": 1}}),
            )]),
            true,
            false,
            HashMap::from([("materials".to_string(), vec!["Wood".to_string()])]),
        );
        assert_eq!(inventory.categories["materials"]["Ore"]["quantity"], 5);
        assert_eq!(inventory.categories["materials"]["Gem"]["quantity"], 1);
        assert!(inventory.categories["materials"].get("Wood").is_none());

        merge_inventory(
            &mut inventory,
            HashMap::from([(
                "fruits".to_string(),
                serde_json::json!({"Dragon": {"quantity": 1}}),
            )]),
            false,
            true,
            HashMap::new(),
        );
        assert_eq!(inventory.categories.len(), 1);
        assert!(inventory.categories.get("materials").is_none());
        assert_eq!(inventory.categories["fruits"]["Dragon"]["quantity"], 1);
    }

    #[test]
    fn applies_inventory_field_changes_without_replacing_other_fields() {
        let mut inventory = WorkspaceInventory::default();
        inventory.categories.insert(
            "materials".to_string(),
            serde_json::json!({
                "Ore": {
                    "quantity": 2,
                    "itemId": "ore-id",
                    "metadata": {"quality": "rare", "source": "mine"}
                }
            }),
        );
        apply_inventory_changes(
            &mut inventory,
            vec![
                InventoryDeltaChange {
                    category: "materials".to_string(),
                    name: "Ore".to_string(),
                    path: vec!["quantity".to_string()],
                    value: Some(Value::from(5)),
                    remove: false,
                },
                InventoryDeltaChange {
                    category: "materials".to_string(),
                    name: "Ore".to_string(),
                    path: vec!["metadata".to_string(), "quality".to_string()],
                    value: None,
                    remove: true,
                },
            ],
        );

        let ore = &inventory.categories["materials"]["Ore"];
        assert_eq!(ore["quantity"], 5);
        assert_eq!(ore["itemId"], "ore-id");
        assert_eq!(ore["metadata"]["source"], "mine");
        assert!(ore["metadata"].get("quality").is_none());
    }

    #[test]
    fn parses_inventory_delta_metadata() {
        let report = parse_workspace_report(&serde_json::json!({
            "customGameId": "BLOX_FRUITS",
            "accountId": "12345",
            "world": "Unknown",
            "inventoryDelta": true,
            "inventory": {},
            "inventoryChanges": [{
                "category": "materials",
                "name": "Ore",
                "path": ["quantity"],
                "value": 5
            }, {
                "category": "materials",
                "name": "Ore",
                "path": ["metadata", "quality"],
                "remove": true
            }],
            "inventoryRemoved": {"materials": ["Wood"]}
        }))
        .expect("valid inventory delta should parse");
        assert!(report.inventory_delta);
        assert!(!report.inventory_snapshot);
        assert_eq!(
            report.removed_inventory_items["materials"],
            vec!["Wood".to_string()]
        );
        assert_eq!(report.inventory_changes.len(), 2);
        assert_eq!(
            report.inventory_changes[0].path,
            vec!["quantity".to_string()]
        );
        assert_eq!(report.inventory_changes[0].value, Some(Value::from(5)));
        assert!(report.inventory_changes[1].remove);
        assert_eq!(
            report.inventory_changes[1].path,
            vec!["metadata".to_string(), "quality".to_string()]
        );

        assert!(parse_workspace_report(&serde_json::json!({
            "customGameId": "BLOX_FRUITS",
            "accountId": "12345",
            "world": "Unknown",
            "inventoryDelta": true,
            "inventorySnapshot": true,
            "inventory": {}
        }))
        .is_err());
    }

    #[test]
    fn validates_server_script_api_port_range_and_reservation() {
        assert!(validate_script_api_port(1024, SERVER_PORT).is_ok());
        assert!(validate_script_api_port(5243, SERVER_PORT).is_ok());
        assert!(validate_script_api_port(u16::MAX, SERVER_PORT).is_ok());
        assert!(validate_script_api_port(0, SERVER_PORT).is_err());
        assert!(validate_script_api_port(1023, SERVER_PORT).is_err());
        assert!(validate_script_api_port(SERVER_PORT, SERVER_PORT).is_err());
        assert!(validate_server_port(1024, SCRIPT_API_PORT).is_ok());
        assert!(validate_server_port(u16::MAX, SCRIPT_API_PORT).is_ok());
        assert!(validate_server_port(0, SCRIPT_API_PORT).is_err());
        assert!(validate_server_port(1023, SCRIPT_API_PORT).is_err());
        assert!(validate_server_port(SCRIPT_API_PORT, SCRIPT_API_PORT).is_err());
    }

    #[test]
    fn accepts_server_script_api_function_name_alias_and_restricts_token_format() {
        let request: ScriptApiRequest =
            serde_json::from_str(
                r#"{"functionName":"find_item","customGameId":"BLOX_FRUITS","args":{"query":"Potion"}}"#,
            )
            .expect("client API request should deserialize");
        assert_eq!(request.function, "find_item");
        assert_eq!(request.custom_game_id, "BLOX_FRUITS");
        assert_eq!(request.args["query"], "Potion");
        assert!(constant_time_eq(b"same-token", b"same-token"));
        assert!(!constant_time_eq(b"same-token", b"different"));

        let server = AxionServer::new(PathBuf::from("missing-inventory-cache-test.json"))
            .expect("server should initialize without a cache file");
        assert!(server.set_api_token("z".repeat(64)).is_err());
        assert!(server.set_api_token("a".repeat(64)).is_ok());
    }

    #[test]
    fn limits_server_script_api_request_frequency() {
        let server = AxionServer::new(PathBuf::from("missing-script-api-cache-test.json"))
            .expect("server should initialize without a cache file");
        let sent_at = Instant::now();
        assert!(server.check_script_api_rate_limit(sent_at).is_ok());
        assert_eq!(
            server
                .check_script_api_rate_limit(
                    sent_at + SCRIPT_API_MIN_INTERVAL - Duration::from_millis(1)
                )
                .expect_err("requests inside the rate limit should be rejected"),
            Duration::from_millis(1)
        );
        assert!(server
            .check_script_api_rate_limit(sent_at + SCRIPT_API_MIN_INTERVAL)
            .is_ok());
    }

    #[test]
    fn persists_inventory_and_restores_it_as_offline_after_restart() {
        let test_dir = std::env::temp_dir().join(format!("axion-workspace-test-{}", now_ms()));
        let workspace_path = test_dir.join("Database").join("Workspace");
        let server =
            AxionServer::new(workspace_path.clone()).expect("new workspace should be empty");
        let agent = ConnectedAgent {
            id: "worker-1".to_string(),
            name: "Worker".to_string(),
            status: "online".to_string(),
            server: "job-1".to_string(),
            place_id: Some("place-1".to_string()),
            connected_at: now_ms(),
            last_seen_at: now_ms(),
        };
        let report = serde_json::json!({
            "customGameId": "BLOX_FRUITS",
            "accountId": "12345",
            "gameName": "Legacy display name",
            "world": "Sea 1",
            "profile": {"level": 10, "bounty": 100},
            "worldProgress": {"Sea 1": {"bosses": ["Bobby"]}},
            "inventory": {
                "fruits": {"Dragon": 1},
                "swords": {"Saber": 1},
                "guns": {},
                "accessories": {},
                "materials": {"Scrap Metal": 5},
                "custom_gear": {"Charm": 2}
            }
        });
        server
            .store_workspace_report(&agent, &report)
            .expect("workspace should be persisted");
        let updated_report = serde_json::json!({
            "customGameId": "BLOX_FRUITS",
            "accountId": "12345",
            "world": "Sea 2",
            "worldProgress": {"Sea 2": {"bosses": ["Don Swan"]}}
        });
        server
            .store_workspace_report(&agent, &updated_report)
            .expect("later world session should update the same workspace");
        let file_path = workspace_path.join("BLOX_FRUITS").join("12345.json");
        server
            .store_workspace_report(
                &agent,
                &serde_json::json!({
                    "customGameId": "BLOX_FRUITS",
                    "accountId": "67890",
                    "world": "Sea 1"
                }),
            )
            .expect("a second account should get a separate file");
        server
            .store_workspace_report(
                &agent,
                &serde_json::json!({
                    "customGameId": "OTHER_GAME",
                    "accountId": "12345",
                    "world": "World A"
                }),
            )
            .expect("a second game should get a separate folder");
        let persisted: Value =
            serde_json::from_slice(&fs::read(&file_path).expect("workspace file should exist"))
                .expect("workspace file should be valid JSON");
        assert_eq!(persisted["session"]["world"], "Sea 2");
        assert!(persisted["meta"].get("gameName").is_none());
        assert_eq!(persisted["worldProgress"]["Sea 1"]["bosses"][0], "Bobby");
        assert_eq!(persisted["worldProgress"]["Sea 2"]["bosses"][0], "Don Swan");
        assert_eq!(persisted["inventory"]["fruits"]["Dragon"], 1);
        assert_eq!(persisted["inventory"]["custom_gear"]["Charm"], 2);
        let mut legacy_workspace = persisted.clone();
        legacy_workspace["meta"]["gameName"] = Value::String("Legacy display name".to_string());
        fs::write(
            &file_path,
            serde_json::to_vec_pretty(&legacy_workspace).expect("legacy workspace should encode"),
        )
        .expect("legacy workspace should be written");
        let restarted = AxionServer::new(workspace_path.clone()).expect("workspace should reload");
        let migrated: Value =
            serde_json::from_slice(&fs::read(&file_path).expect("migrated workspace should exist"))
                .expect("migrated workspace should be valid JSON");
        assert!(migrated["meta"].get("gameName").is_none());
        let inventory = restarted.list_inventories();
        assert_eq!(inventory.len(), 3);
        assert!(inventory
            .iter()
            .any(|entry| { entry.account_id == "12345" && entry.custom_game_id == "BLOX_FRUITS" }));
        assert!(inventory
            .iter()
            .any(|entry| { entry.account_id == "67890" && entry.custom_game_id == "BLOX_FRUITS" }));
        assert!(inventory
            .iter()
            .any(|entry| { entry.account_id == "12345" && entry.custom_game_id == "OTHER_GAME" }));
        assert!(!inventory[0].online);
        assert!(inventory.iter().any(|entry| {
            entry.custom_game_id == "BLOX_FRUITS"
                && entry.account_id == "12345"
                && entry
                    .categories
                    .iter()
                    .any(|category| category == "custom_gear")
                && entry.items.iter().any(|item| {
                    item.name == "Charm" && item.quantity == 2 && item.category == "custom_gear"
                })
        }));
        assert!(inventory.iter().any(|entry| {
            entry.custom_game_id == "BLOX_FRUITS"
                && entry.account_id == "12345"
                && entry.items.iter().any(|item| {
                    item.name == "Scrap Metal" && item.quantity == 5 && item.category == "materials"
                })
        }));
        fs::remove_file(workspace_path.join("BLOX_FRUITS").join("12345.json"))
            .expect("first account workspace should be removed");
        fs::remove_file(workspace_path.join("BLOX_FRUITS").join("67890.json"))
            .expect("second account workspace should be removed");
        fs::remove_file(workspace_path.join("OTHER_GAME").join("12345.json"))
            .expect("other game workspace should be removed");
        fs::remove_dir(workspace_path.join("BLOX_FRUITS"))
            .expect("first game workspace should be removed");
        fs::remove_dir(workspace_path.join("OTHER_GAME"))
            .expect("other game workspace should be removed");
        fs::remove_dir(workspace_path).expect("temporary workspace root should be removed");
        fs::remove_dir(test_dir.join("Database"))
            .expect("temporary database folder should be removed");
        fs::remove_dir(test_dir).expect("temporary test folder should be removed");
    }

    #[test]
    fn updates_cached_inventory_item_and_preserves_other_workspace_data() {
        let test_dir = std::env::temp_dir().join(format!("axion-edit-inventory-test-{}", now_ms()));
        let workspace_path = test_dir.join("Database").join("Workspace");
        let server =
            AxionServer::new(workspace_path.clone()).expect("new workspace should be empty");
        let agent = ConnectedAgent {
            id: "worker-edit-test".to_string(),
            name: "Worker".to_string(),
            status: "online".to_string(),
            server: "job-1".to_string(),
            place_id: None,
            connected_at: now_ms(),
            last_seen_at: now_ms(),
        };
        server
            .store_workspace_report(
                &agent,
                &serde_json::json!({
                    "customGameId": "EDIT_TEST",
                    "accountId": "12345",
                    "world": "World",
                    "profile": {"level": 50},
                    "inventory": {
                        "materials": {
                            "Ore": {"quantity": 5, "itemId": "ore-1"}
                        },
                        "swords": {"Saber": 1}
                    }
                }),
            )
            .expect("workspace report should be saved");

        let updated = server
            .update_inventory_item(
                "EDIT_TEST",
                "12345",
                "materials",
                "Ore",
                5,
                Some("ore-1"),
                "custom_gear",
                "Refined Ore",
                9,
                Some("refined-ore-2"),
            )
            .expect("inventory item should be updated");
        assert!(updated.items.iter().any(|item| {
            item.name == "Refined Ore"
                && item.quantity == 9
                && item.category == "custom_gear"
                && item.item_id.as_deref() == Some("refined-ore-2")
        }));
        assert!(updated
            .categories
            .iter()
            .any(|category| category == "custom_gear"));
        assert!(!updated
            .items
            .iter()
            .any(|item| item.name == "Ore" && item.category == "materials"));
        assert!(server
            .update_inventory_item(
                "EDIT_TEST",
                "12345",
                "custom_gear",
                "Refined Ore",
                9,
                Some("refined-ore-2"),
                "swords",
                "Saber",
                10,
                None,
            )
            .is_err());

        let file_path = workspace_path.join("EDIT_TEST").join("12345.json");
        let persisted: Value =
            serde_json::from_slice(&fs::read(&file_path).expect("workspace file should exist"))
                .expect("workspace should remain valid JSON");
        assert_eq!(persisted["profile"]["level"], 50);
        assert_eq!(
            persisted["inventory"]["custom_gear"]["Refined Ore"]["quantity"],
            9
        );
        assert_eq!(
            persisted["inventory"]["custom_gear"]["Refined Ore"]["itemId"],
            "refined-ore-2"
        );
        assert_eq!(persisted["inventory"]["swords"]["Saber"], 1);
        assert_eq!(persisted["inventory"]["materials"]["Ore"], Value::Null);
        fs::remove_dir_all(test_dir)
            .expect("temporary inventory edit test directory should be removed");
    }

    #[test]
    fn adds_and_deletes_cached_inventory_items_persistently() {
        let test_dir =
            std::env::temp_dir().join(format!("axion-manage-inventory-test-{}", now_ms()));
        let workspace_path = test_dir.join("Database").join("Workspace");
        let server =
            AxionServer::new(workspace_path.clone()).expect("new workspace should be empty");
        let agent = ConnectedAgent {
            id: "worker-manage-test".to_string(),
            name: "Worker".to_string(),
            status: "online".to_string(),
            server: "job-1".to_string(),
            place_id: None,
            connected_at: now_ms(),
            last_seen_at: now_ms(),
        };
        server
            .store_workspace_report(
                &agent,
                &serde_json::json!({
                    "customGameId": "MANAGE_TEST",
                    "accountId": "12345",
                    "world": "World",
                    "profile": {"level": 50}
                }),
            )
            .expect("workspace report should be saved");

        let added = server
            .add_inventory_item("MANAGE_TEST", "12345", "materials", "Ore", 5, Some("ore-2"))
            .expect("inventory item should be added");
        assert!(added.items.iter().any(|item| {
            item.name == "Ore"
                && item.quantity == 5
                && item.category == "materials"
                && item.item_id.as_deref() == Some("ore-2")
        }));
        assert!(server
            .add_inventory_item("MANAGE_TEST", "12345", "materials", "Ore", 1, None)
            .is_err());

        let deleted = server
            .delete_inventory_item("MANAGE_TEST", "12345", "materials", "Ore", 5, Some("ore-2"))
            .expect("inventory item should be deleted");
        assert!(deleted.items.is_empty());
        assert!(server
            .delete_inventory_item("MANAGE_TEST", "12345", "materials", "Ore", 5, Some("ore-2"))
            .is_err());

        let file_path = workspace_path.join("MANAGE_TEST").join("12345.json");
        let persisted: Value =
            serde_json::from_slice(&fs::read(&file_path).expect("workspace file should exist"))
                .expect("workspace should remain valid JSON");
        assert_eq!(persisted["profile"]["level"], 50);
        assert!(persisted["inventory"]["materials"]
            .as_object()
            .expect("materials should remain an object")
            .is_empty());
        fs::remove_dir_all(test_dir)
            .expect("temporary inventory management test directory should be removed");
    }

    #[test]
    fn deletes_account_workspace_from_disk_and_cache() {
        let test_dir =
            std::env::temp_dir().join(format!("axion-delete-workspace-test-{}", now_ms()));
        let workspace_path = test_dir.join("Database").join("Workspace");
        let server =
            AxionServer::new(workspace_path.clone()).expect("new workspace should be empty");
        let agent = ConnectedAgent {
            id: "workspace-delete-agent".to_string(),
            name: "Workspace Delete Test".to_string(),
            status: "online".to_string(),
            server: "job-1".to_string(),
            place_id: None,
            connected_at: now_ms(),
            last_seen_at: now_ms(),
        };
        server
            .store_workspace_report(
                &agent,
                &serde_json::json!({
                    "customGameId": "DELETE_TEST",
                    "accountId": "account-1",
                    "world": "Test World",
                    "inventory": {"materials": {"Ore": 3}}
                }),
            )
            .expect("workspace should be persisted");

        let workspace_file = workspace_path.join("DELETE_TEST").join("account-1.json");
        assert!(workspace_file.exists());
        server
            .delete_account_workspace("DELETE_TEST", "account-1")
            .expect("workspace should be deleted");

        assert!(!workspace_file.exists());
        assert!(server.list_inventories().is_empty());
        assert!(server
            .delete_account_workspace("DELETE_TEST", "account-1")
            .is_err());
        assert!(server
            .delete_account_workspace("../DELETE_TEST", "account-1")
            .is_err());

        fs::remove_dir(workspace_path.join("DELETE_TEST"))
            .expect("game workspace folder should be removed");
        fs::remove_dir(workspace_path).expect("workspace root should be removed");
        fs::remove_dir(test_dir.join("Database"))
            .expect("temporary database folder should be removed");
        fs::remove_dir(test_dir).expect("temporary test folder should be removed");
    }

    #[test]
    fn deleting_agent_persists_block_and_removes_inventory() {
        let test_dir = std::env::temp_dir().join(format!("axion-delete-agent-test-{}", now_ms()));
        fs::create_dir_all(&test_dir).expect("temporary test directory should be created");
        let workspace_path = test_dir.join("Database").join("Workspace");
        fs::create_dir_all(&workspace_path).expect("workspace folder should be created");
        let deleted_path = test_dir.join("deleted-agents.json");
        let server = AxionServer::new(workspace_path.clone()).expect("server should initialize");
        let agent = ConnectedAgent {
            id: "player-delete-test".to_string(),
            name: "Worker".to_string(),
            status: "online".to_string(),
            server: "job-1".to_string(),
            place_id: None,
            connected_at: now_ms(),
            last_seen_at: now_ms(),
        };
        server
            .store_workspace_report(
                &agent,
                &serde_json::json!({
                    "customGameId": "BLOX_FRUITS",
                    "accountId": "12345",
                    "world": "Sea 1",
                    "inventory": {"materials": {"Potion": 1}}
                }),
            )
            .expect("workspace should be persisted");

        server
            .delete_agent("player-delete-test")
            .expect("agent should be deleted");

        let restarted =
            AxionServer::new(workspace_path.clone()).expect("server state should reload");
        assert!(restarted
            .deleted_agent_ids
            .lock()
            .expect("deleted agent lock")
            .contains("player-delete-test"));
        assert!(restarted.list_inventories().is_empty());

        fs::remove_file(deleted_path).expect("deleted agent list should be removed");
        fs::remove_dir(workspace_path.join("BLOX_FRUITS"))
            .expect("game workspace should be removed");
        fs::remove_dir(workspace_path).expect("workspace should be removed");
        fs::remove_dir(test_dir.join("Database"))
            .expect("temporary database folder should be removed");
        fs::remove_dir(test_dir).expect("temporary test folder should be removed");
    }

    #[test]
    fn encodes_only_allowlisted_agent_commands() {
        let encoded = encode_agent_command("KillInstance").expect("known command");
        let message: Value = serde_json::from_str(&encoded).expect("valid json");
        assert_eq!(message["Name"], "KillInstance");
        assert_eq!(message["Payload"], serde_json::json!({}));
        assert!(encode_agent_command("ExecuteLua").is_err());
    }

    #[test]
    fn encodes_axion_heartbeat_acknowledgement() {
        let encoded = encode_agent_heartbeat_ack().expect("heartbeat response");
        let message: Value = serde_json::from_str(&encoded).expect("valid json");
        assert_eq!(message["Name"], "pong");
    }

    #[test]
    fn encodes_scripts_as_axion_execute_messages() {
        assert_eq!(
            encode_agent_script("print('hello')").expect("valid script"),
            "execute print('hello')"
        );
        assert!(encode_agent_script(" \n ").is_err());
        assert!(encode_agent_script(&"a".repeat(MAX_MESSAGE_BYTES)).is_err());
    }

    #[test]
    fn limits_command_frequency_per_agent() {
        let sent_at = Instant::now();
        assert!(ensure_command_rate_limit(None, sent_at, "player-1").is_ok());
        assert!(ensure_command_rate_limit(
            Some(sent_at),
            sent_at + COMMAND_MIN_INTERVAL - Duration::from_millis(1),
            "player-1"
        )
        .is_err());
        assert!(ensure_command_rate_limit(
            Some(sent_at),
            sent_at + COMMAND_MIN_INTERVAL,
            "player-1"
        )
        .is_ok());
    }

    #[test]
    fn extracts_place_and_job_ids_from_legacy_payloads() {
        assert_eq!(
            payload_identifier(&serde_json::json!({"PlaceId": 1234}), "SetPlaceId"),
            Some("1234".to_string())
        );
        assert_eq!(
            payload_identifier(&serde_json::json!({"Content": 1234}), "SetPlaceId"),
            Some("1234".to_string())
        );
        assert_eq!(
            payload_identifier(&serde_json::json!({"jobId": "server-1"}), "SetJobId"),
            Some("server-1".to_string())
        );
        assert_eq!(
            payload_identifier(&serde_json::json!({"Content": "server-2"}), "SetJobId"),
            Some("server-2".to_string())
        );
    }
}
