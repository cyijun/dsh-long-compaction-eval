/** Session-event accounting for provider usage, compaction lifecycle, and optical generations. */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { compactionMetricSchema, usageSchema, type CompactionMetric, type Usage } from './schema.js'

export interface EventEnvelope {
  seq?: number
  time?: number
  type: string
  data: unknown
}

export interface EventMetrics {
  mainUsage: Usage
  compactionUsage: Usage
  totalUsage: Usage
  compactions: CompactionMetric[]
  llmMs: number
  toolMs: number
}

interface PendingCompaction {
  id: string
  startTime?: number
  endTime?: number
  summary?: Record<string, unknown>
  error?: string
}

/** Fold DSH events plus an optional direct query call into comparable metrics. */
export function analyzeEvents(events: readonly EventEnvelope[], directQueryUsage?: TokenUsage): EventMetrics {
  let mainUsage = emptyUsage()
  let compactionUsage = emptyUsage()
  const compactions = new Map<string, PendingCompaction>()
  const openSteps = new Map<string, number>()
  const openTools = new Map<string, number>()
  let llmMs = 0
  let toolMs = 0
  for (const event of events) {
    const data = record(event.data)
    switch (event.type) {
      case 'assistant/message': {
        mainUsage = addUsage(mainUsage, usageOf(data?.usage))
        if (event.time !== undefined) {
          const key = `${String(data?.turn)}:${String(data?.step)}`
          const start = openSteps.get(key)
          if (start !== undefined) llmMs += Math.max(0, event.time - start)
          openSteps.delete(key)
        }
        break
      }
      case 'compaction/start': {
        const id = stringOf(data?.compactionId)
        if (id !== undefined) compactions.set(id, { id, ...(event.time === undefined ? {} : { startTime: event.time }) })
        break
      }
      case 'compaction/summary': {
        const id = stringOf(data?.compactionId)
        if (id === undefined) break
        const pending = compactions.get(id) ?? { id }
        pending.summary = data ?? {}
        compactions.set(id, pending)
        compactionUsage = addUsage(compactionUsage, usageOf(data?.usage))
        break
      }
      case 'compaction/end': {
        const id = stringOf(data?.compactionId)
        if (id === undefined) break
        const pending = compactions.get(id) ?? { id }
        if (event.time !== undefined) pending.endTime = event.time
        if (typeof data?.error === 'string') pending.error = data.error
        compactions.set(id, pending)
        break
      }
      case 'step/start': {
        if (event.time === undefined) break
        const key = `${String(data?.turn)}:${String(data?.step)}`
        openSteps.set(key, event.time)
        break
      }
      case 'tool/call': {
        if (event.time !== undefined && typeof data?.callId === 'string') openTools.set(data.callId, event.time)
        break
      }
      case 'tool/result': {
        if (event.time === undefined) break
        const message = record(data?.message)
        const source = record(message?.source)
        const callId = stringOf(source?.callId)
        if (callId === undefined) break
        const start = openTools.get(callId)
        if (start !== undefined) toolMs += Math.max(0, event.time - start)
        openTools.delete(callId)
        break
      }
    }
  }
  mainUsage = addUsage(mainUsage, usageOf(directQueryUsage))
  const details = [...compactions.values()].map(compactionMetric)
  return {
    mainUsage,
    compactionUsage,
    totalUsage: addUsage(mainUsage, compactionUsage),
    compactions: details,
    llmMs,
    toolMs,
  }
}

/** Add disjoint provider usage categories and derive processed input. */
export function addUsage(left: Usage, right: Usage): Usage {
  const inputTokens = left.inputTokens + right.inputTokens
  const cacheReadTokens = left.cacheReadTokens + right.cacheReadTokens
  const cacheWriteTokens = left.cacheWriteTokens + right.cacheWriteTokens
  return usageSchema.parse({
    inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    processedInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
  })
}

/** Construct a zero usage accumulator. */
export function emptyUsage(): Usage {
  return usageSchema.parse({})
}

function compactionMetric(pending: PendingCompaction): CompactionMetric {
  const summary = pending.summary
  const optical = opticalFacts(summary?.summary)
  const durationMs = pending.startTime === undefined || pending.endTime === undefined
    ? undefined
    : Math.max(0, pending.endTime - pending.startTime)
  return compactionMetricSchema.parse({
    compactionId: pending.id,
    status: pending.error !== undefined ? 'error' : pending.endTime === undefined ? 'open' : 'ok',
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(typeof summary?.provider === 'string' ? { provider: summary.provider } : {}),
    ...(typeof summary?.model === 'string' ? { model: summary.model } : {}),
    shadowedNodes: Array.isArray(summary?.shadowedSeqs) ? summary.shadowedSeqs.length : 0,
    shadowedTokenEstimate: finite(summary?.shadowedTokenCount) ?? 0,
    opticalPages: optical.pages,
    opticalMaxGeneration: optical.maxGeneration,
    usage: usageOf(summary?.usage),
    ...(pending.error === undefined ? {} : { error: pending.error }),
  })
}

function opticalFacts(summary: unknown): { pages: number; maxGeneration: number } {
  if (!Array.isArray(summary)) return { pages: 0, maxGeneration: 0 }
  const first = record(summary[0])
  if (first?.type !== 'text' || typeof first.text !== 'string') return { pages: 0, maxGeneration: 0 }
  const marker = 'DSH_OPTICAL_MEMORY_V1 '
  const offset = first.text.indexOf(marker)
  if (offset < 0) return { pages: 0, maxGeneration: 0 }
  try {
    const manifest = record(JSON.parse(first.text.slice(offset + marker.length)) as unknown)
    const pages = Array.isArray(manifest?.pages) ? manifest.pages : []
    return {
      pages: pages.length,
      maxGeneration: pages.reduce((highest, page) => Math.max(highest, finite(record(page)?.generation) ?? 0), 0),
    }
  } catch {
    return { pages: 0, maxGeneration: 0 }
  }
}

function usageOf(value: unknown): Usage {
  const data = record(value)
  const inputTokens = finite(data?.inputTokens) ?? 0
  const cacheReadTokens = finite(data?.cacheReadTokens) ?? 0
  const cacheWriteTokens = finite(data?.cacheWriteTokens) ?? 0
  return usageSchema.parse({
    inputTokens,
    outputTokens: finite(data?.outputTokens) ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: finite(data?.reasoningTokens) ?? 0,
    processedInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
