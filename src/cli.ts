#!/usr/bin/env node

/** Command-line entry point for dataset preparation, replay, and reporting. */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { importLongMemEval, importMrcrV2 } from './adapters.js'
import { runHarborAgent, type HarborAgentOptions } from './harbor-agent.js'
import { readJsonl, writeJsonl } from './io.js'
import { renderReport } from './report.js'
import { planExperiment, runExperiment, type RunFilters } from './runner.js'
import { runResultSchema } from './schema.js'
import { generateSyntheticTasks } from './synthetic.js'

const HELP = `dsh-long-compaction-eval <command> [options]

Commands:
  generate-synthetic  Write deterministic exact-retention probes.
  import-longmemeval  Convert the official LongMemEval JSON release to task JSONL.
  import-mrcr-v2      Convert an official MRCR v2 CSV to task JSONL.
  plan                Validate a manifest and print its execution matrix.
  run                 Execute the controlled in-process replay matrix.
  report              Render paired quality and resource-use results.
  harbor-agent        Launch a DSH ACP agent for Harbor end-to-end tasks.

Run a command with --help for its required options.
`

/** Execute the CLI and return a process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return 0
  }
  const options = parseOptions(rest)
  if (options.has('help')) {
    process.stdout.write(commandHelp(command))
    return 0
  }
  assertAllowed(command, options)
  switch (command) {
    case 'generate-synthetic': {
      const output = required(options, 'output')
      const tasks = generateSyntheticTasks(integer(options, 'per-category', 8), integer(options, 'seed', 20260823))
      await writeJsonl(output, tasks)
      process.stderr.write(`wrote ${tasks.length} tasks to ${resolve(output)}\n`)
      return 0
    }
    case 'import-longmemeval': {
      const tasks = await importLongMemEval(required(options, 'input'), optionalInteger(options, 'limit'))
      const output = required(options, 'output')
      await writeJsonl(output, tasks)
      process.stderr.write(`wrote ${tasks.length} tasks to ${resolve(output)}\n`)
      return 0
    }
    case 'import-mrcr-v2': {
      const tasks = await importMrcrV2(required(options, 'input'), optionalInteger(options, 'limit'))
      const output = required(options, 'output')
      await writeJsonl(output, tasks)
      process.stderr.write(`wrote ${tasks.length} tasks to ${resolve(output)}\n`)
      return 0
    }
    case 'plan': {
      const plan = await planExperiment(required(options, 'manifest'), filters(options))
      process.stdout.write(`${JSON.stringify({
        experimentId: plan.experiment.experimentId,
        tasks: plan.tasks.length,
        cells: plan.cells,
        byArm: plan.byArm,
        byCycle: plan.byCycle,
      }, null, 2)}\n`)
      return 0
    }
    case 'run': {
      const manifest = required(options, 'manifest')
      const output = required(options, 'output')
      await runExperiment(manifest, output, filters(options), (result, completed, total) => {
        process.stderr.write(`[${completed}/${total}] ${result.runId}: ${result.status}\n`)
      })
      return 0
    }
    case 'report': {
      const input = required(options, 'input')
      const output = required(options, 'output')
      const results = await readJsonl(input, runResultSchema)
      await writeFile(output, renderReport(results, options.get('baseline') ?? 'basic-text'), 'utf8')
      process.stderr.write(`wrote report to ${resolve(output)}\n`)
      return 0
    }
    case 'harbor-agent':
      return await runHarborAgent(harborOptions(options))
    default:
      throw new Error(`unknown command: ${command}`)
  }
}

function parseOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (item === undefined || !item.startsWith('--')) throw new Error(`expected an option, received: ${item ?? ''}`)
    const [rawKey, inline] = item.slice(2).split('=', 2)
    if (rawKey === undefined || rawKey === '') throw new Error('empty option name')
    if (rawKey === 'help') {
      options.set('help', 'true')
      continue
    }
    const value = inline ?? args[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new Error(`--${rawKey} requires a value`)
    }
    if (inline === undefined) index += 1
    if (options.has(rawKey)) throw new Error(`duplicate option: --${rawKey}`)
    options.set(rawKey, value)
  }
  return options
}

function filters(options: ReadonlyMap<string, string>): RunFilters {
  const taskId = options.get('task')
  const armId = options.get('arm')
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(armId === undefined ? {} : { armId }),
    ...(options.get('limit') === undefined ? {} : { limit: integer(options, 'limit') }),
  }
}

function harborOptions(options: ReadonlyMap<string, string>): HarborAgentOptions {
  const arm = required(options, 'arm')
  if (arm !== 'basic-text' && arm !== 'optical-direct' && arm !== 'optical-summary') {
    throw new Error('--arm must be basic-text, optical-direct, or optical-summary')
  }
  const thresholdRatio = options.get('threshold-ratio') === undefined ? undefined : ratio(options, 'threshold-ratio')
  const retainRatio = options.get('retain-ratio') === undefined ? undefined : ratio(options, 'retain-ratio')
  if ((retainRatio ?? 0.16) >= (thresholdRatio ?? 0.8)) {
    throw new Error('--retain-ratio must be below --threshold-ratio')
  }
  return {
    arm,
    ...(thresholdRatio === undefined ? {} : { thresholdRatio }),
    ...(retainRatio === undefined ? {} : { retainRatio }),
    ...(options.get('max-pages') === undefined ? {} : { maxPages: integer(options, 'max-pages') }),
    ...(options.get('max-generation') === undefined ? {} : { maxGeneration: integer(options, 'max-generation') }),
  }
}

function required(options: ReadonlyMap<string, string>, key: string): string {
  const value = options.get(key)
  if (value === undefined || value.length === 0) throw new Error(`--${key} is required`)
  return value
}

function optionalInteger(options: ReadonlyMap<string, string>, key: string): number | undefined {
  return options.get(key) === undefined ? undefined : integer(options, key)
}

function integer(options: ReadonlyMap<string, string>, key: string, fallback?: number): number {
  const raw = options.get(key)
  if (raw === undefined) {
    if (fallback !== undefined) return fallback
    throw new Error(`--${key} is required`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${key} must be a positive integer`)
  return value
}

function number(options: ReadonlyMap<string, string>, key: string): number {
  const value = Number(required(options, key))
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} must be positive`)
  return value
}

function ratio(options: ReadonlyMap<string, string>, key: string): number {
  const value = number(options, key)
  if (value > 1) throw new Error(`--${key} must not exceed 1`)
  return value
}

function assertAllowed(command: string, options: ReadonlyMap<string, string>): void {
  const allowed: Record<string, readonly string[]> = {
    'generate-synthetic': ['output', 'per-category', 'seed'],
    'import-longmemeval': ['input', 'output', 'limit'],
    'import-mrcr-v2': ['input', 'output', 'limit'],
    plan: ['manifest', 'task', 'arm', 'limit'],
    run: ['manifest', 'output', 'task', 'arm', 'limit'],
    report: ['input', 'output', 'baseline'],
    'harbor-agent': ['arm', 'threshold-ratio', 'retain-ratio', 'max-pages', 'max-generation'],
  }
  const commandOptions = allowed[command]
  if (commandOptions === undefined) throw new Error(`unknown command: ${command}`)
  for (const key of options.keys()) {
    if (!commandOptions.includes(key)) throw new Error(`unknown option for ${command}: --${key}`)
  }
}

function commandHelp(command: string): string {
  const usages: Record<string, string> = {
    'generate-synthetic': 'generate-synthetic --output tasks.jsonl [--per-category 8] [--seed 20260823]',
    'import-longmemeval': 'import-longmemeval --input longmemeval.json --output tasks.jsonl [--limit N]',
    'import-mrcr-v2': 'import-mrcr-v2 --input mrcr.csv --output tasks.jsonl [--limit N]',
    plan: 'plan --manifest experiment.json [--task ID] [--arm ID] [--limit N]',
    run: 'run --manifest experiment.json --output results.jsonl [--task ID] [--arm ID] [--limit N]',
    report: 'report --input results.jsonl --output report.md [--baseline basic-text]',
    'harbor-agent': 'harbor-agent --arm basic-text|optical-direct|optical-summary [--threshold-ratio 0.8] [--retain-ratio 0.16] [--max-pages 8] [--max-generation 1]',
  }
  const usage = usages[command]
  if (usage === undefined) throw new Error(`unknown command: ${command}`)
  return `Usage: dsh-long-compaction-eval ${usage}\n`
}

main(process.argv.slice(2)).then(
  code => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
