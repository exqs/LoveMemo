import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { Page } from '../components/Page'
import { Button, Chip, Empty, Severity, cx, inputCls } from '../components/ui'
import { q, useLoad } from '../db/base'
import { allAnalyses, listIncidents } from '../db/incidents'
import { fmtDate } from '../lib/util'

const STATUS: Record<string, string> = { draft: '草稿', reviewed: '已复盘', archived: '已归档' }

export default function Incidents() {
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const [kw, setKw] = useState(sp.get('kw') ?? '')
  const [tag, setTag] = useState('')
  const [status, setStatus] = useState('')
  const [data] = useLoad(async () => {
    const [list, analyses] = await Promise.all([listIncidents(), allAnalyses()])
    return { list, summary: new Map(analyses.map((a) => [a.incident_id, a.data.summary])) }
  })
  const [hits] = useLoad(async () => {
    if (!kw.trim()) return null
    const r = await q<{ incident_id: string }>('SELECT DISTINCT incident_id FROM message WHERE content LIKE ?', [`%${kw.trim()}%`])
    return new Set(r.map((x) => x.incident_id))
  }, [kw])

  const tags = useMemo(() => [...new Set((data?.list ?? []).flatMap((i) => i.tags))], [data])
  if (!data) return null
  const k = kw.trim()
  const list = data.list.filter((i) =>
    (!tag || i.tags.includes(tag)) && (!status || i.status === status) &&
    (!k || i.title.includes(k) || i.background.includes(k) || (data.summary.get(i.id) ?? '').includes(k) || hits?.has(i.id)))

  return (
    <Page title="便签" actions={<Button kind="primary" onClick={() => nav('/new')}><Plus size={16} />记一次</Button>}>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="relative w-72">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input className={cx(inputCls, 'pl-8')} placeholder="搜标题、复盘、聊天内容" value={kw} onChange={(e) => setKw(e.target.value)} />
        </div>
        <div className="flex gap-1.5">
          {['', 'draft', 'reviewed', 'archived'].map((s) => <Chip key={s} active={status === s} onClick={() => setStatus(s)}>{s ? STATUS[s] : '全部'}</Chip>)}
        </div>
      </div>
      {tags.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mb-4">
          {tags.map((t) => <Chip key={t} tone="red" active={tag === t} onClick={() => setTag(tag === t ? '' : t)}>{t}</Chip>)}
        </div>
      )}

      {data.list.length === 0 ? (
        <Empty title="还没有便签" action={<Button kind="primary" onClick={() => nav('/new')}>记第一次</Button>}>每次吵架或不愉快，记一张。截图拖进来就行。</Empty>
      ) : list.length === 0 ? (
        <Empty title="没有符合条件的便签" />
      ) : (
        // 错题本式排版：左侧红色页边线，日期写在页边
        <div className="bg-sheet border border-rule rounded-[10px] overflow-hidden">
          {list.map((i) => (
            <Link key={i.id} to={i.status === 'draft' ? `/incident/${i.id}/edit` : `/incident/${i.id}`}
              className="grid grid-cols-[104px_1fr] border-b border-rule last:border-0 hover:bg-paper/70">
              <div className="border-r-2 border-red/50 px-4 py-3.5 text-right">
                <div className="kai text-[15px] text-ink">{fmtDate(i.occurred_at).slice(5)}</div>
                <div className="text-[11px] text-ink-faint">{i.channel}</div>
              </div>
              <div className="px-4 py-3 min-w-0">
                <div className="flex items-center gap-3">
                  <span className="font-medium truncate">{i.title || '未命名'}</span>
                  <Severity value={i.severity} />
                  {i.status !== 'reviewed' && <Chip tone="warn">{STATUS[i.status]}</Chip>}
                </div>
                {data.summary.get(i.id) && <p className="text-sm text-ink-soft truncate mt-0.5">{data.summary.get(i.id)}</p>}
                {i.tags.length > 0 && <div className="flex gap-1 mt-1.5">{i.tags.map((t) => <Chip key={t}>{t}</Chip>)}</div>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </Page>
  )
}
