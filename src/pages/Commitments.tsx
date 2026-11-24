// 承诺清单（PRD F11）
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Check, Plus, Trash2 } from 'lucide-react'
import { Page } from '../components/Page'
import { Button, Chip, Empty, Field, Modal, Sheet, confirmDialog, cx, inputCls, promptDialog, toast } from '../components/ui'
import { useLoad } from '../db/base'
import { createIncident, listIncidents, replaceMessages } from '../db/incidents'
import { createCommitment, deleteCommitment, listCommitments, updateCommitment } from '../db/misc'
import type { Commitment } from '../lib/types'
import { fmtDateTime, fromLocalInput, relDays, toLocalInput, uid } from '../lib/util'

export default function Commitments() {
  const nav = useNavigate()
  const [edit, setEdit] = useState<Partial<Commitment> | null>(null)
  const [data] = useLoad(async () => {
    const [cs, incs] = await Promise.all([listCommitments(), listIncidents()])
    return { cs, incs: new Map(incs.map((i) => [i.id, i.title || '未命名'])) }
  })
  if (!data) return null
  const now = Date.now()
  const open = data.cs.filter((c) => c.status === 'open' && (!c.due_at || c.due_at >= now))
  const late = data.cs.filter((c) => c.status === 'open' && c.due_at && c.due_at < now)
  const done = data.cs.filter((c) => c.status !== 'open')

  const finish = async (c: Commitment) => {
    const note = await promptDialog(`「${c.content}」做完了。\n简单记一下做了什么（可选）`, '例如：知识库应用做好了，发了截图给她', false)
    if (note === null) return
    const told = await confirmDialog('告诉她了吗？说到做到，也要让她知道。\n没告诉的话，首页会一直提醒。', '已经告诉了')
    await updateCommitment(c.id, { status: 'done', done_note: note, told_her: told })
    toast(told ? '已完成' : '已完成。记得告诉她')
  }
  const cancel = async (c: Commitment) => {
    const reason = await promptDialog('取消这个承诺的原因（必填）。\n取消之前，最好先和她说一声。', '例如：和她商量后改成别的方式')
    if (!reason) return
    await updateCommitment(c.id, { status: 'cancelled', cancel_reason: reason })
  }
  /** 逾期 → 生成一条"说到没做到"的便签草稿（PRD F11.5） */
  const logOverdue = async (c: Commitment) => {
    const id = await createIncident({ title: `没做到：${c.content.slice(0, 16)}`, background: `承诺「${c.content}」截止 ${fmtDateTime(c.due_at)}，到期没有完成。`, tags: ['说到没做到'], severity: 3 })
    await replaceMessages(id, [{ id: uid(), incident_id: id, seq: 0, speaker: 'me', content: `（我答应过）${c.content}`, msg_type: 'text', reply_to: '', sent_at: '', is_key: true, confidence: 1, dup_suspect: false, attachment_id: null }])
    await updateCommitment(c.id, { overdue_logged: true })
    nav(`/incident/${id}/edit`)
  }

  const Row = ({ c }: { c: Commitment }) => {
    const isLate = c.status === 'open' && c.due_at && c.due_at < now
    return (
      <div className="px-4 py-3 border-b border-rule last:border-0">
        <div className="flex items-center gap-3">
          <p className={cx('flex-1', c.status === 'cancelled' && 'line-through text-ink-faint')}>{c.content}</p>
          {c.due_at && c.status === 'open' && <span className={cx('text-sm', isLate ? 'text-red' : 'text-ink-faint')}>{relDays(c.due_at, now)}</span>}
          {c.status === 'open' && <>
            <Button size="sm" onClick={() => finish(c)}><Check size={14} />做完了</Button>
            <Button size="sm" kind="ghost" onClick={() => setEdit(c)}>改</Button>
            <Button size="sm" kind="ghost" onClick={() => cancel(c)}>取消</Button>
          </>}
          {c.status === 'done' && (c.told_her ? <Chip tone="ok">已告诉她</Chip> : <Button size="sm" onClick={() => updateCommitment(c.id, { told_her: true })}>已告诉她</Button>)}
          {c.status !== 'open' && <button className="text-ink-faint hover:text-red p-1" aria-label="删除" onClick={async () => { if (await confirmDialog('删除这条记录？', '删除', true)) deleteCommitment(c.id) }}><Trash2 size={14} /></button>}
        </div>
        <div className="flex gap-3 text-xs text-ink-faint mt-0.5">
          {c.promised_at && <span>答应于 {fmtDateTime(c.promised_at)}</span>}
          {c.due_at && <span>截止 {fmtDateTime(c.due_at)}</span>}
          {c.incident_id && data.incs.has(c.incident_id) && <Link className="hover:text-pen" to={`/incident/${c.incident_id}`}>来自「{data.incs.get(c.incident_id)}」</Link>}
          {c.done_note && <span>完成：{c.done_note}</span>}
          {c.cancel_reason && <span>取消原因：{c.cancel_reason}</span>}
        </div>
        {isLate && !c.overdue_logged && (
          <div className="mt-2 rounded-md bg-red-soft px-3 py-2 text-sm flex items-center gap-3">
            <span className="flex-1 text-red">到期没完成。要不要记一次"说到没做到"？</span>
            <Button size="sm" onClick={() => logOverdue(c)}>记一次</Button>
            <Button size="sm" kind="ghost" onClick={() => updateCommitment(c.id, { overdue_logged: true })}>不用</Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <Page narrow title="答应她的事" actions={<Button kind="primary" onClick={() => setEdit({ content: '', promised_at: now, due_at: null })}><Plus size={15} />新承诺</Button>}>
      {data.cs.length === 0 ? <Empty title="还没有承诺">复盘时 AI 识别出的承诺，确认后会出现在这里。也可以手动添加。到期前 24 小时、1 小时和到期时会提醒你。</Empty> : (
        <div className="space-y-5">
          {late.length > 0 && <section><h2 className="red-note text-lg mb-1.5">已逾期</h2><Sheet className="border-red/40">{late.map((c) => <Row key={c.id} c={c} />)}</Sheet></section>}
          <section><h2 className="font-semibold mb-1.5">进行中</h2><Sheet>{open.length ? open.map((c) => <Row key={c.id} c={c} />) : <p className="p-4 text-sm text-ink-faint">没有</p>}</Sheet></section>
          {done.length > 0 && <section><h2 className="font-semibold mb-1.5 text-ink-soft">已结束</h2><Sheet>{done.map((c) => <Row key={c.id} c={c} />)}</Sheet></section>}
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? '修改承诺' : '新承诺'}
        footer={<><Button onClick={() => setEdit(null)}>取消</Button><Button kind="primary" disabled={!edit?.content?.trim()} onClick={async () => {
          if (!edit) return
          if (edit.id) await updateCommitment(edit.id, { content: edit.content, due_at: edit.due_at ?? null, overdue_logged: false })
          else await createCommitment({ content: edit.content!.trim(), promised_at: edit.promised_at, due_at: edit.due_at ?? null })
          setEdit(null)
        }}>保存</Button></>}>
        {edit && (
          <div className="space-y-3">
            <Field label="答应了什么（必填）"><input autoFocus placeholder="例如：这周把知识库做出来" className={inputCls} value={edit.content ?? ''} onChange={(e) => setEdit({ ...edit, content: e.target.value })} /></Field>
            <Field label="截止时间" hint="改截止时间也是一种承诺，记得告诉她新的时间"><input type="datetime-local" className={inputCls} value={toLocalInput(edit.due_at)} onChange={(e) => setEdit({ ...edit, due_at: fromLocalInput(e.target.value) })} /></Field>
          </div>
        )}
      </Modal>
    </Page>
  )
}
