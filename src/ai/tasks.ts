// 各 AI 任务的编排：组装输入 → 调用 → 校验 → 把消息编号映射回真实 id
import type { AnalysisData, CardRow, ChatLine, Incident, Message, QuizGrade, QuizKind, QuizQuestion, Rule, Settings } from '../lib/types'
import { clamp } from '../lib/util'
import { guessDue, mergeBatches, verifyQuotes, type RawMsg } from '../domain/text'
import { allMessages, listMessages } from '../db/incidents'
import { listEvidence, listRules, listTags, recentScenarioKeys } from '../db/rules'
import { callJSON, callText, type ChatMsg } from './client'
import { AnalyzeSchema, GradeSchema, MatchSchema, QuizSchema, RecognizeSchema, RoleplayReviewSchema, RoleplaySchema, WeeklySchema, type MatchOut, type RoleplayOut, type RoleplayReview } from './schemas'
import * as P from './prompts'

const SPK = (s: string) => (s === 'them' ? 'T' : 'M')

/** 给模型看的消息用 m1、m2 编号，省 token，也避免模型抄错长 id */
export function aliasMessages(msgs: Message[]) {
  const a2id = new Map<string, string>()
  msgs.forEach((m, i) => a2id.set('m' + (i + 1), m.id))
  const text = msgs.map((m, i) =>
    `m${i + 1} ${SPK(m.speaker)}${m.sent_at ? ` [${m.sent_at}]` : ''}${m.reply_to ? ` (引用「${m.reply_to}」)` : ''}${m.is_key ? ' ★' : ''}: ${m.content}`).join('\n')
  return { a2id, text }
}

export async function recognizeImages(dataUrls: string[], s: Settings, source: string, onProgress?: (i: number, n: number) => void): Promise<RawMsg[]> {
  const n = dataUrls.length
  const batches: RawMsg[][] = []
  for (let i = 0; i < n; i++) {
    onProgress?.(i, n)
    const r = await callJSON({
      task: 'recognize', system: P.recognizeSystem(s.herNick, s.myNick, source), temperature: 0, maxTokens: 8000,
      messages: [{ role: 'user', content: [{ type: 'image', dataUrl: dataUrls[i] }, { type: 'text', text: `这是第 ${i + 1} 张，共 ${n} 张。请逐条转写成 JSON。` }] }],
      mockData: { index: i, total: n },
    }, RecognizeSchema)
    batches.push(r.messages.filter((m) => m.content.trim()).map((m) => ({ ...m, confidence: clamp(m.confidence, 0, 1) })))
  }
  onProgress?.(n, n)
  return mergeBatches(batches)
}

/** 知识点多了以后只给模型最相关的 20 个（PRD 8.4） */
function relevantRules(rules: Rule[], tags: string[], text: string, n = 20): Rule[] {
  if (rules.length <= n) return rules
  const score = (r: Rule) => r.tags.filter((t) => tags.includes(t)).length * 3
    + [...new Set(r.title.replace(/[，。、\s]/g, ''))].filter((ch) => text.includes(ch)).length / Math.max(4, r.title.length)
    + r.occurrence_count * 0.1
  return [...rules].sort((a, b) => score(b) - score(a)).slice(0, n)
}

export async function analyzeIncident(inc: Incident, msgs: Message[]): Promise<AnalysisData> {
  const { a2id, text } = aliasMessages(msgs)
  const tags = await listTags()
  const rules = relevantRules((await listRules()).filter((r) => r.status !== 'archived'), inc.tags, text)
  const user = `背景：${inc.background || '无'}\n场景：${inc.channel}\n\n已有知识点（参考，避免换个说法重复）：\n${rules.map((r) => `- ${r.title}`).join('\n') || '（暂无）'}\n\n聊天记录：\n${text}`
  const out = await callJSON({
    task: 'analyze', system: P.analyzeSystem(tags.map((t) => `- ${t.name}：${t.description}`).join('\n')),
    messages: [{ role: 'user', content: user }], temperature: 0.3, maxTokens: 8000, mockData: { msgs },
  }, AnalyzeSchema)
  const map = (a: string) => a2id.get(a.trim().toLowerCase()) ?? ''
  const { kept, dropped } = verifyQuotes(out.her_words.map((h) => ({ quote: h.quote, msg: map(h.msg) })), msgs)
  const mine = new Set(msgs.filter((m) => m.speaker === 'me').map((m) => m.id))
  const tagNames = new Set(tags.map((t) => t.name))
  const base = inc.occurred_at ?? Date.now()
  return {
    summary: out.summary,
    timeline: out.timeline.map((t) => ({ msg: map(t.msg), note: t.note })).filter((t) => t.note),
    her_words: kept,
    inferences: out.inferences,
    misses: out.misses.filter((x) => x.problem).map((x) => ({ msg: mine.has(map(x.msg)) ? map(x.msg) : '', problem: x.problem })),
    next_time: out.next_time.filter((x) => x.action || x.say),
    commitments: out.commitments.filter((c) => c.content).map((c) => ({ ...c, picked: true, due_at: guessDue(c.due_hint, base) })),
    tags: out.tags.filter((t) => tagNames.has(t)).slice(0, 4),
    new_tags: [...new Set([...out.new_tags, ...out.tags.filter((t) => !tagNames.has(t))])].filter(Boolean).slice(0, 2),
    severity: clamp(Math.round(out.severity), 1, 5),
    dropped_quotes: dropped,
  }
}

export type MatchDecision = MatchOut['decisions'][number]
export async function matchRules(inc: Incident, a: AnalysisData, msgs: Message[]): Promise<MatchDecision[]> {
  const all = (await listRules()).filter((r) => r.status !== 'archived')
  const rules = relevantRules(all, a.tags, a.summary + a.misses.map((m) => m.problem).join(''))
  const myBad = a.misses.map((m) => msgs.find((x) => x.id === m.msg)?.content).filter(Boolean)
  const list = rules.map((r) => `- id=${r.id}｜${r.title}｜场景：${r.trigger_scene}｜标签：${r.tags.join('、')}`).join('\n')
  const user = `已有知识点：\n${list || '（知识库为空）'}\n\n本次复盘（${inc.title || '未命名'}）：\n概括：${a.summary}\n她在意的：${a.her_words.map((h) => h.quote).join('；')}\n我哪里没接住：${a.misses.map((m) => m.problem).join('；')}\n我这次说的原话：${myBad.join('；')}\n下次怎么做：${a.next_time.map((n) => n.action).join('；')}\n标签：${a.tags.join('、')}`
  const out = await callJSON({ task: 'match', system: P.matchSystem(), messages: [{ role: 'user', content: user }], temperature: 0.2, maxTokens: 4000, mockData: { rules, analysis: a, myBad } }, MatchSchema)
  const ids = new Set(all.map((r) => r.id))
  const seen = new Set<string>()
  return out.decisions.filter((d) => {
    if (d.action === 'attach') { if (!ids.has(d.rule_id) || seen.has(d.rule_id)) return false; seen.add(d.rule_id); return true }
    return !!d.title
  })
}

/** 按掌握程度选题型：新的多出选择题，熟了多出改写和找问题（PRD F8 出题规则 2） */
export function pickKinds(card: CardRow | null, n: number): QuizKind[] {
  const pool: QuizKind[] = !card || card.reps < 2 ? ['choose', 'why', 'choose'] : card.stability < 7 ? ['choose', 'rewrite', 'spot', 'why'] : ['rewrite', 'spot', 'why', 'rewrite']
  const start = card ? card.reps % pool.length : 0
  return Array.from({ length: n }, (_, i) => pool[(start + i) % pool.length])
}

async function herSamples(n = 30): Promise<string> {
  const xs = (await allMessages()).filter((m) => m.speaker === 'them' && m.msg_type !== 'link' && m.content.length <= 40)
  return xs.slice(-n).map((m) => m.content).join('\n') || '（暂无样例）'
}

export async function generateQuiz(rule: Rule, kind: QuizKind, s: Settings): Promise<QuizQuestion> {
  const ev = await listEvidence(rule.id)
  const incIds = [...new Set(ev.map((e) => e.incident_id))]
  const recent = await recentScenarioKeys(rule.id)
  // 情景来源轮换：真实事件原样 → 改编 → 新编（PRD F8 出题规则 1）
  const mode = incIds.length ? (['real', 'adapt', 'new'] as const)[recent.length % 3] : 'new'
  let real = ''
  if (mode !== 'new') {
    const msgs = await listMessages(incIds[recent.length % incIds.length])
    real = aliasMessages(msgs.slice(0, 60)).text
  }
  const modeText = { real: '用下面的真实事件原样出题（可以截取其中一段）', adapt: '以下面的真实事件为基础，换掉具体细节（话题、时间、事情）后出题', new: '新编一个同类情景，不要用已有事件' }[mode]
  const user = `知识点：${rule.title}\n触发场景：${rule.trigger_scene}\n参考做法：${rule.good_example}\n我的反例：${rule.bad_example}\n我自己的话：${rule.my_own_words}\n\n情景来源：${modeText}\n${real ? `真实事件聊天（T 是她，M 是我）：\n${real}\n` : ''}\n最近用过的情景（不要重复）：${recent.join('、') || '无'}\n\n${s.herName}的说话风格样例：\n${await herSamples()}`
  const q = await callJSON({ task: 'quiz', system: P.quizSystem(kind, s.herName), messages: [{ role: 'user', content: user }], temperature: 0.8, maxTokens: 4000, mockData: { kind, rule } }, QuizSchema)
  const out: QuizQuestion = { ...q, kind, scenario_key: q.scenario_key || `${kind}-${Date.now() % 10000}` }
  if (kind === 'choose') {
    if (out.options.length < 2) throw new Error('题目缺少选项，请重新出题')
    if (out.answer_index == null || out.answer_index < 0 || out.answer_index >= out.options.length) out.answer_index = 0
  }
  if (kind === 'spot') {
    const meIdx = out.chat.map((c, i) => (c.speaker === 'me' ? i : -1)).filter((i) => i >= 0)
    if (!meIdx.length) throw new Error('题目里没有"我"说的话，请重新出题')
    if (out.spot_index == null || !meIdx.includes(out.spot_index)) out.spot_index = meIdx[meIdx.length - 1]
  }
  return out
}

const fmtChat = (chat: ChatLine[], her: string) => chat.map((c) => `${c.speaker === 'them' ? her : '我'}：${c.content}`).join('\n')

export async function gradeAnswer(rule: Rule, q: QuizQuestion, answer: string, chosen: number | null, s: Settings): Promise<QuizGrade> {
  let ans = answer
  if (q.kind === 'choose' && chosen != null) ans = `我选了第 ${chosen + 1} 个：${q.options[chosen]}${answer ? `\n理由：${answer}` : ''}`
  if (q.kind === 'spot' && chosen != null) ans = `我认为是这一句：${q.chat[chosen]?.content}${answer ? `\n理由：${answer}` : ''}`
  const user = `知识点：${rule.title}\n题型：${P.KIND_DESC[q.kind]}\n题目：${q.prompt}\n聊天：\n${fmtChat(q.chat, s.herName)}\n${q.options.length ? `选项：\n${q.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n` : ''}${q.kind === 'choose' ? `最好的是第 ${(q.answer_index ?? 0) + 1} 个\n` : ''}${q.kind === 'spot' ? `有问题的是：${q.chat[q.spot_index ?? 0]?.content}\n` : ''}评分要点：${q.rubric.join('；')}\n参考答案：${q.reference}\n\n我的答案：\n${ans || '（没写）'}`
  const g = await callJSON({ task: 'grade', system: P.gradeSystem(), messages: [{ role: 'user', content: user }], temperature: 0.2, maxTokens: 3000, mockData: { q, chosen } }, GradeSchema)
  let score = clamp(Math.round(g.score), 0, 100)
  // 选择题、找问题题的对错由程序判定，AI 只负责讲解
  if ((q.kind === 'choose' || q.kind === 'spot') && chosen != null) {
    const right = chosen === (q.kind === 'choose' ? q.answer_index : q.spot_index)
    score = right ? Math.max(score, answer.trim() ? 80 : 72) : Math.min(score, 35)
  }
  return { score, good: g.good, problems: g.problems, reference: g.reference || q.reference, option_notes: g.option_notes }
}

export async function followUp(rule: Rule, q: QuizQuestion, answer: string, grade: QuizGrade, chat: { role: 'user' | 'assistant'; content: string }[], s: Settings): Promise<string> {
  const ctx = `知识点：${rule.title}\n题目：${q.prompt}\n聊天：\n${fmtChat(q.chat, s.herName)}\n我的答案：${answer}\n评分：${grade.score}，问题：${grade.problems.join('；')}\n参考：${grade.reference}`
  const messages: ChatMsg[] = [{ role: 'user', content: ctx + '\n\n' + (chat[0]?.content ?? '') }, ...chat.slice(1)]
  return callText({ task: 'grade', system: P.coachSystem(), messages, temperature: 0.4, maxTokens: 1500, mockData: { text: chat[chat.length - 1]?.content ?? '' } })
}

export async function roleplayTurn(rule: Rule, scenario: string, history: ChatLine[], s: Settings): Promise<RoleplayOut> {
  const user = `情景：${scenario}\n这次练习的知识点：${rule.title}（参考做法：${rule.good_example}）\n\n对话到目前为止：\n${fmtChat(history, s.herName)}\n\n请给出${s.herName}的下一句、教练提示、她现在的情绪。`
  const r = await callJSON({ task: 'roleplay', system: P.roleplaySystem(s.herName, await herSamples(40)), messages: [{ role: 'user', content: user }], temperature: 0.7, maxTokens: 2000, mockData: { history } }, RoleplaySchema)
  return { ...r, mood: clamp(Math.round(r.mood), 1, 5) }
}

export async function roleplayReview(rule: Rule, scenario: string, history: ChatLine[], s: Settings): Promise<RoleplayReview> {
  const user = `情景：${scenario}\n知识点：${rule.title}\n\n完整对话：\n${fmtChat(history, s.herName)}`
  const r = await callJSON({ task: 'roleplay', system: P.roleplayReviewSystem(), messages: [{ role: 'user', content: user }], temperature: 0.2, maxTokens: 3000, mockData: { review: true, history } }, RoleplayReviewSchema)
  return { ...r, score: clamp(Math.round(r.score), 0, 100) }
}

export async function weeklyReport(statsText: string) {
  return callJSON({ task: 'weekly', system: P.weeklySystem(), messages: [{ role: 'user', content: statsText }], temperature: 0.5, maxTokens: 1500, mockData: {} }, WeeklySchema)
}
