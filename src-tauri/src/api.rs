// 桌面版连接服务器的 Tauri 命令。服务器地址存在应用配置目录，登录令牌存在系统凭据里。
use crate::api_core::{self, ApiReq, ApiResp};
use crate::secrets;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use url::Url;

pub struct ServerState {
    url: Mutex<Option<Url>>,
    file: PathBuf,
    client: reqwest::Client,
}

fn token_name(u: &Url) -> String {
    format!("session:{}", u.origin().ascii_serialization())
}

pub fn init(app: &AppHandle) -> ServerState {
    let file = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("server.json");
    let url = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
        .and_then(|u| {
            // 只有用户确认过的地址才会被保存，所以这里接受 http
            api_core::normalize_server_url(&u, true).ok()
        });
    ServerState { url: Mutex::new(url), file, client: api_core::client() }
}

fn current(state: &ServerState) -> Result<Url, String> {
    state.url.lock().unwrap().clone().ok_or_else(|| "还没有设置服务器地址".to_string())
}

#[tauri::command]
pub fn server_get_url(state: State<'_, ServerState>) -> Option<String> {
    state.url.lock().unwrap().as_ref().map(|u| u.origin().ascii_serialization())
}

#[tauri::command]
pub fn server_set_url(state: State<'_, ServerState>, url: String, allow_http: Option<bool>) -> Result<String, String> {
    let u = api_core::normalize_server_url(&url, allow_http.unwrap_or(false))?;
    let mut cur = state.url.lock().unwrap();
    if let Some(old) = cur.as_ref() {
        if old.origin() != u.origin() {
            // 换了服务器，旧服务器的登录令牌立即删除
            secrets::delete(&token_name(old))?;
        }
    }
    if let Some(dir) = state.file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("保存设置失败：{e}"))?;
    }
    std::fs::write(&state.file, serde_json::json!({ "url": u.as_str() }).to_string()).map_err(|e| format!("保存设置失败：{e}"))?;
    *cur = Some(u.clone());
    Ok(u.origin().ascii_serialization())
}

#[tauri::command]
pub async fn api_call(state: State<'_, ServerState>, req: ApiReq) -> Result<ApiResp, String> {
    let base = current(&state)?;
    let name = token_name(&base);
    let token = secrets::get(&name)?;
    let resp = api_core::send(&state.client, &base, token.as_deref(), req).await?;
    if resp.status == 401 && token.is_some() {
        // 服务器说令牌无效（过期、被管理员停用、在别处退出了所有设备），本地也删掉
        let _ = secrets::delete(&name);
    }
    Ok(resp)
}

#[tauri::command]
pub async fn api_login(state: State<'_, ServerState>, username: String, password: String) -> Result<ApiResp, String> {
    let base = current(&state)?;
    let (resp, token) = api_core::login(&state.client, &base, &username, &password).await?;
    if let Some(t) = token {
        secrets::set(&token_name(&base), &t)?;
    }
    Ok(resp)
}

#[tauri::command]
pub async fn api_logout(state: State<'_, ServerState>) -> Result<(), String> {
    let base = current(&state)?;
    let name = token_name(&base);
    if let Some(t) = secrets::get(&name)? {
        let req = ApiReq { method: "POST".into(), path: "/api/auth/logout".into(), json: Some("{}".into()), bin: None, data_version: None, data_owner: None };
        // 服务器连不上也要删本地令牌
        let _ = api_core::send(&state.client, &base, Some(&t), req).await;
    }
    secrets::delete(&name)
}
