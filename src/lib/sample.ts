import type { Message } from './types'
import { uid } from './util'
import type { RawMsg } from '../domain/text'

export function rawToMessages(incidentId: string, raw: RawMsg[], attachmentId: string | null = null): Message[] {
  return raw.map((m, i) => ({
    id: uid(), incident_id: incidentId, seq: i, speaker: m.speaker, content: m.content, msg_type: m.msg_type,
    reply_to: m.reply_to, sent_at: m.sent_at, is_key: false, confidence: m.confidence, dup_suspect: !!m.dup_suspect, attachment_id: attachmentId,
  }))
}
