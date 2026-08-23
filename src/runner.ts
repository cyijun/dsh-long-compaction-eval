/** Experiment planning and sequential paired execution. */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { experimentSchema, taskSchema, type Arm, type Experiment, type RunResult, type Task } from './schema.js'
import { readJson, readJsonl, relativeTo } from './io.js'
import { runReplayCell } from './runtime.js'

export interface RunFilters {
  taskId?: string
  armId?: string
  limit?: number
}

export interface ExperimentPlan {
  experiment: Experiment
  tasks: Task[]
  cells: number
  byArm: Record<string, number>
  byCycle: Record<string, number>
}

/** Load a manifest and every task file it pins. */
export async function loadExperiment(path: string): Promise<{ experiment: Experiment; tasks: Task[] }> {
  const experiment = await readJson(path, experimentSchema)
  const tasks = (await Promise.all(experiment.taskFiles.map(taskFile => (
    readJsonl(relativeTo(path, taskFile), taskSchema)
  )))).flat()
  const ids = tasks.map(task => task.id)
  if (new Set(ids).size !== ids.length) throw new Error('task ids must be unique across taskFiles')
  return { experiment, tasks }
}

/** Validate all cells and return their deterministic count. */
export async function planExperiment(path: string, filters: RunFilters = {}): Promise<ExperimentPlan> {
  const loaded = await loadExperiment(path)
  const tasks = selectTasks(loaded.tasks, filters)
  const arms = selectArms(loaded.experiment.arms, filters)
  for (const task of tasks) {
    for (const cycle of loaded.experiment.cycles) {
      if (cycle > 0 && task.segments.length < cycle + 1
        && arms.some(arm => isCompactionArm(arm))) {
        throw new Error(`task ${task.id} has ${task.segments.length} segments; cycle ${cycle} needs at least ${cycle + 1}`)
      }
    }
  }
  const perPair = loaded.experiment.cycles.length * loaded.experiment.replications
  return {
    experiment: { ...loaded.experiment, arms },
    tasks,
    cells: tasks.length * arms.length * perPair,
    byArm: Object.fromEntries(arms.map(arm => [arm.id, tasks.length * perPair])),
    byCycle: Object.fromEntries(loaded.experiment.cycles.map(cycle => [String(cycle), tasks.length * arms.length * loaded.experiment.replications])),
  }
}

/** Run every paired cell, appending durable JSONL after each completion. */
export async function runExperiment(
  manifestPath: string,
  outputPath: string,
  filters: RunFilters = {},
  onResult?: (result: RunResult, completed: number, total: number) => void,
): Promise<RunResult[]> {
  const plan = await planExperiment(manifestPath, filters)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, '', 'utf8')
  const results: RunResult[] = []
  for (const task of deterministicShuffle(plan.tasks, hash(`${plan.experiment.experimentId}:tasks`))) {
    for (const cycle of plan.experiment.cycles) {
      for (let replicate = 0; replicate < plan.experiment.replications; replicate += 1) {
        const arms = deterministicShuffle(
          plan.experiment.arms,
          hash(`${plan.experiment.experimentId}:${task.id}:${cycle}:${replicate}`),
        )
        for (const arm of arms) {
          const result = await runReplayCell(plan.experiment, task, arm, cycle, replicate)
          results.push(result)
          await appendFile(outputPath, `${JSON.stringify(result)}\n`, 'utf8')
          onResult?.(result, results.length, plan.cells)
        }
      }
    }
  }
  return results
}

function selectTasks(tasks: readonly Task[], filters: RunFilters): Task[] {
  const selected = filters.taskId === undefined ? [...tasks] : tasks.filter(task => task.id === filters.taskId)
  if (filters.taskId !== undefined && selected.length === 0) throw new Error(`unknown task id: ${filters.taskId}`)
  if (filters.limit !== undefined && (!Number.isSafeInteger(filters.limit) || filters.limit <= 0)) {
    throw new Error('limit must be a positive integer')
  }
  return filters.limit === undefined ? selected : selected.slice(0, filters.limit)
}

function selectArms(arms: readonly Arm[], filters: RunFilters): Arm[] {
  const selected = filters.armId === undefined ? [...arms] : arms.filter(arm => arm.id === filters.armId)
  if (filters.armId !== undefined && selected.length === 0) throw new Error(`unknown arm id: ${filters.armId}`)
  return selected
}

function isCompactionArm(arm: Arm): boolean {
  return arm.kind === 'basic' || arm.kind === 'optical-direct' || arm.kind === 'optical-summary'
}

function deterministicShuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values]
  let state = seed >>> 0
  const random = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const current = result[index]
    result[index] = result[swap] as T
    result[swap] = current as T
  }
  return result
}

function hash(value: string): number {
  let result = 2166136261
  for (const char of value) {
    result ^= char.codePointAt(0) ?? 0
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}
