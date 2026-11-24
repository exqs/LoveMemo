import { it, expect } from 'vitest'
import { GradeSchema, QuizSchema, RoleplaySchema, AnalyzeSchema } from './schemas'
it('zod 宽松', () => {
  expect(GradeSchema.parse({ score: '88' })).toEqual({ score: 88, good: [], problems: [], reference: '', option_notes: [] })
  expect(QuizSchema.parse({ prompt: 'x', chat: [{ speaker: 'me', content: 1 }] }).answer_index).toBeUndefined()
  expect(RoleplaySchema.parse({ her_reply: 'a', resolved: 'false' }).resolved).toBe(false)
  expect(AnalyzeSchema.parse({ summary: 's', commitments: [{ content: 'c' }] }).commitments[0].due_hint).toBe('')
})
