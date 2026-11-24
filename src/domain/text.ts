// 截图去重、原话校验、粘贴文本拆分
import type { MsgType, Speaker } from '../lib/types'

export interface RawMsg {
  speaker: Speaker
  content: string
  msg_type: MsgType
  reply_to: string
  sent_at: string
  confidence: number
  dup_suspect?: boolean
}

export const norm = (s: string) =>
  s.replace(/\s+/g, '').replace(/[，。、,.!！?？~～…:：;；"'“”‘’()（）【】\[\]]/g, '').toLowerCase()

function same(a: RawMsg, b: RawMsg, needTime: boolean): boolean {
  if (a.speaker !== b.speaker || norm(a.content) !== norm(b.content)) return false
  if (a.sent_at && b.sent_at) return a.sent_at === b.sent_at
  return !needTime
}

/**
 * 合并多张截图的识别结果。相邻截图的首尾重叠部分去掉。
 * 只有一条重叠、又没有时间可对照时，不删，标为疑似重复让用户确认（PRD F1.4）。
 */
export function mergeBatches(batches: RawMsg[][]): RawMsg[] {
  const out: RawMsg[] = []
  for (const b of batches) {
    if (!out.length) { out.push(...b.map((m) => ({ ...m }))); continue }
    let k = Math.min(out.length, b.length)
    for (; k > 0; k--) {
      let ok = true
      for (let i = 0; i < k; i++) if (!same(out[out.length - k + i], b[i], false)) { ok = false; break }
      if (ok) break
    }
    const timed = k > 0 && b.slice(0, k).every((m) => !!m.sent_at)
    if (k >= 2 || (k === 1 && timed)) out.push(...b.slice(k).map((m) => ({ ...m })))
    else out.push(...b.map((m, i) => ({ ...m, dup_suspect: k === 1 && i === 0 ? true : m.dup_suspect })))
  }
  // 同一说话人连续两条内容完全相同：疑似重复（例如连发两次"睡了"可能是真的连发，也可能是截图重叠）
  for (let i = 1; i < out.length; i++) {
    if (same(out[i - 1], out[i], false) && (!out[i].sent_at || out[i].sent_at === out[i - 1].sent_at)) out[i].dup_suspect = true
  }
  return out
}

export interface QuoteCheckMsg { id: string; speaker: Speaker; content: string }

/**
 * 原话逐字校验：每条"她明确说的"必须能在她的消息里找到（忽略空白和标点）。
 * 允许跨相邻两三条拼接（她常把一句话拆成几条发）。找到后把 msg 修正为实际所在的消息。
 */
export function verifyQuotes<T extends { quote: string; msg: string }>(quotes: T[], msgs: QuoteCheckMsg[]) {
  const hers = msgs.filter((m) => m.speaker === 'them')
  const kept: T[] = []
  const dropped: string[] = []
  for (const q of quotes) {
    const nq = norm(q.quote)
    if (!nq) continue
    // 先找单条完整包含的；找不到再允许从某一条开头、跨到后面一两条
    let hit: string | null = hers.find((m) => norm(m.content).includes(nq))?.id ?? null
    for (let i = 0; i < hers.length && !hit; i++) {
      const first = norm(hers[i].content)
      let acc = first
      for (let j = i + 1; j < Math.min(hers.length, i + 3); j++) {
        acc += norm(hers[j].content)
        const at = acc.indexOf(nq)
        if (at >= 0 && at < first.length) { hit = hers[i].id; break }
      }
    }
    if (hit) kept.push({ ...q, msg: hit })
    else dropped.push(q.quote)
  }
  return { kept, dropped }
}

/**
 * 粘贴纯文本拆成消息。支持两种格式：
 *   "她：好具象的爱啊"（一行一条）
 *   "她 2026年11月22日 12:37" 换行 "好具象的爱啊"（电脑微信复制格式）
 */
export function parsePasted(text: string, herNick: string, myNick: string): RawMsg[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const out: RawMsg[] = []
  const who = (name: string): Speaker | null => {
    const n = name.trim()
    if (herNick && n === herNick) return 'them'
    if (myNick && n === myNick) return 'me'
    if (n === '我') return 'me'
    if (n === '她' || n === '对方') return 'them'
    return null
  }
  const headerRe = /^(.{1,20}?)\s+((?:\d{4}年\d{1,2}月\d{1,2}日\s*)?\d{1,2}:\d{2}(?::\d{2})?)$/
  let pending: { speaker: Speaker; sent_at: string } | null = null
  for (const l of lines) {
    const h = l.match(headerRe)
    if (h && who(h[1])) { pending = { speaker: who(h[1])!, sent_at: h[2] }; continue }
    const c = l.match(/^(.{1,20}?)[：:]\s*(.+)$/)
    if (c && who(c[1])) { out.push(mk(who(c[1])!, c[2], '')); pending = null; continue }
    if (pending) { out.push(mk(pending.speaker, l, pending.sent_at)); continue }
    if (out.length) out[out.length - 1].content += '\n' + l
    else out.push(mk('them', l, ''))
  }
  return out
}

function mk(speaker: Speaker, content: string, sent_at: string): RawMsg {
  return { speaker, content, msg_type: 'text', reply_to: '', sent_at, confidence: 1 }
}

/** 承诺里的模糊时间 → 截止时间。认不出就返回 null，让用户自己选 */
export function guessDue(hint: string, base: number): number | null {
  if (!hint) return null
  const d = new Date(base)
  const at = (dayOff: number, h: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOff, h, 0).getTime()
  if (/马上|立刻|现在/.test(hint)) return base + 3_600_000
  if (/今天下午|下午/.test(hint) && !/明天/.test(hint)) return Math.max(at(0, 18), base + 3_600_000)
  if (/今晚|晚上|睡前/.test(hint) && !/明/.test(hint)) return Math.max(at(0, 23), base + 3_600_000)
  if (/今天/.test(hint)) return Math.max(at(0, 23), base + 3_600_000)
  if (/后天/.test(hint)) return at(2, 21)
  if (/明天|明早|明晚/.test(hint)) return at(1, /早|上午/.test(hint) ? 12 : 21)
  if (/周末/.test(hint)) { const add = (7 - d.getDay()) % 7 || 7; return at(add, 21) }
  if (/下周/.test(hint)) return at(7, 21)
  return null
}

/** 从 AI 原始输出里取出 JSON：去掉代码块围栏，截取最外层的 {} 或 [] */
export function extractJSON(raw: string): unknown {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  try { return JSON.parse(s) } catch { /* 继续尝试截取 */ }
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0)
  if (!starts.length) throw new Error('输出里没有 JSON')
  const st = Math.min(...starts)
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
  if (end <= st) throw new Error('JSON 不完整')
  return JSON.parse(s.slice(st, end + 1))
}
