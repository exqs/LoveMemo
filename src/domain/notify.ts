// 提醒计划：算出未来 48 小时内要发的通知，交给 Rust 端定时器
import type { NotifyEntry } from '../lib/platform'
import type { Commitment, Settings } from '../lib/types'
import { DAY, HOUR, atTime, fmtDate, startOfDay } from '../lib/util'

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h || 0) * 60 + (m || 0) }

export function inQuiet(t: number, s: Pick<Settings, 'quietStart' | 'quietEnd'>): boolean {
  if (!s.quietStart || !s.quietEnd || s.quietStart === s.quietEnd) return false
  const d = new Date(t)
  const m = d.getHours() * 60 + d.getMinutes()
  const a = toMin(s.quietStart), b = toMin(s.quietEnd)
  return a < b ? m >= a && m < b : m >= a || m < b
}

/** 落在免打扰时段的提醒顺延到时段结束 */
function shift(t: number, s: Settings): number {
  if (!inQuiet(t, s)) return t
  let end = atTime(startOfDay(t), s.quietEnd)
  if (end <= t) end += DAY
  return end
}

export interface DueCard { title: string; due: number }

export function planNotifications(s: Settings, cards: DueCard[], commitments: Commitment[], now: number): NotifyEntry[] {
  const out: NotifyEntry[] = []
  const horizon = now + 2 * DAY
  for (let d = 0; d < 3; d++) {
    const day = startOfDay(now) + d * DAY
    for (const hm of s.reminderTimes) {
      const at = atTime(day, hm)
      if (at <= now || at > horizon || inQuiet(at, s)) continue
      const due = cards.filter((c) => c.due <= at)
      if (!due.length) continue
      const names = due.slice(0, 2).map((c) => `「${c.title}」`).join('、')
      out.push({
        key: `review:${fmtDate(at)}:${hm}`, at, title: '复盘便签',
        body: s.privacyNotify ? `今天有 ${due.length} 个复习` : `今天有 ${due.length} 个点要复习：${names}${due.length > 2 ? ' 等' : ''}`,
        route: '/review',
      })
    }
  }
  for (const c of commitments) {
    if (c.status !== 'open' || !c.due_at) continue
    const steps: [number, string, string][] = [
      [24 * HOUR, '24h', '承诺明天到期'],
      [1 * HOUR, '1h', '承诺 1 小时后到期'],
      [0, '0', '承诺到期了'],
    ]
    for (const [off, tag, title] of steps) {
      const at = shift(c.due_at - off, s)
      if (at <= now || at > horizon) continue
      out.push({ key: `commit:${c.id}:${tag}`, at, title, body: s.privacyNotify ? '有一条承诺需要处理' : c.content, route: '/commitments' })
    }
  }
  if (s.weeklyTime) {
    const [dow, hm] = s.weeklyTime.split(' ')
    for (let d = 0; d < 8; d++) {
      const day = startOfDay(now) + d * DAY
      if (new Date(day).getDay() !== Number(dow)) continue
      const at = atTime(day, hm)
      if (at > now && at <= horizon && !inQuiet(at, s)) out.push({ key: `weekly:${fmtDate(at)}`, at, title: '本周复盘', body: '看看这周哪里进步了，下周重点改哪一条', route: '/stats' })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** 启动时补发：今天的复习提醒时间已过、没发过、且有到期复习，只补一次（PRD F6.4） */
export function catchUp(s: Settings, dueCount: number, fired: string[], lastCatchup: string, now: number): NotifyEntry | null {
  const today = fmtDate(now)
  if (lastCatchup === today || dueCount === 0) return null
  const passed = s.reminderTimes.filter((hm) => atTime(startOfDay(now), hm) <= now)
  if (!passed.length) return null
  if (passed.some((hm) => fired.includes(`review:${today}:${hm}`))) return null
  if (inQuiet(now, s)) return null
  return { key: `catchup:${today}`, at: now, title: '复盘便签', body: s.privacyNotify ? `今天有 ${dueCount} 个复习` : `今天的复习提醒错过了，还有 ${dueCount} 个点要复习`, route: '/review' }
}
