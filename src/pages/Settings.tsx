// 设置（PRD F10、F12）：基本信息、模型、复习、提醒、数据
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, KeyRound, LogOut, PlugZap, Plus, Trash2, Upload } from 'lucide-react'
import { Page } from '../components/Page'
import { Button, Chip, Field, Sheet, Spinner, confirmDialog, cx, errText, inputCls, toast } from '../components/ui'
import { useLoad, useSettings } from '../db/base'
import { discardRemote, flushSave } from '../db/db'
import { addTag, deleteTag, listTags } from '../db/rules'
import { exportAll, importAll, listProfiles, usageSummary } from '../db/misc'
import { testProfile } from '../ai/client'
import { autostartEnabled, isTauri, saveToDownloads, setAutostart } from '../lib/platform'
import { changePassword, isPreview, logoutAll, sessions } from '../lib/api'
import { useSession } from '../lib/session'
import type { ModelProfile, RouteKey, Settings } from '../lib/types'
import { fmtDate } from '../lib/util'

const ROUTES: [RouteKey, string, string][] = [
  ['recognize', '截图识别', '需要支持图片'], ['analyze', '复盘分析和知识点归属', '建议用最强的'], ['quiz', '出题和评分', ''], ['roleplay', '角色扮演', '可以用便宜的快模型'],
]

export default function SettingsPage() {
  const [s, save] = useSettings()
  if (!s) return null
  return (
    <Page narrow title="设置">
      <div className="space-y-5">
        <Account />
        <Basic s={s} save={save} />
        <Models s={s} save={save} />
        <ReviewSet s={s} save={save} />
        <Reminders s={s} save={save} />
        <Data s={s} save={save} />
      </div>
    </Page>
  )
}

type P = { s: Settings; save: (p: Partial<Settings>) => Promise<void> }
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Sheet className="p-5">
      <h2 className="font-semibold mb-0.5">{title}</h2>
      {hint && <p className="text-xs text-ink-faint mb-3">{hint}</p>}
      <div className={cx(!hint && 'mt-3')}>{children}</div>
    </Sheet>
  )
}

/** 失焦时保存的输入框 */
function Lazy({ value, onSave, className, ...p }: { value: string; onSave: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <input {...p} className={cx(inputCls, className)} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />
}

function Basic({ s, save }: P) {
  return (
    <Section title="基本信息" hint="称呼用在界面和出题里；昵称用来在截图里区分谁说的话，要和截图上显示的一致">
      <div className="grid grid-cols-2 gap-3">
        <Field label="界面里怎么称呼她"><Lazy value={s.herName} onSave={(v) => save({ herName: v || '她' })} /></Field>
        <Field label="界面里怎么称呼我"><Lazy value={s.myName} onSave={(v) => save({ myName: v || '我' })} /></Field>
        <Field label="她在聊天截图里的昵称"><Lazy value={s.herNick} placeholder="例如 Toria" onSave={(v) => save({ herNick: v.trim() })} /></Field>
        <Field label="我在聊天截图里的昵称"><Lazy value={s.myNick} placeholder="例如 柒" onSave={(v) => save({ myNick: v.trim() })} /></Field>
      </div>
    </Section>
  )
}

function Models({ s, save }: P) {
  const [profiles] = useLoad(listProfiles)
  const [usage] = useLoad(usageSummary)
  const [test, setTest] = useState<Record<string, { busy?: boolean; ok?: boolean; text?: string }>>({})
  const runTest = async (p: ModelProfile) => {
    setTest((t) => ({ ...t, [p.id]: { busy: true } }))
    try {
      const r = await testProfile(p)
      setTest((t) => ({ ...t, [p.id]: { ok: true, text: `连接正常，耗时 ${r.ms}ms。${r.vision === undefined ? '' : r.vision ? '图片识别正常。' : '没能识别测试图片。'}` } }))
    } catch (e) { setTest((t) => ({ ...t, [p.id]: { ok: false, text: errText(e) } })) }
  }
  return (
    <Section title="模型" hint="模型和 API Key 由管理员在「管理 → AI 模型」里配置，Key 加密保存在服务器上，浏览器和电脑里都没有。这里可以按任务选用哪个模型">
      <div className="space-y-2 mb-4">
        {(profiles ?? []).map((p) => (
          <div key={p.id} className="rounded-lg border border-rule px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-medium">{p.name}{p.name !== p.model && <span className="text-ink-faint font-normal text-sm"> {p.model}</span>}</p>
                <p className="text-xs text-ink-faint">{p.protocol === 'anthropic' ? 'Anthropic 协议' : 'OpenAI 兼容'}</p>
              </div>
              {p.supports_vision && <Chip tone="ok">支持图片</Chip>}
              <Button size="sm" disabled={test[p.id]?.busy} onClick={() => runTest(p)}><PlugZap size={13} />测试</Button>
            </div>
            {test[p.id]?.busy && <div className="mt-2"><Spinner label="测试中…" /></div>}
            {test[p.id]?.text && <p className={cx('text-xs mt-2', test[p.id].ok ? 'text-ok' : 'text-red')}>{test[p.id].text}</p>}
          </div>
        ))}
        {profiles && !profiles.length && <p className="text-sm text-ink-faint">还没有开启任何 AI 模型。管理员可以在「管理 → AI 模型」里添加。</p>}
      </div>

      {!!profiles?.length && (
        <div className="grid grid-cols-2 gap-3">
          {ROUTES.map(([k, label, hint]) => (
            <Field key={k} label={label} hint={hint}>
              <select className={inputCls} value={s.routing[k] ?? ''} onChange={(e) => save({ routing: { ...s.routing, [k]: e.target.value || null } })}>
                <option value="">自动（管理员推荐的）</option>
                {profiles.filter((p) => k !== 'recognize' || p.supports_vision).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
              </select>
            </Field>
          ))}
        </div>
      )}

      {!!usage?.length && (
        <div className="mt-4">
          <p className="text-sm text-ink-soft mb-1">用量</p>
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-ink-faint text-left"><th className="font-normal">模型</th><th className="font-normal">调用</th><th className="font-normal">输入 token</th><th className="font-normal">输出 token</th><th className="font-normal">失败</th><th className="font-normal">估算费用</th></tr></thead>
            <tbody>{usage.map((u) => {
              const p = profiles?.find((x) => x.name === u.profile_name && x.model === u.model)
              const cost = p?.price_in != null && p.price_out != null ? (Number(u.tin) * p.price_in + Number(u.tout) * p.price_out) / 1e6 : null
              return <tr key={u.profile_name + u.model} className="border-t border-rule"><td className="py-1">{u.profile_name} {u.model}</td><td>{u.calls}</td><td>{Number(u.tin).toLocaleString()}</td><td>{Number(u.tout).toLocaleString()}</td><td>{u.fails}</td><td>{cost == null ? '—' : `¥${cost.toFixed(2)}`}</td></tr>
            })}</tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

/** 账号：修改密码、登录设备、退出 */
function Account() {
  const { user, logout } = useSession()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [next2, setNext2] = useState('')
  const [busy, setBusy] = useState(false)
  const [list, setList] = useState<Awaited<ReturnType<typeof sessions>>['sessions']>()
  const loadSessions = () => { sessions().then((r) => setList(r.sessions)).catch(() => {}) }
  useEffect(() => { if (!isPreview) loadSessions() }, [])
  if (isPreview) return null
  const change = async () => {
    if (next !== next2) { toast('两次输入的新密码不一样', 'err'); return }
    setBusy(true)
    try { await changePassword(cur, next); setCur(''); setNext(''); setNext2(''); toast('密码改好了，其他设备已经退出登录'); loadSessions() } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
  }
  return (
    <Section title="账号" hint={`当前登录：${user.username}${user.role === 'superadmin' ? '（管理员）' : ''}`}>
      <div className="grid grid-cols-3 gap-3 mb-2">
        <Field label="当前密码"><input type="password" autoComplete="current-password" className={inputCls} value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="新密码" hint="至少 10 位"><input type="password" autoComplete="new-password" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="再输一次新密码"><input type="password" autoComplete="new-password" className={inputCls} value={next2} onChange={(e) => setNext2(e.target.value)} /></Field>
      </div>
      <Button disabled={busy || !cur || !next || !next2} onClick={change}><KeyRound size={14} />修改密码</Button>

      <p className="text-[13px] text-ink-soft mt-5 mb-1.5">登录过的设备</p>
      <div className="space-y-1 mb-3">
        {(list ?? []).map((x, i) => (
          <p key={i} className="text-xs text-ink-soft">
            {x.kind === 'desktop' ? '桌面版' : '网页'} · {x.ua.slice(0, 60) || '未知设备'} · 最近使用 {new Date(x.lastSeen).toLocaleString('zh-CN', { hour12: false })} · {x.ip}{x.current && <span className="text-ok"> · 就是这台</span>}
          </p>
        ))}
      </div>
      <div className="flex gap-2">
        <Button onClick={() => { void logout() }}><LogOut size={14} />退出登录</Button>
        <Button kind="danger" onClick={async () => {
          if (!(await confirmDialog('所有设备（包括这台）都会退出登录。如果怀疑密码泄露了，请先改密码再这样做。', '全部退出', true))) return
          try { await flushSave(); await logoutAll() } catch (e) { toast(errText(e), 'err'); return }
          discardRemote()
          location.reload()
        }}>退出所有设备</Button>
      </div>
    </Section>
  )
}

function ReviewSet({ s, save }: P) {
  return (
    <Section title="复习" hint="FSRS 按每张卡的记忆状态安排下次复习（Anki 现在用的算法）；艾宾浩斯是固定间隔 1、2、4、7、15、30 天……">
      <div className="grid grid-cols-2 gap-3">
        <Field label="记忆算法">
          <select className={inputCls} value={s.algorithm} onChange={(e) => save({ algorithm: e.target.value as Settings['algorithm'] })}>
            <option value="fsrs">FSRS（推荐）</option><option value="ebbinghaus">艾宾浩斯固定间隔</option>
          </select>
        </Field>
        <Field label={`目标记忆保持率：${Math.round(s.retention * 100)}%`} hint="越高复习越频繁">
          <input type="range" min={0.8} max={0.95} step={0.01} disabled={s.algorithm !== 'fsrs'} className="w-full accent-[#24426b]" value={s.retention} onChange={(e) => save({ retention: Number(e.target.value) })} />
        </Field>
        <Field label="每天最多复习"><input type="number" min={1} max={50} className={inputCls} value={s.dailyReviewLimit} onChange={(e) => save({ dailyReviewLimit: Math.max(1, Number(e.target.value) || 10) })} /></Field>
        <Field label="每天最多新增"><input type="number" min={0} max={20} className={inputCls} value={s.dailyNewLimit} onChange={(e) => save({ dailyNewLimit: Math.max(0, Number(e.target.value) || 0) })} /></Field>
        <Field label="新知识点首次复习（小时后）" hint="也是选“重来”之后的间隔"><input type="number" min={1} max={48} className={inputCls} value={s.firstStepHours} onChange={(e) => save({ firstStepHours: Math.max(1, Number(e.target.value) || 4) })} /></Field>
      </div>
    </Section>
  )
}

function Reminders({ s, save }: P) {
  const [auto, setAuto] = useState<boolean | null>(null)
  useEffect(() => { autostartEnabled().then(setAuto).catch(() => setAuto(false)) }, [])
  const [dow, hm] = (s.weeklyTime || '0 20:00').split(' ')
  return (
    <Section title="提醒" hint="关闭窗口时应用会留在右下角托盘里，到点发系统通知。如果到点时应用没运行，下次启动时补发一次">
      <div className="space-y-3">
        <div>
          <p className="text-[13px] text-ink-soft mb-1">每日复习提醒</p>
          <div className="flex flex-wrap items-center gap-2">
            {s.reminderTimes.map((t, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                <input type="time" className={cx(inputCls, 'w-auto py-1')} value={t} onChange={(e) => save({ reminderTimes: s.reminderTimes.map((x, j) => (j === i ? e.target.value : x)) })} />
                <button className="text-ink-faint hover:text-red" aria-label="删除" onClick={() => save({ reminderTimes: s.reminderTimes.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
              </span>
            ))}
            <Button size="sm" onClick={() => save({ reminderTimes: [...s.reminderTimes, '12:30'] })}><Plus size={13} />加一个时间</Button>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!s.weeklyTime} onChange={(e) => save({ weeklyTime: e.target.checked ? '0 20:00' : '' })} />每周复盘提醒</label>
          {s.weeklyTime && <>
            <select className={cx(inputCls, 'w-auto py-1')} value={dow} onChange={(e) => save({ weeklyTime: `${e.target.value} ${hm}` })}>{['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((d, i) => <option key={i} value={i}>{d}</option>)}</select>
            <input type="time" className={cx(inputCls, 'w-auto py-1')} value={hm} onChange={(e) => save({ weeklyTime: `${dow} ${e.target.value}` })} />
          </>}
        </div>
        <div className="flex items-center gap-2 text-sm">
          免打扰
          <input type="time" className={cx(inputCls, 'w-auto py-1')} value={s.quietStart} onChange={(e) => save({ quietStart: e.target.value })} />到
          <input type="time" className={cx(inputCls, 'w-auto py-1')} value={s.quietEnd} onChange={(e) => save({ quietEnd: e.target.value })} />
          <span className="text-xs text-ink-faint">承诺提醒落在这段时间会顺延到结束时</span>
        </div>
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={s.privacyNotify} onChange={(e) => save({ privacyNotify: e.target.checked })} />隐私模式：通知里不显示知识点和承诺的内容</label>
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" disabled={!isTauri || auto === null} checked={!!auto} onChange={async (e) => { await setAutostart(e.target.checked); setAuto(await autostartEnabled()) }} />开机自动启动（启动后只留在托盘，不弹窗口）</label>
        <p className="text-xs text-ink-faint">承诺会在截止前 24 小时、前 1 小时和到期时各提醒一次。</p>
      </div>
    </Section>
  )
}

function Data({ s, save }: P) {
  const [tags, reloadTags] = useLoad(listTags)
  const [newTag, setNewTag] = useState('')
  const file = useRef<HTMLInputElement>(null)
  return (
    <Section title="数据" hint="数据加密保存在你的服务器上，只有登录这个账号才能打开。服务器会保留最近 3 个版本">
      <div className="flex flex-wrap gap-2 mb-3">
        <Button onClick={async () => { try { const path = await saveToDownloads(`复盘便签-备份-${fmtDate(Date.now())}.json`, await exportAll()); toast(`已导出到 ${path}`) } catch (e) { toast(errText(e), 'err') } }}><Download size={14} />导出全部数据</Button>
        <Button onClick={() => file.current?.click()}><Upload size={14} />从备份导入</Button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (!f) return
          if (!(await confirmDialog('导入会覆盖当前所有数据（便签、知识点、复习进度、设置）。\n建议先导出一份当前数据。确定导入吗？', '覆盖并导入', true))) return
          try { await importAll(await f.text()); await flushSave(); toast('导入完成'); setTimeout(() => location.reload(), 600) } catch (err) { toast(errText(err), 'err') }
        }} />
      </div>
      {isTauri && <div className="flex items-center gap-2 text-sm mb-4">
        在这台电脑上额外自动备份：每
        <input type="number" min={0} max={60} className={cx(inputCls, 'w-16 py-1')} value={s.autoBackupDays} onChange={(e) => save({ autoBackupDays: Math.max(0, Number(e.target.value) || 0) })} />
        天一次，保留最近 5 份（0 为关闭）。{s.lastBackupAt ? `上次：${fmtDate(s.lastBackupAt)}` : ''}
      </div>}
      <p className="text-[13px] text-ink-soft mb-1.5">标签库</p>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {(tags ?? []).map((t) => (
          <span key={t.name} title={t.description} className="inline-flex items-center gap-1 rounded-full bg-pen-soft text-pen text-xs pl-2.5 pr-1.5 py-0.5">
            {t.name}{!t.builtin && <button aria-label={`删除 ${t.name}`} className="hover:text-red" onClick={async () => { await deleteTag(t.name); reloadTags() }}>×</button>}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input className={cx(inputCls, 'w-48 py-1')} value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="新标签" />
        <Button size="sm" disabled={!newTag.trim()} onClick={async () => { await addTag(newTag); setNewTag(''); reloadTags() }}>添加</Button>
      </div>
    </Section>
  )
}
