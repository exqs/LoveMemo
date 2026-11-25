// 只在界面预览构建里使用（见 src/env.d.ts）
import { createIncident, replaceMessages } from '../db/incidents'
import { emitChange, saveSettings } from '../db/base'
import { rawToMessages } from '../lib/sample'
import { SAMPLE_INCIDENT, SAMPLE_MESSAGES } from './sample1122'

/** 导入 2026-11-22 那次聊天作为第一条便签 */
export async function importSample(): Promise<string> {
  const id = await createIncident(SAMPLE_INCIDENT)
  await replaceMessages(id, rawToMessages(id, SAMPLE_MESSAGES))
  await saveSettings({ herNick: 'Toria', myNick: '柒' })
  emitChange()
  return id
}
