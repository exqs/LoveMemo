import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { BookOpen, ChartNetwork, Handshake, Home as HomeIcon, NotebookPen, Repeat2, Settings as Cog } from 'lucide-react'
import { GlobalLayer, cx } from './components/ui'
import { onChange, useLoad } from './db/base'
import { ensureTags, todayQueue } from './db/rules'
import { autoBackupIfDue } from './db/misc'
import { isTauri, onNavigate } from './lib/platform'
import { startupCatchUp, syncSchedule } from './lib/scheduleSync'
import Home from './pages/Home'
import Incidents from './pages/Incidents'
import NewIncident from './pages/NewIncident'
import Editor from './pages/Editor'
import AnalysisPage from './pages/Analysis'
import Rules, { RuleDetail } from './pages/Rules'
import Review from './pages/Review'
import Commitments from './pages/Commitments'
import Stats from './pages/Stats'
import SettingsPage from './pages/Settings'

function Nav() {
  const [q] = useLoad(() => todayQueue())
  const due = q?.items.length ?? 0
  const items = [
    { to: '/', label: '今天', icon: HomeIcon, end: true },
    { to: '/incidents', label: '便签', icon: NotebookPen },
    { to: '/rules', label: '知识库', icon: BookOpen },
    { to: '/review', label: '复习', icon: Repeat2, badge: due },
    { to: '/commitments', label: '承诺', icon: Handshake },
    { to: '/stats', label: '统计', icon: ChartNetwork },
    { to: '/settings', label: '设置', icon: Cog },
  ]
  return (
    <nav className="w-[184px] max-[1180px]:w-[64px] shrink-0 bg-sheet border-r border-rule flex flex-col">
      <div className="px-5 pt-6 pb-5 max-[1180px]:px-0 max-[1180px]:text-center">
        <div className="text-[22px] leading-tight text-ink max-[1180px]:hidden">复盘便签</div>
        <div className="text-[22px] text-red hidden max-[1180px]:block">复</div>
        <div className="text-xs text-ink-faint mt-1 max-[1180px]:hidden">把每次不愉快，练成下次的好反应</div>
      </div>
      <ul className="flex-1 px-2.5 space-y-0.5">
        {items.map((it) => (
          <li key={it.to}>
            <NavLink to={it.to} end={it.end} title={it.label}
              className={({ isActive }) => cx('flex items-center gap-2.5 h-9 px-3 rounded-md text-[14px] max-[1180px]:justify-center max-[1180px]:px-0',
                isActive ? 'bg-pen-soft text-pen font-medium' : 'text-ink-soft hover:bg-paper hover:text-ink')}>
              <it.icon size={17} strokeWidth={1.8} />
              <span className="max-[1180px]:hidden flex-1">{it.label}</span>
              {!!it.badge && <span className="max-[1180px]:hidden min-w-5 h-5 px-1.5 rounded-full bg-red text-white text-[11px] flex items-center justify-center">{it.badge}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
      {!isTauri && <div className="m-2.5 rounded-md bg-warn-soft text-warn text-xs p-2.5 max-[1180px]:hidden">浏览器预览：数据存在本浏览器里，AI 返回的是模拟内容。</div>}
    </nav>
  )
}

function Boot() {
  const nav = useNavigate()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const resync = () => { clearTimeout(timer); timer = setTimeout(() => { syncSchedule().catch(console.error) }, 1500) }
    ;(async () => {
      await ensureTags()
      await syncSchedule()
      await startupCatchUp()
      await autoBackupIfDue()
    })().catch(console.error)
    const off = onChange(resync)
    const hourly = setInterval(resync, 3_600_000)
    let unlisten = () => {}
    onNavigate((r) => nav(r)).then((f) => { unlisten = f })
    return () => { off(); clearInterval(hourly); unlisten() }
  }, [nav])
  return null
}

export default function App() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    (async () => {
      await ensureTags()
      // 单文件界面预览：灌入示例数据（桌面版没有这个标记，不会执行）
      if (!isTauri && (window as unknown as { __FUPAN_PREVIEW__?: string }).__FUPAN_PREVIEW__) {
        const { seedPreview } = await import('./fixtures/previewSeed')
        await seedPreview()
      }
    })().catch(console.error).finally(() => setReady(true))
  }, [])
  return (
    <HashRouter>
      <div className="flex h-full">
        <Nav />
        <main className="flex-1 min-w-0 overflow-auto grid-paper">
          {ready && (
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/incidents" element={<Incidents />} />
              <Route path="/new" element={<NewIncident />} />
              <Route path="/incident/:id/edit" element={<Editor />} />
              <Route path="/incident/:id" element={<AnalysisPage />} />
              <Route path="/rules" element={<Rules />} />
              <Route path="/rule/:id" element={<RuleDetail />} />
              <Route path="/review" element={<Review />} />
              <Route path="/commitments" element={<Commitments />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          )}
        </main>
      </div>
      <Boot />
      <GlobalLayer />
    </HashRouter>
  )
}
