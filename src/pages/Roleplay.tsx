// 角色扮演（PRD F8）：AI 模拟她，侧边教练即时提示，结束后整体评分
import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { Bubble } from '../components/Bubble'
import { Button, Sheet, Spinner, errText, inputCls, toast } from '../components/ui'
import { saveQuizItem, updateQuizItem } from '../db/rules'
import { generateQuiz, roleplayReview, roleplayTurn } from '../ai/tasks'
import type { RoleplayReview } from '../ai/schemas'
import type { ChatLine, QuizQuestion, Rule, Settings } from '../lib/types'
import { ScoreRing } from './Quiz'

const MAX_TURNS = 12
const MOOD = ['', '很生气', '不高兴', '有点松动', '缓和了', '平和']

export default function Roleplay({ rule, s, sessionId, onDone }: { rule: Rule; s: Settings; sessionId: string; onDone: (score: number) => void }) {
  const [q, setQ] = useState<QuizQuestion | null>(null)
  const [itemId, setItemId] = useState('')
  const [hist, setHist] = useState<ChatLine[]>([])
  const [tips, setTips] = useState<string[]>([])
  const [mood, setMood] = useState(2)
  const [resolved, setResolved] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [coach, setCoach] = useState(true)
  const [review, setReview] = useState<RoleplayReview | null>(null)
  const [err, setErr] = useState('')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    generateQuiz(rule, 'roleplay', s).then(async (x) => {
      if (!alive) return
      const first = x.chat.find((c) => c.speaker === 'them') ?? { speaker: 'them' as const, content: '……' }
      setQ(x); setHist([first])
      setItemId(await saveQuizItem({ session_id: sessionId, rule_id: rule.id, question: x, chat: [first] }))
    }).catch((e) => alive && setErr(errText(e)))
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [hist, tips])

  const turns = hist.filter((h) => h.speaker === 'me').length
  const send = async () => {
    if (!text.trim() || !q) return
    const h = [...hist, { speaker: 'me' as const, content: text.trim() }]
    setHist(h); setText(''); setBusy(true)
    try {
      const r = await roleplayTurn(rule, q.prompt, h, s)
      const h2 = [...h, { speaker: 'them' as const, content: r.her_reply }]
      setHist(h2); setTips((t) => [...t, r.coach_tip]); setMood(r.mood); setResolved(r.resolved)
      await updateQuizItem(itemId, { chat: h2 })
    } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
  }
  const finish = async () => {
    if (!q) return
    setBusy(true)
    try {
      const r = await roleplayReview(rule, q.prompt, hist, s)
      setReview(r)
      await updateQuizItem(itemId, { grade: r, score: r.score, chat: hist })
      onDone(r.score)
    } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
  }

  if (err) return <Sheet className="p-5 text-red text-sm">开场生成失败：{err}</Sheet>
  if (!q) return <Sheet className="p-6"><Spinner label="正在准备情景…" /></Sheet>
  const over = resolved || turns >= MAX_TURNS

  return (
    <div className="grid grid-cols-[1fr_260px] gap-4">
      <Sheet className="p-4 flex flex-col">
        <p className="text-sm text-ink-soft mb-1">情景：{q.prompt}</p>
        <p className="text-xs text-warn mb-3">这是模拟，不代表{s.herName}真实的反应。练的是你的反应，不是预测她。</p>
        <div className="flex-1 min-h-[260px] max-h-[48vh] overflow-auto rounded-lg bg-paper/70 py-2">
          {hist.map((h, i) => <Bubble key={i} speaker={h.speaker} name={h.speaker === 'me' ? '我' : s.herName} content={h.content} />)}
          {busy && !review && <p className="px-4 text-sm text-ink-faint">{s.herName}正在输入…</p>}
          <div ref={end} />
        </div>
        {review ? (
          <div className="mt-4 flex gap-5">
            <ScoreRing score={review.score} />
            <div className="flex-1 space-y-1.5">
              <p className="text-sm">{review.summary}</p>
              {review.line_notes.map((n, i) => <p key={i} className="text-sm"><span className="text-ink-soft">「{n.line}」</span><span className="red-note ml-2">{n.note}</span></p>)}
              {review.reference && <p className="text-sm"><span className="text-ink-faint">重来一次可以这样开头：</span><span className="text-pen">{review.reference}</span></p>}
            </div>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <input className={inputCls} disabled={busy || over} value={text} onChange={(e) => setText(e.target.value)} placeholder={over ? (resolved ? '她的情绪平和了，可以结束了' : `已到 ${MAX_TURNS} 轮上限`) : '回她……'} onKeyDown={(e) => { if (e.key === 'Enter') send() }} />
            <Button onClick={send} disabled={busy || over || !text.trim()}><Send size={14} /></Button>
            <Button kind={over ? 'primary' : 'line'} onClick={finish} disabled={busy || turns === 0}>结束并评分</Button>
          </div>
        )}
      </Sheet>
      <Sheet className="p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="font-medium text-sm">教练</p>
          <label className="text-xs text-ink-faint flex items-center gap-1"><input type="checkbox" checked={coach} onChange={(e) => setCoach(e.target.checked)} />即时提示</label>
        </div>
        <p className="text-xs text-ink-soft mb-1">{s.herName}现在：{MOOD[mood]}</p>
        <div className="h-1.5 rounded-full bg-grid mb-3"><div className="h-full rounded-full bg-ok transition-all" style={{ width: `${mood * 20}%` }} /></div>
        <p className="text-xs text-ink-faint mb-2">第 {turns} / {MAX_TURNS} 轮</p>
        {coach && tips.map((t, i) => <p key={i} className="red-note !text-[14px] mb-1.5">{t}</p>)}
        {coach && !tips.length && <p className="text-xs text-ink-faint">回一句之后，这里会给提示。这次练的是：{rule.title}</p>}
      </Sheet>
    </div>
  )
}
