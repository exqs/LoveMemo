import { describe, expect, it } from 'vitest'
import { buildQueue, isInternalized, newCard, preview, Rating, review, scoreToRating, type SchedOpts } from './srs'
import { extractJSON, guessDue, mergeBatches, parsePasted, verifyQuotes } from './text'
import { catchUp, inQuiet, planNotifications } from './notify'
import { tokenize, wordFreq, commitmentRate } from './stats'
import { SAMPLE_MESSAGES, SAMPLE_SCREENSHOT_SPLITS } from '../fixtures/sample1122'
import type { Commitment, Settings } from '../lib/types'
import { DAY, HOUR } from '../lib/util'

const O: SchedOpts = { algorithm: 'fsrs', retention: 0.9, firstStepHours: 4, fuzz: false }
const T0 = new Date(2026, 10, 23, 21, 30).getTime()

describe('复习调度', () => {
  it('分数换算四档', () => {
    expect([0, 39, 40, 69, 70, 89, 90, 100].map(scoreToRating)).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
  })

  it('新知识点首次复习在 4 小时后', () => {
    expect(newCard('r', T0, O).due).toBe(T0 + 4 * HOUR)
  })

  it('连续 5 次良好，间隔逐次变长', () => {
    let c = newCard('r', T0, O)
    let now = c.due
    const gaps: number[] = []
    for (let i = 0; i < 6; i++) {
      c = review(c, Rating.Good, now, O)
      gaps.push(c.due - now)
      now = c.due
    }
    for (let i = 2; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1])
    expect(gaps[gaps.length - 1]).toBeGreaterThan(10 * DAY)
  })

  it('再次发生（按重来处理）后，下次到期回到 1 天以内', () => {
    let c = newCard('r', T0, O)
    let now = c.due
    for (let i = 0; i < 5; i++) { c = review(c, Rating.Good, now, O); now = c.due }
    const after = review(c, Rating.Again, now, O)
    expect(after.due - now).toBeLessThanOrEqual(DAY)
    expect(after.lapses).toBe(c.lapses + 1)
  })

  it('艾宾浩斯模式按固定间隔', () => {
    const E = { ...O, algorithm: 'ebbinghaus' as const }
    let c = newCard('r', T0, E)
    const days: number[] = []
    for (let i = 0; i < 4; i++) { c = review(c, Rating.Good, T0, E); days.push(Math.round((c.due - T0) / DAY)) }
    expect(days).toEqual([2, 4, 7, 15])
    expect(review(c, Rating.Again, T0, E).due).toBe(T0 + 4 * HOUR)
  })

  it('评分按钮预览：重来最短，简单最长', () => {
    const c = review(newCard('r', T0, O), Rating.Good, T0 + 4 * HOUR, O)
    const p = preview(c, c.due, O)
    expect(p[Rating.Again]).toBeLessThan(p[Rating.Good])
    expect(p[Rating.Good]).toBeLessThanOrEqual(p[Rating.Easy])
  })

  it('已内化判定', () => {
    const c = { ...newCard('r', T0, O), stability: 120, reps: 8 }
    expect(isInternalized(c, [3, 4, 3], T0 - 70 * DAY, T0)).toBe(true)
    expect(isInternalized(c, [3, 2, 3], T0 - 70 * DAY, T0)).toBe(false)
    expect(isInternalized(c, [3, 4, 3], T0 - 10 * DAY, T0)).toBe(false)
  })

  it('每日上限和积压排序', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ rule_id: 'r' + i, due: T0 - i * DAY, reps: i % 4 === 0 ? 0 : 3, severity: 3, occurrence: 1 }))
    const q = buildQueue(items, T0, { review: 10, new: 3 })
    expect(q.today.length).toBe(10)
    expect(q.today.filter((x) => x.reps === 0).length).toBeLessThanOrEqual(3)
    expect(q.deferred).toBe(10)
    expect(q.today[0].rule_id).toBe('r19')
  })
})

describe('截图去重', () => {
  it('8 张有重叠的截图合并后与原始 61 条一致', () => {
    const batches = SAMPLE_SCREENSHOT_SPLITS.map(([a, b]) => SAMPLE_MESSAGES.slice(a, b))
    const out = mergeBatches(batches)
    expect(out.length).toBe(SAMPLE_MESSAGES.length)
    expect(out.map((m) => m.content)).toEqual(SAMPLE_MESSAGES.map((m) => m.content))
    expect(out.filter((m) => m.dup_suspect).length).toBe(0)
  })

  it('连续两条一样且没有时间：保留并标为疑似重复', () => {
    const m = (c: string) => ({ speaker: 'them' as const, content: c, msg_type: 'text' as const, reply_to: '', sent_at: '', confidence: 1 })
    const out = mergeBatches([[m('你的态度'), m('睡了')], [m('睡了'), m('到此为止')]])
    expect(out.length).toBe(4)
    expect(out[2].dup_suspect).toBe(true)
  })
})

describe('原话校验', () => {
  const msgs = SAMPLE_MESSAGES.map((m, i) => ({ id: 'm' + (i + 1), speaker: m.speaker, content: m.content }))
  it('能找到的保留，并修正所在消息', () => {
    const r = verifyQuotes([{ quote: '不在乎，随口敷衍几句', msg: 'm1' }, { quote: '你想什么先说', msg: 'x' }], msgs)
    expect(r.kept.map((q) => q.msg)).toEqual(['m26', 'm55'])
    expect(r.dropped).toEqual([])
  })
  it('跨相邻几条拼接也算', () => {
    expect(verifyQuotes([{ quote: '你的态度挺没意思的', msg: '' }], msgs).kept.length).toBe(1)
  })
  it('编造的原话被丢弃', () => {
    expect(verifyQuotes([{ quote: '你从来不关心我', msg: 'm3' }], msgs).dropped).toEqual(['你从来不关心我'])
  })
  it('我说的话不能当成她的原话', () => {
    expect(verifyQuotes([{ quote: '我下午做出来', msg: '' }], msgs).kept.length).toBe(0)
  })
})

describe('文本工具', () => {
  it('粘贴文本拆分（两种格式）', () => {
    const a = parsePasted('她：好具象的爱啊\n我：阿巴阿巴', '她', '我')
    expect(a.map((m) => m.speaker)).toEqual(['them', 'me'])
    const b = parsePasted('她 2026年11月22日 13:02\n你的态度\n挺没意思的\n我 2026年11月22日 13:03\n啊？这什么态度呀', '她', '我')
    expect(b.map((m) => [m.speaker, m.content])).toEqual([['them', '你的态度'], ['them', '挺没意思的'], ['me', '啊？这什么态度呀']])
    expect(b[0].sent_at).toBe('2026年11月22日 13:02')
  })
  it('承诺时间：下午 → 当天 18:00；认不出 → null', () => {
    const base = new Date(2026, 10, 22, 13, 8).getTime()
    expect(guessDue('下午', base)).toBe(new Date(2026, 10, 22, 18, 0).getTime())
    expect(new Date(guessDue('明天', base)!).getDate()).toBe(23)
    expect(guessDue('有空的时候', base)).toBeNull()
  })
  it('从 AI 输出里取 JSON', () => {
    expect(extractJSON('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJSON('结果是 {"a":[1,2]} 以上')).toEqual({ a: [1, 2] })
    expect(() => extractJSON('没有')).toThrow()
  })
  it('中文分词和词频', () => {
    expect(tokenize('不在乎 随口敷衍几句')).toContain('敷衍')
    const f = wordFreq(['我说了多说多说多说', '我说了多说', '你想什么先说'])
    expect(f[0].name).toContain('多说')
  })
})

const S: Settings = {
  herName: '她', myName: '我', herNick: '她', myNick: '我',
  routing: { recognize: null, analyze: null, quiz: null, roleplay: null },
  algorithm: 'fsrs', retention: 0.9, dailyReviewLimit: 10, dailyNewLimit: 3, firstStepHours: 4,
  reminderTimes: ['21:30'], weeklyTime: '0 20:00', quietStart: '00:00', quietEnd: '08:00',
  privacyNotify: false, autoBackupDays: 7, lastBackupAt: 0, onboarded: true,
}

describe('提醒计划', () => {
  const morning = new Date(2026, 10, 23, 9, 0).getTime()
  it('每日复习提醒带上知识点标题', () => {
    const p = planNotifications(S, [{ title: '先说想法', due: morning - HOUR }], [], morning)
    const r = p.filter((e) => e.key.startsWith('review:'))
    expect(r.length).toBe(2) // 今天和明天
    expect(r[0].body).toContain('先说想法')
    expect(new Date(r[0].at).getHours()).toBe(21)
  })
  it('隐私模式不显示标题', () => {
    const p = planNotifications({ ...S, privacyNotify: true }, [{ title: '先说想法', due: morning }], [], morning)
    expect(p[0].body).not.toContain('先说想法')
  })
  it('承诺提醒：前 24 小时、前 1 小时、到期；免打扰时段顺延', () => {
    const c: Commitment = {
      id: 'c1', content: '把知识库做出来', promised_at: morning, due_at: new Date(2026, 10, 24, 2, 0).getTime(), status: 'open',
      incident_id: null, done_note: '', cancel_reason: '', told_her: false, overdue_logged: false, created_at: morning, updated_at: morning,
    }
    const p = planNotifications(S, [], [c], morning).filter((e) => e.key.startsWith('commit:'))
    // 前 24 小时（11-23 02:00）已过；前 1 小时和到期都在 0 点到 8 点之间，顺延到 8:00
    expect(p.map((e) => e.key.split(':')[2])).toEqual(['1h', '0'])
    for (const e of p) expect(inQuiet(e.at, S)).toBe(false)
    expect(p.every((e) => new Date(e.at).getHours() === 8)).toBe(true)
  })
  it('补发：错过了且没发过才补，一天只补一次', () => {
    const night = new Date(2026, 10, 23, 22, 0).getTime()
    expect(catchUp(S, 3, [], '', night)).not.toBeNull()
    expect(catchUp(S, 3, ['review:2026-11-23:21:30'], '', night)).toBeNull()
    expect(catchUp(S, 3, [], '2026-11-23', night)).toBeNull()
    expect(catchUp(S, 0, [], '', night)).toBeNull()
    expect(catchUp(S, 3, [], '', morning)).toBeNull()
  })
})

describe('承诺完成率', () => {
  it('按时完成 / 已到期或已完成', () => {
    const base = { promised_at: 0, incident_id: null, done_note: '', cancel_reason: '', told_her: false, overdue_logged: false, created_at: 0 }
    const cs: Commitment[] = [
      { ...base, id: 'a', content: '', status: 'done', due_at: 100, updated_at: 50 },
      { ...base, id: 'b', content: '', status: 'done', due_at: 100, updated_at: 150 },
      { ...base, id: 'c', content: '', status: 'open', due_at: 100, updated_at: 0 },
      { ...base, id: 'd', content: '', status: 'cancelled', due_at: 100, updated_at: 0 },
    ]
    expect(commitmentRate(cs, 200)).toEqual({ total: 3, ontime: 1, rate: 1 / 3 })
  })
})
