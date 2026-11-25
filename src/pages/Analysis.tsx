// 复盘页（PRD F3）：左边聊天记录 + 红笔批注，右边复盘区块
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil, Plus, Sparkles, Trash2, Eye, EyeOff } from 'lucide-react'
import { Bubble } from '../components/Bubble'
import { Button, Chip, Severity, Sheet, Spinner, confirmDialog, cx, errText, inputCls, toast } from '../components/ui'
import { useSettings } from '../db/base'
import { emptyAnalysis, getAnalysis, getIncident, listMessages, saveAnalysis, updateIncident } from '../db/incidents'
import { addTag, listTags } from '../db/rules'
import { createCommitment } from '../db/misc'
import { analyzeIncident } from '../ai/tasks'
import { profileFor } from '../ai/client'
import { isPreview } from '../lib/api'
import type { AnalysisData, Incident, Message } from '../lib/types'
import { fmtDateTime, fromLocalInput, toLocalInput } from '../lib/util'
import MatchModal from './MatchModal'

export default function AnalysisPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const [s] = useSettings()
  const [inc, setInc] = useState<Incident | null>(null)
  const [msgs, setMsgs] = useState<Message[]>([])
  const [a, setA] = useState<AnalysisData | null>(null)
  const [mine, setMine] = useState('')
  const [profileName, setProfileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [hl, setHl] = useState<string | null>(null)
  const [tagLib, setTagLib] = useState<string[]>([])
  const [showFeel, setShowFeel] = useState(false)
  const [matchOpen, setMatchOpen] = useState(false)

  useEffect(() => {
    (async () => {
      const i = await getIncident(id)
      if (!i) { nav('/incidents'); return }
      setInc(i)
      setMsgs(await listMessages(id))
      const an = await getAnalysis(id)
      if (an) { setA(an.data); setMine(an.my_own_words); setProfileName(an.profile_name) }
      setTagLib((await listTags()).map((t) => t.name))
    })()
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(msgs.map((m, i) => [m.id, { m, i }])), [msgs])
  const missBy = useMemo(() => new Map((a?.misses ?? []).filter((x) => x.msg).map((x) => [x.msg, x.problem])), [a])
  const herBy = useMemo(() => new Set((a?.her_words ?? []).map((x) => x.msg)), [a])

  const set = (p: Partial<AnalysisData>) => { setA((x) => ({ ...(x ?? emptyAnalysis()), ...p })); setDirty(true) }

  const run = async () => {
    if (!inc) return
    if (a && !(await confirmDialog('重新分析会覆盖右边的内容（"我自己写的"会保留）。继续吗？', '重新分析'))) return
    setBusy(true)
    try {
      const p = await profileFor('analyze')
      const out = await analyzeIncident(inc, msgs)
      setA(out); setDirty(true)
      setProfileName(!isPreview ? p?.name ?? '' : '预览模拟')
      if (out.dropped_quotes?.length) toast(`有 ${out.dropped_quotes.length} 条"原话"在聊天里找不到，已丢弃`, 'info')
    } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
  }

  const jump = (mid: string) => {
    setHl(mid)
    document.getElementById('msg-' + mid)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => setHl((x) => (x === mid ? null : x)), 1800)
  }

  const save = async () => {
    if (!a || !inc) return
    if (!mine.trim()) { toast('"下次怎么做"最后一句请自己写，这一栏是必填的', 'err'); document.getElementById('mine')?.focus(); return }
    for (const t of a.new_tags) if (a.tags.includes(t) && !tagLib.includes(t)) await addTag(t)
    const commitments = []
    for (const c of a.commitments) {
      if (c.picked && !c.created_id && c.content.trim()) {
        const cid = await createCommitment({ content: c.content.trim(), promised_at: inc.occurred_at, due_at: c.due_at ?? null, incident_id: id })
        commitments.push({ ...c, created_id: cid })
      } else commitments.push(c)
    }
    const data = { ...a, commitments }
    await saveAnalysis(id, data, mine.trim(), profileName)
    await updateIncident(id, { status: 'reviewed', tags: a.tags, severity: a.severity })
    setA(data); setDirty(false)
    setInc({ ...inc, status: 'reviewed', tags: a.tags, severity: a.severity })
    toast('复盘已保存')
    if (!a.matched) setMatchOpen(true)
  }

  if (!inc || !s) return null
  const her = s.herName
  const nameOf = (mid: string) => { const x = byId.get(mid); return x ? `第 ${x.i + 1} 条` : '' }

  return (
    <div className="h-full flex flex-col">
      <div className="bg-sheet border-b border-rule px-6 py-3 flex items-center gap-3">
        <button onClick={() => nav('/incidents')} className="text-ink-soft hover:text-pen" aria-label="返回"><ArrowLeft size={18} /></button>
        <h1 className="kai text-xl">{inc.title || '未命名'}</h1>
        <span className="text-sm text-ink-faint">{fmtDateTime(inc.occurred_at)}</span>
        <span className="text-sm text-ink-faint">{inc.channel}</span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => nav(`/incident/${id}/edit`)}><Pencil size={14} />编辑聊天记录</Button>
        {a && <Button size="sm" onClick={run} disabled={busy}><Sparkles size={14} />重新分析</Button>}
        {a && inc.status === 'reviewed' && <Button size="sm" onClick={() => setMatchOpen(true)}>归入知识库</Button>}
        {a && <Button size="sm" kind="primary" onClick={save} disabled={busy}>{dirty || inc.status !== 'reviewed' ? '保存复盘' : '已保存'}</Button>}
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[minmax(380px,1fr)_minmax(420px,1.05fr)]">
        <div className="overflow-auto border-r border-rule">
          <div className="max-w-[640px] mx-auto py-4">
            {inc.background && <p className="mx-3 mb-3 text-sm text-ink-soft">背景：{inc.background}</p>}
            {msgs.map((m) => (
              <Bubble key={m.id} id={'msg-' + m.id} speaker={m.speaker} name={m.speaker === 'me' ? '我' : her} msgType={m.msg_type} replyTo={m.reply_to}
                time={m.sent_at} isKey={m.is_key || herBy.has(m.id)} highlight={hl === m.id}
                content={missBy.has(m.id) ? <span className="red-wave">{m.content}</span> : m.content}
                redNote={missBy.get(m.id)} />
            ))}
          </div>
        </div>

        <div className="overflow-auto">
          {!a ? (
            <div className="p-8">
              <Sheet className="p-6 text-center">
                <p className="kai text-xl mb-2">还没有复盘</p>
                <p className="text-sm text-ink-soft mb-4">AI 会先给一份草稿：她明确说了什么、我哪里没接住、下次怎么做。你再改。</p>
                {busy ? <Spinner label="正在分析，通常要 20 秒到 1 分钟…" /> : (
                  <div className="flex justify-center gap-2">
                    <Button kind="primary" onClick={run}><Sparkles size={15} />AI 复盘</Button>
                    <Button onClick={() => { setA(emptyAnalysis()); setDirty(true) }}>自己写</Button>
                  </div>
                )}
              </Sheet>
            </div>
          ) : (
            <div className="p-5 space-y-4 max-w-[720px]">
              {busy && <Spinner label="正在重新分析…" />}
              <Block title="一句话概括">
                <textarea rows={2} className={inputCls} value={a.summary} onChange={(e) => set({ summary: e.target.value })} />
              </Block>

              <Block title={`${her}明确说的`} hint="只收她的原话。点引用跳到聊天里对应的那条">
                {a.her_words.map((h, i) => (
                  <div key={i} className="flex items-start gap-2 py-1 group">
                    <button className="kai text-[16px] text-left flex-1 hover:text-pen" onClick={() => h.msg && jump(h.msg)}>
                      <span className="marker">「{h.quote}」</span>
                      <span className="text-xs text-ink-faint ml-2 font-sans">{nameOf(h.msg)}</span>
                    </button>
                    <Del onClick={() => set({ her_words: a.her_words.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                {!!a.dropped_quotes?.length && <p className="text-xs text-warn mt-1">已丢弃 AI 给出但聊天里找不到的：{a.dropped_quotes.map((x) => `「${x}」`).join('')}</p>}
              </Block>

              <Block title="AI 的推测" hint="不是她说的，仅供参考">
                {a.inferences.map((x, i) => (
                  <Line key={i} value={x} muted onChange={(v) => set({ inferences: a.inferences.map((y, j) => (j === i ? v : y)) })} onDelete={() => set({ inferences: a.inferences.filter((_, j) => j !== i) })} />
                ))}
                <AddBtn onClick={() => set({ inferences: [...a.inferences, ''] })} />
              </Block>

              <Block title="我哪里没接住" red>
                {a.misses.map((x, i) => (
                  <div key={i} className="flex items-start gap-2 py-1">
                    <button className="shrink-0 text-xs text-ink-faint w-14 text-left pt-1.5 hover:text-pen" onClick={() => x.msg && jump(x.msg)}>{nameOf(x.msg) || '—'}</button>
                    <div className="flex-1 min-w-0">
                      {x.msg && <p className="text-sm text-ink-soft truncate">我：{byId.get(x.msg)?.m.content}</p>}
                      <input className={cx(inputCls, 'red-note !text-[15px]')} value={x.problem} onChange={(e) => set({ misses: a.misses.map((y, j) => (j === i ? { ...y, problem: e.target.value } : y)) })} />
                    </div>
                    <Del onClick={() => set({ misses: a.misses.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                <AddBtn onClick={() => set({ misses: [...a.misses, { msg: '', problem: '' }] })} />
              </Block>

              <Block title="下次怎么做">
                {a.next_time.map((x, i) => (
                  <div key={i} className="py-1.5 flex gap-2">
                    <div className="flex-1 space-y-1">
                      <input className={inputCls} value={x.action} placeholder="具体动作" onChange={(e) => set({ next_time: a.next_time.map((y, j) => (j === i ? { ...y, action: e.target.value } : y)) })} />
                      <input className={cx(inputCls, 'text-pen')} value={x.say} placeholder="一句可以直接说出口的话" onChange={(e) => set({ next_time: a.next_time.map((y, j) => (j === i ? { ...y, say: e.target.value } : y)) })} />
                    </div>
                    <Del onClick={() => set({ next_time: a.next_time.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                <AddBtn onClick={() => set({ next_time: [...a.next_time, { action: '', say: '' }] })} />
                <label className="block mt-3">
                  <span className="text-sm font-medium">我自己写的一句 <span className="text-red">*</span></span>
                  <span className="block text-xs text-ink-faint mb-1">用自己的话写下次要怎么做。上面是 AI 的参考，这一句必须是你的。</span>
                  <textarea id="mine" rows={2} className={inputCls} value={mine} onChange={(e) => { setMine(e.target.value); setDirty(true) }} />
                </label>
              </Block>

              <Block title="这次答应她的事" hint="勾选的会在保存时加入承诺清单">
                {a.commitments.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 py-1">
                    <input type="checkbox" disabled={!!c.created_id} checked={!!c.picked || !!c.created_id} onChange={(e) => set({ commitments: a.commitments.map((y, j) => (j === i ? { ...y, picked: e.target.checked } : y)) })} />
                    <input className={cx(inputCls, 'flex-1')} value={c.content} disabled={!!c.created_id} onChange={(e) => set({ commitments: a.commitments.map((y, j) => (j === i ? { ...y, content: e.target.value } : y)) })} />
                    <input type="datetime-local" className={cx(inputCls, 'w-auto')} disabled={!!c.created_id} value={toLocalInput(c.due_at)} onChange={(e) => set({ commitments: a.commitments.map((y, j) => (j === i ? { ...y, due_at: fromLocalInput(e.target.value) } : y)) })} />
                    {c.created_id ? <Chip tone="ok">已加入</Chip> : <Del onClick={() => set({ commitments: a.commitments.filter((_, j) => j !== i) })} />}
                  </div>
                ))}
                {a.commitments.some((c) => c.due_hint && !c.due_at && !c.created_id) && <p className="text-xs text-warn">有承诺没认出截止时间（原话："{a.commitments.find((c) => c.due_hint && !c.due_at)?.due_hint}"），请手动选一个。</p>}
                <AddBtn onClick={() => set({ commitments: [...a.commitments, { content: '', due_hint: '', picked: true, due_at: null }] })} />
              </Block>

              <Block title="标签和严重度">
                <div className="flex flex-wrap gap-1.5">
                  {[...new Set([...tagLib, ...a.new_tags])].map((t) => (
                    <Chip key={t} tone={a.new_tags.includes(t) && !tagLib.includes(t) ? 'warn' : 'pen'} active={a.tags.includes(t)}
                      onClick={() => set({ tags: a.tags.includes(t) ? a.tags.filter((x) => x !== t) : [...a.tags, t].slice(-4) })}>
                      {t}{a.new_tags.includes(t) && !tagLib.includes(t) ? '（新）' : ''}
                    </Chip>
                  ))}
                </div>
                <p className="text-xs text-ink-faint mt-1.5">最多选 4 个。标"新"的是 AI 建议的新标签，选中并保存后才会加入标签库。</p>
                <div className="flex items-center gap-2 mt-3 text-sm">严重度 <Severity value={a.severity} onChange={(v) => set({ severity: v })} /></div>
              </Block>

              <Sheet className="p-4">
                <button className="flex items-center gap-2 text-sm text-ink-soft" onClick={() => setShowFeel((v) => !v)}>
                  {showFeel ? <EyeOff size={15} /> : <Eye size={15} />}我的感受（只给自己看，不参与出题，默认收起）
                </button>
                {showFeel && <textarea rows={3} className={cx(inputCls, 'mt-2')} value={inc.my_feelings} onChange={(e) => { setInc({ ...inc, my_feelings: e.target.value }); updateIncident(id, { my_feelings: e.target.value }, false) }} />}
              </Sheet>
              {profileName && <p className="text-xs text-ink-faint">草稿由「{profileName}」生成</p>}
            </div>
          )}
        </div>
      </div>
      {a && <MatchModal open={matchOpen} onClose={() => setMatchOpen(false)} incident={inc} analysis={a} msgs={msgs} myOwnWords={mine}
        onDone={async () => { const d = { ...a, matched: true }; setA(d); await saveAnalysis(id, d, mine.trim(), profileName) }} />}
    </div>
  )
}

function Block({ title, hint, children, red }: { title: string; hint?: string; children: ReactNode; red?: boolean }) {
  return (
    <Sheet className="p-4">
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className={cx('font-semibold text-[15px]', red && 'text-red')}>{title}</h3>
        {hint && <span className="text-xs text-ink-faint">{hint}</span>}
      </div>
      {children}
    </Sheet>
  )
}
function Del({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="shrink-0 p-1.5 text-ink-faint hover:text-red" aria-label="删除"><Trash2 size={14} /></button>
}
function AddBtn({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="mt-1 text-sm text-ink-faint hover:text-pen inline-flex items-center gap-1"><Plus size={14} />添加</button>
}
function Line({ value, onChange, onDelete, muted }: { value: string; onChange: (v: string) => void; onDelete: () => void; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <input className={cx(inputCls, muted && 'text-ink-soft bg-paper/60')} value={value} onChange={(e) => onChange(e.target.value)} />
      <Del onClick={onDelete} />
    </div>
  )
}
