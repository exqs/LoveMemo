// 和服务器通信的核心逻辑（不依赖 Tauri，便于单独测试）。
// 桌面版的所有请求都从这里发出：前端只能访问配置好的那台服务器的 /api/ 路径，
// 登录令牌由 Rust 端保管，永远不交给前端脚本。
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use url::Url;

const MAX_RESP: u64 = 600 * 1024 * 1024;

/// 用户填的服务器地址 → 只保留协议、域名、端口。公网必须 https，只有本机调试允许 http
pub fn normalize_server_url(input: &str) -> Result<Url, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("请填写服务器地址".into());
    }
    let with_scheme = if s.contains("://") { s.to_string() } else { format!("https://{s}") };
    let u = Url::parse(&with_scheme).map_err(|_| "服务器地址格式不对".to_string())?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err("服务器地址里不能带账号密码".into());
    }
    if (u.path() != "/" && !u.path().is_empty()) || u.query().is_some() || u.fragment().is_some() {
        return Err("只填域名就行，例如 https://memo.example.com".into());
    }
    let host = u.host_str().unwrap_or("").to_string();
    if host.is_empty() {
        return Err("服务器地址格式不对".into());
    }
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    match u.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("为了保护密码和数据，服务器地址必须是 https 开头".into()),
    }
    Url::parse(&format!("{}/", u.origin().ascii_serialization())).map_err(|e| e.to_string())
}

/// 前端能请求的路径：只限 /api/ 下面，字符白名单，不允许 .. 和 //，不允许直接调登录接口（登录要走 login()，令牌不能回到前端）
pub fn check_path(path: &str) -> Result<(), String> {
    let ok = path.starts_with("/api/")
        && path.len() <= 200
        && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
        && !path.contains("..")
        && !path.contains("//");
    if !ok {
        return Err("请求路径不对".into());
    }
    if path == "/api/auth/login" {
        return Err("请使用登录功能".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiReq {
    pub method: String,
    pub path: String,
    pub json: Option<String>,
    pub bin: Option<String>,
    pub data_version: Option<u64>,
    pub data_owner: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApiResp {
    pub status: u16,
    pub body: Option<String>,
    pub bin: Option<String>,
    pub data_version: Option<u64>,
    pub data_owner: Option<String>,
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(20))
        // 不跟随重定向：防止请求和令牌被带到别的地址
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("LoveMemo-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("无法创建网络客户端")
}

fn net_err(e: reqwest::Error, base: &Url) -> String {
    if e.is_timeout() {
        "连接服务器超时了，请稍后再试".into()
    } else if e.is_connect() {
        format!("连不上服务器 {}，请检查网络或服务器地址", base.host_str().unwrap_or(""))
    } else {
        format!("网络请求失败：{e}")
    }
}

async fn finish(resp: reqwest::Response, base: &Url) -> Result<ApiResp, String> {
    let status = resp.status().as_u16();
    if resp.content_length().unwrap_or(0) > MAX_RESP {
        return Err("服务器返回的内容太大了".into());
    }
    let is_bin = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("application/octet-stream"))
        .unwrap_or(false);
    let data_version = resp
        .headers()
        .get("x-data-version")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let data_owner = resp.headers().get("x-data-owner").and_then(|v| v.to_str().ok()).map(str::to_string);
    let bytes = resp.bytes().await.map_err(|e| net_err(e, base))?;
    if is_bin {
        Ok(ApiResp { status, body: None, bin: Some(B64.encode(&bytes)), data_version, data_owner })
    } else {
        Ok(ApiResp { status, body: Some(String::from_utf8_lossy(&bytes).into_owned()), bin: None, data_version, data_owner })
    }
}

pub async fn send(client: &reqwest::Client, base: &Url, token: Option<&str>, req: ApiReq) -> Result<ApiResp, String> {
    let method = match req.method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        _ => return Err("不支持的请求方式".into()),
    };
    check_path(&req.path)?;
    let url = base.join(&req.path).map_err(|_| "请求路径不对".to_string())?;
    if url.origin() != base.origin() {
        return Err("请求路径不对".into());
    }
    let mut rb = client.request(method, url).header("X-LoveMemo", "1");
    if let Some(t) = token {
        rb = rb.bearer_auth(t);
    }
    if let Some(j) = req.json {
        rb = rb.header(reqwest::header::CONTENT_TYPE, "application/json").body(j);
    } else if let Some(b) = req.bin {
        let bytes = B64.decode(b.as_bytes()).map_err(|_| "数据编码不对".to_string())?;
        rb = rb.header(reqwest::header::CONTENT_TYPE, "application/octet-stream").body(bytes);
    }
    if let Some(v) = req.data_version {
        rb = rb.header("X-Data-Version", v.to_string());
    }
    if let Some(o) = req.data_owner {
        if !o.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || o.len() > 64 {
            return Err("请求格式不对".into());
        }
        rb = rb.header("X-Data-Owner", o);
    }
    let resp = rb.send().await.map_err(|e| net_err(e, base))?;
    finish(resp, base).await
}

/// 令牌格式：32 字节随机数的 base64url，43 个字符
pub fn valid_token(t: &str) -> bool {
    t.len() == 43 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 登录。成功时把令牌从响应里取出来单独返回，交给前端的响应里不再包含令牌
pub async fn login(client: &reqwest::Client, base: &Url, username: &str, password: &str) -> Result<(ApiResp, Option<String>), String> {
    let body = serde_json::json!({ "username": username, "password": password, "client": "desktop" }).to_string();
    let url = base.join("/api/auth/login").map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .header("X-LoveMemo", "1")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| net_err(e, base))?;
    let mut out = finish(resp, base).await?;
    if out.status != 200 {
        return Ok((out, None));
    }
    let mut v: serde_json::Value = serde_json::from_str(out.body.as_deref().unwrap_or("")).map_err(|_| "服务器返回的内容格式不对".to_string())?;
    let token = v
        .as_object_mut()
        .and_then(|o| o.remove("token"))
        .and_then(|t| t.as_str().map(str::to_string))
        .filter(|t| valid_token(t))
        .ok_or_else(|| "服务器没有返回有效的登录凭证".to_string())?;
    out.body = Some(v.to_string());
    Ok((out, Some(token)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_url_rules() {
        assert_eq!(normalize_server_url("memo.example.com").unwrap().as_str(), "https://memo.example.com/");
        assert_eq!(normalize_server_url(" https://memo.example.com/ ").unwrap().as_str(), "https://memo.example.com/");
        assert_eq!(normalize_server_url("https://memo.example.com:8443").unwrap().as_str(), "https://memo.example.com:8443/");
        assert!(normalize_server_url("http://memo.example.com").is_err());
        assert!(normalize_server_url("http://localhost:1420").is_ok());
        assert!(normalize_server_url("https://a:b@memo.example.com").is_err());
        assert!(normalize_server_url("https://memo.example.com/x").is_err());
        assert!(normalize_server_url("https://memo.example.com/?a=1").is_err());
        assert!(normalize_server_url("ftp://memo.example.com").is_err());
        assert!(normalize_server_url("file:///etc/passwd").is_err());
        assert!(normalize_server_url("").is_err());
    }

    #[test]
    fn path_rules() {
        assert!(check_path("/api/data").is_ok());
        assert!(check_path("/api/admin/invites/0f0e2d1c-1111-4222-8333-444455556666/revoke").is_ok());
        assert!(check_path("/api/auth/login").is_err());
        assert!(check_path("/api/../admin").is_err());
        assert!(check_path("/api//evil.com/x").is_err());
        assert!(check_path("//evil.com/api/x").is_err());
        assert!(check_path("/api/data?x=1").is_err());
        assert!(check_path("/api/data#x").is_err());
        assert!(check_path("/api/%2e%2e/x").is_err());
        assert!(check_path("/index.html").is_err());
        assert!(check_path("https://evil.com/api/data").is_err());
        let base = normalize_server_url("https://memo.example.com").unwrap();
        assert_eq!(base.join("/api/data").unwrap().as_str(), "https://memo.example.com/api/data");
    }

    #[test]
    fn token_rules() {
        assert!(valid_token(&"a".repeat(43)));
        assert!(!valid_token(&"a".repeat(42)));
        assert!(!valid_token(&format!("{}=", "a".repeat(42))));
    }
}
