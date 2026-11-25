mod api;
mod api_core;
mod scheduler;
mod secrets;

use std::path::PathBuf;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_notification::NotificationExt;

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 文件名里去掉路径分隔符等字符，避免写到别的目录
fn safe_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let s = s.trim().trim_start_matches('.').to_string();
    if s.is_empty() { "fupan.json".into() } else { s }
}

#[tauri::command]
fn save_to_downloads(app: AppHandle, file_name: String, content: String) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| format!("找不到下载文件夹：{e}"))?;
    let path = dir.join(safe_name(&file_name));
    std::fs::write(&path, content).map_err(|e| format!("写文件失败：{e}"))?;
    Ok(path.display().to_string())
}

/// 自动备份到应用数据目录的 backups 文件夹，只保留最近 keep 份
#[tauri::command]
fn write_backup(app: AppHandle, file_name: String, content: String, keep: usize) -> Result<String, String> {
    let dir: PathBuf = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_name(&file_name));
    std::fs::write(&path, content).map_err(|e| format!("备份失败：{e}"))?;
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("fupan-") && n.ends_with(".json")).unwrap_or(false))
        .collect();
    files.sort();
    let keep = keep.max(1);
    if files.len() > keep {
        for p in &files[..files.len() - keep] {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例要最先注册：再次打开时只把已有窗口调出来
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .invoke_handler(tauri::generate_handler![
            api::server_get_url,
            api::server_set_url,
            api::api_call,
            api::api_login,
            api::api_logout,
            scheduler::schedule_set,
            scheduler::schedule_fired,
            scheduler::notify_now,
            save_to_downloads,
            write_backup,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(api::init(&handle));
            scheduler::init(&handle);

            // 开机自启时带 --hidden，只留在托盘
            if !std::env::args().any(|a| a == "--hidden") {
                show_main(&handle);
            }

            // 点击系统通知 → 打开对应页面
            {
                let h = handle.clone();
                let _ = handle.notification().on_action(move |a| {
                    if a.action_id() == "tap" || a.action_id().is_empty() {
                        scheduler::open_last_route(&h);
                    }
                });
            }

            let open = MenuItem::with_id(app, "open", "打开复盘便签", true, None::<&str>)?;
            let review = MenuItem::with_id(app, "review", "开始复习", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &review, &sep, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("复盘便签")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "review" => {
                        show_main(app);
                        let _ = app.emit("navigate", "/review");
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        // 关窗口时只隐藏到托盘，保证到点还能提醒；从托盘菜单"退出"才真正退出
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("启动失败");
}
