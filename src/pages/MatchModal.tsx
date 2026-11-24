// 归入知识库（PRD F4.1）：AI 建议归入已有知识点或新建，我逐条确认。AI 不能自动改知识库。
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Chip, Modal, Spinner, cx, errText, inputCls, toast } from '../components/ui'
import { addEvidence, createRule, listRules, listTags, recordRecurrence } from '../db/rules'
import { updateIncident } from '../db/incidents'
import { matchRules, type MatchDecision } from '../ai/tasks'
import type { AnalysisData, Incident, Message, Rule } from '../lib/types'

type Item = MatchDecision & { on: boolean }

export default function MatchModal({ open, onClose, incident, analysis, msgs, myOwnWords, onDone }: {
  open: boolean; onClose: () => void; incident: Incident; analysis: AnalysisData; msgs: Message[]; myOwnWords: string; onDone: () => Promise<void>
}) {
  const nav = useNavigate()
  const [items, setItems] = useState<Item[] | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open) return
    setItems(null); setErr('')
    ;(async () => {
      const rs = (await listRules()).filter((r) => r.status !== 'archived')
      setRules(rs)
      setTags((await listTags()).map((t) => t.name))
      try {
        const d = await matchRules(incident, analysis, msgs)
        setItems(d.map((x) => ({ ...x, on: true })))
      } catch (e) { setErr(errText(e)); setItems([]) }
    })()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const upd = (i: number, p: Partial<Item>) => setItems((xs) => xs!.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const ruleById = new Map(rules.map((r) => [r.id, r]))

  const apply = async () => {
    if (!items) return
    setBusy(true)
    try {
      const at = incident.occurred_at ?? Date.now()
      const myMsg = (mid: string) => msgs.find((m) => m.id === mid)
      const addEv = async (ruleId: string) => {
        for (const h of analysis.her_words) await addEvidence(ruleId, incident.id, 'her_words', h.quote, h.msg || null)
        for (const x of analysis.misses) if (x.msg) await addEvidence(ruleId, incident.id, 'my_bad', myMsg(x.msg)?.content ?? '', x.msg)
      }
      let created = 0, attached = 0
      for (const it of items.filter((x) => x.on)) {
        if (it.action === 'create') {
          if (!it.title.trim()) continue
          const rid = await createRule({ title: it.title.trim(), trigger_scene: it.trigger_scene, good_example: it.good_example, bad_example: it.bad_example, my_own_words: myOwnWords, tags: it.tags.filter((t) => tags.includes(t)) }, at)
          await addEv(rid)
          created++
        } else if (await recordRecurrence(it.rule_id, incident.id, at)) {
          await addEv(it.rule_id)
          attached++
        }
      }
      if (attached && !incident.tags.includes('重复踩坑')) await updateIncident(incident.id, { tags: [...incident.tags, '重复踩坑'].slice(0, 5) })
      await onDone()
      toast(created || attached ? `新建 ${created} 个知识点，归入已有 ${attached} 个${attached ? '（已回到短间隔复习）' : ''}` : '没有改动知识库')
      onClose()
      if (created || attached) nav('/rules')
    } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="归入知识库" wide
      footer={<>
        <Button onClick={async () => { await onDone(); onClose() }}>这次不归入</Button>
        <Button kind="primary" disabled={busy || !items} onClick={apply}>{busy ? '保存中…' : '确认'}</Button>
      </>}>
      {!items ? <Spinner label="AI 正在对照已有知识点…" /> : (
        <div className="space-y-3">
          {err && <p className="text-sm text-red">AI 没能给出建议：{err}。可以手动添加。</p>}
          <p className="text-sm text-ink-soft">知识点是可以反复用的一条经验，复习时按知识点出题。每条建议可以修改或取消勾选。</p>
          {items.map((it, i) => (
            <div key={i} className={cx('rounded-lg border p-3', it.on ? 'border-pen/40 bg-pen-soft/30' : 'border-rule opacity-60')}>
              <div className="flex items-center gap-2 mb-2">
                <input type="checkbox" checked={it.on} onChange={(e) => upd(i, { on: e.target.checked })} />
                <select className={cx(inputCls, 'w-auto py-1')} value={it.action === 'attach' ? it.rule_id : '__new'}
                  onChange={(e) => upd(i, e.target.value === '__new' ? { action: 'create' } : { action: 'attach', rule_id: e.target.value })}>
                  <option value="__new">新建知识点</option>
                  {rules.map((r) => <option key={r.id} value={r.id}>归入：{r.title}</option>)}
                </select>
                {it.action === 'attach' && <Chip tone="red">再次发生，复习会回到短间隔</Chip>}
              </div>
              {it.reason && <p className="text-xs text-ink-soft mb-2">AI 的理由：{it.reason}</p>}
              {it.action === 'create' ? (
                <div className="grid grid-cols-2 gap-2">
                  <label className="col-span-2 text-sm">规则（一句话，写成能照着做的动作）<input className={inputCls} value={it.title} onChange={(e) => upd(i, { title: e.target.value })} /></label>
                  <label className="text-sm">什么时候用得上<input className={inputCls} value={it.trigger_scene} onChange={(e) => upd(i, { trigger_scene: e.target.value })} /></label>
                  <label className="text-sm">参考说法<input className={inputCls} value={it.good_example} onChange={(e) => upd(i, { good_example: e.target.value })} /></label>
                  <label className="col-span-2 text-sm">我这次的反例<input className={inputCls} value={it.bad_example} onChange={(e) => upd(i, { bad_example: e.target.value })} /></label>
                  <div className="col-span-2 flex flex-wrap gap-1.5">
                    {tags.map((t) => <Chip key={t} active={it.tags.includes(t)} onClick={() => upd(i, { tags: it.tags.includes(t) ? it.tags.filter((x) => x !== t) : [...it.tags, t] })}>{t}</Chip>)}
                  </div>
                </div>
              ) : (
                <p className="text-sm">{ruleById.get(it.rule_id)?.trigger_scene}</p>
              )}
            </div>
          ))}
          <Button size="sm" onClick={() => setItems((xs) => [...(xs ?? []), { action: 'create', rule_id: '', reason: '', title: '', trigger_scene: '', good_example: analysis.next_time[0]?.say ?? '', bad_example: '', tags: analysis.tags, on: true }])}>＋ 再加一条</Button>
        </div>
      )}
    </Modal>
  )
}
