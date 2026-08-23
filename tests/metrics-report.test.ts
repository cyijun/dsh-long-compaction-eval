import { describe, expect, it } from 'vitest'
import { analyzeEvents } from '../src/metrics.js'
import { renderReport } from '../src/report.js'
import { runResultSchema, type RunResult } from '../src/schema.js'

describe('metrics and report', () => {
  it('separates main and compaction usage and reads optical generations', () => {
    const manifest = `DSH_OPTICAL_MEMORY_V1 ${JSON.stringify({ pages: [{ generation: 0 }, { generation: 2 }] })}`
    const metrics = analyzeEvents([
      { time: 10, type: 'compaction/start', data: { compactionId: 'c1' } },
      { time: 20, type: 'compaction/summary', data: {
        compactionId: 'c1',
        summary: [{ type: 'text', text: manifest }],
        shadowedSeqs: [1, 2],
        shadowedTokenCount: 100,
        usage: { inputTokens: 30, cacheReadTokens: 5, outputTokens: 4 },
      } },
      { time: 25, type: 'compaction/end', data: { compactionId: 'c1' } },
      { time: 30, type: 'step/start', data: { turn: 1, step: 1 } },
      { time: 50, type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 2 } } },
    ], { inputTokens: 10, cacheReadTokens: 2, outputTokens: 1 })
    expect(metrics.compactionUsage.processedInputTokens).toBe(35)
    expect(metrics.mainUsage.processedInputTokens).toBe(32)
    expect(metrics.compactions[0]).toMatchObject({ durationMs: 15, opticalPages: 2, opticalMaxGeneration: 2 })
    expect(metrics.llmMs).toBe(20)
  })

  it('reports failed runs as zero and retains paired contrasts', () => {
    const results = [result('task-1', 'basic-text', 0.5, 100), result('task-1', 'optical-direct', 1, 50)]
    const report = renderReport(results, 'basic-text')
    expect(report).toContain('| optical-direct | 1 | 1 | +50.00% |')
    expect(report).toContain('-50.00%')
  })
})

function result(taskId: string, armId: string, primary: number, processedInputTokens: number): RunResult {
  return runResultSchema.parse({
    schemaVersion: 1,
    runId: `${taskId}-${armId}`,
    experimentId: 'e1',
    taskId,
    dataset: 'test',
    split: 'test',
    armId,
    armKind: armId,
    cycleTarget: 1,
    replicate: 0,
    startedAt: '2026-08-23T00:00:00.000Z',
    durationMs: 10,
    status: 'ok',
    response: 'answer',
    answers: ['answer'],
    scores: { primary, exact: primary, normalizedExact: primary, contains: primary, tokenF1: primary },
    usage: {
      main: { processedInputTokens, inputTokens: processedInputTokens },
      compaction: {},
      total: { processedInputTokens, inputTokens: processedInputTokens },
    },
    compactions: [],
    provenance: { harnessPackages: 'test', opticalCommit: 'test' },
  })
}
