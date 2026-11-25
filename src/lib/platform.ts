// 运行环境：Tauri 桌面版或网页版。两者都要登录服务器，数据和 AI 都走服务器（见 api.ts）；
// 这里只放桌面版独有的能力：系统通知、开机自启、保存到下载文件夹、本机备份。
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export interface NotifyEntry { key: string; at: number; title: string; body: string; route: string }

/** 把未来的提醒计划交给 Rust 端定时器（窗口隐藏时前端计时器不可靠） */
export async function pushSchedule(entries: NotifyEntry[]) {
  if (!isTauri) return
  await invoke('schedule_set', { entries })
}
export async function firedKeys(): Promise<string[]> {
  if (!isTauri) return []
  return invoke<string[]>('schedule_fired')
}
export async function notifyNow(e: NotifyEntry) {
  if (!isTauri) { console.info('[通知]', e.title, e.body); return }
  await invoke('notify_now', { entry: e })
}

export async function autostartEnabled(): Promise<boolean> {
  if (!isTauri) return false
  const m = await import('@tauri-apps/plugin-autostart')
  return m.isEnabled()
}
export async function setAutostart(on: boolean) {
  if (!isTauri) return
  const m = await import('@tauri-apps/plugin-autostart')
  if (on) await m.enable(); else await m.disable()
}

/** 保存文本文件到「下载」文件夹，返回完整路径 */
export async function saveToDownloads(fileName: string, content: string): Promise<string> {
  if (!isTauri) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    a.download = fileName
    a.click()
    return fileName
  }
  return invoke<string>('save_to_downloads', { fileName, content })
}
export async function writeBackup(fileName: string, content: string, keep: number): Promise<string> {
  if (!isTauri) return ''
  return invoke<string>('write_backup', { fileName, content, keep })
}

/** 托盘菜单「开始复习」或点击通知时，Rust 端发 navigate 事件 */
export async function onNavigate(cb: (route: string) => void): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<string>('navigate', (e) => cb(e.payload))
}
