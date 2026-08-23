import { describe, expect, it } from 'vitest'
import { mrcrV2Score, scoreResponse } from '../src/scoring.js'
import { sequenceMatcherRatio } from '../src/sequence-matcher.js'
import { generateSyntheticTasks } from '../src/synthetic.js'

describe('scoring', () => {
  it('implements the MRCR v2 certificate and last-match rule', () => {
    expect(mrcrV2Score('abcdefghijklhello world', 'abcdefghijklhello world')).toBe(1)
    expect(mrcrV2Score('wrong-prefix hello world', 'abcdefghijklhello world')).toBe(0)
    expect(mrcrV2Score('abcdefghijklwrong abcdefghijklhello world', 'abcdefghijklhello world')).toBe(1)
  })

  it('matches known Python difflib ratios', () => {
    expect(sequenceMatcherRatio('abcd', 'bcde')).toBe(0.75)
    expect(sequenceMatcherRatio('', '')).toBe(1)
    expect(sequenceMatcherRatio('private Thread currentThread', 'public Thread currentThread')).toBeCloseTo(0.8363636363636363)
  })

  it('scores CJK exact-retention probes without whitespace tokenization', () => {
    const task = generateSyntheticTasks(1).find(candidate => candidate.tags.category === 'cjk')
    expect(task).toBeDefined()
    expect(scoreResponse(task!, task!.answers[0] ?? '').primary).toBe(1)
  })

  it('generates a deterministic balanced diagnostic set', () => {
    const first = generateSyntheticTasks(2, 42)
    expect(first).toEqual(generateSyntheticTasks(2, 42))
    expect(first).toHaveLength(10)
    expect(new Set(first.map(task => task.tags.category)).size).toBe(5)
  })
})
