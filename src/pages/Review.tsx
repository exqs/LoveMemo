// 复习（PRD F7）：承诺检查 → 回忆卡 → 练习题 / 角色扮演 → 评分并安排下次复习 → 小结
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Check, RotateCcw } from 'lucide-react'
import { Page } from '../components/Page'
import { Button, Empty, Sheet, confirmDialog, cx } from '../components/ui'
import { useSettings } from '../db/base'
import { listCommitments, updateCommitment } from '../db/misc'
import { getCard, getRule, gradeRule, listCards, listEvidence, listRules, todayQueue, type QueueItem } from '../db/rules'
import { RATING_LABEL, Rating, fmtInterval, preview, scoreToRating, type Grade } from '../domain/srs'
import { pickKinds } from '../ai/tasks'
import type { CardRow, Commitment, Evidence } from '../lib/types'
import { DAY, HOUR, fmtDate, relDays, uid } from '../lib/util'
import Quiz, { KIND_NAME } from './Quiz'
import Roleplay from './Roleplay'

type Phase = 'commit' | 'recall' | 'practice' | 'roleplay' | 'rate' | 'summary'
interface Done { title: string; rating: Grade; due: number; avg: number | null }

export default function Review() {
  const [sp] = useSearchParams()
  const single = sp.get('rule')
  const nav = useNavigate()
  const [s] = useSettings()
  const sessionId = useMemo(() => uid(), [])
  const [queue, setQueue] = useState<QueueItem[] | null>(null)
  const [upcoming, setUpcoming] = useState<{ title: string; due: number; id: string }[]>([])
  const [commits, setCommits] = useState<Commitment[]>([])
  const [idx, setIdx] = useState(0)
  const [phase, setPhase] = useState<Phase>('recall')
  const [flipped, setFlipped] = useState(false)
  const [scores, setScores] = useState<number[]>([])
  const [qn, setQn] = useState(0)
  const [ev, setEv] = useState<Evidence[]>([])
  const [done, setDone] = useState<Done[]>([])

  useEffect(() => {
    (async () => {
      let items: QueueItem[]
      if (single) {
        const [r, c] = await Promise.all([getRule(single), getCard(single)])
        items = r && c ? [{ rule: r, card: c }] : []
      } else {
        items = (await todayQueue()).items
        const now = Date.now()
        const cs = (await listCommitments()).filter((c) => c.status === 'open' && c.due_at && c.due_at < now + 2 * DAY)
        setCommits(cs)
        if (cs.length) setPhase('commit')
        if (!items.length) {
          const rules = new Map((await listRules()).filter((r) => r.status !== 'archived').map((r) => [r.id, r.title]))
          setUpcoming((await listCards()).filter((c) => rules.has(c.rule_id)).sort((a, b) => a.due - b.due).slice(0, 5).map((c) => ({ id: c.rule_id, title: rules.get(c.rule_id)!, due: c.due })))
        }
      }
      setQueue(items)
    })()
  }, [single])

  const cur = queue?.[idx]
  useEffect(() => { if (cur) listEvidence(cur.rule.id).then(setEv) }, [cur])

  if (!s || !queue) return null
  const opts = { algorithm: s.algorithm, retention: s.retention, firstStepHours: s.firstStepHours }

  const nextItem = (d: Done) => {
    setDone((x) => [...x, d])
    if (idx + 1 < queue.length) { setIdx(idx + 1); setPhase('recall'); setFlipped(false); setScores([]); setQn(0) }
    else setPhase('summary')
  }
  const rate = async (g: Grade) => {
    if (!cur) return
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
    const c = await gradeRule(cur.rule.id, g, avg, sessionId)
    nextItem({ title: cur.rule.title, rating: g, due: c?.due ?? Date.now(), avg })
  }

  // ---------- 承诺检查 ----------
  if (phase === 'commit') {
    return (
      <Page narrow title="先看看答应她的事">
        <Sheet className="p-5 space-y-3">
          {commits.map((c) => (
            <div key={c.id} className="flex items-center gap-3 border-b border-dashed border-rule pb-3 last:border-0 last:pb-0">
              <div className="flex-1">
                <p>{c.content}</p>
                <p className={cx('text-xs', c.due_at! < Date.now() ? 'text-red' : 'text-ink-faint')}>{relDays(c.due_at!)}</p>
              </div>
              {c.status === 'open' ? <>
                <Button size="sm" onClick={async () => { const told = await confirmDialog('已经告诉她做完了吗？\n没告诉的话，首页会一直提醒你。', '已经告诉了'); await updateCommitment(c.id, { status: 'done', told_her: told }); setCommits((xs) => xs.map((x) => (x.id === c.id ? { ...x, status: 'done' } : x))) }}><Check size={14} />做完了</Button>
                <Button size="sm" kind="ghost" onClick={() => nav('/commitments')}>改时间</Button>
              </> : <span className="text-sm text-ok">已完成，记得告诉她</span>}
            </div>
          ))}
        </Sheet>
        <div className="mt-4"><Button kind="primary" onClick={() => setPhase(queue.length ? 'recall' : 'summary')}>{queue.length ? `继续，复习 ${queue.length} 个点` : '好了'}</Button></div>
      </Page>
    )
  }

  // ---------- 空队列 ----------
  if (!queue.length && phase !== 'summary') {
    return (
      <Page narrow title="复习">
        <Empty title={single ? '找不到这个知识点' : '今天没有要复习的'}>
          {upcoming.length ? '下面是接下来要复习的，也可以提前练一条。' : '复盘一次争吵并归入知识库后，这里会开始安排复习。'}
        </Empty>
        {upcoming.length > 0 && (
          <Sheet className="divide-y divide-rule">
            {upcoming.map((u) => (
              <div key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1">{u.title}</span><span className="text-sm text-ink-faint">{relDays(u.due)}</span>
                <Button size="sm" onClick={() => nav(`/review?rule=${u.id}`)}>提前练</Button>
              </div>
            ))}
          </Sheet>
        )}
      </Page>
    )
  }

  // ---------- 小结 ----------
  if (phase === 'summary') {
    const weak = [...done].filter((d) => d.avg != null).sort((a, b) => a.avg! - b.avg!)[0]
    return (
      <Page narrow title="这次复习完了">
        <Sheet className="divide-y divide-rule">
          {done.length === 0 && <p className="p-4 text-sm text-ink-faint">这次没有复习知识点</p>}
          {done.map((d, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <span className="flex-1">{d.title}</span>
              {d.avg != null && <span className="text-sm text-ink-soft">{Math.round(d.avg)} 分</span>}
              <span className={cx('text-sm rounded px-2', d.rating >= 3 ? 'bg-ok-soft text-ok' : d.rating === 2 ? 'bg-warn-soft text-warn' : 'bg-red-soft text-red')}>{RATING_LABEL[d.rating]}</span>
              <span className="text-sm text-ink-faint w-28 text-right">下次 {fmtDate(d.due).slice(5)}（{fmtInterval(d.due - Date.now())}后）</span>
            </div>
          ))}
        </Sheet>
        {weak && weak.avg! < 70 && <p className="red-note mt-4">下次多留意：{weak.title}</p>}
        <div className="mt-5 flex gap-2"><Button kind="primary" onClick={() => nav('/')}>回到今天</Button><Button onClick={() => nav('/rules')}>看知识库</Button></div>
      </Page>
    )
  }

  const r = cur!.rule
  const card: CardRow = cur!.card
  const her = s.herName
  const herWords = [...new Set(ev.filter((e) => e.kind === 'her_words').map((e) => e.text))].slice(0, 4)
  const kinds = pickKinds(card, 3)
  const passed = scores.length >= 2 && scores.slice(-2).every((x) => x >= 70)
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
  const suggested = avg == null ? Rating.Good : scoreToRating(avg)
  const pv = preview(card, Date.now(), opts)

  return (
    <div className="max-w-[860px] mx-auto px-8 py-6">
      <div className="flex items-center gap-3 mb-4 text-sm text-ink-soft">
        <span>{single ? '单独练习' : `第 ${idx + 1} 个，共 ${queue.length} 个`}</span>
        <div className="flex-1 h-1 rounded-full bg-grid"><div className="h-full rounded-full bg-pen transition-all" style={{ width: `${((idx + (phase === 'rate' ? 0.9 : 0.3)) / queue.length) * 100}%` }} /></div>
        <Link to="/" className="hover:text-pen">退出</Link>
      </div>

      {/* 回忆卡 */}
      <div className="flip mb-4">
        <div className={cx('flip-inner', flipped && 'flipped')}>
          <Sheet className="flip-face p-7 min-h-[240px] flex flex-col">
            <p className="text-xs text-ink-faint mb-2">当这种情况发生时</p>
            <p className="kai text-[22px] leading-relaxed flex-1">{r.trigger_scene || r.title}</p>
            {herWords[0] && <p className="text-sm text-ink-soft mb-4">她说过：「{herWords[0]}」</p>}
            <div className="flex items-center gap-3">
              <Button kind="primary" onClick={() => setFlipped(true)}>想好了，翻面</Button>
              <span className="text-xs text-ink-faint">先在心里回答：这时候你该怎么做、怎么说？</span>
            </div>
          </Sheet>
          <Sheet className="flip-face flip-back p-7 min-h-[240px]">
            <p className="kai text-[22px] leading-snug mb-3">{r.title}</p>
            {r.good_example && <p className="mb-1.5"><span className="text-xs text-ink-faint mr-2">可以这样说</span><span className="text-pen">{r.good_example}</span></p>}
            {r.bad_example && <p className="mb-1.5"><span className="text-xs text-ink-faint mr-2">我说过</span><span className="red-note red-wave">{r.bad_example}</span></p>}
            {r.my_own_words && <p className="mb-1.5"><span className="text-xs text-ink-faint mr-2">我自己的话</span>{r.my_own_words}</p>}
            {herWords.length > 0 && <p className="text-sm text-ink-soft mt-2">{her}说过：{herWords.map((w) => `「${w}」`).join('')}</p>}
            <button className="mt-3 text-xs text-ink-faint hover:text-pen inline-flex items-center gap-1" onClick={() => setFlipped(false)}><RotateCcw size={12} />翻回正面</button>
          </Sheet>
        </div>
      </div>

      {flipped && phase === 'recall' && (
        <div className="flex gap-2">
          <Button kind="primary" onClick={() => { setPhase('practice'); setQn(1) }}>做练习题（{KIND_NAME[kinds[0]]}）</Button>
          <Button onClick={() => setPhase('roleplay')}>角色扮演练一遍</Button>
          <Button kind="ghost" onClick={() => setPhase('rate')}>跳过练习，直接评分</Button>
        </div>
      )}

      {phase === 'practice' && (
        <div className="space-y-4">
          {Array.from({ length: qn }, (_, i) => (
            <Quiz key={`${r.id}-${i}`} rule={r} kind={kinds[i % kinds.length]} s={s} sessionId={sessionId} onGraded={(sc) => setScores((x) => [...x, sc])} />
          ))}
          <div className="flex items-center gap-2">
            {passed && <span className="red-note mr-2">连续两题 70 分以上，这一条通过了</span>}
            <Button onClick={() => setQn((n) => n + 1)} disabled={scores.length < qn}>再来一题（{KIND_NAME[kinds[qn % kinds.length]]}）</Button>
            <Button kind={passed ? 'primary' : 'line'} onClick={() => setPhase('rate')}>完成这一条</Button>
          </div>
        </div>
      )}

      {phase === 'roleplay' && (
        <div className="space-y-3">
          <Roleplay rule={r} s={s} sessionId={sessionId} onDone={(sc) => setScores((x) => [...x, sc])} />
          {scores.length > 0 && <Button kind="primary" onClick={() => setPhase('rate')}>完成这一条</Button>}
        </div>
      )}

      {phase === 'rate' && (
        <Sheet className="p-5">
          <p className="font-medium mb-1">这一条掌握得怎么样？</p>
          <p className="text-sm text-ink-soft mb-4">{avg != null ? `这次平均 ${Math.round(avg)} 分，建议选"${RATING_LABEL[suggested]}"。以你选的为准。` : '没有做题，按你自己的感觉选。'}</p>
          <div className="grid grid-cols-4 gap-2">
            {([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as Grade[]).map((g) => (
              <button key={g} onClick={() => rate(g)}
                className={cx('rounded-lg border px-3 py-3 text-center transition-colors', g === suggested ? 'border-pen bg-pen-soft' : 'border-rule hover:border-ink-faint')}>
                <span className="block font-medium">{RATING_LABEL[g]}</span>
                <span className="block text-xs text-ink-faint mt-0.5">{fmtInterval(Math.max(HOUR / 60, pv[g] - Date.now()))}后</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-faint mt-3">重来：没想起来或方向错了。困难：方向对但还会踩坑。良好：能用自己的话做到。简单：很自然。</p>
        </Sheet>
      )}

    </div>
  )
}
