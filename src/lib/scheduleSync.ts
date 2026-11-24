// 把提醒计划同步给 Rust 端；启动时检查是否需要补发
import { getKV, getSettings, setKV } from '../db/base'
import { listCommitments } from '../db/misc'
import { todayQueue, listCards, listRules } from '../db/rules'
import { catchUp, planNotifications } from '../domain/notify'
import { firedKeys, notifyNow, pushSchedule } from './platform'
import { fmtDate } from './util'

export async function syncSchedule() {
  const s = await getSettings()
  const rules = new Map((await listRules()).filter((r) => r.status !== 'archived').map((r) => [r.id, r.title]))
  const cards = (await listCards()).filter((c) => rules.has(c.rule_id)).map((c) => ({ title: rules.get(c.rule_id)!, due: c.due }))
  const plan = planNotifications(s, cards, await listCommitments(), Date.now())
  await pushSchedule(plan)
}

export async function startupCatchUp() {
  const s = await getSettings()
  const { items } = await todayQueue()
  const last = (await getKV('lastCatchup')) ?? ''
  const e = catchUp(s, items.length, await firedKeys(), last, Date.now())
  if (!e) return
  await notifyNow(e)
  await setKV('lastCatchup', fmtDate(Date.now()))
}
