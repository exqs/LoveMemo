import type { Analysis, AnalysisData, Attachment, Incident, Message } from '../lib/types'
import { parseJSON, uid } from '../lib/util'
import { emitChange, insert, q, run, update } from './base'

type Row = Record<string, unknown>
const toIncident = (r: Row): Incident => ({ ...(r as unknown as Incident), tags: parseJSON(r.tags as string, []) })
const toMessage = (r: Row): Message => ({ ...(r as unknown as Message), is_key: !!r.is_key, dup_suspect: !!r.dup_suspect })

export async function listIncidents(): Promise<Incident[]> {
  return (await q('SELECT * FROM incident ORDER BY COALESCE(occurred_at, created_at) DESC')).map(toIncident)
}
export async function getIncident(id: string): Promise<Incident | null> {
  const r = await q('SELECT * FROM incident WHERE id=?', [id])
  return r.length ? toIncident(r[0]) : null
}
export async function createIncident(p: Partial<Incident> = {}): Promise<string> {
  const now = Date.now()
  const id = uid()
  await insert('incident', {
    id, title: p.title ?? '', occurred_at: p.occurred_at ?? now, channel: p.channel ?? '微信', background: p.background ?? '',
    severity: p.severity ?? 3, status: 'draft', my_feelings: '', tags: p.tags ?? [], created_at: now, updated_at: now,
  })
  emitChange()
  return id
}
export async function updateIncident(id: string, patch: Partial<Incident>, notify = true) {
  const { id: _i, created_at: _c, ...rest } = patch
  void _i; void _c
  await update('incident', id, { ...rest, updated_at: Date.now() })
  if (notify) emitChange()
}
export async function deleteIncident(id: string) {
  await run('DELETE FROM incident WHERE id=?', [id])
  await run('UPDATE commitment SET incident_id=NULL WHERE incident_id=?', [id]) // 承诺保留
  emitChange()
}

export async function listMessages(incidentId: string): Promise<Message[]> {
  return (await q('SELECT * FROM message WHERE incident_id=? ORDER BY seq', [incidentId])).map(toMessage)
}
export async function allMessages(): Promise<Message[]> {
  return (await q('SELECT * FROM message ORDER BY incident_id, seq')).map(toMessage)
}
/** 编辑页整体保存：先删后插，保留消息 id（复盘里的引用依赖 id） */
export async function replaceMessages(incidentId: string, msgs: Message[]) {
  await run('DELETE FROM message WHERE incident_id=?', [incidentId])
  let seq = 0
  for (const m of msgs) {
    await insert('message', {
      id: m.id, incident_id: incidentId, seq: seq++, speaker: m.speaker, content: m.content, msg_type: m.msg_type,
      reply_to: m.reply_to, sent_at: m.sent_at, is_key: m.is_key, confidence: m.confidence, dup_suspect: m.dup_suspect,
      attachment_id: m.attachment_id,
    })
  }
  await run('UPDATE incident SET updated_at=? WHERE id=?', [Date.now(), incidentId])
}

export async function listAttachments(incidentId: string): Promise<Attachment[]> {
  return q<Attachment>('SELECT * FROM attachment WHERE incident_id=? ORDER BY order_no', [incidentId])
}
export async function addAttachment(incidentId: string, dataUrl: string, order: number): Promise<string> {
  const id = uid()
  await insert('attachment', { id, incident_id: incidentId, data_url: dataUrl, order_no: order })
  return id
}

export async function getAnalysis(incidentId: string): Promise<Analysis | null> {
  const r = await q('SELECT * FROM analysis WHERE incident_id=? ORDER BY created_at DESC LIMIT 1', [incidentId])
  if (!r.length) return null
  return { ...(r[0] as unknown as Analysis), data: parseJSON<AnalysisData>(r[0].data as string, emptyAnalysis()) }
}
export async function saveAnalysis(incidentId: string, data: AnalysisData, myOwnWords: string, profileName: string) {
  const cur = await getAnalysis(incidentId)
  if (cur) await update('analysis', cur.id, { data, my_own_words: myOwnWords, profile_name: profileName })
  else await insert('analysis', { id: uid(), incident_id: incidentId, data, my_own_words: myOwnWords, profile_name: profileName, created_at: Date.now() })
}
export async function allAnalyses(): Promise<Analysis[]> {
  return (await q('SELECT * FROM analysis')).map((r) => ({ ...(r as unknown as Analysis), data: parseJSON<AnalysisData>(r.data as string, emptyAnalysis()) }))
}

export function emptyAnalysis(): AnalysisData {
  return { summary: '', timeline: [], her_words: [], inferences: [], misses: [], next_time: [], commitments: [], tags: [], new_tags: [], severity: 3 }
}
