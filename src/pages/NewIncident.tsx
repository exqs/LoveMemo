import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, ClipboardPaste, ImagePlus, Keyboard, X } from 'lucide-react'
import { Page } from '../components/Page'
import { Button, Field, Sheet, Spinner, confirmDialog, cx, errText, inputCls, toast } from '../components/ui'
import { getSettings, saveSettings, useSettings } from '../db/base'
import { addAttachment, createIncident, deleteIncident, replaceMessages } from '../db/incidents'
import { profileFor } from '../ai/client'
import { recognizeImages } from '../ai/tasks'
import { rawToMessages } from '../lib/sample'
import { isPreview } from '../lib/api'

const SOURCES = ['电脑版微信', '手机版微信', 'QQ', '其他']

/** 截图缩到长边 2000px 以内，转 JPEG。省 token，也让数据库小一些 */
export async function fileToDataUrl(file: File, maxSide = 2000): Promise<string> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k)
  c.height = Math.round(bmp.height * k)
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(bmp, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.88)
}


export default function NewIncident() {
  const nav = useNavigate()
  const [s] = useSettings()
  const [imgs, setImgs] = useState<{ name: string; url: string }[]>([])
  const [source, setSource] = useState(SOURCES[0])
  const [herNick, setHerNick] = useState('')
  const [myNick, setMyNick] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (s) { setHerNick((v) => v || s.herNick); setMyNick((v) => v || s.myNick) } }, [s])

  const addFiles = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith('image/'))
    if (!pics.length) return
    const out = await Promise.all(pics.map(async (f) => ({ name: f.name || '粘贴的图片', url: await fileToDataUrl(f) })))
    setImgs((xs) => [...xs, ...out].sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true })))
  }

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length) { e.preventDefault(); addFiles(files) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  const move = (i: number, d: number) => setImgs((xs) => {
    const j = i + d
    if (j < 0 || j >= xs.length) return xs
    const ys = [...xs];
    [ys[i], ys[j]] = [ys[j], ys[i]]
    return ys
  })

  const manual = async (paste = false) => {
    const id = await createIncident({ title: '' })
    nav(`/incident/${id}/edit${paste ? '?paste=1' : ''}`)
  }

  const recognize = async () => {
    if (!herNick.trim() || !myNick.trim()) { toast('请先填写双方昵称，识别要靠昵称区分说话人', 'err'); return }
    const p = await profileFor('recognize')
    if (!isPreview) {
      if (!p) { toast('还没有开启任何 AI 模型，管理员可以在「管理 → AI 模型」里添加', 'err'); return }
      if (!p.supports_vision) { toast(`「${p.name}」不支持图片。请在设置里给截图识别选一个视觉模型`, 'err'); return }
      if (!(await confirmDialog(`截图会经过你的服务器发送到「${p.name}」进行识别。\n确定继续吗？`, '发送并识别'))) return
    }
    await saveSettings({ herNick: herNick.trim(), myNick: myNick.trim() })
    let id = ''
    try {
      setBusy('正在准备…')
      id = await createIncident({ title: '', channel: source.includes('微信') ? '微信' : source })
      const attIds: string[] = []
      for (let i = 0; i < imgs.length; i++) attIds.push(await addAttachment(id, imgs[i].url, i))
      const raw = await recognizeImages(imgs.map((x) => x.url), await getSettings(), source, (i, n) => setBusy(i < n ? `正在识别第 ${i + 1} 张，共 ${n} 张…` : '正在合并去重…'))
      if (!raw.length) throw new Error('没有识别出任何消息。请检查截图是否清晰，或换一个视觉模型。')
      await replaceMessages(id, rawToMessages(id, raw))
      toast(`识别出 ${raw.length} 条消息，请逐条核对`)
      nav(`/incident/${id}/edit`)
    } catch (e) {
      if (id) await deleteIncident(id)
      toast(errText(e), 'err')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Page title="记一次" narrow back={<button onClick={() => nav(-1)} className="text-ink-soft hover:text-pen inline-flex items-center gap-1"><ArrowLeft size={14} />返回</button>}>
      <Sheet className="p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-semibold">从聊天截图识别</h2>
          <span className="text-xs text-ink-faint">手机截图可以先用微信"文件传输助手"发到电脑</span>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles([...e.dataTransfer.files]) }}
          onClick={() => fileRef.current?.click()}
          className={cx('rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors', drag ? 'border-pen bg-pen-soft' : 'border-rule hover:border-ink-faint')}>
          <ImagePlus className="mx-auto text-ink-faint mb-2" size={28} />
          <p>把截图拖到这里，或按 Ctrl+V 粘贴，或点击选择</p>
          <p className="text-xs text-ink-faint mt-1">可以一次放多张，按聊天顺序排好；相邻截图有重叠没关系，会自动去重</p>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
        </div>

        {imgs.length > 0 && (
          <div className="flex gap-3 mt-4 overflow-x-auto pb-2">
            {imgs.map((im, i) => (
              <div key={i} className="shrink-0 w-28">
                <div className="relative">
                  <img src={im.url} alt={`第 ${i + 1} 张`} className="w-28 h-40 object-cover object-top rounded border border-rule" />
                  <span className="absolute top-1 left-1 bg-ink/70 text-white text-[11px] rounded px-1.5">{i + 1}</span>
                  <button className="absolute top-1 right-1 bg-sheet/90 rounded p-0.5 hover:text-red" onClick={() => setImgs((xs) => xs.filter((_, j) => j !== i))} aria-label="移除"><X size={13} /></button>
                </div>
                <div className="flex justify-between mt-1">
                  <button className="text-ink-faint hover:text-pen disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="前移"><ArrowLeft size={14} /></button>
                  <span className="text-[11px] text-ink-faint truncate px-1">{im.name}</span>
                  <button className="text-ink-faint hover:text-pen disabled:opacity-30" disabled={i === imgs.length - 1} onClick={() => move(i, 1)} aria-label="后移"><ArrowRight size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 mt-4">
          <Field label="截图来源">
            <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value)}>{SOURCES.map((x) => <option key={x}>{x}</option>)}</select>
          </Field>
          <Field label={`${s?.herName ?? '她'}在截图里的昵称`}><input className={inputCls} value={herNick} onChange={(e) => setHerNick(e.target.value)} placeholder="例如 Toria" /></Field>
          <Field label="我在截图里的昵称"><input className={inputCls} value={myNick} onChange={(e) => setMyNick(e.target.value)} placeholder="例如 柒" /></Field>
        </div>
        {source === '电脑版微信' && <p className="text-xs text-warn mt-2">电脑版微信截图里双方都在左边，只能靠昵称区分，昵称请填准确。</p>}

        <div className="mt-4 flex items-center gap-3">
          <Button kind="primary" disabled={!imgs.length || !!busy} onClick={recognize}>识别 {imgs.length || ''} 张截图</Button>
          {busy && <Spinner label={busy} />}
        </div>
      </Sheet>

      <div className="grid grid-cols-2 gap-4 mt-4">
        <button onClick={() => manual(false)} className="text-left">
          <Sheet className="p-5 hover:border-ink-faint h-full">
            <Keyboard size={20} className="text-pen mb-2" />
            <p className="font-semibold">手动录入</p>
            <p className="text-sm text-ink-soft mt-1">当面吵的、电话里的，或者没有截图。用"她说""我说"两个按钮一条条补。</p>
          </Sheet>
        </button>
        <button onClick={() => manual(true)} className="text-left">
          <Sheet className="p-5 hover:border-ink-faint h-full">
            <ClipboardPaste size={20} className="text-pen mb-2" />
            <p className="font-semibold">粘贴文字</p>
            <p className="text-sm text-ink-soft mt-1">从电脑微信复制的聊天记录，或"昵称：内容"一行一条的文字，自动拆成消息。</p>
          </Sheet>
        </button>
      </div>
    </Page>
  )
}
