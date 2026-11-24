// 大模型请求：前端组好请求体，这里补上 Key 发出去，原样返回状态码和响应体
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmReq {
    profile_id: String,
    protocol: String,
    url: String,
    body: String,
    timeout_s: u64,
    needs_key: bool,
}

#[derive(Serialize)]
pub struct LlmResp {
    status: u16,
    body: String,
}

fn is_local(host: &str) -> bool {
    host == "localhost"
        || host == "::1"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("[::1]")
}

#[tauri::command]
pub async fn llm_request(req: LlmReq) -> Result<LlmResp, String> {
    let url = url::Url::parse(&req.url).map_err(|_| format!("接口地址格式不对：{}", req.url))?;
    let host = url.host_str().unwrap_or("").to_string();
    match url.scheme() {
        "https" => {}
        "http" if is_local(&host) => {}
        "http" if !req.needs_key => {}
        _ => return Err("为了保护 API Key，只允许 https 地址（本机地址除外）".into()),
    }

    let key = if req.needs_key {
        match crate::secrets::get(&req.profile_id)? {
            Some(k) if !k.is_empty() => Some(k),
            _ => return Err("这个模型还没有填 API Key，请到设置里填写".into()),
        }
    } else {
        None
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(req.timeout_s.clamp(10, 600)))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut rb = client
        .post(url)
        .header("content-type", "application/json")
        .body(req.body);
    if req.protocol == "anthropic" {
        rb = rb.header("anthropic-version", "2023-06-01");
        if let Some(k) = &key {
            rb = rb.header("x-api-key", k);
        }
    } else if let Some(k) = &key {
        rb = rb.bearer_auth(k);
    }

    let resp = rb.send().await.map_err(|e| {
        if e.is_timeout() {
            "请求超时。可以在设置里把超时时间调长，或换一个更快的模型".to_string()
        } else if e.is_connect() {
            format!("连不上 {host}，请检查网络或接口地址")
        } else {
            e.to_string()
        }
    })?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| format!("读取响应失败：{e}"))?;
    Ok(LlmResp { status, body })
}
