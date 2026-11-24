// API Key 存在系统凭据里（Windows 凭据管理器 / macOS 钥匙串），不进数据库，不回传给前端
use keyring::Entry;

const SERVICE: &str = "fupan-bianqian";

fn entry(profile_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("model:{profile_id}")).map_err(|e| format!("无法访问系统凭据：{e}"))
}

pub fn get(profile_id: &str) -> Result<Option<String>, String> {
    match entry(profile_id)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取 API Key 失败：{e}")),
    }
}

#[tauri::command]
pub fn secret_set(profile_id: String, key: String) -> Result<(), String> {
    entry(&profile_id)?.set_password(key.trim()).map_err(|e| format!("保存 API Key 失败：{e}"))
}

#[tauri::command]
pub fn secret_has(profile_id: String) -> Result<bool, String> {
    Ok(get(&profile_id)?.is_some())
}

#[tauri::command]
pub fn secret_delete(profile_id: String) -> Result<(), String> {
    match entry(&profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除 API Key 失败：{e}")),
    }
}
