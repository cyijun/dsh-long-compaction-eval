/** Markdown reporting over paired run JSONL. */

import type { RunResult } from './schema.js'
import { bootstrapMean, mean, median, type ConfidenceInterval } from './statistics.js'

interface Aggregate {
  arm: string
  cycle: number
  runs: number
  tasks: number
  primary: number
  errorRate: number
  processedInput: number
  compactionInput: number
  durationMs: number
  compactions: number
}

interface Contrast {
  arm: string
  cycle: number
  quality: ConfidenceInterval
  processedInputDelta: number
  pairedTasks: number
}

/** Render a decision-oriented report without collapsing quality and cost into one score. */
export function renderReport(results: readonly RunResult[], baseline: string): string {
  if (results.length === 0) throw new Error('cannot report an empty run set')
  const aggregates = aggregate(results)
  if (!aggregates.some(row => row.arm === baseline)) throw new Error(`baseline arm not found: ${baseline}`)
  const contrasts = pairedContrasts(results, baseline)
  const lines = [
    '# DSH Long Compaction Evaluation',
    '',
    `Generated from ${results.length} run records. Failed runs count as zero task quality. Provider-reported processed input is input + cache read + cache write tokens; it is not a monetary cost estimate.`,
    '',
    '## Quality and resource use',
    '',
    '| Arm | Cycles | Runs | Tasks | Primary score | Error rate | Processed input | Compaction input | Median duration | Mean compactions |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...aggregates.map(row => `| ${escapeCell(row.arm)} | ${row.cycle} | ${row.runs} | ${row.tasks} | ${pct(row.primary)} | ${pct(row.errorRate)} | ${integer(row.processedInput)} | ${integer(row.compactionInput)} | ${integer(row.durationMs)} ms | ${fixed(row.compactions)} |`),
    '',
    `## Paired contrasts versus ${baseline}`,
    '',
    '| Arm | Cycles | Paired tasks | Quality delta | 95% task-bootstrap CI | Processed-input delta |',
    '|---|---:|---:|---:|---:|---:|',
    ...contrasts.map(row => `| ${escapeCell(row.arm)} | ${row.cycle} | ${row.pairedTasks} | ${signedPct(row.quality.estimate)} | [${signedPct(row.quality.low)}, ${signedPct(row.quality.high)}] | ${signedPct(row.processedInputDelta)} |`),
    '',
    '## Interpretation guardrails',
    '',
    '- Promote a provider only when its paired quality interval is non-inferior and its provider-reported cost or input reduction is material.',
    '- Inspect exact/code/CJK and prompt-injection tags separately before adopting an aggregate winner.',
    '- Do not use `shadowedTokenCount` as real model input accounting; it is a Harness estimator.',
    '- Experimental model aliases may drift. Do not pool runs across dates without a model fingerprint or date block.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

function aggregate(results: readonly RunResult[]): Aggregate[] {
  const groups = groupBy(results, run => `${run.armId}\u0000${run.cycleTarget}`)
  return [...groups.values()].map(group => ({
    arm: group[0]?.armId ?? '',
    cycle: group[0]?.cycleTarget ?? 0,
    runs: group.length,
    tasks: new Set(group.map(run => run.taskId)).size,
    primary: mean(group.map(quality)),
    errorRate: mean(group.map(run => Number(run.status === 'error'))),
    processedInput: mean(group.map(run => run.usage.total.processedInputTokens)),
    compactionInput: mean(group.map(run => run.usage.compaction.processedInputTokens)),
    durationMs: median(group.map(run => run.durationMs)),
    compactions: mean(group.map(run => run.compactions.filter(item => item.status === 'ok').length)),
  })).sort((left, right) => left.cycle - right.cycle || left.arm.localeCompare(right.arm))
}

function pairedContrasts(results: readonly RunResult[], baseline: string): Contrast[] {
  const cycles = [...new Set(results.map(run => run.cycleTarget))].sort((left, right) => left - right)
  const arms = [...new Set(results.map(run => run.armId))].filter(arm => arm !== baseline).sort()
  const contrasts: Contrast[] = []
  for (const cycle of cycles) {
    const atCycle = results.filter(run => run.cycleTarget === cycle)
    const taskArm = groupBy(atCycle, run => `${run.taskId}\u0000${run.armId}`)
    for (const arm of arms) {
      const qualityDiffs: number[] = []
      const costDiffs: number[] = []
      const tasks = [...new Set(atCycle.map(run => run.taskId))]
      for (const task of tasks) {
        const candidate = taskArm.get(`${task}\u0000${arm}`)
        const base = taskArm.get(`${task}\u0000${baseline}`)
        if (candidate === undefined || base === undefined) continue
        qualityDiffs.push(mean(candidate.map(quality)) - mean(base.map(quality)))
        const baseCost = mean(base.map(run => run.usage.total.processedInputTokens))
        const candidateCost = mean(candidate.map(run => run.usage.total.processedInputTokens))
        if (baseCost > 0) costDiffs.push((candidateCost - baseCost) / baseCost)
      }
      contrasts.push({
        arm,
        cycle,
        quality: bootstrapMean(qualityDiffs),
        processedInputDelta: mean(costDiffs),
        pairedTasks: qualityDiffs.length,
      })
    }
  }
  return contrasts
}

function quality(run: RunResult): number {
  return run.status === 'ok' ? run.scores?.primary ?? 0 : 0
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const groupKey = key(value)
    const group = groups.get(groupKey)
    if (group === undefined) groups.set(groupKey, [value])
    else group.push(value)
  }
  return groups
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'N/A'
}

function signedPct(value: number): string {
  return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%` : 'N/A'
}

function integer(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : 'N/A'
}

function fixed(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'N/A'
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|')
}
