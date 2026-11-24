// 聊天编辑页（PRD F2）：截图识别和手动录入都落到这里
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { DndContext, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowLeft, ArrowLeftRight, ArrowUpToLine, ClipboardPaste, GripVertical, Image as ImageIcon, Redo2, Star, Trash2, Undo2, Clock } from 'lucide-react'
import { Bubble } from '../components/Bubble'
import { Button, Modal, Severity, confirmDialog, cx, inputCls, promptDialog, toast } from '../components/ui'
import { useSettings } from '../db/base'
import { deleteIncident, getAnalysis, getIncident, listAttachments, listMessages, replaceMessages, updateIncident } from '../db/incidents'
import { parsePasted } from '../domain/text'
import { rawToMessages } from '../lib/sample'
import type { Attachment, Incident, Message, MsgType, Speaker } from '../lib/types'
import { fromLocalInput, toLocalInput, uid } from '../lib/util'

const TYPES: [MsgType, string][] = [['text', '文字'], ['reply', '引用回复'], ['emoji', '表情'], ['image', '图片'], ['link', '分享卡片'], ['voice', '语音']]
const CHANNELS = ['微信', '当面', '电话', 'QQ', '其他']

function newMsg(incidentId: string, speaker: Speaker): Message {
  return { id: uid(), incident_id: incidentId, seq: 0, speaker, content: '', msg_type: 'text', reply_to: '', sent_at: '', is_key: false, confidence: 1, dup_suspect: false, attachment_id: null }
}

export default function Editor() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  const [s] = useSettings()
  const [inc, setInc] = useState<Incident | null>(null)
  const [msgs, setMsgs] = useState<Message[]>([])
  const [atts, setAtts] = useState<Attachment[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [meta, setMeta] = useState<Message | null>(null)
  const [paste, setPaste] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [showShots, setShowShots] = useState(true)
  const [saved, setSaved] = useState(true)
  const undo = useRef<Message[][]>([])
  const redo = useRef<Message[][]>([])
  const loaded = useRef(false)
  const listEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    (async () => {
      const i = await getIncident(id)
      if (!i) { nav('/incidents'); return }
      setInc(i)
      setMsgs(await listMessages(id))
      setAtts(await listAttachments(id))
      loaded.current = true
      if (sp.get('paste')) { setPaste(true); setSp({}, { replace: true }) }
    })()
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 自动保存
  useEffect(() => {
    if (!loaded.current || !inc) return
    setSaved(false)
    const t = setTimeout(async () => {
      await replaceMessages(id, msgs)
      await updateIncident(id, { title: inc.title, occurred_at: inc.occurred_at, channel: inc.channel, background: inc.background, severity: inc.severity }, false)
      setSaved(true)
    }, 600)
    return () => clearTimeout(t)
  }, [msgs, inc, id])

  const commit = useCallback((next: Message[] | ((m: Message[]) => Message[])) => {
    setMsgs((cur) => {
      const n = typeof next === 'function' ? next(cur) : next
      undo.current.push(cur)
      if (undo.current.length > 200) undo.current.shift()
      redo.current = []
      return n
    })
  }, [])
  const patch = (mid: string, p: Partial<Message>) => commit((xs) => xs.map((m) => (m.id === mid ? { ...m, ...p, confidence: 1, dup_suspect: false } : m)))

  const doUndo = () => { const prev = undo.current.pop(); if (prev) { redo.current.push(msgs); setMsgs(prev) } }
  const doRedo = () => { const nx = redo.current.pop(); if (nx) { undo.current.push(msgs); setMsgs(nx) } }
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return
      if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo() }
      if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); doRedo() }
    }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  })

  const add = (speaker: Speaker, after?: string) => {
    const m = newMsg(id, speaker)
    commit((xs) => {
      if (!after) return [...xs, m]
      const i = xs.findIndex((x) => x.id === after)
      return [...xs.slice(0, i + 1), m, ...xs.slice(i + 1)]
    })
    setEditing(m.id)
    if (!after) setTimeout(() => listEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 30)
  }
  const insertAbove = (mid: string, speaker: Speaker) => {
    const m = newMsg(id, speaker)
    commit((xs) => { const i = xs.findIndex((x) => x.id === mid); return [...xs.slice(0, i), m, ...xs.slice(i)] })
    setEditing(m.id)
  }
  const remove = (mid: string) => { commit((xs) => xs.filter((x) => x.id !== mid)); if (editing === mid) setEditing(null) }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const a = msgs.findIndex((m) => m.id === e.active.id), b = msgs.findIndex((m) => m.id === e.over!.id)
    commit(arrayMove(msgs, a, b))
  }

  const doPaste = () => {
    const raw = parsePasted(pasteText, s?.herNick ?? '', s?.myNick ?? '')
    if (!raw.length) { toast('没有拆出消息。请用"昵称：内容"一行一条的格式', 'err'); return }
    commit((xs) => [...xs, ...rawToMessages(id, raw)])
    setPaste(false); setPasteText('')
    toast(`拆出 ${raw.length} 条，请核对说话人`)
  }

  const finish = async () => {
    const empty = msgs.filter((m) => !m.content.trim())
    if (!msgs.length || msgs.length === empty.length) { toast('还没有消息', 'err'); return }
    const flagged = msgs.filter((m) => m.confidence < 0.7 || m.dup_suspect).length
    if (flagged && !(await confirmDialog(`还有 ${flagged} 条标黄的消息（识别不确定或疑似重复）没有核对。\n确认它们都没问题吗？`, '都没问题，继续'))) return
    const final = msgs.filter((m) => m.content.trim()).map((m) => ({ ...m, confidence: 1, dup_suspect: false }))
    let title = inc!.title
    if (!title.trim()) {
      title = (await promptDialog('给这次起个名字，方便以后找', '例如：小红书文件夹那次', false)) ?? ''
      if (!title) title = final.find((m) => m.speaker === 'them')?.content.slice(0, 14) ?? '未命名'
    }
    setMsgs(final)
    await replaceMessages(id, final)
    await updateIncident(id, { ...inc!, title })
    if (await getAnalysis(id)) toast('聊天记录改过了。如果复盘里引用的消息对不上，可以点"重新分析"', 'info')
    nav(`/incident/${id}`)
  }

  if (!inc || !s) return null
  const her = s.herName, flagged = msgs.filter((m) => m.confidence < 0.7 || m.dup_suspect).length

  return (
    <div className="h-full flex flex-col">
      {/* 顶部信息 */}
      <div className="bg-sheet border-b border-rule px-6 py-3 flex items-center gap-3 flex-wrap">
        <button onClick={() => nav(-1)} className="text-ink-soft hover:text-pen" aria-label="返回"><ArrowLeft size={18} /></button>
        <input className="kai text-xl bg-transparent outline-none border-b border-transparent focus:border-pen w-64" placeholder="给这次起个名字" value={inc.title} onChange={(e) => setInc({ ...inc, title: e.target.value })} />
        <input type="datetime-local" className={cx(inputCls, 'w-auto py-1')} value={toLocalInput(inc.occurred_at)} onChange={(e) => setInc({ ...inc, occurred_at: fromLocalInput(e.target.value) })} />
        <select className={cx(inputCls, 'w-auto py-1')} value={inc.channel} onChange={(e) => setInc({ ...inc, channel: e.target.value })}>{CHANNELS.map((c) => <option key={c}>{c}</option>)}</select>
        <span className="flex items-center gap-1.5 text-sm text-ink-soft">严重度 <Severity value={inc.severity} onChange={(v) => setInc({ ...inc, severity: v })} /></span>
        <span className="flex-1" />
        <span className="text-xs text-ink-faint">{saved ? '已自动保存' : '保存中…'}</span>
        <Button size="sm" kind="ghost" onClick={doUndo} title="撤销 Ctrl+Z" disabled={!undo.current.length}><Undo2 size={15} /></Button>
        <Button size="sm" kind="ghost" onClick={doRedo} title="重做 Ctrl+Y" disabled={!redo.current.length}><Redo2 size={15} /></Button>
        <Button size="sm" onClick={() => setPaste(true)}><ClipboardPaste size={14} />粘贴文字</Button>
        {atts.length > 0 && <Button size="sm" onClick={() => setShowShots((v) => !v)}><ImageIcon size={14} />{showShots ? '收起截图' : '对照截图'}</Button>}
        <Button size="sm" kind="danger" onClick={async () => { if (await confirmDialog('删除这张便签和其中所有消息？', '删除', true)) { await deleteIncident(id); nav('/incidents') } }}><Trash2 size={14} /></Button>
      </div>
      <div className="bg-sheet border-b border-rule px-6 pb-2">
        <input className="w-full text-sm bg-transparent outline-none text-ink-soft placeholder:text-ink-faint" placeholder="补充背景（可选），例如：上午她心情就不太好" value={inc.background} onChange={(e) => setInc({ ...inc, background: e.target.value })} />
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 聊天列表 */}
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="max-w-[760px] mx-auto py-4">
            {flagged > 0 && <p className="mx-3 mb-2 rounded-md bg-warn-soft text-warn text-sm px-3 py-2">有 {flagged} 条标黄：识别不确定或疑似重复。点一下气泡核对；改过的会自动取消标黄。</p>}
            {msgs.length === 0 && <p className="text-center text-ink-faint py-16">用下面的"{her}说""我说"开始一条条录入</p>}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={msgs.map((m) => m.id)} strategy={verticalListSortingStrategy}>
                {msgs.map((m) => (
                  <Row key={m.id} m={m} her={her} editing={editing === m.id}
                    onEdit={() => setEditing(m.id)}
                    onDone={(text, next) => {
                      if (text !== m.content) patch(m.id, { content: text })
                      setEditing(null)
                      if (next) add(m.speaker, m.id)
                    }}
                    onSwap={() => patch(m.id, { speaker: m.speaker === 'me' ? 'them' : 'me' })}
                    onKey={() => patch(m.id, { is_key: !m.is_key })}
                    onInsert={() => insertAbove(m.id, m.speaker)}
                    onMeta={() => setMeta(m)}
                    onDelete={() => remove(m.id)} />
                ))}
              </SortableContext>
            </DndContext>
            <div ref={listEnd} className="h-4" />
          </div>
        </div>
        {showShots && atts.length > 0 && (
          <aside className="w-[340px] shrink-0 border-l border-rule bg-sheet overflow-auto p-3 space-y-3">
            {atts.map((a, i) => <figure key={a.id}><figcaption className="text-xs text-ink-faint mb-1">第 {i + 1} 张</figcaption><img src={a.data_url} alt={`截图 ${i + 1}`} className="w-full rounded border border-rule" /></figure>)}
          </aside>
        )}
      </div>

      {/* 底部两个大按钮 */}
      <div className="bg-sheet border-t border-rule px-6 py-3 flex items-center gap-3">
        <Button size="lg" className="flex-1 max-w-[240px] border-[#d9d9d9]" onClick={() => add('them')}>＋ {her}说</Button>
        <Button size="lg" className="flex-1 max-w-[240px] !bg-me !border-me text-[#111] hover:brightness-95" onClick={() => add('me')}>＋ 我说</Button>
        <span className="text-xs text-ink-faint">Enter 保存，Ctrl+Enter 保存并接着写同一边，Esc 取消</span>
        <span className="flex-1" />
        <span className="text-sm text-ink-soft">{msgs.length} 条</span>
        <Button size="lg" kind="primary" onClick={finish}>完成，开始复盘</Button>
      </div>

      <Modal open={paste} onClose={() => setPaste(false)} title="粘贴聊天文字" wide
        footer={<><Button onClick={() => setPaste(false)}>取消</Button><Button kind="primary" onClick={doPaste}>拆成消息</Button></>}>
        <p className="text-sm text-ink-soft mb-2">支持两种格式。昵称要和设置里的一致（{s.herNick || '未设置'} / {s.myNick || '未设置'}），也可以直接写"她""我"。</p>
        <pre className="text-xs bg-paper rounded p-2 mb-2 text-ink-soft">{`${s.herNick || '她'}：好具象的爱啊\n${s.myNick || '我'}：阿巴阿巴\n\n或者电脑微信复制出来的：\n${s.herNick || '她'} 2026年11月22日 13:02\n你的态度`}</pre>
        <textarea autoFocus rows={10} className={inputCls} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
      </Modal>

      <Modal open={!!meta} onClose={() => setMeta(null)} title="这条消息的详细信息"
        footer={<Button kind="primary" onClick={() => { if (meta) patch(meta.id, { sent_at: meta.sent_at, msg_type: meta.msg_type, reply_to: meta.reply_to }); setMeta(null) }}>保存</Button>}>
        {meta && (
          <div className="space-y-3">
            <label className="block"><span className="text-sm text-ink-soft">时间（原样填写，如 13:02）</span><input className={inputCls} value={meta.sent_at} onChange={(e) => setMeta({ ...meta, sent_at: e.target.value })} /></label>
            <label className="block"><span className="text-sm text-ink-soft">类型</span><select className={inputCls} value={meta.msg_type} onChange={(e) => setMeta({ ...meta, msg_type: e.target.value as MsgType })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="block"><span className="text-sm text-ink-soft">引用了哪条（可选）</span><input className={inputCls} value={meta.reply_to} onChange={(e) => setMeta({ ...meta, reply_to: e.target.value })} placeholder="例如 柒: 阿巴阿巴" /></label>
          </div>
        )}
      </Modal>
    </div>
  )
}

function Row(p: {
  m: Message; her: string; editing: boolean
  onEdit: () => void; onDone: (text: string, next: boolean) => void
  onSwap: () => void; onKey: () => void; onInsert: () => void; onMeta: () => void; onDelete: () => void
}) {
  const { m } = p
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: m.id })
  const [text, setText] = useState(m.content)
  useEffect(() => { if (p.editing) setText(m.content) }, [p.editing, m.content])
  const me = m.speaker === 'me'
  const tool = 'p-1 rounded hover:bg-pen-soft hover:text-pen'
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cx('relative', isDragging && 'z-10 opacity-80')}>
      <Bubble speaker={m.speaker} name={me ? '我' : p.her} msgType={m.msg_type} replyTo={m.reply_to} time={m.sent_at} isKey={m.is_key}
        lowConfidence={m.confidence < 0.7} dupSuspect={m.dup_suspect}
        content={p.editing ? (
          <textarea autoFocus rows={Math.min(6, Math.max(1, Math.ceil(text.length / 26)))} value={text}
            className="w-[min(420px,60vw)] bg-transparent outline-none resize-none" onClick={(e) => e.stopPropagation()}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => p.onDone(text, false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); p.onDone(text, e.ctrlKey) }
              if (e.key === 'Escape') { e.preventDefault(); p.onDone(m.content, false) }
            }} />
        ) : (m.content || <span className="text-ink-faint">（空）</span>)}
        onClick={p.editing ? undefined : p.onEdit}>
        <div className={cx('absolute top-6 flex items-center gap-0.5 bg-sheet border border-rule rounded-md px-1 py-0.5 text-ink-soft opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity',
          me ? 'left-14' : 'right-14')} onClick={(e) => e.stopPropagation()}>
          <button className={cx(tool, 'cursor-grab')} {...attributes} {...listeners} aria-label="拖动排序" title="拖动排序"><GripVertical size={14} /></button>
          <button className={tool} onClick={p.onSwap} title="对调说话人"><ArrowLeftRight size={14} /></button>
          <button className={tool} onClick={p.onInsert} title="在上方插入"><ArrowUpToLine size={14} /></button>
          <button className={cx(tool, m.is_key && 'text-red')} onClick={p.onKey} title="标为关键句"><Star size={14} /></button>
          <button className={tool} onClick={p.onMeta} title="时间、类型、引用"><Clock size={14} /></button>
          <button className={cx(tool, 'hover:!text-red hover:!bg-red-soft')} onClick={p.onDelete} title="删除"><Trash2 size={14} /></button>
        </div>
      </Bubble>
    </div>
  )
}
