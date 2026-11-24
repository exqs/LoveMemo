import { Link, useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Page, SectionTitle } from '../components/Page'
import { Button, Chip, Mastery, Severity, Sheet, toast } from '../components/ui'
import { q, useLoad, useSettings } from '../db/base'
import { listIncidents } from '../db/incidents'
import { listCommitments, listProfiles, updateCommitment } from '../db/misc'
import { listCards, listRules, todayQueue } from '../db/rules'
import { masteryLevel } from '../domain/srs'
import { rankRules } from '../domain/stats'
import { importSample } from '../lib/sample'
import { DAY, fmtDate, relDays } from '../lib/util'

export default function Home() {
  const nav = useNavigate()
  const [s, save] = useSettings()
  const [data] = useLoad(async () => {
    const [queue, incidents, commitments, rules, cards, profiles] = await Promise.all([todayQueue(), listIncidents(), listCommitments(), listRules(), listCards(), listProfiles()])
    const recur = await q<{ rule_id: string; reviewed_at: number }>("SELECT rule_id, MAX(reviewed_at) AS reviewed_at FROM review_log WHERE source='recurrence' AND reviewed_at>=? GROUP BY rule_id", [Date.now() - 7 * DAY])
    const sev = await q<{ rule_id: string; severity: number }>('SELECT e.rule_id, i.severity FROM rule_evidence e JOIN incident i ON i.id=e.incident_id')
    const sevBy = new Map<string, number[]>()
    for (const x of sev) sevBy.set(x.rule_id, [...(sevBy.get(x.rule_id) ?? []), Number(x.severity)])
    return { queue, incidents, commitments, rules, cards: new Map(cards.map((c) => [c.rule_id, c])), profiles, recur, top: rankRules(rules, sevBy, Date.now()).slice(0, 3) }
  })
  if (!data || !s) return null
  const now = Date.now()
  const open = data.commitments.filter((c) => c.status === 'open').slice(0, 4)
  const untold = data.commitments.filter((c) => c.status === 'done' && !c.told_her)
  const ruleTitle = new Map(data.rules.map((r) => [r.id, r.title]))
  const n = data.queue.items.length

  const showOnboard = !s.onboarded && (data.incidents.length === 0 || !data.profiles.length || !s.herNick)

  return (
    <Page title={`${s.myName === '我' ? '' : s.myName + '，'}今天`} actions={<Button kind="primary" onClick={() => nav('/new')}><Plus size={16} />记一次</Button>}>
      {showOnboard && (
        <Sheet className="p-5 mb-5 border-pen/40">
          <p className="kai text-lg mb-1">开始之前，三件事</p>
          <ol className="text-sm text-ink-soft space-y-1.5 mb-3 list-decimal pl-5">
            <li className={s.herNick ? 'line-through text-ink-faint' : ''}>在设置里填双方在聊天截图里的昵称（识别说话人要用）</li>
            <li className={data.profiles.length ? 'line-through text-ink-faint' : ''}>在设置里添加一个模型（截图识别需要支持图片的模型）</li>
            <li className={data.incidents.length ? 'line-through text-ink-faint' : ''}>记下第一次。也可以直接导入 11 月 22 日那次的聊天（已经按截图转写好）</li>
          </ol>
          <div className="flex gap-2">
            <Button onClick={() => nav('/settings')}>去设置</Button>
            {!data.incidents.length && <Button onClick={async () => { const id = await importSample(); toast('已导入 11-22 那次'); nav(`/incident/${id}/edit`) }}>导入 11-22 那次</Button>}
            <Button kind="ghost" onClick={() => save({ onboarded: true })}>不再显示</Button>
          </div>
        </Sheet>
      )}

      <div className="grid grid-cols-[1.35fr_1fr] gap-5 max-[1000px]:grid-cols-1">
        <Sheet className="p-6">
          {n > 0 ? (
            <>
              <p className="text-ink-soft text-sm">今天要复习</p>
              <p className="kai text-[44px] leading-tight text-ink">{n} 个点</p>
              <ul className="mt-3 mb-5 space-y-1.5">
                {data.queue.items.slice(0, 4).map((it) => (
                  <li key={it.rule.id} className="flex items-center gap-3 text-[14.5px]">
                    <Mastery value={masteryLevel(it.card)} className="w-14 shrink-0" />
                    <span className="truncate">{it.rule.title}</span>
                  </li>
                ))}
                {n > 4 && <li className="text-sm text-ink-faint">还有 {n - 4} 个</li>}
              </ul>
              <Button kind="primary" size="lg" onClick={() => nav('/review')}>开始复习</Button>
              {data.queue.deferred > 0 && <p className="text-xs text-ink-faint mt-2">另有 {data.queue.deferred} 个超出今日上限，顺延到明天</p>}
            </>
          ) : (
            <>
              <p className="text-ink-soft text-sm">今天要复习</p>
              <p className="kai text-[34px] leading-tight text-ink">{data.rules.length ? '今天没有到期的' : '知识库还是空的'}</p>
              <p className="text-sm text-ink-soft mt-2">{data.queue.doneToday ? `今天已经复习了 ${data.queue.doneToday} 个。` : data.rules.length ? '下一次复习时间可以在知识库里看到。' : '记一次不愉快，复盘后会生成第一条知识点。'}</p>
            </>
          )}
        </Sheet>

        <div className="space-y-5">
          {data.recur.length > 0 && (
            <Sheet className="p-4 border-red/40 bg-red-soft/40">
              <p className="red-note mb-1">这一点又发生了</p>
              <ul className="text-sm space-y-1">
                {data.recur.map((r) => <li key={r.rule_id}><Link className="hover:underline" to={`/rule/${r.rule_id}`}>{ruleTitle.get(r.rule_id) ?? '（已删除）'}</Link><span className="text-ink-faint ml-2">{fmtDate(r.reviewed_at)}</span></li>)}
              </ul>
              <p className="text-xs text-ink-soft mt-2">这些知识点已经回到短间隔复习。</p>
            </Sheet>
          )}

          <Sheet className="p-4">
            <SectionTitle aside={<Link to="/commitments" className="hover:text-pen">全部</Link>}>答应她的事</SectionTitle>
            {untold.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-sm py-1.5 border-b border-dashed border-rule last:border-0">
                <span className="flex-1">已完成「{c.content}」，<span className="text-red">还没告诉她</span></span>
                <Button size="sm" onClick={() => updateCommitment(c.id, { told_her: true })}>已告诉</Button>
              </div>
            ))}
            {open.length === 0 && !untold.length && <p className="text-sm text-ink-faint py-2">没有进行中的承诺</p>}
            {open.map((c) => {
              const late = c.due_at && c.due_at < now
              return (
                <div key={c.id} className="flex items-center gap-2 text-sm py-1.5 border-b border-dashed border-rule last:border-0">
                  <span className="flex-1 truncate">{c.content}</span>
                  {c.due_at && <span className={late ? 'text-red' : 'text-ink-faint'}>{relDays(c.due_at, now)}</span>}
                </div>
              )
            })}
          </Sheet>

          <Sheet className="p-4">
            <SectionTitle aside={<Link to="/stats" className="hover:text-pen">统计</Link>}>重复最多的问题</SectionTitle>
            {data.top.length === 0 && <p className="text-sm text-ink-faint py-2">还没有数据</p>}
            {data.top.map((r, i) => (
              <Link key={r.rule.id} to={`/rule/${r.rule.id}`} className="flex items-center gap-3 py-1.5 text-sm hover:text-pen">
                <span className="kai text-red w-4">{i + 1}</span>
                <span className="flex-1 truncate">{r.rule.title}</span>
                <span className="text-ink-faint">{r.rule.occurrence_count} 次</span>
              </Link>
            ))}
          </Sheet>
        </div>
      </div>

      <div className="mt-6">
        <SectionTitle aside={<Link to="/incidents" className="hover:text-pen">全部便签</Link>}>最近</SectionTitle>
        <div className="grid grid-cols-3 gap-3 max-[1000px]:grid-cols-2">
          {data.incidents.slice(0, 3).map((i) => (
            <Link key={i.id} to={i.status === 'draft' ? `/incident/${i.id}/edit` : `/incident/${i.id}`}>
              <Sheet className="p-3.5 hover:border-ink-faint h-full">
                <div className="flex items-center justify-between mb-1"><span className="text-xs text-ink-faint">{fmtDate(i.occurred_at)}</span><Severity value={i.severity} /></div>
                <p className="font-medium truncate">{i.title || '未命名'}</p>
                <div className="mt-2 flex gap-1 flex-wrap">{i.status === 'draft' ? <Chip tone="warn">草稿</Chip> : i.tags.slice(0, 3).map((t) => <Chip key={t}>{t}</Chip>)}</div>
              </Sheet>
            </Link>
          ))}
        </div>
        {data.incidents.length === 0 && <p className="text-sm text-ink-faint">还没有便签</p>}
      </div>
    </Page>
  )
}
