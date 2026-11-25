// 登录、注册（需要注册码）、首次安装（创建超级管理员）
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Field, Sheet, cx, errText, inputCls } from '../components/ui'
import { getServerUrl, login, register, setServerUrl, setup, type User } from '../lib/api'
import { isTauri } from '../lib/platform'

export type AuthMode = 'setup' | 'login' | 'register'

function Card({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-full grid-paper flex items-center justify-center p-6">
      <Sheet className="w-full max-w-[400px] p-7">
        <div className="mb-5">
          <div className="text-[24px] leading-tight text-ink">复盘便签</div>
          <div className="red-note mt-0.5">{title}</div>
          {sub && <p className="text-[13px] text-ink-soft mt-2">{sub}</p>}
        </div>
        {children}
      </Sheet>
    </div>
  )
}

/** 桌面版第一次打开：填服务器地址 */
export function ServerScreen({ onDone }: { onDone: () => void }) {
  const [server, setServer] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { getServerUrl().then((u) => setServer(u ?? '')).catch(() => {}) }, [])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try { await setServerUrl(server.trim()); onDone() } catch (e2) { setErr(errText(e2)) } finally { setBusy(false) }
  }
  return (
    <Card title="连接到你的服务器" sub="数据都存在这个服务器上，换电脑登录也能看到。">
      <form className="space-y-3" onSubmit={submit} noValidate>
        <Field label="服务器地址" hint="向管理员要，例如 https://memo.example.com">
          <input className={inputCls} value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://" autoComplete="url" spellCheck={false} autoFocus />
        </Field>
        {err && <p className="text-sm text-red" role="alert">{err}</p>}
        <Button kind="primary" type="submit" className="w-full" disabled={busy || !server.trim()}>{busy ? '正在连接…' : '连接'}</Button>
      </form>
    </Card>
  )
}

export function AuthScreen({ mode: initial, onDone, onSetupDone, onChangeServer, expiredFor }: { mode: AuthMode; onDone: (u: User) => void; onSetupDone?: () => void; onChangeServer?: () => void; expiredFor?: string }) {
  const [mode, setMode] = useState<AuthMode>(initial)
  const [server, setServer] = useState('')
  const [username, setUsername] = useState(expiredFor ?? '')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { setMode(initial) }, [initial])
  useEffect(() => { if (isTauri) getServerUrl().then((u) => setServer(u ?? '')).catch(() => {}) }, [])
  useEffect(() => { setErr(''); setPassword(''); setPassword2('') }, [mode])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr('')
    if (mode !== 'login' && password !== password2) { setErr('两次输入的密码不一样'); return }
    setBusy(true)
    try {
      if (mode === 'setup') {
        await setup(code, username, password)
        onSetupDone?.()
      } else if (mode === 'register') {
        await register(code, username, password)
      }
      const u = await login(username, password)
      setPassword(''); setPassword2(''); setCode('')
      onDone(u)
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }

  const pwHint = '至少 10 位。可以用一句好记的话，比如"周末一起去看海吧2026"'
  return (
    <Card
      title={mode === 'setup' ? '第一次使用，先创建管理员' : mode === 'register' ? '注册新账号' : expiredFor ? '登录已过期，请重新登录' : '欢迎回来'}
      sub={mode === 'setup'
        ? <>安装码在服务器的启动日志里（<code className="text-[12px]">docker compose logs app</code>）。管理员可以给别人发注册码。</>
        : mode === 'register' ? '注册码向管理员要，一个码通常只能用一次。' : undefined}>
      <form className="space-y-3" onSubmit={submit} noValidate>
        {isTauri && server && (
          <p className="text-xs text-ink-faint">服务器：{server}{onChangeServer && !expiredFor && <> · <button type="button" className="underline" onClick={onChangeServer}>更换</button></>}</p>
        )}
        {mode !== 'login' && (
          <Field label={mode === 'setup' ? '安装码' : '注册码'}>
            <input className={cx(inputCls, 'font-mono tracking-wider')} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" maxLength={64} required />
          </Field>
        )}
        <Field label="用户名" hint={mode !== 'login' ? '最多 32 个字，可以用中文' : undefined}>
          <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} maxLength={32} required readOnly={!!expiredFor} />
        </Field>
        <Field label="密码" hint={mode !== 'login' ? pwHint : undefined}>
          <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} maxLength={128} required />
        </Field>
        {mode !== 'login' && (
          <Field label="再输一次密码">
            <input type="password" className={inputCls} value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" maxLength={128} required />
          </Field>
        )}
        {err && <p className="text-sm text-red" role="alert">{err}</p>}
        <Button kind="primary" type="submit" className="w-full" disabled={busy || !username.trim() || !password || (mode !== 'login' && !code.trim())}>
          {busy ? '请稍等…' : mode === 'setup' ? '创建管理员并登录' : mode === 'register' ? '注册并登录' : '登录'}
        </Button>
      </form>
      {mode !== 'setup' && !expiredFor && (
        <p className="text-sm text-ink-soft mt-4 text-center">
          {mode === 'login'
            ? <>还没有账号？<button className="text-pen underline" onClick={() => setMode('register')}>用注册码注册</button></>
            : <>已经有账号了？<button className="text-pen underline" onClick={() => setMode('login')}>去登录</button></>}
        </p>
      )}
    </Card>
  )
}

export function Loading({ text = '正在打开…' }: { text?: string }) {
  return <div className="h-full grid-paper flex items-center justify-center text-ink-soft">{text}</div>
}

export function Fatal({ text, retry }: { text: string; retry: () => void }) {
  return (
    <Card title="出了点问题">
      <p className="text-sm text-ink-soft mb-4 whitespace-pre-wrap">{text}</p>
      <Button kind="primary" className="w-full" onClick={retry}>再试一次</Button>
    </Card>
  )
}
