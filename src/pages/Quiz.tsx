// 单道练习题：出题 → 作答 → AI 评分讲解 → 继续追问（PRD F8）
import { useEffect, useState } from 'react'
import { MessageCircle, Send } from 'lucide-react'
import { Bubble } from '../components/Bubble'
import { Button, Sheet, Spinner, cx, errText, inputCls, toast } from '../components/ui'
import { saveQuizItem, updateQuizItem } from '../db/rules'
import { followUp, generateQuiz, gradeAnswer } from '../ai/tasks'
import type { QuizGrade, QuizKind, QuizQuestion, Rule, Settings } from '../lib/types'

export const KIND_NAME: Record<QuizKind, string> = { why: '原因分析', choose: '回复选择', rewrite: '改写回复', spot: '找出问题', roleplay: '角色扮演' }

export function ScoreRing({ score, size = 64 }: { score: number; size?: number }) {
  return <span className="score-ring" style={{ width: size, height: size, fontSize: size * 0.42 }}>{score}</span>
}

export default function Quiz({ rule, kind, s, sessionId, onGraded }: { rule: Rule; kind: QuizKind; s: Settings; sessionId: string; onGraded: (score: number) => void }) {
  const [q, setQ] = useState<QuizQuestion | null>(null)
  const [itemId, setItemId] = useState('')
  const [err, setErr] = useState('')
  const [answer, setAnswer] = useState('')
  const [chosen, setChosen] = useState<number | null>(null)
  const [grade, setGrade] = useState<QuizGrade | null>(null)
  const [busy, setBusy] = useState(false)
  const [chat, setChat] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [ask, setAsk] = useState('')

  useEffect(() => {
    let alive = true
    generateQuiz(rule, kind, s)
      .then(async (x) => { if (!alive) return; setQ(x); setItemId(await saveQuizItem({ session_id: sessionId, rule_id: rule.id, question: x })) })
      .catch((e) => alive && setErr(errText(e)))
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!q) return
    if ((q.kind === 'choose' || q.kind === 'spot') && chosen == null) { toast(q.kind === 'choose' ? '先选一个' : '先点出是哪一句', 'err'); return }
    if ((q.kind === 'why' || q.kind === 'rewrite') && !answer.trim()) { toast('先写下你的答案', 'err'); return }
    setBusy(true)
    try {
      const g = await gradeAnswer(rule, q, answer, chosen, s)
      setGrade(g)
      await updateQuizItem(itemId, { answer: answer || (chosen != null ? String(chosen) : ''), grade: g, score: g.score })
      onGraded(g.score)
    } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
  }

  const sendAsk = async () => {
    if (!ask.trim() || !q || !grade) return
    const next = [...chat, { role: 'user' as const, content: ask.trim() }]
    setChat(next); setAsk(''); setBusy(true)
    try {
      const r = await followUp(rule, q, answer, grade, next, s)
      const full = [...next, { role: 'assistant' as const, content: r }]
      setChat(full)
      await updateQuizItem(itemId, { chat: full })
    } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
  }

  if (err) return <Sheet className="p-5"><p className="text-red text-sm">出题失败：{err}</p><p className="text-sm text-ink-soft mt-1">可以点"再来一题"重试，或直接给自己打分。</p></Sheet>
  if (!q) return <Sheet className="p-6"><Spinner label={`正在出一道「${KIND_NAME[kind]}」题…`} /></Sheet>

  const her = s.herName
  return (
    <Sheet className="p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="rounded bg-pen-soft text-pen text-xs px-2 py-0.5">{KIND_NAME[q.kind]}</span>
        <p className="font-medium">{q.prompt}</p>
      </div>

      {q.chat.length > 0 && (
        <div className="rounded-lg bg-paper/70 py-2 mb-4">
          {q.chat.map((c, i) => {
            const pickable = q.kind === 'spot' && !grade && c.speaker === 'me'
            const wrongPick = grade && q.kind === 'spot' && chosen === i && i !== q.spot_index
            return (
              <div key={i} className={cx(pickable && 'cursor-pointer')} onClick={() => pickable && setChosen(i)}>
                <Bubble speaker={c.speaker} name={c.speaker === 'me' ? '我' : her} content={grade && q.kind === 'spot' && i === q.spot_index ? <span className="red-wave">{c.content}</span> : c.content}
                  highlight={q.kind === 'spot' && chosen === i} redNote={wrongPick ? '你选的这句' : grade && q.kind === 'spot' && i === q.spot_index ? '问题在这一句' : undefined} />
              </div>
            )
          })}
          {q.kind === 'spot' && !grade && <p className="text-xs text-ink-faint px-4 pt-1">点一下"我"说的那一句</p>}
        </div>
      )}

      {q.kind === 'choose' && (
        <div className="space-y-2 mb-3">
          {q.options.map((o, i) => {
            const right = grade && i === q.answer_index, wrong = grade && chosen === i && i !== q.answer_index
            return (
              <button key={i} disabled={!!grade} onClick={() => setChosen(i)}
                className={cx('w-full text-left rounded-lg border px-3.5 py-2.5 transition-colors',
                  right ? 'border-ok bg-ok-soft' : wrong ? 'border-red bg-red-soft' : chosen === i ? 'border-pen bg-pen-soft' : 'border-rule hover:border-ink-faint')}>
                <span className="text-ink-faint mr-2">{String.fromCharCode(65 + i)}</span>{o}
                {grade?.option_notes?.[i] && <span className="block red-note !text-[14px] mt-1 !text-ink-soft">{grade.option_notes[i]}</span>}
              </button>
            )
          })}
        </div>
      )}

      {!grade && (
        <>
          <textarea rows={q.kind === 'why' || q.kind === 'rewrite' ? 3 : 2} className={inputCls} value={answer} onChange={(e) => setAnswer(e.target.value)}
            placeholder={q.kind === 'why' ? '她在意的是什么？用自己的话写' : q.kind === 'rewrite' ? '把最后一句我的话改写成……' : '（可选）说说为什么'}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) submit() }} />
          <div className="flex items-center gap-3 mt-3">
            <Button kind="primary" onClick={submit} disabled={busy}>{busy ? '评分中…' : '提交'}</Button>
            <span className="text-xs text-ink-faint">Ctrl+Enter 提交。参考答案在提交后显示</span>
          </div>
        </>
      )}

      {grade && (
        <div className="mt-2 border-t border-dashed border-rule pt-4">
          <div className="flex gap-5">
            <ScoreRing score={grade.score} />
            <div className="flex-1 min-w-0 space-y-2">
              {(q.kind === 'why' || q.kind === 'rewrite') && <p className="text-sm text-ink-soft">你的答案：{answer}</p>}
              {grade.good.map((g, i) => <p key={'g' + i} className="text-sm text-ok">✓ {g}</p>)}
              {grade.problems.map((p, i) => <p key={'p' + i} className="red-note">{p}</p>)}
              {grade.reference && <p className="text-sm"><span className="text-ink-faint">参考：</span><span className="text-pen">{grade.reference}</span></p>}
            </div>
          </div>
          <div className="mt-4">
            {chat.map((c, i) => (
              <p key={i} className={cx('text-sm py-1', c.role === 'assistant' ? 'text-ink' : 'text-ink-soft')}>
                <span className="text-ink-faint mr-1">{c.role === 'user' ? '我：' : '教练：'}</span>{c.content}
              </p>
            ))}
            <div className="flex gap-2 mt-2">
              <div className="relative flex-1">
                <MessageCircle size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
                <input className={cx(inputCls, 'pl-8')} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="继续追问，或写一个你自己的说法让 AI 看看" onKeyDown={(e) => { if (e.key === 'Enter') sendAsk() }} />
              </div>
              <Button onClick={sendAsk} disabled={busy || !ask.trim()}><Send size={14} /></Button>
            </div>
          </div>
        </div>
      )}
    </Sheet>
  )
}
