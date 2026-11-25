// 登录令牌存在系统凭据里（Windows 凭据管理器 / macOS 钥匙串），不写文件，不交给前端脚本。
// AI 的 API Key 已经改为只存在服务器上，桌面版不再保存任何 Key。
use keyring::Entry;

const SERVICE: &str = "lovememo";

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| format!("无法访问系统凭据：{e}"))
}

pub fn get(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(k) if !k.is_empty() => Ok(Some(k)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取登录状态失败：{e}")),
    }
}

pub fn set(name: &str, value: &str) -> Result<(), String> {
    entry(name)?.set_password(value).map_err(|e| format!("保存登录状态失败：{e}"))
}

pub fn delete(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("清除登录状态失败：{e}")),
    }
}
