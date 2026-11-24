import type { ReactNode } from 'react'
import type { MsgType, Speaker } from '../lib/types'
import { cx } from './ui'

const TYPE_LABEL: Partial<Record<MsgType, string>> = { emoji: '表情', image: '图片', link: '分享', voice: '语音' }

export function Avatar({ speaker, name }: { speaker: Speaker; name: string }) {
  return (
    <span className={cx('shrink-0 size-9 rounded-md flex items-center justify-center text-sm font-medium select-none',
      speaker === 'them' ? 'bg-[#e9dfd0] text-[#6b5235]' : 'bg-[#d6e4f2] text-pen')} aria-hidden>
      {(name || (speaker === 'them' ? '她' : '我')).slice(0, 1)}
    </span>
  )
}

export interface BubbleProps {
  speaker: Speaker
  name: string
  content: ReactNode
  msgType?: MsgType
  replyTo?: string
  time?: string
  isKey?: boolean
  lowConfidence?: boolean
  dupSuspect?: boolean
  highlight?: boolean
  redNote?: string // 复盘时的红笔批注
  onClick?: () => void
  children?: ReactNode // 悬停工具栏等
  id?: string
}

/** 微信式气泡：对方在左（白），我在右（绿） */
export function Bubble(p: BubbleProps) {
  const me = p.speaker === 'me'
  return (
    <div id={p.id} className={cx('group relative flex gap-2.5 px-3 py-1.5 rounded-lg transition-colors', me && 'flex-row-reverse', p.highlight && 'bg-mark/40')} onClick={p.onClick}>
      <Avatar speaker={p.speaker} name={p.name} />
      <div className={cx('min-w-0 max-w-[72%] flex flex-col', me ? 'items-end' : 'items-start')}>
        <div className={cx('flex items-center gap-2 text-[11px] text-ink-faint mb-0.5', me && 'flex-row-reverse')}>
          {p.time && <span>{p.time}</span>}
          {p.msgType && TYPE_LABEL[p.msgType] && <span className="rounded bg-grid px-1">{TYPE_LABEL[p.msgType]}</span>}
          {p.isKey && <span className="text-red">★ 关键句</span>}
          {p.dupSuspect && <span className="text-warn">疑似重复</span>}
          {p.lowConfidence && <span className="text-warn">识别不确定</span>}
        </div>
        <div className={cx('relative rounded-[8px] px-3 py-2 text-[14.5px] leading-relaxed whitespace-pre-wrap break-words shadow-[0_1px_1px_rgba(0,0,0,0.04)]',
          me ? 'bg-me text-[#111]' : 'bg-them text-ink border border-[#ececec]',
          (p.lowConfidence || p.dupSuspect) && 'ring-2 ring-warn/60',
          p.isKey && 'marker')}>
          <span className={cx('absolute top-3 size-2.5 rotate-45', me ? '-right-1 bg-me' : '-left-[5px] bg-them border-l border-b border-[#ececec]')} aria-hidden />
          <span className="relative">{p.content}</span>
        </div>
        {p.replyTo && <div className="mt-1 max-w-full truncate rounded bg-[#e9ebe6] px-2 py-0.5 text-xs text-ink-soft">{p.replyTo}</div>}
        {p.redNote && <div className={cx('red-note mt-1 max-w-[340px]', me ? 'text-right' : 'text-left')}>{p.redNote}</div>}
      </div>
      {p.children}
    </div>
  )
}
