// 统计与可视化（PRD F9）：词云、问题图谱、高频排行、趋势、复习日历、AI 周报
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Minus, Sparkles, TrendingDown, TrendingUp } from 'lucide-react'
import { Page } from '../components/Page'
import { Button, Chip, Empty, Sheet, cx, errText, toast } from '../components/ui'
import EChart, { C, FONT, KAI } from '../components/EChart'
import { q, useLoad, useSettings } from '../db/base'
import { allAnalyses, allMessages, listIncidents } from '../db/incidents'
import { listCommitments } from '../db/misc'
import { listCards, listEvidence, listLogs, listRules } from '../db/rules'
import { masteryLevel } from '../domain/srs'
import { buildGraph, commitmentRate, dailyHeat, herTexts, monthlyTrend, rankRules, retentionByWeek, tagFreq, wordFreq } from '../domain/stats'
import { weeklyReport } from '../ai/tasks'
import { DAY, fmtDate } from '../lib/util'
import type { Analysis, CardRow, Commitment, Evidence, Incident, Message, ReviewLog, Rule } from '../lib/types'

interface D { incidents: Incident[]; rules: Rule[]; cards: CardRow[]; evidence: Evidence[]; logs: ReviewLog[]; commitments: Commitment[]; msgs: Message[]; analyses: Analysis[]; sev: { rule_id: string; severity: number }[] }

type Tab = 'cloud' | 'graph' | 'rank' | 'trend' | 'calendar'
const TABS: [Tab, string][] = [['cloud', '词云'], ['graph', '问题图谱'], ['rank', '高频问题'], ['trend', '趋势'], ['calendar', '复习日历']]
const RANGES: [number, string][] = [[30, '近 30 天'], [90, '近 3 个月'], [0, '全部']]

export default function Stats() {
  const nav = useNavigate()
  const [s] = useSettings()
  const [tab, setTab] = useState<Tab>('cloud')
  const [cloud, setCloud] = useState<'mine' | 'hers'>('mine')
  const [range, setRange] = useState(0)
  const [weekly, setWeekly] = useState<{ summary: string; focus: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const [d] = useLoad<D>(async () => {
    const [incidents, rules, cards, evidence, logs, commitments, msgs, analyses] = await Promise.all([listIncidents(), listRules(), listCards(), listEvidence(), listLogs(), listCommitments(), allMessages(), allAnalyses()])
    const sev = await q<{ rule_id: string; severity: number }>('SELECT e.rule_id, i.severity FROM rule_evidence e JOIN incident i ON i.id=e.incident_id')
    return { incidents, rules, cards, evidence, logs, commitments, msgs, analyses, sev }
  })

  const view = useMemo(() => {
    if (!d) return null
    const now = Date.now()
    const since = range ? now - range * DAY : 0
    const incs = d.incidents.filter((i) => (i.occurred_at ?? i.created_at) >= since)
    const ids = new Set(incs.map((i) => i.id))
    const mastery = new Map(d.cards.map((c) => [c.rule_id, masteryLevel(c)]))
    const sevBy = new Map<string, number[]>()
    for (const x of d.sev) sevBy.set(x.rule_id, [...(sevBy.get(x.rule_id) ?? []), Number(x.severity)])
    const problems = d.analyses.filter((a) => ids.has(a.incident_id)).flatMap((a) => a.data.misses.map((m) => m.problem))
    const tagWords = tagFreq(incs, d.rules.filter((r) => (r.last_seen ?? 0) >= since)).map((x) => ({ ...x, value: x.value * 3 }))
    const mine = [...tagWords, ...wordFreq(problems, 50).filter((w) => !tagWords.some((t) => t.name === w.name))]
    const hers = wordFreq(herTexts(d.msgs.filter((m) => ids.has(m.incident_id))), 80)
    return { incs, mastery, sevBy, mine, hers, now }
  }, [d, range])

  if (!d || !view || !s) return null
  if (!d.incidents.length) return <Page title="统计"><Empty title="还没有数据">记几次之后，这里能看出哪类问题最常出现、有没有在减少。</Empty></Page>

  const runWeekly = async () => {
    setBusy(true)
    try {
      const wk = Date.now() - 7 * DAY
      const newIncs = d.incidents.filter((i) => (i.occurred_at ?? i.created_at) >= wk)
      const rank = rankRules(d.rules, view.sevBy, Date.now()).slice(0, 5)
      const logs = d.logs.filter((l) => l.reviewed_at >= wk)
      const cr = commitmentRate(d.commitments)
      const text = `本周新增便签 ${newIncs.length} 条：${newIncs.map((i) => `${i.title}（${i.tags.join('、')}）`).join('；') || '无'}\n重复最多的知识点：${rank.map((r) => `${r.rule.title}（${r.rule.occurrence_count} 次）`).join('；')}\n本周复习 ${logs.filter((l) => l.source === 'review').length} 次，其中良好及以上 ${logs.filter((l) => l.source === 'review' && l.rating >= 3).length} 次；再次发生 ${logs.filter((l) => l.source === 'recurrence').length} 次\n承诺按时完成率：${cr.rate == null ? '无数据' : Math.round(cr.rate * 100) + '%'}`
      setWeekly(await weeklyReport(text))
    } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
  }

  return (
    <Page title="统计" actions={<Button onClick={runWeekly} disabled={busy}><Sparkles size={15} />{busy ? '生成中…' : '生成本周周报'}</Button>}>
      {weekly && (
        <Sheet className="p-5 mb-5">
          <p className="text-sm leading-relaxed">{weekly.summary}</p>
          <p className="red-note mt-2">下周只练一条：{weekly.focus}</p>
        </Sheet>
      )}
      <div className="flex items-center gap-1 mb-4 border-b border-rule">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={cx('px-4 py-2 -mb-px border-b-2 text-[14.5px]', tab === k ? 'border-pen text-pen font-medium' : 'border-transparent text-ink-soft hover:text-ink')}>{l}</button>
        ))}
        <span className="flex-1" />
        {(tab === 'cloud' || tab === 'graph') && RANGES.map(([v, l]) => <Chip key={v} active={range === v} onClick={() => setRange(v)}>{l}</Chip>)}
      </div>

      {tab === 'cloud' && (
        <Sheet className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Chip active={cloud === 'mine'} onClick={() => setCloud('mine')}>我的问题</Chip>
            <Chip active={cloud === 'hers'} onClick={() => setCloud('hers')}>{s.herName}的原话</Chip>
            <span className="text-xs text-ink-faint ml-2">{cloud === 'mine' ? '来自标签和复盘里"我哪里没接住"，字越大出现越多' : `${s.herName}的消息分词统计，看她反复说的是什么`}。点一个词，查看相关便签</span>
          </div>
          {(cloud === 'mine' ? view.mine : view.hers).length === 0 ? <Empty title="这个时间范围里没有数据" /> : (
            <EChart height={460} onClick={(p) => p.name && nav(`/incidents?kw=${encodeURIComponent(p.name)}`)} option={{
              tooltip: { show: true, formatter: (p: { name: string; value: number }) => `${p.name}：${cloud === 'mine' ? '' : p.value + ' 次'}` },
              series: [{
                type: 'wordCloud', shape: 'circle', left: 'center', top: 'center', width: '96%', height: '96%',
                sizeRange: [14, 64], rotationRange: [0, 0], gridSize: 10, drawOutOfBound: false, layoutAnimation: false,
                textStyle: { fontFamily: KAI, color: (p: { dataIndex: number }) => (p.dataIndex < 3 ? C.red : p.dataIndex < 10 ? C.pen : p.dataIndex % 2 ? C.soft : C.ink) },
                emphasis: { textStyle: { color: C.red } },
                data: cloud === 'mine' ? view.mine : view.hers,
              }],
            }} />
          )}
        </Sheet>
      )}

      {tab === 'graph' && <Graph d={d} view={view} onOpen={(id) => {
        const [k, rid] = [id.slice(0, 1), id.slice(2)]
        if (k === 'r') nav(`/rule/${rid}`)
        if (k === 'i') nav(`/incident/${rid}`)
        if (k === 'c') nav('/commitments')
      }} />}

      {tab === 'rank' && <Rank rows={rankRules(d.rules, view.sevBy, view.now)} mastery={view.mastery} onOpen={(id) => nav(`/rule/${id}`)} />}

      {tab === 'trend' && <Trend d={d} />}

      {tab === 'calendar' && (
        <Sheet className="p-4">
          <p className="text-sm text-ink-soft mb-2">每天复习了几次。连续的格子越多，习惯越稳。</p>
          <EChart height={220} option={{
            tooltip: { formatter: (p: { value: [string, number] }) => `${p.value[0]}：复习 ${p.value[1]} 次` },
            visualMap: { show: false, min: 0, max: 8, inRange: { color: ['#eef1ea', '#bcd3b0', '#6fae7f', C.ok] } },
            calendar: { range: [fmtDate(Date.now() - 180 * DAY), fmtDate(Date.now())], cellSize: ['auto', 16], left: 30, right: 10, top: 30, splitLine: { show: false }, itemStyle: { borderColor: '#fff', borderWidth: 3, color: '#f3f5f0' }, dayLabel: { nameMap: 'ZH', color: C.faint, firstDay: 1 }, monthLabel: { nameMap: 'ZH', color: C.soft }, yearLabel: { show: false } },
            series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: dailyHeat(d.logs) }],
          }} />
        </Sheet>
      )}
    </Page>
  )
}

function Graph({ d, view, onOpen }: { d: D; view: { incs: Incident[]; mastery: Map<string, number> }; onOpen: (id: string) => void }) {
  const g = useMemo(() => {
    const ids = new Set(view.incs.map((i) => i.id))
    return buildGraph(d.rules, view.incs, d.commitments.filter((c) => c.incident_id && ids.has(c.incident_id)), d.evidence.filter((e) => ids.has(e.incident_id)), view.mastery)
  }, [d, view])
  const masteryColor = (m: number) => (m < 0.34 ? C.red : m < 0.67 ? C.warn : C.ok)
  return (
    <Sheet className="p-4">
      <p className="text-sm text-ink-soft mb-1">圆越大出现越多。<span className="text-pen">蓝色</span>是问题类型，<span className="text-red">红</span>/<span className="text-warn">橙</span>/<span className="text-ok">绿</span>是知识点（按掌握度），灰色是便签，浅色小点是承诺。单击高亮相连的点，双击打开。</p>
      <EChart height={560} onDblClick={(p) => { const id = (p.data as { id?: string } | undefined)?.id; if (p.dataType === 'node' && id) onOpen(id) }} option={{
        tooltip: { formatter: (p: { dataType: string; data: { name: string; category: number; value: number } }) => p.dataType === 'node' ? `${p.data.name}${p.data.category <= 1 ? `（${p.data.value} 次）` : ''}` : '' },
        legend: { data: ['问题类型', '知识点', '便签', '承诺'], bottom: 0, textStyle: { color: C.soft, fontFamily: FONT } },
        series: [{
          type: 'graph', layout: 'force', roam: true, draggable: true,
          force: { repulsion: 220, edgeLength: [60, 140], gravity: 0.08 },
          categories: [{ name: '问题类型', itemStyle: { color: C.pen } }, { name: '知识点', itemStyle: { color: C.red } }, { name: '便签', itemStyle: { color: '#a8b0b8' } }, { name: '承诺', itemStyle: { color: '#d9c9a3' } }],
          emphasis: { focus: 'adjacency', lineStyle: { width: 2.5 } },
          label: { show: true, position: 'right', fontFamily: FONT, fontSize: 12, color: C.ink, formatter: (p: { data: { name: string; category: number } }) => (p.data.category === 3 ? '' : p.data.name.length > 14 ? p.data.name.slice(0, 14) + '…' : p.data.name) },
          lineStyle: { color: '#c3cabd', width: 1, curveness: 0.12 },
          data: g.nodes.map((n) => ({ ...n, itemStyle: n.category === 1 ? { color: masteryColor(n.mastery ?? 0) } : undefined, label: n.category === 0 ? { fontFamily: KAI, fontSize: 15, color: C.pen } : undefined })),
          links: g.links,
        }],
      }} />
    </Sheet>
  )
}

function Rank({ rows, mastery, onOpen }: { rows: ReturnType<typeof rankRules>; mastery: Map<string, number>; onOpen: (id: string) => void }) {
  if (!rows.length) return <Empty title="还没有知识点" />
  return (
    <Sheet>
      <div className="grid grid-cols-[40px_1fr_80px_80px_90px_60px] gap-2 px-4 py-2 text-xs text-ink-faint border-b border-rule">
        <span>名次</span><span>知识点</span><span>出现次数</span><span>平均严重度</span><span>掌握度</span><span>较上周</span>
      </div>
      {rows.map((r, i) => (
        <button key={r.rule.id} onClick={() => onOpen(r.rule.id)} className="w-full grid grid-cols-[40px_1fr_80px_80px_90px_60px] gap-2 px-4 py-2.5 text-left items-center border-b border-rule last:border-0 hover:bg-paper">
          <span className={cx('kai text-lg', i < 3 ? 'text-red' : 'text-ink-faint')}>{i + 1}</span>
          <span className="truncate">{r.rule.title}</span>
          <span>{r.rule.occurrence_count}</span>
          <span>{r.avgSeverity.toFixed(1)}</span>
          <span className="text-sm">{Math.round((mastery.get(r.rule.id) ?? 0) * 100)}%</span>
          <span className="flex items-center">{r.delta > 0 ? <TrendingUp size={16} className="text-red" /> : r.delta < 0 ? <TrendingDown size={16} className="text-ok" /> : <Minus size={16} className="text-ink-faint" />}</span>
        </button>
      ))}
      <p className="px-4 py-2 text-xs text-ink-faint">排序依据：出现次数 × 平均严重度 × 时间衰减（60 天减半）。红色上升箭头表示这一条比一周前更靠前了。</p>
    </Sheet>
  )
}

function Trend({ d }: { d: D }) {
  const months = monthlyTrend(d.incidents, 6)
  const cr = commitmentRate(d.commitments)
  const ret = retentionByWeek(d.logs, 8)
  const tags = [...new Set(d.incidents.flatMap((i) => i.tags))].slice(0, 6)
  const tagSeries = tags.map((t) => ({
    name: t, type: 'bar', stack: 'tag', barMaxWidth: 28,
    data: months.map((m) => d.incidents.filter((i) => i.tags.includes(t) && fmtDate(i.occurred_at ?? i.created_at).startsWith(m.month)).length),
  }))
  const axis = { axisLine: { lineStyle: { color: C.rule } }, axisLabel: { color: C.soft, fontFamily: FONT }, splitLine: { lineStyle: { color: C.grid } } }
  return (
    <div className="grid grid-cols-2 gap-4 max-[1000px]:grid-cols-1">
      <Sheet className="p-4">
        <p className="font-medium text-sm mb-1">每月便签数和平均严重度</p>
        <EChart height={260} option={{
          tooltip: { trigger: 'axis' }, grid: { left: 36, right: 36, top: 24, bottom: 28 },
          xAxis: { type: 'category', data: months.map((m) => m.month.slice(2)), ...axis },
          yAxis: [{ type: 'value', minInterval: 1, ...axis }, { type: 'value', min: 0, max: 5, ...axis, splitLine: { show: false } }],
          series: [{ name: '便签数', type: 'bar', data: months.map((m) => m.count), itemStyle: { color: C.pen }, barMaxWidth: 26 }, { name: '平均严重度', type: 'line', yAxisIndex: 1, data: months.map((m) => m.avgSeverity || null), itemStyle: { color: C.red }, smooth: true }],
        }} />
      </Sheet>
      <Sheet className="p-4">
        <p className="font-medium text-sm mb-1">各类问题每月出现次数</p>
        <EChart height={260} option={{
          tooltip: { trigger: 'axis' }, legend: { bottom: 0, textStyle: { color: C.soft, fontSize: 11 } }, grid: { left: 30, right: 10, top: 16, bottom: 44 },
          color: [C.red, C.pen, C.warn, C.ok, '#7d6aa8', '#5c97a8'],
          xAxis: { type: 'category', data: months.map((m) => m.month.slice(2)), ...axis }, yAxis: { type: 'value', minInterval: 1, ...axis },
          series: tagSeries,
        }} />
      </Sheet>
      <Sheet className="p-4">
        <p className="font-medium text-sm mb-1">复习保持率（每周评分为良好及以上的比例）</p>
        <EChart height={240} option={{
          tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v == null ? '无' : Math.round(v * 100) + '%') }, grid: { left: 40, right: 10, top: 16, bottom: 28 },
          xAxis: { type: 'category', data: ret.map((r) => r.week), ...axis }, yAxis: { type: 'value', min: 0, max: 1, ...axis, axisLabel: { ...axis.axisLabel, formatter: (v: number) => Math.round(v * 100) + '%' } },
          series: [{ type: 'line', data: ret.map((r) => r.rate), connectNulls: true, itemStyle: { color: C.ok }, areaStyle: { color: 'rgba(47,143,91,0.08)' } }],
        }} />
      </Sheet>
      <Sheet className="p-4 flex flex-col">
        <p className="font-medium text-sm mb-1">承诺按时完成率</p>
        <div className="flex-1 flex items-center justify-center">
          {cr.rate == null ? <p className="text-ink-faint text-sm">还没有到期的承诺</p> : (
            <div className="text-center">
              <p className={cx('kai text-[56px] leading-none', cr.rate >= 0.8 ? 'text-ok' : 'text-red')}>{Math.round(cr.rate * 100)}%</p>
              <p className="text-sm text-ink-soft mt-2">{cr.total} 个已到期或已完成的承诺里，{cr.ontime} 个按时完成</p>
              <p className="text-xs text-ink-faint mt-1">目标：80% 以上</p>
            </div>
          )}
        </div>
      </Sheet>
    </div>
  )
}

