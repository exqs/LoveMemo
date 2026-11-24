// 通用读写工具 + 设置 + 数据变更通知
import { useEffect, useState } from 'react'
import { getDb, type Bind } from './db'
import type { Settings } from '../lib/types'
import { parseJSON } from '../lib/util'

type Val = string | number | null
export function enc(v: unknown): Val {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string') return v
  return JSON.stringify(v)
}

// 表名和列名都来自代码常量，不来自用户输入
export async function insert(table: string, obj: Record<string, unknown>) {
  const db = await getDb()
  const keys = Object.keys(obj)
  await db.execute(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => enc(obj[k])))
}
export async function upsert(table: string, obj: Record<string, unknown>) {
  const db = await getDb()
  const keys = Object.keys(obj)
  await db.execute(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => enc(obj[k])))
}
export async function update(table: string, id: string, patch: Record<string, unknown>, idCol = 'id') {
  const keys = Object.keys(patch)
  if (!keys.length) return
  const db = await getDb()
  await db.execute(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE ${idCol}=?`, [...keys.map((k) => enc(patch[k])), id])
}
export async function q<T = Record<string, unknown>>(sql: string, bind: Bind = []): Promise<T[]> {
  return (await getDb()).select<T>(sql, bind)
}
export async function run(sql: string, bind: Bind = []) {
  return (await getDb()).execute(sql, bind)
}

// ---------- 数据变更通知：列表页、首页、提醒计划据此刷新 ----------
let version = 0
const subs = new Set<(v: number) => void>()
export function emitChange() { version++; subs.forEach((f) => f(version)) }
export function onChange(f: (v: number) => void) { subs.add(f); return () => { subs.delete(f) } }
export function useDataVersion() {
  const [v, setV] = useState(version)
  useEffect(() => onChange(setV), [])
  return v
}

// ---------- 设置 ----------
export const DEFAULT_SETTINGS: Settings = {
  herName: '她', myName: '我', herNick: '', myNick: '',
  routing: { recognize: null, analyze: null, quiz: null, roleplay: null },
  algorithm: 'fsrs', retention: 0.9, dailyReviewLimit: 10, dailyNewLimit: 3, firstStepHours: 4,
  reminderTimes: ['21:30'], weeklyTime: '0 20:00', quietStart: '00:00', quietEnd: '08:00',
  privacyNotify: false, autoBackupDays: 7, lastBackupAt: 0, onboarded: false,
}

export async function getKV(k: string): Promise<string | null> {
  const r = await q<{ v: string }>('SELECT v FROM setting WHERE k=?', [k])
  return r.length ? r[0].v : null
}
export async function setKV(k: string, v: string) {
  await run('INSERT OR REPLACE INTO setting (k, v) VALUES (?, ?)', [k, v])
}

export async function getSettings(): Promise<Settings> {
  const s = parseJSON<Partial<Settings>>(await getKV('settings'), {})
  return { ...DEFAULT_SETTINGS, ...s, routing: { ...DEFAULT_SETTINGS.routing, ...(s.routing ?? {}) } }
}
export async function saveSettings(patch: Partial<Settings>) {
  const cur = await getSettings()
  await setKV('settings', JSON.stringify({ ...cur, ...patch }))
  emitChange()
}

export function useSettings(): [Settings | null, (p: Partial<Settings>) => Promise<void>] {
  const v = useDataVersion()
  const [s, setS] = useState<Settings | null>(null)
  useEffect(() => { getSettings().then(setS) }, [v])
  return [s, saveSettings]
}

/** 通用异步加载 hook：数据变更时自动重新加载 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): [T | undefined, () => void] {
  const v = useDataVersion()
  const [data, setData] = useState<T>()
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    fn().then((d) => { if (alive) setData(d) }).catch(console.error)
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, n, ...deps])
  return [data, () => setN((x) => x + 1)]
}
