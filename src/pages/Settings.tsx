// 设置（PRD F10、F12）：基本信息、模型、复习、提醒、数据
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, KeyRound, PlugZap, Plus, Trash2, Upload } from 'lucide-react'
import { Page } from '../components/Page'
import { Button, Chip, Field, Modal, Sheet, Spinner, confirmDialog, cx, errText, inputCls, toast } from '../components/ui'
import { useLoad, useSettings } from '../db/base'
import { resetPreviewDb } from '../db/db'
import { addTag, deleteTag, listTags } from '../db/rules'
import { deleteProfile, exportAll, importAll, listProfiles, saveProfile, usageSummary } from '../db/misc'
import { testProfile } from '../ai/client'
import { autostartEnabled, deleteSecret, hasSecret, isTauri, saveToDownloads, setAutostart, setSecret } from '../lib/platform'
import type { ModelProfile, RouteKey, Settings } from '../lib/types'
import { fmtDate, uid } from '../lib/util'

interface Preset { name: string; protocol: 'openai' | 'anthropic'; base_url: string; model: string; placeholder?: string; vision: boolean; needs_key: boolean; max_tokens: number; quirks?: ModelProfile['quirks']; note?: string }
// 不内置具体模型名的地方，由你填写当前可用的模型
const PRESETS: Preset[] = [
  { name: 'OpenAI（GPT）', protocol: 'openai', base_url: 'https://api.openai.com/v1', model: '', placeholder: '填写你要用的 GPT 模型名', vision: true, needs_key: true, max_tokens: 16000, quirks: { maxCompletionTokens: true } },
  { name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', vision: false, needs_key: true, max_tokens: 8192, note: '官方文档：deepseek-flash 目前由 V4.1-Flash 提供，旧名 deepseek-v4-flash 仍可用。是否支持图片请用"测试连接"确认。' },
  { name: 'Claude（Anthropic）', protocol: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-opus-5-5', vision: true, needs_key: true, max_tokens: 16000, quirks: { noTemperature: true }, note: 'Opus 5.5 的思考始终开启，回复里只取文字部分；输出上限留得比较大。' },
  { name: '通义千问', protocol: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '', vision: true, needs_key: true, max_tokens: 8192 },
  { name: 'Kimi', protocol: 'openai', base_url: 'https://api.moonshot.cn/v1', model: '', vision: false, needs_key: true, max_tokens: 8192 },
  { name: '智谱', protocol: 'openai', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: '', vision: false, needs_key: true, max_tokens: 8192 },
  { name: '硅基流动', protocol: 'openai', base_url: 'https://api.siliconflow.cn/v1', model: '', vision: false, needs_key: true, max_tokens: 8192 },
  { name: 'OpenRouter', protocol: 'openai', base_url: 'https://openrouter.ai/api/v1', model: '', vision: false, needs_key: true, max_tokens: 8192 },
  { name: 'Ollama（本机）', protocol: 'openai', base_url: 'http://localhost:11434/v1', model: '', vision: false, needs_key: false, max_tokens: 8192, note: '本机模型，聊天记录不出电脑。' },
  { name: 'LM Studio（本机）', protocol: 'openai', base_url: 'http://localhost:1234/v1', model: '', vision: false, needs_key: false, max_tokens: 8192 },
  { name: '自定义', protocol: 'openai', base_url: '', model: '', vision: false, needs_key: true, max_tokens: 8192 },
]
const ROUTES: [RouteKey, string, string][] = [
  ['recognize', '截图识别', '需要支持图片'], ['analyze', '复盘分析和知识点归属', '建议用最强的'], ['quiz', '出题和评分', ''], ['roleplay', '角色扮演', '可以用便宜的快模型'],
]

export default function SettingsPage() {
  const [s, save] = useSettings()
  if (!s) return null
  return (
    <Page narrow title="设置">
      <div className="space-y-5">
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
  const [profiles, reload] = useLoad(listProfiles)
  const [usage] = useLoad(usageSummary)
  const [edit, setEdit] = useState<ModelProfile | null>(null)
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  useEffect(() => { (profiles ?? []).forEach((p) => hasSecret(p.id).then((h) => setKeys((k) => ({ ...k, [p.id]: h })))) }, [profiles])
  const fromPreset = (pr: Preset): ModelProfile => ({
    id: uid(), name: pr.name.replace(/（.*）/, ''), protocol: pr.protocol, base_url: pr.base_url, model: pr.model, supports_vision: pr.vision, supports_json: true,
    temperature: null, max_tokens: pr.max_tokens, timeout_s: 120, needs_key: pr.needs_key, quirks: pr.quirks ?? {}, price_in: null, price_out: null, created_at: 0,
  })
  return (
    <Section title="模型" hint="可以配多个，再按任务分配。API Key 存在 Windows 凭据管理器里，不进数据库">
      {!isTauri && <p className="text-xs text-warn mb-3">浏览器预览不会真正调用模型，所有 AI 结果都是模拟内容。</p>}
      <div className="space-y-2 mb-3">
        {(profiles ?? []).map((p) => (
          <div key={p.id} className="flex items-center gap-3 rounded-lg border border-rule px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <p className="font-medium">{p.name} <span className="text-ink-faint font-normal text-sm">{p.model}</span></p>
              <p className="text-xs text-ink-faint truncate">{p.protocol === 'anthropic' ? 'Anthropic 协议' : 'OpenAI 兼容'} · {p.base_url}</p>
            </div>
            {p.supports_vision && <Chip tone="ok">支持图片</Chip>}
            {p.needs_key && !keys[p.id] && <Chip tone="red">没有 Key</Chip>}
            <Button size="sm" onClick={() => setEdit(p)}>编辑</Button>
          </div>
        ))}
        {!profiles?.length && <p className="text-sm text-ink-faint">还没有模型。选一个服务商开始：</p>}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-5">
        {PRESETS.map((pr) => <Chip key={pr.name} onClick={() => setEdit(fromPreset(pr))}><Plus size={11} className="mr-0.5" />{pr.name}</Chip>)}
      </div>

      {!!profiles?.length && (
        <div className="grid grid-cols-2 gap-3">
          {ROUTES.map(([k, label, hint]) => (
            <Field key={k} label={label} hint={hint}>
              <select className={inputCls} value={s.routing[k] ?? ''} onChange={(e) => save({ routing: { ...s.routing, [k]: e.target.value || null } })}>
                <option value="">自动（{k === 'recognize' ? '第一个支持图片的' : '第一个'}）</option>
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
      {edit && <ProfileModal p={edit} hasKey={!!keys[edit.id]} onClose={() => { setEdit(null); reload() }} />}
    </Section>
  )
}

function ProfileModal({ p: init, hasKey, onClose }: { p: ModelProfile; hasKey: boolean; onClose: () => void }) {
  const [p, setP] = useState(init)
  const [key, setKey] = useState('')
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({})
  const preset = PRESETS.find((x) => x.base_url && x.base_url === p.base_url)
  const set = (x: Partial<ModelProfile>) => setP({ ...p, ...x })
  const valid = p.name.trim() && p.base_url.trim() && p.model.trim() && /^https?:\/\//.test(p.base_url.trim())
  const persist = async () => {
    await saveProfile({ ...p, name: p.name.trim(), base_url: p.base_url.trim(), model: p.model.trim() })
    if (key.trim()) await setSecret(p.id, key.trim())
    setKey('')
  }
  const runTest = async () => {
    await persist()
    setTest({ busy: true })
    try {
      const r = await testProfile(p)
      setTest({ ok: true, text: `连接成功，耗时 ${r.ms}ms。${r.vision === undefined ? '' : r.vision ? '图片识别正常。' : '没能识别测试图片，可能不支持图片，建议取消勾选"支持图片"。'}` })
    } catch (e) { setTest({ ok: false, text: errText(e) }) }
  }
  return (
    <Modal open onClose={onClose} title={init.created_at ? '编辑模型' : '添加模型'} wide
      footer={<>
        {init.created_at > 0 && <Button kind="danger" className="mr-auto" onClick={async () => { if (await confirmDialog(`删除「${p.name}」？Key 也会一起删除。`, '删除', true)) { await deleteSecret(p.id); await deleteProfile(p.id); onClose() } }}><Trash2 size={14} />删除</Button>}
        <Button onClick={runTest} disabled={!valid || test.busy}><PlugZap size={14} />保存并测试连接</Button>
        <Button kind="primary" disabled={!valid} onClick={async () => { await persist(); toast('已保存'); onClose() }}>保存</Button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="名称"><input className={inputCls} value={p.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="接口协议">
          <select className={inputCls} value={p.protocol} onChange={(e) => set({ protocol: e.target.value as ModelProfile['protocol'] })}>
            <option value="openai">OpenAI 兼容（Chat Completions）</option><option value="anthropic">Anthropic（Messages）</option>
          </select>
        </Field>
        <Field label="API 端点（Base URL）" className="col-span-2" hint="填到 /v1 为止即可，也可以填完整的 …/chat/completions"><input className={inputCls} value={p.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://…" /></Field>
        <Field label="模型名"><input className={inputCls} value={p.model} onChange={(e) => set({ model: e.target.value })} placeholder={PRESETS.find((x) => x.base_url === p.base_url)?.placeholder ?? '例如 deepseek-flash'} /></Field>
        <Field label="API Key" hint={!p.needs_key ? '本机模型不需要' : hasKey ? '已保存。留空表示不修改' : '保存后存进 Windows 凭据管理器'}>
          <div className="relative"><KeyRound size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input type="password" autoComplete="off" disabled={!p.needs_key} className={cx(inputCls, 'pl-8')} value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? '••••••••' : 'sk-…'} /></div>
        </Field>
        <div className="col-span-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={p.supports_vision} onChange={(e) => set({ supports_vision: e.target.checked })} />支持图片（截图识别需要）</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={p.supports_json} onChange={(e) => set({ supports_json: e.target.checked })} />支持 JSON 输出模式</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={!p.needs_key} onChange={(e) => set({ needs_key: !e.target.checked })} />不需要 Key</label>
        </div>
        <Field label="最大输出 token"><input type="number" className={inputCls} value={p.max_tokens} onChange={(e) => set({ max_tokens: Number(e.target.value) || 4096 })} /></Field>
        <Field label="超时（秒）"><input type="number" className={inputCls} value={p.timeout_s} onChange={(e) => set({ timeout_s: Number(e.target.value) || 120 })} /></Field>
        <Field label="输入单价（元 / 百万 token，可选）"><input type="number" step="0.01" className={inputCls} value={p.price_in ?? ''} onChange={(e) => set({ price_in: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
        <Field label="输出单价（元 / 百万 token，可选）"><input type="number" step="0.01" className={inputCls} value={p.price_out ?? ''} onChange={(e) => set({ price_out: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
      </div>
      {preset?.note && <p className="text-xs text-ink-soft mt-3">{preset.note}</p>}
      {Object.values(p.quirks).some(Boolean) && <p className="text-xs text-ink-faint mt-2">已自动适配：{[p.quirks.noTemperature && '不发送温度参数', p.quirks.maxCompletionTokens && '用 max_completion_tokens', p.quirks.noResponseFormat && '不用 JSON 模式参数'].filter(Boolean).join('、')}。<button className="underline" onClick={() => set({ quirks: {} })}>重置</button></p>}
      {test.busy && <div className="mt-3"><Spinner label="测试中…" /></div>}
      {test.text && <p className={cx('text-sm mt-3', test.ok ? 'text-ok' : 'text-red')}>{test.text}</p>}
    </Modal>
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
    <Section title="数据" hint="所有数据只存在这台电脑上">
      <div className="flex flex-wrap gap-2 mb-3">
        <Button onClick={async () => { try { const path = await saveToDownloads(`复盘便签-备份-${fmtDate(Date.now())}.json`, await exportAll()); toast(`已导出到 ${path}`) } catch (e) { toast(errText(e), 'err') } }}><Download size={14} />导出全部数据</Button>
        <Button onClick={() => file.current?.click()}><Upload size={14} />从备份导入</Button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (!f) return
          if (!(await confirmDialog('导入会覆盖当前所有数据（便签、知识点、复习进度、设置）。\n建议先导出一份当前数据。确定导入吗？', '覆盖并导入', true))) return
          try { await importAll(await f.text()); toast('导入完成'); setTimeout(() => location.reload(), 600) } catch (err) { toast(errText(err), 'err') }
        }} />
        {!isTauri && <Button kind="danger" onClick={async () => { if (await confirmDialog('清空浏览器预览里的全部数据？', '清空', true)) { await resetPreviewDb(); location.reload() } }}>清空预览数据</Button>}
      </div>
      <div className="flex items-center gap-2 text-sm mb-4">
        自动备份：每
        <input type="number" min={0} max={60} className={cx(inputCls, 'w-16 py-1')} value={s.autoBackupDays} onChange={(e) => save({ autoBackupDays: Math.max(0, Number(e.target.value) || 0) })} />
        天一次，保留最近 5 份（0 为关闭）。{s.lastBackupAt ? `上次：${fmtDate(s.lastBackupAt)}` : ''}
      </div>
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
