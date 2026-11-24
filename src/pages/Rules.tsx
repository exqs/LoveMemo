// 知识库（PRD F4）：列表 + 详情
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Archive, ArrowLeft, Merge, Plus, Repeat2, Trash2 } from 'lucide-react'
import { Page, SectionTitle } from '../components/Page'
import { Button, Chip, Empty, Field, Mastery, Modal, Sheet, confirmDialog, cx, inputCls, toast } from '../components/ui'
import { useLoad } from '../db/base'
import { listIncidents } from '../db/incidents'
import { createRule, deleteRule, getCard, getRule, listCards, listEvidence, listLogs, listRules, listTags, mergeRules, updateRule } from '../db/rules'
import { RATING_LABEL, masteryLevel } from '../domain/srs'
import type { Rule } from '../lib/types'
import { fmtDate, fmtDateTime, relDays } from '../lib/util'

const STATUS: Record<string, string> = { active: '练习中', internalized: '已内化', archived: '已归档' }

export default function Rules() {
  const nav = useNavigate()
  const [filter, setFilter] = useState<'active' | 'internalized' | 'archived' | ''>('')
  const [tag, setTag] = useState('')
  const [creating, setCreating] = useState(false)
  const [data] = useLoad(async () => {
    const [rules, cards] = await Promise.all([listRules(), listCards()])
    return { rules, cards: new Map(cards.map((c) => [c.rule_id, c])) }
  })
  if (!data) return null
  const now = Date.now()
  const tags = [...new Set(data.rules.flatMap((r) => r.tags))]
  const list = data.rules
    .filter((r) => (filter ? r.status === filter : r.status !== 'archived') && (!tag || r.tags.includes(tag)))
    .sort((a, b) => (data.cards.get(a.id)?.due ?? 0) - (data.cards.get(b.id)?.due ?? 0))

  return (
    <Page title="知识库" actions={<Button onClick={() => setCreating(true)}><Plus size={15} />手动新建</Button>}>
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {(['', 'active', 'internalized', 'archived'] as const).map((s) => <Chip key={s} active={filter === s} onClick={() => setFilter(s)}>{s ? STATUS[s] : '全部（不含归档）'}</Chip>)}
        <span className="w-3" />
        {tags.map((t) => <Chip key={t} tone="red" active={tag === t} onClick={() => setTag(tag === t ? '' : t)}>{t}</Chip>)}
      </div>
      {data.rules.length === 0 ? (
        <Empty title="知识库还是空的" action={<Button kind="primary" onClick={() => nav('/new')}>记一次</Button>}>复盘一次争吵后，AI 会建议新建知识点，确认后出现在这里，并开始按记忆曲线安排复习。</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 max-[1000px]:grid-cols-1">
          {list.map((r) => {
            const c = data.cards.get(r.id)
            return (
              <Link key={r.id} to={`/rule/${r.id}`}>
                <Sheet className="p-4 hover:border-ink-faint h-full flex flex-col">
                  <p className="kai text-[17px] leading-snug">{r.title}</p>
                  {r.trigger_scene && <p className="text-sm text-ink-soft mt-1 line-clamp-2">{r.trigger_scene}</p>}
                  <div className="flex-1" />
                  <div className="flex items-center gap-3 mt-3 text-xs text-ink-faint">
                    <Mastery value={masteryLevel(c)} className="w-16" />
                    <span className={cx(r.occurrence_count > 1 && 'text-red')}>发生 {r.occurrence_count} 次</span>
                    {c && r.status !== 'archived' && <span className={c.due <= now ? 'text-pen font-medium' : ''}>{c.due <= now ? '今天复习' : `${relDays(c.due, now)}复习`}</span>}
                    {r.status !== 'active' && <Chip tone={r.status === 'internalized' ? 'ok' : 'warn'}>{STATUS[r.status]}</Chip>}
                    <span className="flex-1" />
                    {r.tags.slice(0, 2).map((t) => <Chip key={t}>{t}</Chip>)}
                  </div>
                </Sheet>
              </Link>
            )
          })}
        </div>
      )}
      <NewRuleModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => nav(`/rule/${id}`)} />
    </Page>
  )
}

function NewRuleModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [r, setR] = useState({ title: '', trigger_scene: '', good_example: '', my_own_words: '' })
  return (
    <Modal open={open} onClose={onClose} title="手动新建知识点"
      footer={<><Button onClick={onClose}>取消</Button><Button kind="primary" disabled={!r.title.trim()} onClick={async () => { const id = await createRule({ ...r, title: r.title.trim() }, Date.now()); onClose(); onCreated(id) }}>新建</Button></>}>
      <div className="space-y-3">
        <Field label="规则（一句话，写成能照着做的动作）"><input className={inputCls} value={r.title} onChange={(e) => setR({ ...r, title: e.target.value })} /></Field>
        <Field label="什么时候用得上"><input className={inputCls} value={r.trigger_scene} onChange={(e) => setR({ ...r, trigger_scene: e.target.value })} /></Field>
        <Field label="参考说法"><input className={inputCls} value={r.good_example} onChange={(e) => setR({ ...r, good_example: e.target.value })} /></Field>
        <Field label="我自己的话"><textarea rows={2} className={inputCls} value={r.my_own_words} onChange={(e) => setR({ ...r, my_own_words: e.target.value })} /></Field>
      </div>
    </Modal>
  )
}

export function RuleDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const [r, setR] = useState<Rule | null>(null)
  const [dirty, setDirty] = useState(false)
  const [merge, setMerge] = useState(false)
  const [target, setTarget] = useState('')
  const [data] = useLoad(async () => {
    const [card, ev, logs, incs, rules, tags] = await Promise.all([getCard(id), listEvidence(id), listLogs(id), listIncidents(), listRules(), listTags()])
    return { card, ev, logs, incs: new Map(incs.map((i) => [i.id, i])), others: rules.filter((x) => x.id !== id), tags: tags.map((t) => t.name) }
  }, [id])
  useEffect(() => { getRule(id).then((x) => { if (!x) nav('/rules'); else setR(x) }) }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!r || !data) return null
  const set = (p: Partial<Rule>) => { setR({ ...r, ...p }); setDirty(true) }
  const save = async () => { await updateRule(id, r); setDirty(false); toast('已保存') }
  const incIds = [...new Set(data.ev.map((e) => e.incident_id))]
  const herWords = data.ev.filter((e) => e.kind === 'her_words')
  const myBad = data.ev.filter((e) => e.kind === 'my_bad')
  const c = data.card

  return (
    <Page narrow title={r.title || '知识点'} back={<button onClick={() => nav('/rules')} className="text-ink-soft hover:text-pen inline-flex items-center gap-1"><ArrowLeft size={14} />知识库</button>}
      actions={<>
        <Button kind="primary" onClick={() => nav(`/review?rule=${id}`)}><Repeat2 size={15} />现在练这一条</Button>
        {dirty && <Button kind="primary" onClick={save}>保存</Button>}
      </>}>
      <div className="grid grid-cols-4 gap-3 mb-5">
        <Stat label="发生次数" value={`${r.occurrence_count}`} red={r.occurrence_count > 1} />
        <Stat label="下次复习" value={c ? (r.status === 'archived' ? '不再复习' : relDays(c.due)) : '—'} />
        <Stat label="掌握度" value={c?.reps ? `${Math.round(masteryLevel(c) * 100)}%` : '未复习'} />
        <Stat label="状态" value={STATUS[r.status]} />
      </div>

      <Sheet className="p-5 space-y-3 mb-5">
        <Field label="规则"><input className={cx(inputCls, 'kai text-[17px]')} value={r.title} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="什么时候用得上"><input className={inputCls} value={r.trigger_scene} onChange={(e) => set({ trigger_scene: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="参考说法"><textarea rows={2} className={cx(inputCls, 'text-pen')} value={r.good_example} onChange={(e) => set({ good_example: e.target.value })} /></Field>
          <Field label="反例（我说过的）"><textarea rows={2} className={cx(inputCls, 'red-note')} value={r.bad_example} onChange={(e) => set({ bad_example: e.target.value })} /></Field>
        </div>
        <Field label="我自己的话"><textarea rows={2} className={inputCls} value={r.my_own_words} onChange={(e) => set({ my_own_words: e.target.value })} /></Field>
        <div className="flex flex-wrap gap-1.5">{data.tags.map((t) => <Chip key={t} active={r.tags.includes(t)} onClick={() => set({ tags: r.tags.includes(t) ? r.tags.filter((x) => x !== t) : [...r.tags, t] })}>{t}</Chip>)}</div>
      </Sheet>

      {herWords.length > 0 && (
        <div className="mb-5">
          <SectionTitle>她说过的</SectionTitle>
          <Sheet className="p-4 space-y-1.5">
            {[...new Map(herWords.map((e) => [e.text, e])).values()].map((e) => (
              <p key={e.id} className="kai text-[15.5px]"><span className="marker">「{e.text}」</span><span className="text-xs text-ink-faint font-sans ml-2">{fmtDate(data.incs.get(e.incident_id)?.occurred_at)}</span></p>
            ))}
          </Sheet>
        </div>
      )}
      {myBad.length > 0 && (
        <div className="mb-5">
          <SectionTitle>我说过的反例</SectionTitle>
          <Sheet className="p-4 space-y-1">{[...new Set(myBad.map((e) => e.text))].map((t) => <p key={t} className="red-note red-wave">{t}</p>)}</Sheet>
        </div>
      )}

      <div className="mb-5">
        <SectionTitle>相关便签</SectionTitle>
        <Sheet className="divide-y divide-rule">
          {incIds.length === 0 && <p className="p-4 text-sm text-ink-faint">手动新建的知识点，没有关联便签</p>}
          {incIds.map((iid) => { const i = data.incs.get(iid); return i && (
            <Link key={iid} to={`/incident/${iid}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-paper">
              <span className="kai text-ink-soft w-20">{fmtDate(i.occurred_at)}</span><span className="flex-1">{i.title || '未命名'}</span>
            </Link>
          ) })}
        </Sheet>
      </div>

      <div className="mb-5">
        <SectionTitle>复习记录</SectionTitle>
        <Sheet className="p-4">
          {data.logs.length === 0 ? <p className="text-sm text-ink-faint">还没有复习过</p> : (
            <div className="flex flex-wrap gap-2">
              {data.logs.slice(0, 30).map((l) => (
                <span key={l.id} title={fmtDateTime(l.reviewed_at)} className={cx('rounded px-2 py-0.5 text-xs', l.source === 'recurrence' ? 'bg-red text-white' : l.rating >= 3 ? 'bg-ok-soft text-ok' : l.rating === 2 ? 'bg-warn-soft text-warn' : 'bg-red-soft text-red')}>
                  {fmtDate(l.reviewed_at).slice(5)} {l.source === 'recurrence' ? '又发生' : RATING_LABEL[l.rating]}{l.ai_score != null ? ` ${Math.round(l.ai_score)}` : ''}
                </span>
              ))}
            </div>
          )}
        </Sheet>
      </div>

      <div className="flex gap-2">
        {r.status !== 'archived'
          ? <Button onClick={async () => { await updateRule(id, { status: 'archived' }); setR({ ...r, status: 'archived' }); toast('已归档，不再出题') }}><Archive size={14} />归档</Button>
          : <Button onClick={async () => { await updateRule(id, { status: 'active' }); setR({ ...r, status: 'active' }) }}>恢复练习</Button>}
        <Button onClick={() => setMerge(true)} disabled={!data.others.length}><Merge size={14} />合并到另一条</Button>
        <span className="flex-1" />
        <Button kind="danger" onClick={async () => { if (await confirmDialog('删除这个知识点和它的复习记录？关联的便签不会删除。', '删除', true)) { await deleteRule(id); nav('/rules') } }}><Trash2 size={14} />删除</Button>
      </div>

      <Modal open={merge} onClose={() => setMerge(false)} title="合并知识点"
        footer={<><Button onClick={() => setMerge(false)}>取消</Button><Button kind="primary" disabled={!target} onClick={async () => { await mergeRules(target, id); setMerge(false); toast('已合并'); nav(`/rule/${target}`) }}>合并</Button></>}>
        <p className="text-sm text-ink-soft mb-2">把这条的证据、复习记录并入下面选的那条，出现次数相加，这条删除。</p>
        <select className={inputCls} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">选择要并入的知识点</option>
          {data.others.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
      </Modal>
    </Page>
  )
}

function Stat({ label, value, red }: { label: string; value: string; red?: boolean }) {
  return <Sheet className="px-4 py-3"><p className="text-xs text-ink-faint">{label}</p><p className={cx('kai text-xl mt-0.5', red && 'text-red')}>{value}</p></Sheet>
}
