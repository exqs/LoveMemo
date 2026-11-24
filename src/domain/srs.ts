// 复习调度：默认 FSRS（ts-fsrs），可切换为艾宾浩斯固定间隔
import { fsrs, generatorParameters, Rating, type Card, type Grade, type StepUnit } from 'ts-fsrs'
import type { CardRow } from '../lib/types'
import { DAY, HOUR } from '../lib/util'

export { Rating }
export type { Grade }

export interface SchedOpts {
  algorithm: 'fsrs' | 'ebbinghaus'
  retention: number
  firstStepHours: number
  fuzz?: boolean
}

export const RATING_LABEL: Record<number, string> = { 1: '重来', 2: '困难', 3: '良好', 4: '简单' }

/** AI 分数 → 四档评分（PRD F5.3） */
export function scoreToRating(score: number): Grade {
  if (score < 40) return Rating.Again
  if (score < 70) return Rating.Hard
  if (score < 90) return Rating.Good
  return Rating.Easy
}

export const EBB_DAYS = [1, 2, 4, 7, 15, 30, 60, 120, 240]

function scheduler(o: SchedOpts) {
  const step = `${o.firstStepHours}h` as StepUnit
  return fsrs(generatorParameters({
    request_retention: o.retention,
    enable_fuzz: o.fuzz ?? true,
    enable_short_term: true,
    learning_steps: [step],
    relearning_steps: [step],
    maximum_interval: 365,
  }))
}

/** 新知识点：首次复习不早于 firstStepHours 小时后 */
export function newCard(ruleId: string, now: number, o: SchedOpts): CardRow {
  return {
    rule_id: ruleId, due: now + o.firstStepHours * HOUR, stability: 0, difficulty: 0, elapsed_days: 0,
    scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review: null, ebb_step: 0,
  }
}

function toCard(r: CardRow): Card {
  return {
    due: new Date(r.due), stability: r.stability, difficulty: r.difficulty, elapsed_days: r.elapsed_days,
    scheduled_days: r.scheduled_days, learning_steps: r.learning_steps, reps: r.reps, lapses: r.lapses,
    state: r.state, last_review: r.last_review ? new Date(r.last_review) : undefined,
  }
}

function fromCard(r: CardRow, c: Card): CardRow {
  return {
    ...r, due: c.due.getTime(), stability: c.stability, difficulty: c.difficulty, elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days, learning_steps: c.learning_steps, reps: c.reps, lapses: c.lapses,
    state: c.state, last_review: c.last_review ? c.last_review.getTime() : null,
  }
}

function ebbinghaus(r: CardRow, grade: Grade, now: number, o: SchedOpts): CardRow {
  let step = r.ebb_step
  let due: number
  let lapses = r.lapses
  if (grade === Rating.Again) {
    step = 0
    lapses += r.reps > 0 ? 1 : 0
    due = now + o.firstStepHours * HOUR
  } else {
    if (grade === Rating.Good) step += 1
    if (grade === Rating.Easy) step += 2
    step = Math.min(step, EBB_DAYS.length - 1)
    due = now + EBB_DAYS[step] * DAY
  }
  const days = (due - now) / DAY
  return { ...r, due, ebb_step: step, stability: days, scheduled_days: days, reps: r.reps + 1, lapses, state: grade === Rating.Again ? 3 : 2, last_review: now }
}

export function review(r: CardRow, grade: Grade, now: number, o: SchedOpts): CardRow {
  if (o.algorithm === 'ebbinghaus') return ebbinghaus(r, grade, now, o)
  const out = scheduler(o).next(toCard(r), new Date(now), grade)
  return fromCard(r, out.card)
}

/** 四个评分按钮上显示的下次时间 */
export function preview(r: CardRow, now: number, o: SchedOpts): Record<Grade, number> {
  const g = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as Grade[]
  return Object.fromEntries(g.map((x) => [x, review(r, x, now, { ...o, fuzz: false }).due])) as Record<Grade, number>
}

/** 已内化：稳定度 ≥ 90 天、最近 3 次都是良好或简单、60 天内没再发生（PRD F5.5） */
export function isInternalized(card: CardRow, recentRatings: number[], lastSeen: number | null, now: number): boolean {
  if (card.stability < 90) return false
  if (recentRatings.length < 3 || !recentRatings.slice(0, 3).every((x) => x >= Rating.Good)) return false
  return !lastSeen || now - lastSeen >= 60 * DAY
}

export function masteryLevel(card: CardRow | undefined): number {
  // 0..1，用于颜色。按稳定度对数映射，90 天约为 1
  if (!card || card.reps === 0) return 0
  return Math.max(0, Math.min(1, Math.log1p(card.stability) / Math.log1p(90)))
}

export function fmtInterval(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))} 分钟`
  if (ms < DAY) return `${Math.round(ms / HOUR)} 小时`
  const d = Math.round(ms / DAY)
  if (d < 31) return `${d} 天`
  if (d < 365) return `${Math.round(d / 30)} 个月`
  return `${(d / 365).toFixed(1)} 年`
}

export interface QueueInput { rule_id: string; due: number; reps: number; severity: number; occurrence: number }

/** 今日队列：到期的按「逾期天数 × 严重度 × 再犯次数」排序，受每日上限约束（PRD F5.6） */
export function buildQueue(items: QueueInput[], now: number, limits: { review: number; new: number }) {
  const due = items.filter((x) => x.due <= now)
  const prio = (x: QueueInput) => (1 + Math.max(0, (now - x.due) / DAY)) * Math.max(1, x.severity) * Math.max(1, x.occurrence)
  const sorted = [...due].sort((a, b) => prio(b) - prio(a))
  const fresh = sorted.filter((x) => x.reps === 0).slice(0, limits.new)
  const old = sorted.filter((x) => x.reps > 0).slice(0, limits.review)
  const today = [...old, ...fresh].sort((a, b) => prio(b) - prio(a)).slice(0, limits.review)
  return { today, deferred: due.length - today.length }
}
