import { createIncident, replaceMessages } from '../db/incidents'
import { emitChange, saveSettings } from '../db/base'
import { SAMPLE_INCIDENT, SAMPLE_MESSAGES } from '../fixtures/sample1122'
import type { Message } from './types'
import { uid } from './util'
import type { RawMsg } from '../domain/text'

export function rawToMessages(incidentId: string, raw: RawMsg[], attachmentId: string | null = null): Message[] {
  return raw.map((m, i) => ({
    id: uid(), incident_id: incidentId, seq: i, speaker: m.speaker, content: m.content, msg_type: m.msg_type,
    reply_to: m.reply_to, sent_at: m.sent_at, is_key: false, confidence: m.confidence, dup_suspect: !!m.dup_suspect, attachment_id: attachmentId,
  }))
}

/** 导入 2026-11-22 那次聊天作为第一条便签 */
export async function importSample(): Promise<string> {
  const id = await createIncident(SAMPLE_INCIDENT)
  await replaceMessages(id, rawToMessages(id, SAMPLE_MESSAGES))
  await saveSettings({ herNick: 'Toria', myNick: '柒' })
  emitChange()
  return id
}
