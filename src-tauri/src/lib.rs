mod agent;
mod config;
mod ws_transport;

use agent::{AgentInstance, AgentManager};
use config::{AgentConfig, AgentsConfig, ConfigManager, ConnectionType};
use parking_lot::RwLock;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

struct AppState {
    config_manager: Arc<RwLock<Option<ConfigManager>>>,
    agent_manager: AgentManager,
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Result<AgentsConfig, String> {
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .map(|cm| cm.get_config())
        .ok_or_else(|| "Config manager not initialized".to_string())
}

#[tauri::command]
fn reload_config(state: State<AppState>) -> Result<AgentsConfig, String> {
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .map(|cm| cm.reload())
        .ok_or_else(|| "Config manager not initialized".to_string())?
}

#[tauri::command]
fn get_config_path(state: State<AppState>) -> Result<String, String> {
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .map(|cm| cm.get_config_path().to_string_lossy().to_string())
        .ok_or_else(|| "Config manager not initialized".to_string())
}

#[tauri::command]
fn spawn_agent(
    name: String,
    cwd: Option<String>,
    state: State<AppState>,
    app_handle: AppHandle,
) -> Result<AgentInstance, String> {
    let config_manager = state.config_manager.read();
    let config = config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .get_config();

    let agent_config = config
        .agents
        .get(&name)
        .ok_or_else(|| format!("Agent '{}' not found in config", name))?;

    state
        .agent_manager
        .spawn_agent(name, agent_config, cwd, app_handle)
}

#[tauri::command]
async fn connect_remote_agent(
    name: String,
    cwd: Option<String>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<AgentInstance, String> {
    let (host, port, config_cwd) = {
        let config_manager = state.config_manager.read();
        let config = config_manager
            .as_ref()
            .ok_or_else(|| "Config manager not initialized".to_string())?
            .get_config();

        let agent_config = config
            .agents
            .get(&name)
            .ok_or_else(|| format!("Agent '{}' not found in config", name))?;

        let host = agent_config
            .host
            .clone()
            .ok_or_else(|| "Remote agent requires a host".to_string())?;
        let port = agent_config
            .port
            .ok_or_else(|| "Remote agent requires a port".to_string())?;
        let config_cwd = agent_config.cwd.clone();
        (host, port, config_cwd)
    };

    // Explicit cwd > agent config cwd
    let resolved_cwd = cwd.or(config_cwd);

    state
        .agent_manager
        .connect_remote_agent(name, &host, port, resolved_cwd, app_handle)
        .await
}

#[tauri::command]
fn send_to_agent(agent_id: String, message: String, state: State<AppState>) -> Result<(), String> {
    state.agent_manager.send_message(&agent_id, &message)
}

#[tauri::command]
fn kill_agent(agent_id: String, state: State<AppState>) -> Result<(), String> {
    state.agent_manager.kill_agent(&agent_id)
}

#[tauri::command]
fn list_running_agents(state: State<AppState>) -> Vec<String> {
    state.agent_manager.list_running_agents()
}

#[tauri::command]
fn add_agent(
    name: String,
    command: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
    connection_type: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    cwd: Option<String>,
    state: State<AppState>,
) -> Result<AgentsConfig, String> {
    let ct = match connection_type.as_deref() {
        Some("remote") => ConnectionType::Remote,
        _ => ConnectionType::Local,
    };
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .add_agent(
            name,
            AgentConfig {
                command,
                args,
                env,
                connection_type: ct,
                host,
                port,
                cwd,
            },
        )
}

#[tauri::command]
fn remove_agent(name: String, state: State<AppState>) -> Result<AgentsConfig, String> {
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .remove_agent(&name)
}

#[tauri::command]
fn update_agent(
    name: String,
    command: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
    connection_type: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    cwd: Option<String>,
    state: State<AppState>,
) -> Result<AgentsConfig, String> {
    let ct = match connection_type.as_deref() {
        Some("remote") => ConnectionType::Remote,
        _ => ConnectionType::Local,
    };
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .update_agent(
            name,
            AgentConfig {
                command,
                args,
                env,
                connection_type: ct,
                host,
                port,
                cwd,
            },
        )
}

#[tauri::command]
fn get_machine_id() -> Result<String, String> {
    machine_uid::get().map_err(|e| format!("Failed to get machine ID: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState {
        config_manager: Arc::new(RwLock::new(None)),
        agent_manager: AgentManager::new(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state: State<AppState> = app.state();

            // Initialize config manager
            match ConfigManager::new(&app_handle) {
                Ok(cm) => {
                    *state.config_manager.write() = Some(cm);
                }
                Err(e) => {
                    eprintln!("Failed to initialize config manager: {}", e);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            reload_config,
            get_config_path,
            spawn_agent,
            connect_remote_agent,
            send_to_agent,
            kill_agent,
            list_running_agents,
            add_agent,
            remove_agent,
            update_agent,
            get_machine_id
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
