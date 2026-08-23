/** In-process DSH replay runtime using real compaction providers and DeepSeek calls. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, {
  BlockAssembler,
  createAssistantMessage,
  createUserMessage,
  ReasoningEffortId,
  type ContentBlock,
  type FinishReason,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import OpticalCompactionEngine from 'dsh-compaction-optical'
import { analyzeEvents, type EventEnvelope } from './metrics.js'
import { scoreResponse } from './scoring.js'
import { runResultSchema, type Arm, type Experiment, type RunResult, type Task, type TaskContent } from './schema.js'

interface QueryResult {
  response: string
  usage?: TokenUsage
}

/** Execute one paired experiment cell from fixed history through final answer. */
export async function runReplayCell(
  experiment: Experiment,
  task: Task,
  arm: Arm,
  cycleTarget: number,
  replicate: number,
): Promise<RunResult> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const runId = [experiment.experimentId, task.id, arm.id, `c${cycleTarget}`, `r${replicate}`]
    .map(part => part.replace(/[^A-Za-z0-9_.-]+/gu, '-'))
    .join('--')
  let ctx: Context | undefined
  let session: Session | undefined
  let queryUsage: TokenUsage | undefined
  let response = ''
  let tempHome: string | undefined
  try {
    tempHome = await mkdtemp(join(tmpdir(), 'dsh-compact-eval-'))
    ctx = await createRuntime(experiment, arm, tempHome)
    session = ctx.sessions.create(SessionId(runId))
    const agent = idleAgent(session, experiment)
    const selectedSegments = arm.kind === 'tail-drop'
      ? task.segments.slice(-Math.max(1, Math.ceil(task.segments.length * arm.tailFraction)))
      : task.segments
    const schedule = isCompactionArm(arm) ? compactionSchedule(selectedSegments.length, cycleTarget) : new Set<number>()
    let turn = 0
    let headerWritten = false
    for (const [index, segment] of selectedSegments.entries()) {
      const appended = await appendSegment(ctx, session, segment, turn, experiment, headerWritten)
      turn = appended.turn
      headerWritten ||= appended.headerWritten
      if (schedule.has(index + 1)) {
        const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
        if (result === null) throw new Error(`scheduled compaction after segment ${index + 1} produced no compactable range`)
      }
    }
    const query = await querySession(ctx, session, task.query, experiment)
    response = query.response
    queryUsage = query.usage
    const metrics = analyzeEvents(session.events as readonly EventEnvelope[], queryUsage)
    return runResultSchema.parse({
      schemaVersion: 1,
      runId,
      experimentId: experiment.experimentId,
      taskId: task.id,
      dataset: task.dataset,
      split: task.split,
      armId: arm.id,
      armKind: arm.kind,
      cycleTarget,
      replicate,
      startedAt,
      durationMs: performance.now() - started,
      status: 'ok',
      response,
      answers: task.answers,
      scores: scoreResponse(task, response),
      usage: { main: metrics.mainUsage, compaction: metrics.compactionUsage, total: metrics.totalUsage },
      compactions: metrics.compactions,
      tags: task.tags,
      provenance: experiment.provenance,
    })
  } catch (error) {
    const metrics = analyzeEvents((session?.events ?? []) as readonly EventEnvelope[], queryUsage)
    return runResultSchema.parse({
      schemaVersion: 1,
      runId,
      experimentId: experiment.experimentId,
      taskId: task.id,
      dataset: task.dataset,
      split: task.split,
      armId: arm.id,
      armKind: arm.kind,
      cycleTarget,
      replicate,
      startedAt,
      durationMs: performance.now() - started,
      status: 'error',
      response,
      answers: task.answers,
      usage: { main: metrics.mainUsage, compaction: metrics.compactionUsage, total: metrics.totalUsage },
      compactions: metrics.compactions,
      tags: task.tags,
      provenance: experiment.provenance,
      error: errorRecord(error),
    })
  } finally {
    await ctx?.fiber.dispose().catch(() => {})
    if (tempHome !== undefined) await rm(tempHome, { recursive: true, force: true }).catch(() => {})
  }
}

async function createRuntime(experiment: Experiment, arm: Arm, dshHome: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(DeepSeek, {
    thinking: experiment.runtime.reasoningEffort === 'off' ? 'disabled' : 'enabled',
    reasoningEffort: experiment.runtime.reasoningEffort,
  })
  switch (arm.kind) {
    case 'basic':
      await ctx.plugin(BasicCompactionEngine, { auto: false, ...arm.compaction })
      break
    case 'optical-direct':
      await ctx.plugin(OpticalCompactionEngine, { auto: false, mode: 'direct', ...arm.compaction })
      break
    case 'optical-summary':
      await ctx.plugin(OpticalCompactionEngine, { auto: false, mode: 'summary', ...arm.compaction })
      break
    case 'no-compact':
    case 'tail-drop':
      break
  }
  return ctx
}

function idleAgent(session: Session, experiment: Experiment): Agent {
  return {
    session,
    options: {
      provider: experiment.runtime.provider,
      model: experiment.runtime.model,
      ...(experiment.runtime.reasoningEffort === 'off'
        ? {}
        : { reasoningEffort: ReasoningEffortId(experiment.runtime.reasoningEffort) }),
    },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
  } as unknown as Agent
}

async function appendSegment(
  ctx: Context,
  session: Session,
  segment: Task['segments'][number],
  previousTurn: number,
  experiment: Experiment,
  alreadyWroteHeader: boolean,
): Promise<{ turn: number; headerWritten: boolean }> {
  let turn = previousTurn
  let openTurn: number | undefined
  let step = 0
  let headerWritten = alreadyWroteHeader
  for (const [messageIndex, message] of segment.messages.entries()) {
    const content = await contentBlocks(ctx, message.content)
    if (message.role === 'user') {
      if (openTurn !== undefined) session.append('turn/end', { turn: openTurn, reason: { kind: 'completed' } })
      turn += 1
      openTurn = turn
      step = 0
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: timestamped(content, messageIndex === 0 ? segment.timestamp : undefined),
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      continue
    }
    if (openTurn === undefined) throw new Error(`segment ${segment.id} starts with an assistant message`)
    step += 1
    session.append('step/start', { turn: openTurn, step })
    if (!headerWritten) {
      session.append('request/header', {
        header: {
          config: {
            provider: experiment.runtime.provider,
            model: experiment.runtime.model,
            ...(experiment.runtime.reasoningEffort === 'off'
              ? {}
              : { reasoningEffort: ReasoningEffortId(experiment.runtime.reasoningEffort) }),
            temperature: experiment.runtime.temperature,
            maxTokens: experiment.runtime.queryMaxTokens,
          },
          system: experiment.runtime.systemPrompt,
        },
        reason: 'initial',
      })
      headerWritten = true
    }
    session.append('assistant/message', {
      turn: openTurn,
      step,
      message: createAssistantMessage({
        content,
        source: { provider: experiment.runtime.provider, model: experiment.runtime.model },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: openTurn, step })
  }
  if (openTurn !== undefined) session.append('turn/end', { turn: openTurn, reason: { kind: 'completed' } })
  return { turn, headerWritten }
}

async function contentBlocks(ctx: Context, contents: readonly TaskContent[]): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []
  for (const content of contents) {
    if (content.type === 'text') {
      blocks.push({ type: 'text', text: content.text })
      continue
    }
    const refs = await ctx.attachments.saveImages([{
      data: Uint8Array.from(Buffer.from(content.dataBase64, 'base64')),
      mediaType: content.mediaType,
      ...(content.name === undefined ? {} : { name: content.name }),
    }])
    const ref = refs[0]
    if (ref === undefined) throw new Error('attachment store returned no image reference')
    blocks.push({ type: 'image', attachment: ref })
  }
  return blocks
}

function timestamped(content: ContentBlock[], timestamp: string | undefined): ContentBlock[] {
  if (timestamp === undefined) return content
  return [{ type: 'text', text: `[Session date: ${timestamp}]\n` }, ...content]
}

async function querySession(ctx: Context, session: Session, query: string, experiment: Experiment): Promise<QueryResult> {
  const assembler = new BlockAssembler()
  const messages = [
    ...session.deriveMessages(),
    createUserMessage({ content: [{ type: 'text', text: query }], source: { kind: 'user' } }),
  ]
  for await (const chunk of ctx.llm.stream({
    provider: experiment.runtime.provider,
    model: experiment.runtime.model,
    system: experiment.runtime.systemPrompt,
    messages,
    maxTokens: experiment.runtime.queryMaxTokens,
    temperature: experiment.runtime.temperature,
    ...(experiment.runtime.reasoningEffort === 'off'
      ? {}
      : { reasoningEffort: ReasoningEffortId(experiment.runtime.reasoningEffort) }),
    sessionId: session.id,
  })) assembler.push(chunk)
  assertSuccessfulFinish(assembler.finish)
  const response = assembler.blocks()
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return { response, ...(assembler.usage === undefined ? {} : { usage: assembler.usage }) }
}

function assertSuccessfulFinish(finish: FinishReason): void {
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const error = new Error(finish.failure.message) as Error & { code?: string }
    error.code = finish.failure.code
    throw error
  }
  if (finish.kind === 'max-tokens') throw new Error('query reached maxTokens before a complete answer')
}

function compactionSchedule(segmentCount: number, cycles: number): Set<number> {
  if (cycles === 0) return new Set()
  if (segmentCount < cycles + 1) {
    throw new Error(`task has ${segmentCount} segments but ${cycles} compactions require at least ${cycles + 1}`)
  }
  const schedule = new Set<number>()
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    schedule.add(Math.max(1, Math.floor(cycle * segmentCount / (cycles + 1))))
  }
  if (schedule.size !== cycles) throw new Error('compaction schedule collapsed; add more task segments')
  return schedule
}

function isCompactionArm(arm: Arm): arm is Extract<Arm, { kind: 'basic' | 'optical-direct' | 'optical-summary' }> {
  return arm.kind === 'basic' || arm.kind === 'optical-direct' || arm.kind === 'optical-summary'
}

function errorRecord(error: unknown): { name: string; message: string; code?: string } {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  const code = (error as Error & { code?: unknown }).code
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    ...(typeof code === 'string' && code.length > 0 ? { code } : {}),
  }
}
