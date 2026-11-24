// AI 输出结构。写得宽松一些（类型转换、默认值），模型偶尔少字段也能用
import { z } from 'zod'

// 注意：z.coerce.string() 会把 undefined 变成 "undefined"，所以先把空值转成 ''
const str = z.preprocess((v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)), z.string())
const strArr = z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => x != null).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : typeof v === 'string' && v ? [v] : []), z.array(z.string()))
const num = (d: number) => z.preprocess((v) => { const n = Number(v); return v == null || v === '' || Number.isNaN(n) ? d : n }, z.number())
const optNum = z.preprocess((v) => { const n = Number(v); return v == null || v === '' || Number.isNaN(n) ? undefined : n }, z.number().optional())
const bool = z.preprocess((v) => v === true || v === 'true' || v === 1 || v === '1', z.boolean())

export const RecognizeSchema = z.object({
  messages: z.array(z.object({
    speaker: z.enum(['them', 'me']).catch('them'),
    content: str,
    msg_type: z.enum(['text', 'emoji', 'image', 'link', 'voice', 'reply']).catch('text'),
    reply_to: str,
    sent_at: str,
    confidence: num(0.8),
  })),
})

export const AnalyzeSchema = z.object({
  summary: str,
  timeline: z.array(z.object({ msg: str, note: str })).catch([]),
  her_words: z.array(z.object({ quote: str, msg: str })).catch([]),
  inferences: strArr,
  misses: z.array(z.object({ msg: str, problem: str })).catch([]),
  next_time: z.array(z.object({ action: str, say: str })).catch([]),
  commitments: z.array(z.object({ content: str, due_hint: str })).catch([]),
  tags: strArr,
  new_tags: strArr,
  severity: num(3),
})

export const MatchSchema = z.object({
  decisions: z.array(z.object({
    action: z.enum(['attach', 'create']).catch('create'),
    rule_id: str,
    reason: str,
    title: str,
    trigger_scene: str,
    good_example: str,
    bad_example: str,
    tags: strArr,
  })).catch([]),
})

const chatLine = z.object({ speaker: z.enum(['them', 'me']).catch('them'), content: str })

export const QuizSchema = z.object({
  kind: z.enum(['why', 'choose', 'rewrite', 'spot', 'roleplay']).catch('why'),
  scenario_key: str,
  prompt: str,
  chat: z.array(chatLine).catch([]),
  options: strArr,
  rubric: strArr,
  reference: str,
  answer_index: optNum,
  spot_index: optNum,
})

export const GradeSchema = z.object({
  score: num(50),
  good: strArr,
  problems: strArr,
  reference: str,
  option_notes: strArr,
})

export const RoleplaySchema = z.object({
  her_reply: str,
  coach_tip: str,
  resolved: bool,
  mood: num(3),
})

export const RoleplayReviewSchema = z.object({
  score: num(50),
  summary: str,
  line_notes: z.array(z.object({ line: str, note: str })).catch([]),
  reference: str,
})

export const WeeklySchema = z.object({ summary: str, focus: str })

export type AnalyzeOut = z.infer<typeof AnalyzeSchema>
export type MatchOut = z.infer<typeof MatchSchema>
export type RoleplayOut = z.infer<typeof RoleplaySchema>
export type RoleplayReview = z.infer<typeof RoleplayReviewSchema>
