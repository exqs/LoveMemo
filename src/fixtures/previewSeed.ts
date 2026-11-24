// 界面预览用的示例数据。只在 window.__FUPAN_PREVIEW__ 存在时加载（见 App.tsx），桌面版不会执行。
// 11-22 那次用真实转写；其余几条标了"（示例）"，是编的，只为让统计页有内容。
import { insert, saveSettings, q } from '../db/base'
import { SAMPLE_MESSAGES, SAMPLE_INCIDENT } from './sample1122'
import { SAMPLE_ANALYSIS } from '../ai/mock'
import { DAY, HOUR } from '../lib/util'
import type { AnalysisData, Speaker } from '../lib/types'

type M = [Speaker, string]
const EXAMPLES: { id: string; title: string; at: number; sev: number; tags: string[]; msgs: M[]; summary: string; quote: [number, string]; miss: [number, string]; say: string }[] = [
  { id: 'inc-e2', title: '旅行攻略（示例）', at: new Date(2026, 9, 18, 21, 10).getTime(), sev: 2, tags: ['敷衍回应'],
    msgs: [['them', '[小红书] 大理三天两夜攻略'], ['them', '想去'], ['me', '嗯嗯'], ['them', '就嗯嗯？'], ['me', '那你定吧'], ['them', '算了']],
    summary: '她分享想去的地方，我只回"嗯嗯"和"你定吧"。', quote: [4, '就嗯嗯？'], miss: [3, '只回"嗯嗯"，没有接住她的期待'], say: '好呀，我也想去，这周末我们一起排一下时间。' },
  { id: 'inc-e3', title: '她加班到很晚（示例）', at: new Date(2026, 10, 3, 23, 40).getTime(), sev: 3, tags: ['时机不对', '反问追问'],
    msgs: [['them', '今天好累'], ['me', '那你早点睡'], ['them', '你就不能问问我怎么了'], ['me', '你不是说累吗，那我问什么'], ['them', '睡了']],
    summary: '她说累，我直接让她睡，被指出后又反问。', quote: [3, '你就不能问问我怎么了'], miss: [4, '反问"那我问什么"，把责任推回给她'], say: '辛苦了，今天是不是又被压了很多活？想说就说，不想说我陪你一会儿。' },
  { id: 'inc-e4', title: '一下午没回消息（示例）', at: new Date(2026, 10, 12, 18, 5).getTime(), sev: 3, tags: ['反问追问', '解释辩解'],
    msgs: [['them', '你下午去哪了'], ['me', '在开会啊'], ['them', '开会一下午不能回一句？'], ['me', '真的很忙，你要我怎么样'], ['them', '不用怎么样']],
    summary: '一下午没回消息，被问时先解释再反问。', quote: [3, '开会一下午不能回一句？'], miss: [4, '"你要我怎么样"是反问加辩解'], say: '是我没顾上，下次开会前我先跟你说一声。' },
  { id: 'inc-e5', title: '说好的电影票（示例）', at: new Date(2026, 8, 27, 20, 0).getTime(), sev: 2, tags: ['说到没做到'],
    msgs: [['them', '电影票买了吗'], ['me', '啊忘了'], ['them', '你上周就说买'], ['me', '我现在买']],
    summary: '答应买电影票，一周后被问才想起来。', quote: [3, '你上周就说买'], miss: [2, '答应的事没有兑现，也没有提前说'], say: '是我忘了，我现在就买，买好截图给你。' },
]

const RULES = [
  { id: 'r1', title: '她分享和我们有关的东西时，先说真实感受和打算', scene: '她发来帖子、视频、别人的故事', good: '这个好用心，我也想做一个，今晚给你看。', bad: '阿巴阿巴', tags: ['敷衍回应', '没先说想法'], occ: 2, incs: ['inc-1122', 'inc-e2'], reps: 3, stab: 6, due: -1 * HOUR, last: new Date(2026, 10, 22).getTime() },
  { id: 'r2', title: '她不高兴时先认，不追问、不反问、不解释', scene: '她说"睡了""就这样吧""你的态度"', good: '我刚才那句回得太随便了。', bad: '啊？这什么态度呀', tags: ['反问追问', '解释辩解'], occ: 3, incs: ['inc-1122', 'inc-e3', 'inc-e4'], reps: 5, stab: 12, due: -3 * HOUR, last: new Date(2026, 10, 22).getTime() },
  { id: 'r3', title: '答应的事给出具体时间，到点前主动汇报进度', scene: '我说"下午做""回头买"之类的话时', good: '我今晚十点前做完，做完发你看。', bad: '嘎嘎下午做出来', tags: ['说到没做到'], occ: 2, incs: ['inc-e5', 'inc-1122'], reps: 6, stab: 40, due: 9 * DAY, last: new Date(2026, 10, 22).getTime() },
  { id: 'r4', title: '她累了要睡时，先说晚安，第二天再聊', scene: '她说"好累""睡了"', good: '辛苦了，早点睡，明天我再听你说。', bad: '那你早点睡', tags: ['时机不对'], occ: 1, incs: ['inc-e3'], reps: 9, stab: 95, due: 60 * DAY, last: new Date(2026, 8, 1).getTime() },
]

export async function seedPreview() {
  const n = await q<{ n: number }>('SELECT COUNT(*) AS n FROM incident')
  if (Number(n[0]?.n) > 0) return
  const now = Date.now()
  await saveSettings({ herName: 'Toria', myName: '我', herNick: 'Toria', myNick: '柒', onboarded: true })

  // 11-22 那次
  await insert('incident', { id: 'inc-1122', ...SAMPLE_INCIDENT, severity: 4, status: 'reviewed', my_feelings: '', tags: SAMPLE_ANALYSIS.tags, created_at: now, updated_at: now })
  for (let i = 0; i < SAMPLE_MESSAGES.length; i++) {
    const m = SAMPLE_MESSAGES[i]
    await insert('message', { id: `m-${i + 1}`, incident_id: 'inc-1122', seq: i, speaker: m.speaker, content: m.content, msg_type: m.msg_type, reply_to: m.reply_to, sent_at: m.sent_at, is_key: 0, confidence: 1, dup_suspect: 0, attachment_id: null })
  }
  const fix = (a: string) => a.replace(/^m(\d+)$/, 'm-$1')
  const a: AnalysisData = {
    ...SAMPLE_ANALYSIS,
    timeline: SAMPLE_ANALYSIS.timeline.map((t) => ({ ...t, msg: fix(t.msg) })),
    her_words: SAMPLE_ANALYSIS.her_words.map((t) => ({ ...t, msg: fix(t.msg) })),
    misses: SAMPLE_ANALYSIS.misses.map((t) => ({ ...t, msg: fix(t.msg) })),
    commitments: [{ content: '把知识库做出来', due_hint: '下午', due_at: new Date(2026, 10, 22, 18, 0).getTime(), picked: true, created_id: 'c1' }],
    matched: true,
  }
  await insert('analysis', { id: 'an-1122', incident_id: 'inc-1122', data: a, my_own_words: '她分享东西的时候，我先说一句真心话，再说我打算怎么做；想到什么先说出来，不等她问。', profile_name: '预览模拟', created_at: now })

  for (const e of EXAMPLES) {
    await insert('incident', { id: e.id, title: e.title, occurred_at: e.at, channel: '微信', background: '', severity: e.sev, status: 'reviewed', my_feelings: '', tags: e.tags, created_at: e.at, updated_at: e.at })
    for (let i = 0; i < e.msgs.length; i++) await insert('message', { id: `${e.id}-m${i + 1}`, incident_id: e.id, seq: i, speaker: e.msgs[i][0], content: e.msgs[i][1], msg_type: e.msgs[i][1].startsWith('[') ? 'link' : 'text', reply_to: '', sent_at: '', is_key: 0, confidence: 1, dup_suspect: 0, attachment_id: null })
    const ad: AnalysisData = {
      summary: e.summary, timeline: [], her_words: [{ quote: e.quote[1], msg: `${e.id}-m${e.quote[0]}` }], inferences: [],
      misses: [{ msg: `${e.id}-m${e.miss[0]}`, problem: e.miss[1] }], next_time: [{ action: '先接住她的情绪，再说事情', say: e.say }],
      commitments: [], tags: e.tags, new_tags: [], severity: e.sev, matched: true,
    }
    await insert('analysis', { id: 'an-' + e.id, incident_id: e.id, data: ad, my_own_words: e.say, profile_name: '预览模拟', created_at: e.at })
  }

  for (const r of RULES) {
    const first = Math.min(...r.incs.map((id) => (id === 'inc-1122' ? SAMPLE_INCIDENT.occurred_at : EXAMPLES.find((e) => e.id === id)!.at)))
    await insert('rule', { id: r.id, title: r.title, trigger_scene: r.scene, good_example: r.good, bad_example: r.bad, my_own_words: '', tags: r.tags, status: r.stab >= 90 ? 'internalized' : 'active', occurrence_count: r.occ, first_seen: first, last_seen: r.last, created_at: first, updated_at: now })
    await insert('review_card', { rule_id: r.id, due: now + r.due, stability: r.stab, difficulty: 5, elapsed_days: 0, scheduled_days: r.stab, learning_steps: 0, reps: r.reps, lapses: r.occ - 1, state: 2, last_review: now - 2 * DAY, ebb_step: 0 })
    for (const iid of r.incs) await insert('rule_evidence', { id: `ev-${r.id}-${iid}`, rule_id: r.id, incident_id: iid, kind: 'linked', text: '', message_id: null })
    // 复习记录：分布在过去 50 天
    for (let k = 0; k < r.reps; k++) {
      const t = now - (50 - k * Math.floor(48 / r.reps)) * DAY + (k % 3) * HOUR
      await insert('review_log', { id: `log-${r.id}-${k}`, rule_id: r.id, rating: k === 1 && r.id === 'r2' ? 1 : k % 4 === 2 ? 2 : 3, ai_score: 60 + ((k * 13) % 35), source: 'review', reviewed_at: t, session_id: null })
    }
  }
  for (const [rid, qt, mid] of [['r1', '你想什么先说', 'm-55'], ['r1', '不在乎 随口敷衍几句', 'm-26'], ['r2', '你有什么想说的，大可以说', 'm-34'], ['r2', '我说了无数遍', 'm-57']]) {
    await insert('rule_evidence', { id: `evq-${rid}-${mid}`, rule_id: rid, incident_id: 'inc-1122', kind: 'her_words', text: qt, message_id: mid })
  }
  await insert('rule_evidence', { id: 'evb-r1', rule_id: 'r1', incident_id: 'inc-1122', kind: 'my_bad', text: '阿巴阿巴', message_id: 'm-4' })
  await insert('rule_evidence', { id: 'evb-r2', rule_id: 'r2', incident_id: 'inc-1122', kind: 'my_bad', text: '啊？这什么态度呀，嘎嘎用词不准确还是什么呀', message_id: 'm-25' })
  await insert('review_log', { id: 'log-recur-r2', rule_id: 'r2', rating: 1, ai_score: null, source: 'recurrence', reviewed_at: now - 2 * DAY, session_id: null })

  const c = (id: string, content: string, due: number | null, status: string, told: number, inc: string | null, upd = now) =>
    insert('commitment', { id, content, promised_at: now - 2 * DAY, due_at: due, status, incident_id: inc, done_note: '', cancel_reason: '', told_her: told, overdue_logged: 0, created_at: now - 2 * DAY, updated_at: upd })
  await c('c1', '把知识库做出来', new Date(2026, 10, 22, 18, 0).getTime(), 'open', 0, 'inc-1122')
  await c('c2', '周六陪她去看展，票我来订', now + 4 * DAY, 'open', 0, null)
  await c('c3', '电影票今晚买好发截图', new Date(2026, 8, 27, 23, 0).getTime(), 'done', 1, 'inc-e5', new Date(2026, 8, 27, 21, 0).getTime())

  await insert('model_profile', { id: 'p-ds', name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', supports_vision: 0, supports_json: 1, temperature: null, max_tokens: 8192, timeout_s: 120, needs_key: 1, quirks: {}, price_in: null, price_out: null, created_at: now })
  await insert('model_profile', { id: 'p-claude', name: 'Claude', protocol: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-opus-5-5', supports_vision: 1, supports_json: 1, temperature: null, max_tokens: 16000, timeout_s: 180, needs_key: 1, quirks: { noTemperature: true }, price_in: null, price_out: null, created_at: now + 1 })
  await saveSettings({ routing: { recognize: 'p-claude', analyze: 'p-claude', quiz: 'p-ds', roleplay: 'p-ds' } })
}
