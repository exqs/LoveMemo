// 管理页 · AI 模型：填端点地址和 API Key → 获取模型列表 → 多选添加 → 开启。
// Key 只交给服务器加密保存，这里和任何接口都拿不回明文。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Chip, Field, Modal, Sheet, Spinner, confirmDialog, cx, errText, inputCls, toast } from '../components/ui'
import { llmAdmin, type AdminModel, type AdminProvider, type ProbeModel, type RouteKey } from '../lib/api'
import { invalidateModels } from '../db/misc'

type Protocol = 'openai' | 'anthropic'
interface Preset { name: string; protocol: Protocol; base_url: string; note?: string }
const PRESETS: Preset[] = [
  { name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com' },
  { name: 'Claude（Anthropic）', protocol: 'anthropic', base_url: 'https://api.anthropic.com' },
  { name: 'OpenAI', protocol: 'openai', base_url: 'https://api.openai.com/v1' },
  { name: '通义千问', protocol: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: 'Kimi', protocol: 'openai', base_url: 'https://api.moonshot.cn/v1' },
  { name: '智谱', protocol: 'openai', base_url: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: '硅基流动', protocol: 'openai', base_url: 'https://api.siliconflow.cn/v1' },
  { name: 'OpenRouter', protocol: 'openai', base_url: 'https://openrouter.ai/api/v1' },
  { name: 'Ollama（内网）', protocol: 'openai', base_url: 'http://', note: '需要服务器设置 ALLOW_PRIVATE_LLM_HOSTS=1，地址填服务器能访问到的内网地址，例如 http://192.168.1.10:11434/v1' },
  { name: '自定义', protocol: 'openai', base_url: '' },
]
const ROUTE_LABEL: [RouteKey, string][] = [['recognize', '截图识别'], ['analyze', '复盘'], ['quiz', '出题'], ['roleplay', '角色扮演']]
const PROTOCOL_LABEL: Record<Protocol, string> = { openai: 'OpenAI 兼容', anthropic: 'Anthropic' }

export default function AdminModels() {
  const [data, setData] = useState<Awaited<ReturnType<typeof llmAdmin.list>>>()
  const [err, setErr] = useState('')
  const reload = useCallback(() => { llmAdmin.list().then((d) => { setData(d); setErr('') }, (e) => setErr(errText(e))) }, [])
  useEffect(reload, [reload])
  const changed = useCallback(() => { reload(); invalidateModels() }, [reload])
  const [adding, setAdding] = useState(false)
  const total = (data?.providers ?? []).reduce((n, p) => n + (p.enabled ? p.models.filter((m) => m.enabled).length : 0), 0)
  return (
    <Sheet className="p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold">AI 模型</h2>
          <p className="text-xs text-ink-faint">填端点地址和 API Key，获取模型列表后勾选要开放的模型。Key 加密保存在服务器上，谁都看不到明文。现在开启了 {total} 个模型。</p>
        </div>
        <Button kind="primary" onClick={() => setAdding(true)}><Plus size={14} />添加服务商</Button>
      </div>
      {err && <p className="text-sm text-red">{err}</p>}
      <div className="space-y-3">
        {(data?.providers ?? []).map((p) => <ProviderCard key={p.id} p={p} onChange={changed} />)}
        {data && !data.providers.length && <p className="text-sm text-ink-faint">还没有添加服务商。添加之后，大家才能用 AI 复盘和出题。</p>}
      </div>
      {adding && <AddProvider onClose={() => setAdding(false)} onDone={() => { setAdding(false); changed() }} />}
    </Sheet>
  )
}

function ProviderCard({ p, onChange }: { p: AdminProvider; onChange: () => void }) {
  const [picking, setPicking] = useState<ProbeModel[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const fetchList = async () => {
    setBusy(true)
    try { setPicking((await llmAdmin.probe({ providerId: p.id, protocol: p.protocol, base_url: p.base_url })).models) } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
  }
  const run = async (f: () => Promise<unknown>) => { try { await f(); onChange() } catch (e) { toast(errText(e), 'err') } }
  return (
    <div className={cx('rounded-lg border border-rule', !p.enabled && 'opacity-70')}>
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-rule">
        <label className="flex items-center gap-1.5 text-sm shrink-0" title="关掉后这个服务商下的模型都不能用">
          <input type="checkbox" checked={p.enabled} onChange={(e) => run(() => llmAdmin.update(p.id, { enabled: e.target.checked }))} />开启
        </label>
        <div className="flex-1 min-w-0">
          <p className="font-medium">{p.name} <span className="text-xs text-ink-faint font-normal">{PROTOCOL_LABEL[p.protocol]}</span></p>
          <p className="text-xs text-ink-faint truncate">{p.base_url} · {p.hasKey ? `Key 已保存${p.keyHint ? `（尾号 ${p.keyHint}）` : ''}` : '没有 Key'}</p>
        </div>
        <Button size="sm" disabled={busy} onClick={fetchList}><RefreshCw size={13} className={cx(busy && 'animate-spin')} />获取模型列表</Button>
        <Button size="sm" kind="ghost" onClick={() => setEditing(true)}>修改</Button>
        <Button size="sm" kind="danger" onClick={async () => {
          if (await confirmDialog(`删除「${p.name}」和它下面的 ${p.models.length} 个模型？正在用这些模型的人需要换一个。`, '删除', true)) run(() => llmAdmin.remove(p.id))
        }}>删除</Button>
      </div>
      {p.models.length ? (
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-ink-faint text-left"><th className="font-normal px-3 py-1 w-14">开启</th><th className="font-normal">模型</th><th className="font-normal">支持图片</th><th className="font-normal">推荐用途</th><th className="font-normal">最大输出</th><th /></tr></thead>
          <tbody>{p.models.map((m) => <ModelRow key={m.id} m={m} run={run} />)}</tbody>
        </table>
      ) : <p className="text-sm text-ink-faint px-3 py-2.5">还没有添加模型，点「获取模型列表」选一些。</p>}
      {picking && (
        <Modal open wide title={`从「${p.name}」添加模型`} onClose={() => setPicking(null)}
          footer={<PickFooter onCancel={() => setPicking(null)} />}>
          <ModelPicker list={picking} existing={new Set(p.models.map((m) => m.model))} submitLabel="添加选中的模型"
            onSubmit={async (sel) => { await llmAdmin.addModels(p.id, sel); toast(`添加了 ${sel.length} 个模型`); setPicking(null); onChange() }} />
        </Modal>
      )}
      {editing && <EditProvider p={p} onClose={() => setEditing(false)} onDone={() => { setEditing(false); onChange() }} />}
    </div>
  )
}

function ModelRow({ m, run }: { m: AdminModel; run: (f: () => Promise<unknown>) => void }) {
  const [maxTok, setMaxTok] = useState(String(m.max_tokens))
  useEffect(() => setMaxTok(String(m.max_tokens)), [m.max_tokens])
  return (
    <tr className={cx('border-t border-rule', !m.enabled && 'text-ink-faint')}>
      <td className="px-3 py-1.5"><input type="checkbox" aria-label={`开启 ${m.model}`} checked={m.enabled} onChange={(e) => run(() => llmAdmin.updateModel(m.id, { enabled: e.target.checked }))} /></td>
      <td className="pr-3 break-all">{m.name !== m.model ? <>{m.name} <span className="text-xs text-ink-faint">{m.model}</span></> : m.model}</td>
      <td><input type="checkbox" aria-label={`${m.model} 支持图片`} checked={m.supports_vision} onChange={(e) => run(() => llmAdmin.updateModel(m.id, { supports_vision: e.target.checked }))} /></td>
      <td className="pr-2">
        <div className="flex flex-wrap gap-1">
          {ROUTE_LABEL.map(([k, label]) => (
            <Chip key={k} active={m.routes.includes(k)} onClick={() => run(() => llmAdmin.updateModel(m.id, { routes: m.routes.includes(k) ? m.routes.filter((x) => x !== k) : [...m.routes, k] }))}>{label}</Chip>
          ))}
        </div>
      </td>
      <td className="pr-2"><input type="number" min={256} max={200000} className={cx(inputCls, 'w-24 py-0.5')} value={maxTok} onChange={(e) => setMaxTok(e.target.value)}
        onBlur={() => { const v = Math.round(Number(maxTok)); if (v !== m.max_tokens && v >= 256 && v <= 200000) run(() => llmAdmin.updateModel(m.id, { max_tokens: v })); else setMaxTok(String(m.max_tokens)) }} /></td>
      <td className="pr-2 text-right"><button className="text-ink-faint hover:text-red p-1" aria-label={`删除 ${m.model}`} onClick={() => run(() => llmAdmin.removeModel(m.id))}><Trash2 size={14} /></button></td>
    </tr>
  )
}

/** 模型多选：搜索、全选当前筛选结果、手动补一个列表里没有的模型名 */
function ModelPicker({ list: initial, existing, submitLabel, extra, onSubmit }: { list: ProbeModel[]; existing: Set<string>; submitLabel: string; extra?: React.ReactNode; onSubmit: (sel: { model: string; name: string }[]) => Promise<void> }) {
  const [list, setList] = useState(initial)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const shown = useMemo(() => list.filter((m) => !q.trim() || (m.id + ' ' + m.name).toLowerCase().includes(q.trim().toLowerCase())), [list, q])
  const selectable = shown.filter((m) => !existing.has(m.id))
  const allOn = selectable.length > 0 && selectable.every((m) => sel.has(m.id))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const addManual = () => {
    const id = manual.trim()
    if (!id) return
    if (!list.some((m) => m.id === id)) setList((l) => [{ id, name: id }, ...l])
    setSel((s) => new Set(s).add(id))
    setManual('')
  }
  return (
    <div>
      <div className="flex gap-2 mb-2">
        <input className={cx(inputCls, 'flex-1')} placeholder={`在 ${list.length} 个模型里搜索`} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button disabled={!selectable.length} onClick={() => setSel((s) => { const n = new Set(s); selectable.forEach((m) => (allOn ? n.delete(m.id) : n.add(m.id))); return n })}>{allOn ? '全不选' : '全选'}</Button>
      </div>
      <div className="max-h-[300px] overflow-auto rounded-md border border-rule divide-y divide-rule">
        {shown.map((m) => {
          const had = existing.has(m.id)
          return (
            <label key={m.id} className={cx('flex items-center gap-2 px-3 py-1.5 text-sm', had ? 'text-ink-faint' : 'cursor-pointer hover:bg-paper')}>
              <input type="checkbox" disabled={had} checked={had || sel.has(m.id)} onChange={() => toggle(m.id)} />
              <span className="break-all">{m.id}</span>
              {m.name !== m.id && <span className="text-xs text-ink-faint">{m.name}</span>}
              {had && <span className="ml-auto text-xs">已添加</span>}
            </label>
          )
        })}
        {!shown.length && <p className="px-3 py-3 text-sm text-ink-faint">{list.length ? '没有搜到。' : '列表是空的，可以在下面手动填写模型名。'}</p>}
      </div>
      <div className="flex gap-2 mt-2">
        <input className={cx(inputCls, 'flex-1')} placeholder="列表里没有？手动填写模型名，例如 deepseek-flash" value={manual} maxLength={200} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual() } }} />
        <Button onClick={addManual} disabled={!manual.trim()}>加入</Button>
      </div>
      {extra}
      <div className="flex justify-end mt-3">
        <Button kind="primary" disabled={busy || !sel.size} onClick={async () => {
          setBusy(true)
          try { await onSubmit(list.filter((m) => sel.has(m.id)).map((m) => ({ model: m.id, name: m.name }))) } catch (e) { toast(errText(e), 'err') } finally { setBusy(false) }
        }}>{busy ? '请稍等…' : `${submitLabel}（${sel.size} 个）`}</Button>
      </div>
    </div>
  )
}

function PickFooter({ onCancel }: { onCancel: () => void }) {
  return <Button onClick={onCancel}>取消</Button>
}

function ProviderFields({ v, set, keyHint }: { v: { name: string; protocol: Protocol; base_url: string; api_key: string }; set: (p: Partial<typeof v>) => void; keyHint: string }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="名称"><input className={inputCls} value={v.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} /></Field>
      <Field label="接口协议">
        <select className={inputCls} value={v.protocol} onChange={(e) => set({ protocol: e.target.value as Protocol })}>
          <option value="openai">OpenAI 兼容（Chat Completions）</option><option value="anthropic">Anthropic（Messages）</option>
        </select>
      </Field>
      <Field label="端点地址（Base URL）" className="col-span-2" hint="填到 /v1 为止即可，也可以填完整的 …/chat/completions"><input className={inputCls} value={v.base_url} spellCheck={false} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://…" /></Field>
      <Field label="API Key" className="col-span-2" hint={keyHint}><input type="password" autoComplete="off" className={inputCls} value={v.api_key} onChange={(e) => set({ api_key: e.target.value })} placeholder="sk-…" /></Field>
    </div>
  )
}

function AddProvider({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ name: PRESETS[0].name, protocol: PRESETS[0].protocol, base_url: PRESETS[0].base_url, api_key: '' })
  const [preset, setPreset] = useState(0)
  const [list, setList] = useState<ProbeModel[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [pw, setPw] = useState('')
  const set = (p: Partial<typeof v>) => { setV((x) => ({ ...x, ...p })); setList(null); setErr('') }
  const probe = async () => {
    setBusy(true); setErr('')
    try { setList((await llmAdmin.probe({ protocol: v.protocol, base_url: v.base_url.trim(), api_key: v.api_key.trim() })).models) } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal open wide title="添加 AI 服务商" onClose={onClose} footer={<Button onClick={onClose}>取消</Button>}>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {PRESETS.map((p, i) => <Chip key={p.name} active={preset === i} onClick={() => { setPreset(i); set({ name: p.name.replace(/（.*）/, ''), protocol: p.protocol, base_url: p.base_url }) }}>{p.name}</Chip>)}
      </div>
      <ProviderFields v={v} set={set} keyHint="只保存在服务器上，加密存放。本机模型不需要可以不填" />
      {PRESETS[preset].note && <p className="text-xs text-warn mt-2">{PRESETS[preset].note}</p>}
      <div className="flex items-center gap-2 mt-3">
        <Button kind={list ? 'line' : 'primary'} disabled={busy || !v.base_url.trim()} onClick={probe}><RefreshCw size={14} className={cx(busy && 'animate-spin')} />获取模型列表</Button>
        {!list && <button className="text-sm text-ink-soft underline" onClick={() => { setList([]); setErr('') }}>不获取，手动填写模型名</button>}
        {busy && <Spinner label="正在连接…" />}
      </div>
      {err && <p className="text-sm text-red mt-2" role="alert">{err}</p>}
      {list && (
        <div className="mt-4 pt-4 border-t border-rule">
          <p className="text-sm text-ink-soft mb-2">勾选要开放给大家用的模型：</p>
          <ModelPicker list={list} existing={new Set()} submitLabel="保存并开启"
            extra={<Field label="你的登录密码（保存 API Key 前确认一下是你本人）" className="mt-3"><input type="password" autoComplete="current-password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>}
            onSubmit={async (sel) => {
              if (!pw) throw new Error('请输入你的登录密码')
              const r = await llmAdmin.create({ name: v.name.trim(), protocol: v.protocol, base_url: v.base_url.trim(), api_key: v.api_key.trim(), models: sel, password: pw })
              toast(`已添加，开启了 ${r.added} 个模型`)
              onDone()
            }} />
        </div>
      )}
    </Modal>
  )
}

function EditProvider({ p, onClose, onDone }: { p: AdminProvider; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ name: p.name, protocol: p.protocol, base_url: p.base_url, api_key: '' })
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const urlChanged = v.base_url.trim().replace(/\/+$/, '') !== p.base_url || v.protocol !== p.protocol
  const needPw = urlChanged || !!v.api_key.trim()
  const save = async () => {
    setBusy(true); setErr('')
    try {
      await llmAdmin.update(p.id, { name: v.name.trim(), ...(needPw ? { protocol: v.protocol, base_url: v.base_url.trim(), api_key: v.api_key.trim(), password: pw } : {}) })
      toast('已保存'); onDone()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal open wide title={`修改「${p.name}」`} onClose={onClose}
      footer={<><Button onClick={onClose}>取消</Button><Button kind="primary" disabled={busy || (needPw && !pw)} onClick={save}>保存</Button></>}>
      <ProviderFields v={v} set={(x) => setV((o) => ({ ...o, ...x }))}
        keyHint={urlChanged && p.hasKey ? '端点地址改了，请重新填写 API Key（旧 Key 不会发到新地址）' : p.hasKey ? '已保存。留空表示不修改' : '没有 Key。需要的话在这里填'} />
      {needPw && <Field label="你的登录密码（修改地址或 Key 需要确认是你本人）" className="mt-3"><input type="password" autoComplete="current-password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>}
      {err && <p className="text-sm text-red mt-2" role="alert">{err}</p>}
    </Modal>
  )
}
