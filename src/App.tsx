import { useCallback, useEffect, useMemo, useState } from 'react'
import { HashRouter, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { BookOpen, ChartNetwork, Handshake, Home as HomeIcon, LogOut, NotebookPen, Repeat2, Settings as Cog, ShieldCheck } from 'lucide-react'
import { Button, GlobalLayer, confirmDialog, cx, errText } from './components/ui'
import { onChange, useLoad } from './db/base'
import { ensureTags, todayQueue } from './db/rules'
import { autoBackupIfDue } from './db/misc'
import { discardRemote, flushSave, getSaveState, hasUnsaved, onSaveState, overwriteServer, retrySave, type SaveState } from './db/db'
import { isTauri, onNavigate } from './lib/platform'
import { authState, getServerUrl, isPreview, logout as apiLogout, onAuthExpired, type User } from './lib/api'
import { SessionContext, useSession } from './lib/session'
import { AuthScreen, Fatal, Loading, ServerScreen, type AuthMode } from './pages/Auth'
import AdminPage from './pages/Admin'
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
  const { user, logout } = useSession()
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
    ...(user.role === 'superadmin' ? [{ to: '/admin', label: '管理', icon: ShieldCheck }] : []),
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
      {isPreview && <div className="m-2.5 rounded-md bg-warn-soft text-warn text-xs p-2.5 max-[1180px]:hidden">界面预览：用的是示例数据，AI 返回的是模拟内容。</div>}
      <SaveStatus />
      {!isPreview && (
        <div className="border-t border-rule px-3 py-2.5 flex items-center gap-2 max-[1180px]:flex-col max-[1180px]:px-1">
          <span className="flex-1 min-w-0 truncate text-[13px] text-ink-soft max-[1180px]:hidden" title={user.username}>{user.username}</span>
          <button className="text-ink-faint hover:text-red p-1" title="退出登录" aria-label="退出登录" onClick={() => { void logout() }}><LogOut size={16} /></button>
        </div>
      )}
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

/** 保存状态：平时只显示一个小字；出问题时给出能直接点的处理办法 */
function SaveStatus() {
  const [st, setSt] = useState<SaveState>(getSaveState())
  useEffect(() => onSaveState(setSt), [])
  useEffect(() => {
    if (st !== 'error') return
    const t = setTimeout(retrySave, 10_000)
    return () => clearTimeout(t)
  }, [st])
  if (isPreview) return null
  if (st === 'conflict') {
    return (
      <div className="m-2.5 rounded-md bg-red-soft text-red text-xs p-2.5 space-y-2 max-[1180px]:hidden">
        <p>你在别的页面或设备上也改过数据。这里最近的修改还没保存。</p>
        <div className="flex flex-col gap-1.5">
          <Button size="sm" onClick={async () => { if (await confirmDialog('加载服务器上最新的数据？这个页面上还没保存的修改会丢掉。', '加载最新的', true)) location.reload() }}>加载最新的</Button>
          <Button size="sm" kind="red" onClick={async () => { if (await confirmDialog('用这个页面上的数据覆盖服务器上的？别处刚做的修改会丢掉。', '用这里的覆盖', true)) await overwriteServer() }}>用这里的覆盖</Button>
        </div>
      </div>
    )
  }
  const text: Record<SaveState, string> = { saved: '已保存', pending: '保存中…', saving: '保存中…', error: '保存失败，稍后自动重试', conflict: '', expired: '登录过期，重新登录后会继续保存' }
  return (
    <div className={cx('px-5 pb-2 text-[11px] max-[1180px]:hidden', st === 'error' || st === 'expired' ? 'text-red' : 'text-ink-faint')}>
      {text[st]}{st === 'error' && <> · <button className="underline" onClick={retrySave}>现在重试</button></>}
    </div>
  )
}

function Main() {
  const { user } = useSession()
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState('')
  const init = useCallback(() => {
    setErr('')
    ;(async () => {
      await ensureTags()
      // 单文件界面预览：灌入示例数据（正式版没有这个标记，不会执行）
      if (__PREVIEW_BUILD__ && isPreview) {
        const { seedPreview } = await import('./fixtures/previewSeed')
        await seedPreview()
      }
    })().then(() => setReady(true), (e) => setErr(errText(e)))
  }, [])
  useEffect(init, [init])
  // 关页面时还有没保存完的修改，先提醒
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => { if (hasUnsaved()) { void flushSave(); e.preventDefault() } }
    window.addEventListener('beforeunload', f)
    return () => window.removeEventListener('beforeunload', f)
  }, [])
  if (err) return <Fatal text={`数据没能加载出来：${err}`} retry={() => location.reload()} />
  if (!ready) return <Loading text="正在取回你的数据…" />
  return (
    <HashRouter>
      <div className="flex h-full">
        <Nav />
        <main className="flex-1 min-w-0 overflow-auto grid-paper">
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
            {user.role === 'superadmin' && <Route path="/admin" element={<AdminPage />} />}
          </Routes>
        </main>
      </div>
      <Boot />
    </HashRouter>
  )
}

const PREVIEW_USER: User = { id: 'preview', username: '预览', role: 'superadmin', createdAt: 0 }

type Phase = { k: 'loading' } | { k: 'server' } | { k: 'auth'; mode: AuthMode } | { k: 'ready'; user: User } | { k: 'error'; msg: string }

/** 没登录之前不打开数据库、不渲染任何业务页面 */
function AuthGate() {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' })
  const [expired, setExpired] = useState(false)
  const load = useCallback(async () => {
    setPhase({ k: 'loading' })
    try {
      if (isTauri && !(await getServerUrl())) { setPhase({ k: 'server' }); return }
      const s = await authState()
      setPhase(s.user ? { k: 'ready', user: s.user } : { k: 'auth', mode: s.needsSetup ? 'setup' : 'login' })
    } catch (e) {
      setPhase({ k: 'error', msg: errText(e) })
    }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => onAuthExpired(() => setExpired(true)), [])

  const user = phase.k === 'ready' ? phase.user : null
  const session = useMemo(() => user && {
    user,
    logout: async () => {
      try { await flushSave() } catch { /* 下面会提示 */ }
      if (hasUnsaved() && !(await confirmDialog('还有修改没保存到服务器，现在退出会丢掉这些修改。确定退出吗？', '仍然退出', true))) return
      discardRemote()
      try { await apiLogout() } catch { /* 服务器连不上也照样清掉本地状态 */ }
      // 整页刷新：内存里的数据库随之清空，不会留给下一个登录的人
      location.reload()
    },
  }, [user])

  if (phase.k === 'loading') return <Loading />
  if (phase.k === 'error') return <Fatal text={`连不上服务器：${phase.msg}`} retry={() => { void load() }} />
  if (phase.k === 'server') return <ServerScreen onDone={() => { void load() }} />
  if (phase.k === 'auth') {
    return <AuthScreen mode={phase.mode} onDone={(u) => setPhase({ k: 'ready', user: u })} onChangeServer={isTauri ? () => setPhase({ k: 'server' }) : undefined} />
  }
  return (
    <SessionContext.Provider value={session!}>
      <Main />
      {expired && (
        <div className="fixed inset-0 z-[55] bg-ink/30 overflow-auto">
          <AuthScreen mode="login" expiredFor={phase.user.username} onDone={(u) => {
            if (u.id !== phase.user.id) { discardRemote(); location.reload(); return }
            setExpired(false)
            retrySave()
          }} />
        </div>
      )}
    </SessionContext.Provider>
  )
}

export default function App() {
  const preview = useMemo(() => ({ user: PREVIEW_USER, logout: async () => {} }), [])
  return (
    <>
      {isPreview ? <SessionContext.Provider value={preview}><Main /></SessionContext.Provider> : <AuthGate />}
      <GlobalLayer />
    </>
  )
}
