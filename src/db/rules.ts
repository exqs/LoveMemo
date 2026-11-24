// 知识点、证据、复习卡、复习记录、练习题
import type { CardRow, Evidence, EvidenceKind, QuizQuestion, ReviewLog, Rule } from '../lib/types'
import { parseJSON, startOfDay, uid } from '../lib/util'
import { buildQueue, isInternalized, newCard, review, Rating, type Grade, type SchedOpts } from '../domain/srs'
import { emitChange, getSettings, insert, q, run, update, upsert } from './base'

type Row = Record<string, unknown>
const toRule = (r: Row): Rule => ({ ...(r as unknown as Rule), tags: parseJSON(r.tags as string, []) })

export const BUILTIN_TAGS: [string, string][] = [
  ['敷衍回应', '她认真分享或表达，我用玩笑、表情、一个字带过（Gottman 称为 turning away）'],
  ['没先说想法', '我心里有想法却不说，等她追问'],
  ['反问追问', '把说清楚的责任推给她，如"啥意思呀""这什么态度"'],
  ['解释辩解', '被指出问题后先解释原因'],
  ['说到没做到', '承诺没兑现或没汇报进度'],
  ['没共情', '没回应她的情绪，直接讲道理或给方案'],
  ['时机不对', '她累了、要睡了还继续追问'],
  ['重复踩坑', '已有知识点再次发生'],
]
export async function ensureTags() {
  const r = await q<{ n: number }>('SELECT COUNT(*) AS n FROM tag')
  if (Number(r[0]?.n ?? 0) > 0) return
  for (const [name, description] of BUILTIN_TAGS) await insert('tag', { name, description, builtin: 1 })
}
export async function listTags(): Promise<{ name: string; description: string; builtin: boolean }[]> {
  return (await q<{ name: string; description: string; builtin: number }>('SELECT * FROM tag ORDER BY builtin DESC, name')).map((t) => ({ ...t, builtin: !!t.builtin }))
}
export async function addTag(name: string, description = '') {
  await run('INSERT OR IGNORE INTO tag (name, description, builtin) VALUES (?, ?, 0)', [name.trim(), description])
  emitChange()
}
export async function deleteTag(name: string) { await run('DELETE FROM tag WHERE name=?', [name]); emitChange() }

export async function listRules(): Promise<Rule[]> {
  return (await q('SELECT * FROM rule ORDER BY status, last_seen DESC')).map(toRule)
}
export async function getRule(id: string): Promise<Rule | null> {
  const r = await q('SELECT * FROM rule WHERE id=?', [id])
  return r.length ? toRule(r[0]) : null
}

async function schedOpts(): Promise<SchedOpts> {
  const s = await getSettings()
  return { algorithm: s.algorithm, retention: s.retention, firstStepHours: s.firstStepHours }
}

export async function createRule(p: Partial<Rule> & { title: string }, seenAt: number): Promise<string> {
  const now = Date.now()
  const id = uid()
  await insert('rule', {
    id, title: p.title, trigger_scene: p.trigger_scene ?? '', good_example: p.good_example ?? '', bad_example: p.bad_example ?? '',
    my_own_words: p.my_own_words ?? '', tags: p.tags ?? [], status: 'active', occurrence_count: 1,
    first_seen: seenAt, last_seen: seenAt, created_at: now, updated_at: now,
  })
  await upsert('review_card', newCard(id, now, await schedOpts()) as unknown as Record<string, unknown>)
  emitChange()
  return id
}
export async function updateRule(id: string, patch: Partial<Rule>) {
  const { id: _i, created_at: _c, ...rest } = patch
  void _i; void _c
  await update('rule', id, { ...rest, updated_at: Date.now() })
  emitChange()
}
export async function deleteRule(id: string) { await run('DELETE FROM rule WHERE id=?', [id]); emitChange() }

export async function addEvidence(ruleId: string, incidentId: string, kind: EvidenceKind, text: string, messageId: string | null) {
  await insert('rule_evidence', { id: uid(), rule_id: ruleId, incident_id: incidentId, kind, text, message_id: messageId })
}
export async function listEvidence(ruleId?: string): Promise<Evidence[]> {
  return ruleId ? q<Evidence>('SELECT * FROM rule_evidence WHERE rule_id=?', [ruleId]) : q<Evidence>('SELECT * FROM rule_evidence')
}

/**
 * 新便签归入已有知识点：出现次数 +1，复习卡强制按"重来"处理（PRD F5.4）。
 * 同一便签重复归入同一知识点只算一次。
 */
export async function recordRecurrence(ruleId: string, incidentId: string, seenAt: number): Promise<boolean> {
  const dup = await q('SELECT 1 FROM rule_evidence WHERE rule_id=? AND incident_id=? LIMIT 1', [ruleId, incidentId])
  if (dup.length) return false
  const rule = await getRule(ruleId)
  if (!rule) return false
  await update('rule', ruleId, {
    occurrence_count: rule.occurrence_count + 1, last_seen: Math.max(rule.last_seen ?? 0, seenAt),
    status: rule.status === 'archived' ? 'archived' : 'active', updated_at: Date.now(),
  })
  const card = await getCard(ruleId)
  if (card && card.reps > 0) {
    const now = Date.now()
    await saveCard(review(card, Rating.Again, now, await schedOpts()))
    await insert('review_log', { id: uid(), rule_id: ruleId, rating: Rating.Again, ai_score: null, source: 'recurrence', reviewed_at: now, session_id: null })
  }
  await addEvidence(ruleId, incidentId, 'linked', '', null)
  return true
}

/** 合并：把 b 的证据、复习记录并入 a，出现次数相加，删除 b */
export async function mergeRules(a: string, b: string) {
  const ra = await getRule(a), rb = await getRule(b)
  if (!ra || !rb) return
  await run('UPDATE rule_evidence SET rule_id=? WHERE rule_id=?', [a, b])
  await run('UPDATE review_log SET rule_id=? WHERE rule_id=?', [a, b])
  await run('UPDATE quiz_item SET rule_id=? WHERE rule_id=?', [a, b])
  await update('rule', a, {
    occurrence_count: ra.occurrence_count + rb.occurrence_count,
    first_seen: Math.min(ra.first_seen ?? Infinity, rb.first_seen ?? Infinity) || null,
    last_seen: Math.max(ra.last_seen ?? 0, rb.last_seen ?? 0) || null,
    tags: [...new Set([...ra.tags, ...rb.tags])], updated_at: Date.now(),
  })
  await run('DELETE FROM rule WHERE id=?', [b])
  emitChange()
}

export async function getCard(ruleId: string): Promise<CardRow | null> {
  const r = await q<CardRow>('SELECT * FROM review_card WHERE rule_id=?', [ruleId])
  return r[0] ?? null
}
export async function listCards(): Promise<CardRow[]> { return q<CardRow>('SELECT * FROM review_card') }
async function saveCard(c: CardRow) { await upsert('review_card', c as unknown as Record<string, unknown>) }

export async function listLogs(ruleId?: string): Promise<ReviewLog[]> {
  return ruleId
    ? q<ReviewLog>('SELECT * FROM review_log WHERE rule_id=? ORDER BY reviewed_at DESC', [ruleId])
    : q<ReviewLog>('SELECT * FROM review_log ORDER BY reviewed_at DESC')
}

/** 提交一次复习评分，更新卡片，必要时标记已内化 */
export async function gradeRule(ruleId: string, grade: Grade, aiScore: number | null, sessionId: string): Promise<CardRow | null> {
  const card = await getCard(ruleId)
  if (!card) return null
  const now = Date.now()
  const next = review(card, grade, now, await schedOpts())
  await saveCard(next)
  await insert('review_log', { id: uid(), rule_id: ruleId, rating: grade, ai_score: aiScore, source: 'review', reviewed_at: now, session_id: sessionId })
  const rule = await getRule(ruleId)
  if (rule && rule.status !== 'archived') {
    const ratings = (await q<{ rating: number }>("SELECT rating FROM review_log WHERE rule_id=? AND source='review' ORDER BY reviewed_at DESC LIMIT 3", [ruleId])).map((x) => x.rating)
    const status = isInternalized(next, ratings, rule.last_seen, now) ? 'internalized' : 'active'
    if (status !== rule.status) await update('rule', ruleId, { status })
  }
  emitChange()
  return next
}

export interface QueueItem { rule: Rule; card: CardRow }
/** 今日复习队列 */
export async function todayQueue(now = Date.now()): Promise<{ items: QueueItem[]; deferred: number; doneToday: number }> {
  const s = await getSettings()
  const rules = (await listRules()).filter((r) => r.status !== 'archived')
  const cards = new Map((await listCards()).map((c) => [c.rule_id, c]))
  const sev = await q<{ rule_id: string; sev: number }>('SELECT e.rule_id, MAX(i.severity) AS sev FROM rule_evidence e JOIN incident i ON i.id=e.incident_id GROUP BY e.rule_id')
  const sevMap = new Map(sev.map((x) => [x.rule_id, Number(x.sev)]))
  const done = await q<{ rule_id: string; reps_before: number }>(
    "SELECT rule_id, MIN(reviewed_at) AS t FROM review_log WHERE source='review' AND reviewed_at>=? GROUP BY rule_id", [startOfDay(now)])
  const doneToday = done.length
  const input = rules.filter((r) => cards.has(r.id)).map((r) => {
    const c = cards.get(r.id)!
    return { rule_id: r.id, due: c.due, reps: c.reps, severity: sevMap.get(r.id) ?? 3, occurrence: r.occurrence_count }
  })
  const { today, deferred } = buildQueue(input, now, { review: Math.max(0, s.dailyReviewLimit - doneToday), new: s.dailyNewLimit })
  const byId = new Map(rules.map((r) => [r.id, r]))
  return { items: today.map((x) => ({ rule: byId.get(x.rule_id)!, card: cards.get(x.rule_id)! })), deferred, doneToday }
}

export async function saveQuizItem(p: { session_id: string; rule_id: string | null; question: QuizQuestion; answer?: string; grade?: unknown; score?: number | null; chat?: unknown[] }): Promise<string> {
  const id = uid()
  await insert('quiz_item', {
    id, session_id: p.session_id, rule_id: p.rule_id, kind: p.question.kind, scenario_key: p.question.scenario_key,
    question: p.question, answer: p.answer ?? '', grade: p.grade ?? '', score: p.score ?? null, chat: p.chat ?? [], created_at: Date.now(),
  })
  return id
}
export async function updateQuizItem(id: string, patch: { answer?: string; grade?: unknown; score?: number | null; chat?: unknown[] }) {
  await update('quiz_item', id, patch)
}
export async function recentScenarioKeys(ruleId: string, n = 4): Promise<string[]> {
  return (await q<{ scenario_key: string }>('SELECT scenario_key FROM quiz_item WHERE rule_id=? ORDER BY created_at DESC LIMIT ?', [ruleId, n])).map((x) => x.scenario_key)
}
