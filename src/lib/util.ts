export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export const DAY = 86_400_000
export const HOUR = 3_600_000

export function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const pad = (n: number) => String(n).padStart(2, '0')
export function fmtDate(t: number | null | undefined): string {
  if (!t) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export function fmtDateTime(t: number | null | undefined): string {
  if (!t) return ''
  const d = new Date(t)
  return `${fmtDate(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function toLocalInput(t: number | null | undefined): string {
  if (!t) return ''
  const d = new Date(t)
  return `${fmtDate(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function fromLocalInput(s: string): number | null {
  if (!s) return null
  const t = new Date(s).getTime()
  return Number.isNaN(t) ? null : t
}

/** "3 天后" / "今天" / "已逾期 2 天" */
export function relDays(t: number, now = Date.now()): string {
  const d = Math.round((startOfDay(t) - startOfDay(now)) / DAY)
  if (d === 0) {
    const h = Math.round((t - now) / HOUR)
    return h > 0 ? `${h} 小时后` : '今天'
  }
  if (d === 1) return '明天'
  if (d > 1) return `${d} 天后`
  return `已逾期 ${-d} 天`
}

export function clamp(n: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, n)) }

export function parseJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

/** 把 "HH:MM" 落到某一天 */
export function atTime(day: number, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(day)
  d.setHours(h || 0, m || 0, 0, 0)
  return d.getTime()
}
