// 统计：词频、标签频次、高频问题排行、图谱、趋势
import type { Commitment, Incident, Message, Rule, ReviewLog } from '../lib/types'
import { DAY, fmtDate, startOfDay } from '../lib/util'

const STOP = new Set(('的 了 是 我 你 他 她 它 们 我们 你们 他们 这 那 这个 那个 就 都 也 还 在 有 和 跟 吗 呢 吧 啊 呀 哦 嗯 哈 哈哈 哈哈哈 啦 嘛 么 什么 怎么 为什么 没有 不是 一个 一下 可以 就是 还是 然后 因为 所以 但是 如果 已经 现在 今天 明天 感觉 觉得 知道 自己 宝贝 宝宝 嘎嘎 好的 好吧 一直 这样 那样 这么 那么 真的 有点 一点 东西 时候 之后 之前 而且 不过 只是 应该 这种 那种 一些').split(/\s+/))

/** 中文分词：Intl.Segmenter（WebView2 内置）；把连续的单字片段拼成词，减少"先/说"这类碎片 */
export function tokenize(text: string): string[] {
  if (typeof Intl === 'undefined' || !('Segmenter' in Intl)) return text.split(/[\s，。！？,.!?]+/).filter((w) => w.length >= 2)
  const seg = new Intl.Segmenter('zh', { granularity: 'word' })
  const out: string[] = []
  let run = ''
  const flush = () => { if (run.length >= 2) out.push(run); run = '' }
  for (const s of seg.segment(text)) {
    if (!s.isWordLike) { flush(); continue }
    const w = s.segment
    if (/^[a-z0-9]+$/i.test(w)) { flush(); if (w.length >= 2) out.push(w.toLowerCase()); continue }
    if (w.length === 1) { run += w; if (run.length >= 3) flush(); continue }
    flush()
    out.push(w)
  }
  flush()
  return out.filter((w) => !STOP.has(w) && !/^\d+$/.test(w))
}

export function wordFreq(texts: string[], top = 80): { name: string; value: number }[] {
  const m = new Map<string, number>()
  for (const t of texts) for (const w of tokenize(t)) m.set(w, (m.get(w) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, value]) => ({ name, value }))
}

export function tagFreq(incidents: Incident[], rules: Rule[]): { name: string; value: number }[] {
  const m = new Map<string, number>()
  for (const i of incidents) for (const t of i.tags) m.set(t, (m.get(t) ?? 0) + 1)
  for (const r of rules) for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + Math.max(0, r.occurrence_count - 1))
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))
}

export interface RankRow { rule: Rule; score: number; avgSeverity: number; delta: number }

/** 高频问题：出现次数 × 平均严重度 × 时间衰减（半衰期 60 天）；delta 为与一周前名次相比的变化，正数表示上升 */
export function rankRules(rules: Rule[], sevByRule: Map<string, number[]>, now: number): RankRow[] {
  const score = (r: Rule, at: number) => {
    const sev = sevByRule.get(r.id) ?? [3]
    const avg = sev.reduce((a, b) => a + b, 0) / sev.length
    const age = r.last_seen ? Math.max(0, (at - r.last_seen) / DAY) : 365
    return { s: r.occurrence_count * avg * Math.pow(0.5, age / 60), avg }
  }
  const active = rules.filter((r) => r.status !== 'archived')
  const nowRank = active.map((r) => ({ r, ...score(r, now) })).sort((a, b) => b.s - a.s)
  const pastRank = active.filter((r) => r.created_at <= now - 7 * DAY).map((r) => ({ r, ...score(r, now - 7 * DAY) })).sort((a, b) => b.s - a.s)
  const pastIdx = new Map(pastRank.map((x, i) => [x.r.id, i]))
  return nowRank.map((x, i) => ({
    rule: x.r, score: x.s, avgSeverity: x.avg,
    delta: pastIdx.has(x.r.id) ? pastIdx.get(x.r.id)! - i : 0,
  }))
}

export interface GraphNode { id: string; name: string; category: number; value: number; symbolSize: number; mastery?: number }
export interface GraphLink { source: string; target: string }

/** 问题图谱：标签 / 知识点 / 便签 / 承诺 四类节点 */
export function buildGraph(
  rules: Rule[], incidents: Incident[], commitments: Commitment[],
  evidence: { rule_id: string; incident_id: string }[], mastery: Map<string, number>,
) {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const tagCount = new Map<string, number>()
  for (const r of rules) for (const t of r.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + r.occurrence_count)
  for (const i of incidents) for (const t of i.tags) if (!tagCount.has(t)) tagCount.set(t, 1)
  for (const [t, n] of tagCount) nodes.push({ id: 't:' + t, name: t, category: 0, value: n, symbolSize: 18 + Math.min(40, n * 6) })
  for (const r of rules) {
    nodes.push({ id: 'r:' + r.id, name: r.title, category: 1, value: r.occurrence_count, symbolSize: 14 + Math.min(36, r.occurrence_count * 7), mastery: mastery.get(r.id) ?? 0 })
    for (const t of r.tags) links.push({ source: 'r:' + r.id, target: 't:' + t })
  }
  const used = new Set(evidence.map((e) => e.incident_id))
  for (const i of incidents) {
    if (!used.has(i.id) && !i.tags.length) continue
    nodes.push({ id: 'i:' + i.id, name: i.title || fmtDate(i.occurred_at ?? i.created_at), category: 2, value: i.severity, symbolSize: 8 + i.severity * 2 })
    if (!used.has(i.id)) for (const t of i.tags) links.push({ source: 'i:' + i.id, target: 't:' + t })
  }
  const seen = new Set<string>()
  for (const e of evidence) {
    const k = e.rule_id + '|' + e.incident_id
    if (seen.has(k)) continue
    seen.add(k)
    links.push({ source: 'i:' + e.incident_id, target: 'r:' + e.rule_id })
  }
  for (const c of commitments) {
    if (!c.incident_id) continue
    nodes.push({ id: 'c:' + c.id, name: c.content, category: 3, value: 1, symbolSize: 10 })
    links.push({ source: 'c:' + c.id, target: 'i:' + c.incident_id })
  }
  const ids = new Set(nodes.map((n) => n.id))
  return { nodes, links: links.filter((l) => ids.has(l.source) && ids.has(l.target)) }
}

export function monthKey(t: number) { return fmtDate(t).slice(0, 7) }

export function monthlyTrend(incidents: Incident[], months = 6, now = Date.now()) {
  const keys: string[] = []
  const d = new Date(now)
  for (let i = months - 1; i >= 0; i--) keys.push(monthKey(new Date(d.getFullYear(), d.getMonth() - i, 1).getTime()))
  const count = new Map(keys.map((k) => [k, 0]))
  const sev = new Map(keys.map((k) => [k, 0]))
  for (const i of incidents) {
    const k = monthKey(i.occurred_at ?? i.created_at)
    if (!count.has(k)) continue
    count.set(k, count.get(k)! + 1)
    sev.set(k, sev.get(k)! + i.severity)
  }
  return keys.map((k) => ({ month: k, count: count.get(k)!, avgSeverity: count.get(k) ? +(sev.get(k)! / count.get(k)!).toFixed(1) : 0 }))
}

/** 承诺按时完成率：已完成且完成时间不晚于截止时间 / 已到期或已完成的承诺 */
export function commitmentRate(cs: Commitment[], now = Date.now()) {
  const judged = cs.filter((c) => c.status !== 'cancelled' && (c.status === 'done' || (c.due_at && c.due_at < now)))
  const ontime = judged.filter((c) => c.status === 'done' && (!c.due_at || c.updated_at <= c.due_at))
  return { total: judged.length, ontime: ontime.length, rate: judged.length ? ontime.length / judged.length : null }
}

/** 复习保持率：评分为良好或简单的比例，按周 */
export function retentionByWeek(logs: ReviewLog[], weeks = 8, now = Date.now()) {
  const out: { week: string; rate: number | null; n: number }[] = []
  const end = startOfDay(now) + DAY
  for (let w = weeks - 1; w >= 0; w--) {
    const a = end - (w + 1) * 7 * DAY, b = end - w * 7 * DAY
    const xs = logs.filter((l) => l.source === 'review' && l.reviewed_at >= a && l.reviewed_at < b)
    out.push({ week: fmtDate(a).slice(5), n: xs.length, rate: xs.length ? xs.filter((l) => l.rating >= 3).length / xs.length : null })
  }
  return out
}

export function dailyHeat(logs: ReviewLog[]): [string, number][] {
  const m = new Map<string, number>()
  for (const l of logs) if (l.source === 'review') { const k = fmtDate(l.reviewed_at); m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m.entries()]
}

export function herTexts(msgs: Pick<Message, 'speaker' | 'content' | 'msg_type'>[]) {
  return msgs.filter((m) => m.speaker === 'them' && (m.msg_type === 'text' || m.msg_type === 'reply')).map((m) => m.content)
}
