/** Deterministic QA and official MRCR v2 scoring. */

import type { Score, Task } from './schema.js'
import { sequenceMatcherRatio } from './sequence-matcher.js'

/** Score one response against every accepted answer. */
export function scoreResponse(task: Task, response: string): Score {
  const exact = best(task.answers, answer => Number(response.trim() === answer.trim()))
  const normalizedResponse = normalize(response)
  const normalizedExact = best(task.answers, answer => Number(normalizedResponse === normalize(answer)))
  const contains = best(task.answers, answer => Number(normalizedResponse.includes(normalize(answer))))
  const tokenF1 = best(task.answers, answer => f1(tokens(response), tokens(answer)))
  if (task.scorer.kind === 'mrcr-v2') {
    const mrcrV2 = best(task.answers, answer => mrcrV2Score(response, answer))
    return { primary: mrcrV2, exact, normalizedExact, contains, tokenF1, mrcrV2 }
  }
  const primary = {
    exact,
    'normalized-exact': normalizedExact,
    contains,
    'token-f1': tokenF1,
  }[task.scorer.primary]
  return { primary, exact, normalizedExact, contains, tokenF1 }
}

/** Official MRCR v2 metric, including the required 12-character certificate. */
export function mrcrV2Score(prediction: string, target: string): number {
  const normalizedTarget = target.trim()
  if (prediction.length === 0 || normalizedTarget.length < 12) return 0
  const certificate = normalizedTarget.slice(0, 12)
  const targetReference = normalizedTarget.slice(12).trim()
  const normalizedPrediction = prediction.trim()
  const start = normalizedPrediction.lastIndexOf(certificate)
  if (start < 0) return 0
  const predictedContent = normalizedPrediction.slice(start + 12).trim()
  return sequenceMatcherRatio(targetReference, predictedContent)
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function tokens(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US')
  return normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+/gu) ?? []
}

function f1(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return Number(left.length === right.length)
  const counts = new Map<string, number>()
  for (const token of right) counts.set(token, (counts.get(token) ?? 0) + 1)
  let common = 0
  for (const token of left) {
    const count = counts.get(token) ?? 0
    if (count === 0) continue
    common += 1
    counts.set(token, count - 1)
  }
  if (common === 0) return 0
  const precision = common / left.length
  const recall = common / right.length
  return 2 * precision * recall / (precision + recall)
}

function best(values: readonly string[], score: (value: string) => number): number {
  return Math.max(...values.map(score))
}
