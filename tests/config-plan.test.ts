import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { planExperiment } from '../src/runner.js'
import { experimentSchema } from '../src/schema.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sessionRoot = mkdtempSync(join(tmpdir(), 'dsh-eval-config-'))

afterAll(() => { rmSync(sessionRoot, { recursive: true, force: true }) })

describe('configuration', () => {
  it('rejects duplicate arm ids', () => {
    expect(() => experimentSchema.parse({
      schemaVersion: 1,
      experimentId: 'duplicate',
      taskFiles: ['tasks.jsonl'],
      cycles: [1],
      arms: [{ id: 'same', kind: 'basic' }, { id: 'same', kind: 'no-compact' }],
      runtime: {},
      provenance: { harnessPackages: 'x', opticalCommit: 'y' },
    })).toThrow(/arm ids must be unique/u)
  })

  it('loads every Harbor DSH composition with keyless EOF shutdown', () => {
    const bin = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-acp-demo/bin'))
    for (const arm of ['basic-text', 'optical-direct', 'optical-summary']) {
      const child = spawnSync(process.execPath, [bin, '--config', resolve(root, 'harbor', `cordis.${arm}.yml`)], {
        cwd: root,
        input: '',
        encoding: 'utf8',
        env: { ...process.env, DSH_EVAL_SESSION_ROOT: join(sessionRoot, arm) },
      })
      expect(child.status, child.stderr).toBe(0)
      expect(child.stdout).toBe('')
    }
  })

  it('plans the checked-in paired smoke matrix', async () => {
    const plan = await planExperiment(resolve(root, 'examples/experiment.json'))
    expect(plan.tasks).toHaveLength(5)
    expect(plan.cells).toBe(50)
    expect(plan.byArm['optical-direct']).toBe(10)
  })
})
