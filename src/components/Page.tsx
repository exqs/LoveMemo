import type { ReactNode } from 'react'
import { cx } from './ui'

/** 页面统一外框 */
export function Page({ title, actions, children, narrow, back }: { title: ReactNode; actions?: ReactNode; children: ReactNode; narrow?: boolean; back?: ReactNode }) {
  return (
    <div className={cx('mx-auto px-8 py-7', narrow ? 'max-w-[880px]' : 'max-w-[1200px]')}>
      {back && <div className="mb-2 text-sm">{back}</div>}
      <header className="flex items-end justify-between gap-4 mb-5 flex-wrap">
        <h1 className="text-[26px] leading-tight text-ink">{title}</h1>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2.5">
      <h2 className="text-[15px] font-semibold text-ink">{children}</h2>
      {aside && <div className="text-sm text-ink-soft">{aside}</div>}
    </div>
  )
}
