/** Adapters from official benchmark releases into the replay task format. */

import { readFile } from 'node:fs/promises'
import { parse } from 'csv-parse/sync'
import { taskSchema, type Task, type TaskMessage } from './schema.js'

interface LongMemTurn {
  role?: unknown
  content?: unknown
}

interface LongMemRecord {
  question_id?: unknown
  question_type?: unknown
  question?: unknown
  answer?: unknown
  question_date?: unknown
  haystack_session_ids?: unknown
  haystack_dates?: unknown
  haystack_sessions?: unknown
}

/** Import the released LongMemEval JSON array without retaining evidence labels. */
export async function importLongMemEval(path: string, limit?: number): Promise<Task[]> {
  const source = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!Array.isArray(source)) throw new Error('LongMemEval input must be a JSON array')
  return source.slice(0, limit).map((value, index) => longMemTask(value, index))
}

function longMemTask(value: unknown, index: number): Task {
  if (!isRecord(value)) throw new Error(`LongMemEval record ${index} must be an object`)
  const record = value as LongMemRecord
  const id = requiredString(record.question_id, `LongMemEval record ${index}.question_id`)
  const question = requiredString(record.question, `${id}.question`)
  const answer = requiredString(record.answer, `${id}.answer`)
  if (!Array.isArray(record.haystack_sessions)) throw new Error(`${id}.haystack_sessions must be an array`)
  const sessionIds = stringArray(record.haystack_session_ids)
  const dates = stringArray(record.haystack_dates)
  const segments = record.haystack_sessions.map((session, sessionIndex) => {
    if (!Array.isArray(session)) throw new Error(`${id}.haystack_sessions[${sessionIndex}] must be an array`)
    const messages = session.map((turn, turnIndex) => longMemMessage(turn, id, sessionIndex, turnIndex))
    return {
      id: sessionIds[sessionIndex] ?? `session-${sessionIndex + 1}`,
      ...(dates[sessionIndex] === undefined ? {} : { timestamp: dates[sessionIndex] }),
      messages,
    }
  })
  const questionDate = optionalString(record.question_date)
  const questionType = optionalString(record.question_type) ?? 'unknown'
  return taskSchema.parse({
    schemaVersion: 1,
    id,
    dataset: 'LongMemEval',
    split: 'official',
    query: questionDate === undefined ? question : `[Question date: ${questionDate}]\n${question}`,
    answers: [answer],
    segments,
    scorer: { kind: 'qa', primary: 'token-f1' },
    tags: {
      ability: questionType,
      abstention: id.endsWith('_abs') ? 'true' : 'false',
    },
    metadata: { sourceIndex: index },
  })
}

function longMemMessage(value: unknown, id: string, sessionIndex: number, turnIndex: number): TaskMessage {
  if (!isRecord(value)) throw new Error(`${id}.haystack_sessions[${sessionIndex}][${turnIndex}] must be an object`)
  const turn = value as LongMemTurn
  const role = turn.role
  if (role !== 'user' && role !== 'assistant') {
    throw new Error(`${id}.haystack_sessions[${sessionIndex}][${turnIndex}].role must be user or assistant`)
  }
  return {
    role,
    content: [{ type: 'text', text: requiredString(turn.content, `${id}.content`) }],
  }
}

interface MrcrCsvRecord {
  queries?: string
  answer?: string
  context_len?: string
  answer_token_count?: string
  num_relevant?: string
  answer_context_position?: string
  sampling_or_scoring?: string
}

/** Import an official MRCR v2 CSV and recover its rendered user/assistant turns. */
export async function importMrcrV2(path: string, limit?: number): Promise<Task[]> {
  const records = parse(await readFile(path, 'utf8'), {
    columns: true,
    bom: true,
    relaxColumnCount: false,
    skipEmptyLines: true,
  }) as MrcrCsvRecord[]
  return records.slice(0, limit).map((record, index) => mrcrTask(record, index, path))
}

function mrcrTask(record: MrcrCsvRecord, index: number, path: string): Task {
  const prompt = requiredString(record.queries, `MRCR row ${index}.queries`)
  const answer = requiredString(record.answer, `MRCR row ${index}.answer`)
  const parsed = parseRenderedConversation(prompt)
  const contextLength = numeric(record.context_len)
  const datasetFile = path.split('/').at(-1) ?? path
  return taskSchema.parse({
    schemaVersion: 1,
    id: `mrcr-${datasetFile.replace(/[^A-Za-z0-9_.-]+/gu, '-')}-${index}`,
    dataset: 'MRCR-v2',
    split: datasetFile,
    query: parsed.query,
    answers: [answer],
    segments: parsed.segments,
    scorer: { kind: 'mrcr-v2' },
    tags: {
      contextBucket: contextLength === undefined ? 'unknown' : contextBucket(contextLength),
      relevantNeedles: record.num_relevant ?? 'unknown',
    },
    metadata: {
      sourceIndex: index,
      ...(contextLength === undefined ? {} : { contextLength }),
      ...(numeric(record.answer_token_count) === undefined ? {} : { answerTokenCount: numeric(record.answer_token_count) }),
      ...(record.answer_context_position === undefined ? {} : { answerContextPosition: record.answer_context_position }),
      ...(record.sampling_or_scoring === undefined ? {} : { samplingOrScoring: record.sampling_or_scoring }),
    },
  })
}

/** Parse MRCR's single rendered prompt into seeded turns plus the final query. */
export function parseRenderedConversation(prompt: string): { segments: Task['segments']; query: string } {
  const marker = /^(User|Assistant):[ \t]*/gmu
  const matches = [...prompt.matchAll(marker)]
  if (matches.length < 2) throw new Error('MRCR queries field contains too few role markers')
  const messages: TaskMessage[] = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? prompt.length
    const prefix = index === 0 ? prompt.slice(0, match.index).trim() : ''
    const body = prompt.slice(start, end).trim()
    return {
      role: match[1] === 'User' ? 'user' : 'assistant',
      content: [{ type: 'text', text: prefix.length === 0 ? body : `${prefix}\n\n${body}` }],
    }
  })
  const finalMessage = messages.at(-1)
  if (finalMessage?.role !== 'user') throw new Error('MRCR rendered prompt must end in a user query')
  const query = textOf(finalMessage)
  const seeded = messages.slice(0, -1)
  const segments: Task['segments'] = []
  for (const message of seeded) {
    const current = segments.at(-1)
    if (message.role === 'user' || current === undefined) {
      segments.push({ id: `exchange-${segments.length + 1}`, messages: [message] })
    } else {
      current.messages.push(message)
    }
  }
  return { segments, query }
}

function textOf(message: TaskMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

function contextBucket(length: number): string {
  for (const boundary of [16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_048_576]) {
    if (length <= boundary) return `<=${boundary}`
  }
  return '>1048576'
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item))
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
