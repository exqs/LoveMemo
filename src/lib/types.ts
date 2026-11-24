export type Speaker = 'them' | 'me'
export type MsgType = 'text' | 'emoji' | 'image' | 'link' | 'voice' | 'reply'

export interface Message {
  id: string
  incident_id: string
  seq: number
  speaker: Speaker
  content: string
  msg_type: MsgType
  reply_to: string // 被引用的那条的文字摘要
  sent_at: string // 截图里显示的时间，原样保存，如 "13:02" 或 "2026年11月22日 13:02"
  is_key: boolean
  confidence: number
  dup_suspect: boolean
  attachment_id: string | null
}

export type IncidentStatus = 'draft' | 'reviewed' | 'archived'
export interface Incident {
  id: string
  title: string
  occurred_at: number | null
  channel: string
  background: string
  severity: number
  status: IncidentStatus
  my_feelings: string
  tags: string[]
  created_at: number
  updated_at: number
}

export interface Attachment { id: string; incident_id: string; data_url: string; order_no: number }

/** 复盘内容。msg 字段存消息 id */
export interface AnalysisData {
  summary: string
  timeline: { msg: string; note: string }[]
  her_words: { quote: string; msg: string }[]
  inferences: string[]
  misses: { msg: string; problem: string }[]
  next_time: { action: string; say: string }[]
  commitments: { content: string; due_hint: string; picked?: boolean; due_at?: number | null; created_id?: string }[]
  matched?: boolean // 已经做过知识点归属
  tags: string[]
  new_tags: string[]
  severity: number
  dropped_quotes?: string[] // 校验时丢弃的、在聊天里找不到的"原话"
}
export interface Analysis { id: string; incident_id: string; data: AnalysisData; my_own_words: string; profile_name: string; created_at: number }

export type RuleStatus = 'active' | 'internalized' | 'archived'
export interface Rule {
  id: string
  title: string
  trigger_scene: string
  good_example: string
  bad_example: string
  my_own_words: string
  tags: string[]
  status: RuleStatus
  occurrence_count: number
  first_seen: number | null
  last_seen: number | null
  created_at: number
  updated_at: number
}
export type EvidenceKind = 'her_words' | 'my_bad' | 'linked'
export interface Evidence { id: string; rule_id: string; incident_id: string; kind: EvidenceKind; text: string; message_id: string | null }

export interface CardRow {
  rule_id: string
  due: number
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number // 0 新 1 学习中 2 复习 3 重新学习
  last_review: number | null
  ebb_step: number
}
export interface ReviewLog { id: string; rule_id: string; rating: number; ai_score: number | null; source: 'review' | 'recurrence' | 'manual'; reviewed_at: number; session_id: string | null }

export type CommitmentStatus = 'open' | 'done' | 'cancelled'
export interface Commitment {
  id: string
  content: string
  promised_at: number | null
  due_at: number | null
  status: CommitmentStatus
  incident_id: string | null
  done_note: string
  cancel_reason: string
  told_her: boolean
  overdue_logged: boolean
  created_at: number
  updated_at: number
}

export type Protocol = 'openai' | 'anthropic'
export interface ProfileQuirks { noTemperature?: boolean; maxCompletionTokens?: boolean; noResponseFormat?: boolean }
export interface ModelProfile {
  id: string
  name: string
  protocol: Protocol
  base_url: string
  model: string
  supports_vision: boolean
  supports_json: boolean
  temperature: number | null
  max_tokens: number
  timeout_s: number
  needs_key: boolean
  quirks: ProfileQuirks
  price_in: number | null // 每百万输入 token 的价格（元）
  price_out: number | null
  created_at: number
}

export type AiTask = 'recognize' | 'analyze' | 'match' | 'quiz' | 'grade' | 'roleplay' | 'weekly' | 'test'
export type RouteKey = 'recognize' | 'analyze' | 'quiz' | 'roleplay'

export interface Settings {
  herName: string
  myName: string
  herNick: string // 截图里她的昵称
  myNick: string
  routing: Record<RouteKey, string | null>
  algorithm: 'fsrs' | 'ebbinghaus'
  retention: number
  dailyReviewLimit: number
  dailyNewLimit: number
  firstStepHours: number
  reminderTimes: string[]
  weeklyTime: string // "0 20:00" 周日 20:00；空字符串为关闭
  quietStart: string
  quietEnd: string
  privacyNotify: boolean
  autoBackupDays: number
  lastBackupAt: number
  onboarded: boolean
}

export type QuizKind = 'why' | 'choose' | 'rewrite' | 'spot' | 'roleplay'
export interface ChatLine { speaker: Speaker; content: string }
export interface QuizQuestion {
  kind: QuizKind
  scenario_key: string // 情景来源标识，用来避免连续两次同一情景
  prompt: string
  chat: ChatLine[]
  options: string[]
  rubric: string[]
  reference: string
  answer_index?: number // 回复选择题的最佳选项
  spot_index?: number // 找问题题：chat 中有问题的那一句的下标
}
export interface QuizGrade { score: number; good: string[]; problems: string[]; reference: string; option_notes?: string[] }
