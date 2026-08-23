import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importLongMemEval, importMrcrV2, parseRenderedConversation } from '../src/adapters.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('benchmark adapters', () => {
  it('recovers MRCR turns and separates the final query', () => {
    const parsed = parseRenderedConversation('System preface\n\nUser: Write A\nAssistant: answer A\nUser: Repeat the first answer')
    expect(parsed.query).toBe('Repeat the first answer')
    expect(parsed.segments).toHaveLength(1)
    expect(parsed.segments[0]?.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(parsed.segments[0]?.messages[0]?.content[0]).toEqual({ type: 'text', text: 'System preface\n\nWrite A' })
  })

  it('imports LongMemEval without answer-location labels', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'longmem.json')
    await writeFile(source, JSON.stringify([{
      question_id: 'q1_abs',
      question_type: 'temporal-reasoning',
      question: 'Who owns it?',
      answer: 'Mei',
      question_date: '2026-08-23',
      haystack_session_ids: ['s1'],
      haystack_dates: ['2026-08-20'],
      haystack_sessions: [[
        { role: 'user', content: 'The owner is Mei.', has_answer: true },
        { role: 'assistant', content: 'Recorded.' },
      ]],
    }]), 'utf8')
    const tasks = await importLongMemEval(source)
    expect(tasks[0]?.query).toContain('2026-08-23')
    expect(tasks[0]?.tags).toMatchObject({ ability: 'temporal-reasoning', abstention: 'true' })
    expect(JSON.stringify(tasks)).not.toContain('has_answer')
  })

  it('imports the official MRCR CSV fields and scorer', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'mrcr.csv')
    await writeFile(source, 'queries,answer,context_len,num_relevant\n"User: Ask A\nAssistant: body\nUser: Repeat A","abcdefghijklbody",32768,8\n', 'utf8')
    const tasks = await importMrcrV2(source)
    expect(tasks[0]?.scorer.kind).toBe('mrcr-v2')
    expect(tasks[0]?.query).toBe('Repeat A')
    expect(tasks[0]?.tags.contextBucket).toBe('<=32768')
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-eval-test-'))
  roots.push(root)
  return root
}
