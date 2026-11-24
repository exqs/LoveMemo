import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function cx(...xs: (string | false | null | undefined)[]) { return xs.filter(Boolean).join(' ') }

type BtnKind = 'primary' | 'ghost' | 'danger' | 'line' | 'red'
export function Button({ kind = 'line', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; size?: 'sm' | 'md' | 'lg' }) {
  const k = {
    primary: 'bg-pen text-white hover:bg-[#1b3456] disabled:bg-[#8a9bb3]',
    line: 'bg-sheet text-ink border border-rule hover:border-ink-faint',
    ghost: 'text-ink-soft hover:bg-pen-soft hover:text-pen',
    danger: 'text-red hover:bg-red-soft',
    red: 'bg-red text-white hover:bg-[#ad3727]',
  }[kind]
  const s = { sm: 'h-7 px-2.5 text-[13px]', md: 'h-9 px-3.5 text-sm', lg: 'h-12 px-6 text-base' }[size]
  return <button {...p} className={cx('inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60', k, s, className)} />
}

export function Sheet({ className, children, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={cx('bg-sheet border border-rule rounded-[10px]', className)}>{children}</div>
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="block text-[13px] text-ink-soft mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-faint mt-1">{hint}</span>}
    </label>
  )
}

export const inputCls = 'w-full rounded-md border border-rule bg-sheet px-2.5 py-1.5 outline-none focus:border-pen'

export function Chip({ children, active, onClick, tone = 'pen' }: { children: ReactNode; active?: boolean; onClick?: () => void; tone?: 'pen' | 'red' | 'ok' | 'warn' }) {
  const t = { pen: ['bg-pen-soft text-pen', 'bg-pen text-white'], red: ['bg-red-soft text-red', 'bg-red text-white'], ok: ['bg-ok-soft text-ok', 'bg-ok text-white'], warn: ['bg-warn-soft text-warn', 'bg-warn text-white'] }[tone]
  const C = onClick ? 'button' : 'span'
  return <C type={onClick ? 'button' : undefined} onClick={onClick} className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs', active ? t[1] : t[0], onClick && 'cursor-pointer')}>{children}</C>
}

/** 严重度：用 1 到 5 个红点表示，像批改时打的记号 */
export function Severity({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={`严重度 ${value}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={!onChange} onClick={() => onChange?.(n)} title={`严重度 ${n}`}
          className={cx('size-2.5 rounded-full border', n <= value ? 'bg-red border-red' : 'bg-transparent border-rule', onChange && 'cursor-pointer hover:scale-125 transition-transform')} />
      ))}
    </span>
  )
}

/** 掌握度色条 */
export function Mastery({ value, className }: { value: number; className?: string }) {
  const color = value < 0.34 ? 'var(--color-red)' : value < 0.67 ? 'var(--color-warn)' : 'var(--color-ok)'
  return <span className={cx('block h-1.5 rounded-full bg-grid overflow-hidden', className)}><span className="block h-full rounded-full" style={{ width: `${Math.max(4, value * 100)}%`, background: color }} /></span>
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="py-14 text-center">
      <p className="text-lg text-ink mb-1">{title}</p>
      {children && <p className="text-ink-soft text-sm max-w-md mx-auto">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return <span className="inline-flex items-center gap-2 text-ink-soft text-sm"><span className="size-4 rounded-full border-2 border-pen border-t-transparent animate-spin" />{label}</span>
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx('bg-sheet rounded-[12px] shadow-[0_12px_40px_rgba(31,42,55,0.18)] w-full max-h-[86vh] flex flex-col', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="关闭"><X size={18} /></button>
        </div>
        <div className="px-5 pb-4 overflow-auto">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-rule flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

// ---------- 全局提示和确认框 ----------
type ToastItem = { id: number; text: string; kind: 'ok' | 'err' | 'info' }
let toasts: ToastItem[] = []
const toastSubs = new Set<(t: ToastItem[]) => void>()
export function toast(text: string, kind: ToastItem['kind'] = 'ok') {
  const id = Date.now() + Math.random()
  toasts = [...toasts, { id, text, kind }]
  toastSubs.forEach((f) => f(toasts))
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); toastSubs.forEach((f) => f(toasts)) }, kind === 'err' ? 7000 : 3200)
}

type Ask = { message: string; okText: string; danger: boolean; input?: { placeholder: string; required: boolean }; resolve: (v: string | null) => void }
let ask: Ask | null = null
const askSubs = new Set<(a: Ask | null) => void>()
function setAsk(a: Ask | null) { ask = a; askSubs.forEach((f) => f(a)) }
export function confirmDialog(message: string, okText = '确定', danger = false): Promise<boolean> {
  return new Promise((res) => setAsk({ message, okText, danger, resolve: (v) => res(v !== null) }))
}
export function promptDialog(message: string, placeholder = '', required = true): Promise<string | null> {
  return new Promise((res) => setAsk({ message, okText: '确定', danger: false, input: { placeholder, required }, resolve: res }))
}

export function GlobalLayer() {
  const [ts, setTs] = useState(toasts)
  const [a, setA] = useState(ask)
  const [val, setVal] = useState('')
  useEffect(() => { toastSubs.add(setTs); askSubs.add(setA); return () => { toastSubs.delete(setTs); askSubs.delete(setA) } }, [])
  useEffect(() => { setVal('') }, [a])
  const done = (v: string | null) => { a?.resolve(v); setAsk(null) }
  return (
    <>
      <div className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2 items-end" aria-live="polite">
        {ts.map((t) => (
          <div key={t.id} className={cx('max-w-sm rounded-md px-3.5 py-2 text-sm shadow-[0_6px_20px_rgba(31,42,55,0.15)]', t.kind === 'err' ? 'bg-red text-white' : t.kind === 'info' ? 'bg-sheet text-ink border border-rule' : 'bg-ink text-white')}>{t.text}</div>
        ))}
      </div>
      <Modal open={!!a} onClose={() => done(null)} title={a?.input ? '请填写' : '请确认'}
        footer={<><Button onClick={() => done(null)}>取消</Button><Button kind={a?.danger ? 'red' : 'primary'} disabled={!!a?.input?.required && !val.trim()} onClick={() => done(a?.input ? val.trim() : 'ok')}>{a?.okText}</Button></>}>
        <p className="whitespace-pre-wrap">{a?.message}</p>
        {a?.input && <textarea autoFocus rows={3} className={cx(inputCls, 'mt-3')} placeholder={a.input.placeholder} value={val} onChange={(e) => setVal(e.target.value)} />}
      </Modal>
    </>
  )
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
