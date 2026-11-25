// 管理（只有超级管理员能看到）：注册码、用户、安全日志。这里看不到任何人的便签内容。
import { useCallback, useEffect, useState } from 'react'
import { Copy, Plus } from 'lucide-react'
import { Page } from '../components/Page'
import { Button, Chip, Field, Modal, Sheet, confirmDialog, cx, errText, inputCls, toast } from '../components/ui'
import { admin, type AdminUser, type AuditEvent, type Invite } from '../lib/api'
import { fmtDate } from '../lib/util'
import AdminModels from './AdminModels'

const fmtTime = (t: number | null) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')
const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function useAsync<T>(fn: () => Promise<T>): [T | undefined, () => void, string] {
  const [data, setData] = useState<T>()
  const [err, setErr] = useState('')
  const reload = useCallback(() => { fn().then((d) => { setData(d); setErr('') }, (e) => setErr(errText(e))) }, [fn])
  useEffect(reload, [reload])
  return [data, reload, err]
}

export default function AdminPage() {
  return (
    <Page narrow title="管理">
      <div className="space-y-5">
        <AdminModels />
        <Invites />
        <Users />
        <Audit />
      </div>
    </Page>
  )
}

const STATUS: Record<Invite['status'], [string, 'ok' | 'warn' | 'red' | 'pen']> = {
  active: ['可用', 'ok'], used: ['已用完', 'pen'], expired: ['已过期', 'warn'], revoked: ['已撤销', 'red'],
}

function Invites() {
  const load = useCallback(() => admin.invites().then((r) => r.invites), [])
  const [list, reload, err] = useAsync(load)
  const [open, setOpen] = useState(false)
  const [uses, setUses] = useState(1)
  const [hours, setHours] = useState(72)
  const [note, setNote] = useState('')
  const [created, setCreated] = useState<{ code: string; expiresAt: number } | null>(null)
  const create = async () => {
    try {
      const r = await admin.createInvite(uses, hours, note.trim())
      setCreated({ code: r.code, expiresAt: r.expiresAt })
      setOpen(false); setNote('')
      reload()
    } catch (e) { toast(errText(e), 'err') }
  }
  return (
    <Sheet className="p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold">注册码</h2>
          <p className="text-xs text-ink-faint">别人要注册，得先有你发的注册码。码只在生成时显示一次，服务器上只存它的指纹。</p>
        </div>
        <Button kind="primary" onClick={() => setOpen(true)}><Plus size={14} />生成注册码</Button>
      </div>
      {err && <p className="text-sm text-red">{err}</p>}
      <div className="space-y-1.5">
        {(list ?? []).map((i) => (
          <div key={i.id} className="flex items-center gap-3 rounded-lg border border-rule px-3 py-2 text-sm">
            <Chip tone={STATUS[i.status][1]}>{STATUS[i.status][0]}</Chip>
            <div className="flex-1 min-w-0">
              <p className="truncate">{i.note || <span className="text-ink-faint">（没有备注）</span>}</p>
              <p className="text-xs text-ink-faint">已用 {i.uses}/{i.maxUses} · {i.status === 'active' ? `${fmtTime(i.expiresAt)} 过期` : `创建于 ${fmtDate(i.createdAt)}`}{i.usedBy.length ? ` · 注册了：${i.usedBy.map((u) => u.username).join('、')}` : ''}</p>
            </div>
            {i.status === 'active' && <Button size="sm" kind="danger" onClick={async () => {
              if (!(await confirmDialog('撤销后这个注册码就不能再用了（已经注册的账号不受影响）。', '撤销', true))) return
              try { await admin.revokeInvite(i.id); reload() } catch (e) { toast(errText(e), 'err') }
            }}>撤销</Button>}
          </div>
        ))}
        {list && !list.length && <p className="text-sm text-ink-faint">还没有生成过注册码。</p>}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="生成注册码"
        footer={<><Button onClick={() => setOpen(false)}>取消</Button><Button kind="primary" onClick={create}>生成</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="可以注册几个账号"><input type="number" min={1} max={50} className={inputCls} value={uses} onChange={(e) => setUses(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} /></Field>
          <Field label="多久后过期">
            <select className={inputCls} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              <option value={1}>1 小时</option><option value={24}>1 天</option><option value={72}>3 天</option><option value={168}>7 天</option><option value={720}>30 天</option>
            </select>
          </Field>
          <Field label="备注（给谁的，可选）" className="col-span-2"><input className={inputCls} maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：给女朋友" /></Field>
        </div>
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title="注册码已生成"
        footer={<Button kind="primary" onClick={() => setCreated(null)}>我已经记下了</Button>}>
        <p className="text-sm text-ink-soft mb-3">这个码只显示这一次，关掉就看不到了。请通过可靠的方式发给对方（当面或私聊），{created && fmtTime(created.expiresAt)} 前有效。</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md bg-paper border border-rule px-3 py-2 font-mono text-[15px] tracking-wider select-all">{created?.code}</code>
          <Button onClick={async () => { try { await navigator.clipboard.writeText(created?.code ?? ''); toast('已复制') } catch { toast('复制失败，请手动选中复制', 'err') } }}><Copy size={14} />复制</Button>
        </div>
      </Modal>
    </Sheet>
  )
}

function Users() {
  const load = useCallback(() => admin.users().then((r) => r.users), [])
  const [list, reload, err] = useAsync(load)
  const [del, setDel] = useState<AdminUser | null>(null)
  const [pw, setPw] = useState('')
  return (
    <Sheet className="p-5">
      <h2 className="font-semibold">用户</h2>
      <p className="text-xs text-ink-faint mb-3">可以停用或删除账号，但看不到、也改不了任何人的便签和密码。</p>
      {err && <p className="text-sm text-red">{err}</p>}
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-ink-faint text-left"><th className="font-normal py-1">用户名</th><th className="font-normal">注册时间</th><th className="font-normal">最近登录</th><th className="font-normal">数据</th><th className="font-normal">AI 今天/累计</th><th /></tr></thead>
        <tbody>
          {(list ?? []).map((u) => (
            <tr key={u.id} className={cx('border-t border-rule', u.disabled && 'text-ink-faint')}>
              <td className="py-1.5">{u.username} {u.role === 'superadmin' && <Chip>管理员</Chip>} {u.disabled && <Chip tone="red">已停用</Chip>}</td>
              <td>{fmtDate(u.createdAt)}</td>
              <td>{fmtTime(u.lastLoginAt)}</td>
              <td>{u.dataSize ? fmtSize(u.dataSize) : '—'}</td>
              <td>{u.callsToday} / {u.callsTotal}</td>
              <td className="text-right whitespace-nowrap">
                {u.role !== 'superadmin' && <>
                  <Button size="sm" kind="ghost" onClick={async () => {
                    if (!u.disabled && !(await confirmDialog(`停用「${u.username}」？对方会立刻退出登录，之后也登录不了，数据会保留。`, '停用', true))) return
                    try { await admin.setDisabled(u.id, !u.disabled); reload() } catch (e) { toast(errText(e), 'err') }
                  }}>{u.disabled ? '恢复' : '停用'}</Button>
                  <Button size="sm" kind="danger" onClick={() => { setPw(''); setDel(u) }}>删除</Button>
                </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Modal open={!!del} onClose={() => setDel(null)} title={`删除「${del?.username ?? ''}」`}
        footer={<><Button onClick={() => setDel(null)}>取消</Button><Button kind="red" disabled={!pw} onClick={async () => {
          try { await admin.deleteUser(del!.id, pw); toast('已删除'); setDel(null); reload() } catch (e) { toast(errText(e), 'err') }
        }}>永久删除</Button></>}>
        <p className="text-sm mb-3">这个账号和它的全部数据会被永久删除，不能恢复。请输入你自己的密码确认。</p>
        <input type="password" autoComplete="current-password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="你的密码" />
      </Modal>
    </Sheet>
  )
}

const EVENTS: Record<string, string> = {
  server_start: '服务启动', setup_ok: '创建管理员', setup_fail: '安装码错误', login_ok: '登录成功', login_fail: '密码错误', login_locked: '账号锁定中仍在尝试',
  login_disabled: '停用账号尝试登录', logout: '退出登录', logout_all: '退出所有设备', register_ok: '注册成功', register_bad_invite: '注册码错误',
  password_changed: '修改密码', password_change_fail: '修改密码时原密码错误', invite_created: '生成注册码', invite_revoked: '撤销注册码',
  user_disabled: '停用用户', user_enabled: '恢复用户', user_deleted: '删除用户', admin_reauth_fail: '管理员确认密码错误', admin_password_reset_cli: '在服务器上重设管理员密码',
  llm_probe: '获取模型列表', llm_provider_created: '添加 AI 服务商', llm_provider_updated: '修改 AI 服务商', llm_provider_deleted: '删除 AI 服务商',
  llm_models_added: '添加模型', llm_model_updated: '修改模型', llm_model_deleted: '删除模型', llm_reauth_fail: '配置模型时密码错误',
}
const DANGER = new Set(['setup_fail', 'login_fail', 'login_locked', 'register_bad_invite', 'password_change_fail', 'admin_reauth_fail', 'login_disabled', 'llm_reauth_fail'])

function Audit() {
  const load = useCallback(() => admin.audit().then((r) => r.events), [])
  const [list, reload, err] = useAsync<AuditEvent[]>(load)
  const [onlyBad, setOnlyBad] = useState(false)
  const shown = (list ?? []).filter((e) => !onlyBad || DANGER.has(e.event))
  return (
    <Sheet className="p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold">安全日志</h2>
          <p className="text-xs text-ink-faint">最近 300 条。连续输错密码会自动锁定，不需要你手动处理。</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} />只看异常</label>
          <Button size="sm" onClick={reload}>刷新</Button>
        </div>
      </div>
      {err && <p className="text-sm text-red">{err}</p>}
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full text-[13px]">
          <tbody>
            {shown.map((e, i) => (
              <tr key={i} className={cx('border-t border-rule', DANGER.has(e.event) && 'text-red')}>
                <td className="py-1 pr-3 whitespace-nowrap text-ink-faint">{fmtTime(e.at)}</td>
                <td className="pr-3 whitespace-nowrap">{EVENTS[e.event] ?? e.event}</td>
                <td className="pr-3">{e.username}</td>
                <td className="pr-3 text-ink-faint whitespace-nowrap">{e.ip}</td>
                <td className="text-ink-faint break-all">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sheet>
  )
}
