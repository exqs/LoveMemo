// 承诺、模型配置、AI 调用记录、导出导入、自动备份
import type { Commitment, ModelProfile } from '../lib/types'
import { DAY, fmtDate, parseJSON, uid } from '../lib/util'
import { writeBackup } from '../lib/platform'
import { isPreview, models as apiModels } from '../lib/api'
import { emitChange, getSettings, insert, q, run, saveSettings, update } from './base'

type Row = Record<string, unknown>

// ---------- 承诺 ----------
const toCommit = (r: Row): Commitment => ({ ...(r as unknown as Commitment), told_her: !!r.told_her, overdue_logged: !!r.overdue_logged })
export async function listCommitments(): Promise<Commitment[]> {
  return (await q('SELECT * FROM commitment ORDER BY CASE status WHEN \'open\' THEN 0 ELSE 1 END, COALESCE(due_at, 9e15)')).map(toCommit)
}
export async function createCommitment(p: Partial<Commitment> & { content: string }): Promise<string> {
  const now = Date.now()
  const id = uid()
  await insert('commitment', {
    id, content: p.content, promised_at: p.promised_at ?? now, due_at: p.due_at ?? null, status: 'open',
    incident_id: p.incident_id ?? null, done_note: '', cancel_reason: '', told_her: false, overdue_logged: false, created_at: now, updated_at: now,
  })
  emitChange()
  return id
}
export async function updateCommitment(id: string, patch: Partial<Commitment>) {
  const { id: _i, created_at: _c, ...rest } = patch
  void _i; void _c
  await update('commitment', id, { ...rest, updated_at: Date.now() })
  emitChange()
}
export async function deleteCommitment(id: string) { await run('DELETE FROM commitment WHERE id=?', [id]); emitChange() }

// ---------- 模型配置 ----------
// 正式使用时模型由管理员在「管理 → AI 模型」里配置，这里只拿到名称和能力，拿不到地址和 Key。
// 单文件界面预览没有服务器，读本地表里的示例数据。
const toProfile = (r: Row): ModelProfile => ({
  ...(r as unknown as ModelProfile), supports_vision: !!r.supports_vision, supports_json: !!r.supports_json,
  needs_key: !!r.needs_key, quirks: parseJSON(r.quirks as string, {}),
})
let serverModels: Promise<ModelProfile[]> | null = null
/** 管理员改了模型配置后调用，下次读取时重新向服务器要 */
export function invalidateModels() { serverModels = null; emitChange() }
function fromServer(): Promise<ModelProfile[]> {
  serverModels ??= apiModels().then((r) => r.models.map((m) => ({
    ...m, base_url: '', needs_key: false, created_at: 0,
  }))).catch((e) => { serverModels = null; throw e })
  return serverModels
}
export async function listProfiles(): Promise<ModelProfile[]> {
  if (!isPreview) return fromServer()
  return (await q('SELECT * FROM model_profile ORDER BY created_at')).map(toProfile)
}
export async function getProfile(id: string): Promise<ModelProfile | null> {
  if (!isPreview) return (await fromServer()).find((p) => p.id === id) ?? null
  const r = await q('SELECT * FROM model_profile WHERE id=?', [id])
  return r.length ? toProfile(r[0]) : null
}
export async function saveProfile(p: ModelProfile) {
  if (!isPreview) {
    // 自动适配的参数（quirks）只在本次打开期间记住
    const all = await fromServer()
    const i = all.findIndex((x) => x.id === p.id)
    if (i >= 0) all[i] = p
    return
  }
  const exists = await getProfile(p.id)
  const { id, ...rest } = p
  if (exists) await update('model_profile', id, rest)
  else await insert('model_profile', { ...p, created_at: p.created_at || Date.now() })
  emitChange()
}
export async function deleteProfile(id: string) {
  await run('DELETE FROM model_profile WHERE id=?', [id])
  const s = await getSettings()
  const routing = { ...s.routing }
  for (const k of Object.keys(routing) as (keyof typeof routing)[]) if (routing[k] === id) routing[k] = null
  await saveSettings({ routing })
}

// ---------- AI 调用记录 ----------
export async function logCall(p: { task: string; profile_name: string; model: string; input_tokens?: number | null; output_tokens?: number | null; latency_ms: number; ok: boolean; error?: string }) {
  await insert('ai_call_log', { id: uid(), ...p, input_tokens: p.input_tokens ?? null, output_tokens: p.output_tokens ?? null, error: (p.error ?? '').slice(0, 500), created_at: Date.now() })
}
export async function usageSummary(): Promise<{ profile_name: string; model: string; calls: number; tin: number; tout: number; fails: number }[]> {
  return q('SELECT profile_name, model, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS tin, COALESCE(SUM(output_tokens),0) AS tout, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS fails FROM ai_call_log GROUP BY profile_name, model ORDER BY calls DESC')
}

// ---------- 导出导入 ----------
// 父表在前，子表在后。导入时按此顺序插入、逆序删除
const TABLES = ['incident', 'message', 'attachment', 'analysis', 'rule', 'rule_evidence', 'tag', 'review_card', 'review_log', 'quiz_item', 'commitment', 'model_profile', 'ai_call_log', 'setting']

export async function exportAll(): Promise<string> {
  const data: Record<string, unknown[]> = {}
  for (const t of TABLES) data[t] = await q(`SELECT * FROM ${t}`)
  return JSON.stringify({ app: 'fupan-bianqian', format: 1, exported_at: Date.now(), data })
}

export async function importAll(json: string) {
  const obj = JSON.parse(json) as { app?: string; data?: Record<string, Row[]> }
  if (obj.app !== 'fupan-bianqian' || !obj.data) throw new Error('这不是复盘便签导出的文件')
  for (const t of [...TABLES].reverse()) await run(`DELETE FROM ${t}`)
  for (const t of TABLES) {
    for (const row of obj.data[t] ?? []) {
      const keys = Object.keys(row).filter((k) => /^[a-z_]+$/.test(k))
      await run(`INSERT OR REPLACE INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k] as string | number | null))
    }
  }
  emitChange()
}

/** 每 N 天自动备份一次到应用数据目录的 backups 文件夹，保留最近 5 份 */
export async function autoBackupIfDue() {
  const s = await getSettings()
  if (!s.autoBackupDays || Date.now() - s.lastBackupAt < s.autoBackupDays * DAY) return
  const n = await q<{ n: number }>('SELECT COUNT(*) AS n FROM incident')
  if (!Number(n[0]?.n)) return
  const path = await writeBackup(`fupan-${fmtDate(Date.now())}.json`, await exportAll(), 5)
  if (path) await saveSettings({ lastBackupAt: Date.now() })
}
