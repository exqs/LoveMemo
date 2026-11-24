// 定时提醒。前端算好未来 48 小时的提醒计划交过来，这里用一个后台线程到点发系统通知。
// 窗口隐藏到托盘时 WebView 里的计时器可能被节流，所以计时放在 Rust 端。
// 已发过的提醒记在 fired.json 里，重启后不会重复发；前端据此判断是否需要补发。
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub key: String,
    pub at: i64, // 毫秒时间戳
    pub title: String,
    pub body: String,
    pub route: String,
}

pub struct SchedState {
    plan: Mutex<Vec<Entry>>,
    fired: Mutex<VecDeque<String>>,
    path: PathBuf,
    pub last_route: Mutex<String>,
}

const KEEP_FIRED: usize = 400;
/// 晚了超过 10 分钟的提醒不再补发（例如电脑睡眠了一晚），交给前端启动时的补发逻辑
const STALE_MS: i64 = 10 * 60 * 1000;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl SchedState {
    fn save(&self) {
        let list: Vec<String> = self.fired.lock().unwrap().iter().cloned().collect();
        if let Ok(s) = serde_json::to_string(&list) {
            let _ = std::fs::write(&self.path, s);
        }
    }
    fn mark(&self, key: &str) {
        let mut f = self.fired.lock().unwrap();
        if !f.iter().any(|k| k == key) {
            f.push_back(key.to_string());
            while f.len() > KEEP_FIRED {
                f.pop_front();
            }
        }
    }
    fn was_fired(&self, key: &str) -> bool {
        self.fired.lock().unwrap().iter().any(|k| k == key)
    }
}

pub fn init(app: &AppHandle) {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("fired.json");
    let fired: VecDeque<String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into();
    app.manage(SchedState { plan: Mutex::new(vec![]), fired: Mutex::new(fired), path, last_route: Mutex::new("/review".into()) });

    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(20));
        tick(&handle);
    });
}

fn tick(app: &AppHandle) {
    let st = app.state::<SchedState>();
    let now = now_ms();
    let due: Vec<Entry> = {
        let mut plan = st.plan.lock().unwrap();
        let (due, rest): (Vec<Entry>, Vec<Entry>) = plan.drain(..).partition(|e| e.at <= now);
        *plan = rest;
        due
    };
    if due.is_empty() {
        return;
    }
    for e in due {
        if st.was_fired(&e.key) {
            continue;
        }
        st.mark(&e.key);
        if now - e.at > STALE_MS {
            continue;
        }
        show(app, &e);
    }
    st.save();
}

fn show(app: &AppHandle, e: &Entry) {
    *app.state::<SchedState>().last_route.lock().unwrap() = e.route.clone();
    let _ = app.notification().builder().title(&e.title).body(&e.body).show();
}

/// 点击通知（桌面端 actionId 为 tap）时打开对应页面
pub fn open_last_route(app: &AppHandle) {
    let route = app.state::<SchedState>().last_route.lock().unwrap().clone();
    crate::show_main(app);
    let _ = app.emit("navigate", route);
}

#[tauri::command]
pub fn schedule_set(app: AppHandle, entries: Vec<Entry>) {
    let st = app.state::<SchedState>();
    let now = now_ms();
    let mut plan: Vec<Entry> = entries.into_iter().filter(|e| e.at > now - STALE_MS && !st.was_fired(&e.key)).collect();
    plan.sort_by_key(|e| e.at);
    *st.plan.lock().unwrap() = plan;
}

#[tauri::command]
pub fn schedule_fired(app: AppHandle) -> Vec<String> {
    app.state::<SchedState>().fired.lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub fn notify_now(app: AppHandle, entry: Entry) {
    let st = app.state::<SchedState>();
    st.mark(&entry.key);
    st.save();
    show(&app, &entry);
}
