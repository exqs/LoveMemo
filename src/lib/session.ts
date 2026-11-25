// 当前登录用户。登录之前不会渲染任何业务页面，所以业务页面里总能拿到用户。
import { createContext, useContext } from 'react'
import type { User } from './api'

export interface SessionValue { user: User; logout: () => Promise<void> }
export const SessionContext = createContext<SessionValue | null>(null)
export function useSession(): SessionValue {
  const s = useContext(SessionContext)
  if (!s) throw new Error('useSession 只能在登录后使用')
  return s
}
