// 登录、注册（需要注册码）、首次安装（创建超级管理员）
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Field, Sheet, cx, errText, inputCls } from '../components/ui'
import { certFingerprint, certToPem, getServerCa, getServerUrl, isPlainHttpUrl, login, register, setServerUrl, setup, type User } from '../lib/api'
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

/** 当前连接的服务器是不是不加密的 http（网页版看地址栏，桌面版看设置的服务器地址） */
export function usePlainHttp(): boolean {
  const [plain, setPlain] = useState(() => !isTauri && isPlainHttpUrl(location.href))
  useEffect(() => { if (isTauri) getServerUrl().then((u) => setPlain(isPlainHttpUrl(u))).catch(() => {}) }, [])
  return plain
}

/** 连接不加密时的温和提醒 */
export function PlainHttpNote({ children }: { children?: ReactNode }) {
  return (
    <div className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[13px] text-ink-soft" role="note">
      {children ?? <>小提醒：这个网址是 http 开头的，网络连接没有加密，同一个 Wi-Fi 下的人有可能看到你输入的内容。密码请不要和其他网站一样，也尽量别在公共 Wi-Fi 下登录。</>}
    </div>
  )
}

/** 桌面版第一次打开：填服务器地址；服务器用自签名证书时，在这里导入管理员给的根证书 */
export function ServerScreen({ onDone }: { onDone: () => void }) {
  const [server, setServer] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okHttp, setOkHttp] = useState(false)
  // ca：undefined = 没动过（保留原来的）；'' = 不用证书；其他 = 要导入的证书
  const [ca, setCa] = useState<string | undefined>(undefined)
  const [savedCa, setSavedCa] = useState<string | null>(null)
  const [finger, setFinger] = useState('')
  const [showCa, setShowCa] = useState(false)
  const plain = isPlainHttpUrl(server)
  const shownCa = ca ?? savedCa ?? ''
  useEffect(() => {
    getServerUrl().then((u) => setServer(u ?? '')).catch(() => {})
    getServerCa().then((c) => { setSavedCa(c); if (c) setShowCa(true) }).catch(() => {})
  }, [])
  useEffect(() => { if (!plain) setOkHttp(false) }, [plain])
  useEffect(() => {
    setFinger('')
    if (shownCa) certFingerprint(shownCa).then(setFinger).catch(() => setFinger(''))
  }, [shownCa])
  const pick = async (f: File | undefined) => {
    setErr('')
    if (!f) return
    if (f.size > 16 * 1024) { setErr('这个文件太大了，不像是证书文件。请选择管理员给你的 root.crt'); return }
    try {
      const pem = certToPem(new Uint8Array(await f.arrayBuffer()))
      await certFingerprint(pem)
      setCa(pem)
    } catch { setErr('这个文件不是证书。请选择管理员给你的 root.crt') }
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try { await setServerUrl(server.trim(), plain && okHttp, plain ? '' : ca); onDone() } catch (e2) { setErr(errText(e2)) } finally { setBusy(false) }
  }
  return (
    <Card title="连接到你的服务器" sub="数据都存在这个服务器上，换电脑登录也能看到。">
      <form className="space-y-3" onSubmit={submit} noValidate>
        <Field label="服务器地址" hint="向管理员要，例如 https://47.100.1.2:8443 或 https://memo.example.com">
          <input className={inputCls} value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://" autoComplete="url" spellCheck={false} autoFocus />
        </Field>
        {plain && (
          <PlainHttpNote>
            这个地址是 http 开头的，连接没有加密：密码和聊天记录在网上传的时候，别人有可能看到。如果管理员说过可以这样连，再勾选下面这一项。
            <label className="flex items-center gap-2 mt-2 text-ink cursor-pointer">
              <input type="checkbox" checked={okHttp} onChange={(e) => setOkHttp(e.target.checked)} />
              我知道连接不加密，仍然要连接
            </label>
          </PlainHttpNote>
        )}
        {!plain && !showCa && (
          <button type="button" className="text-xs text-ink-soft underline" onClick={() => setShowCa(true)}>管理员给了你一个证书文件？</button>
        )}
        {!plain && showCa && (
          <div className="rounded-md border border-rule px-3 py-2 text-[13px] text-ink-soft space-y-2">
            <p>服务器用的是管理员自己签发的证书时，需要导入他给你的证书文件（一般叫 root.crt），之后只认这台服务器，别人冒充不了。</p>
            {shownCa ? (
              <>
                <p className="text-ink">已选择证书，指纹：</p>
                <p className="font-mono text-[11px] break-all text-ink" aria-label="证书指纹">{finger || '…'}</p>
                <p>请和管理员核对一下这串指纹，一样才说明证书没被换过。</p>
                <div className="flex gap-3">
                  <label className="underline cursor-pointer">换一个<input type="file" accept=".crt,.pem,.cer" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} /></label>
                  <button type="button" className="underline" onClick={() => setCa('')}>不用证书</button>
                </div>
              </>
            ) : (
              <label className="inline-block underline cursor-pointer text-pen">选择证书文件<input type="file" accept=".crt,.pem,.cer" className="hidden" aria-label="选择证书文件" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} /></label>
            )}
          </div>
        )}
        {err && <p className="text-sm text-red" role="alert">{err}</p>}
        <Button kind="primary" type="submit" className="w-full" disabled={busy || !server.trim() || (plain && !okHttp)}>{busy ? '正在连接…' : '连接'}</Button>
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
  const plain = usePlainHttp()

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
        {plain && <PlainHttpNote />}
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

export function Fatal({ text, retry, onChangeServer }: { text: string; retry: () => void; onChangeServer?: () => void }) {
  return (
    <Card title="出了点问题">
      <p className="text-sm text-ink-soft mb-4 whitespace-pre-wrap">{text}</p>
      <Button kind="primary" className="w-full" onClick={retry}>再试一次</Button>
      {onChangeServer && <Button className="w-full mt-2" onClick={onChangeServer}>更换服务器或导入证书</Button>}
    </Card>
  )
}
