/** Launch one provider-specific DSH ACP runtime for Harbor. */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export interface HarborAgentOptions {
  arm: 'basic-text' | 'optical-direct' | 'optical-summary'
  thresholdRatio?: number
  retainRatio?: number
  maxPages?: number
  maxGeneration?: number
}

/** Replace this process with an ACP-compatible DSH child configuration. */
export async function runHarborAgent(options: HarborAgentOptions): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const config = resolve(root, 'harbor', `cordis.${options.arm}.yml`)
  const bin = import.meta.resolve('@deepseek-ai/dsh-acp-demo/bin')
  const child = spawn(process.execPath, [fileURLToPath(bin), '--config', config], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(options.thresholdRatio === undefined ? {} : { DSH_COMPACTION_THRESHOLD_RATIO: String(options.thresholdRatio) }),
      ...(options.retainRatio === undefined ? {} : { DSH_COMPACTION_RETAIN_RATIO: String(options.retainRatio) }),
      ...(options.maxPages === undefined ? {} : { DSH_OPTICAL_MAX_PAGES: String(options.maxPages) }),
      ...(options.maxGeneration === undefined ? {} : { DSH_OPTICAL_MAX_GENERATION: String(options.maxGeneration) }),
    },
    stdio: 'inherit',
  })
  const terminate = (): void => { child.kill('SIGTERM') }
  const interrupt = (): void => { child.kill('SIGINT') }
  process.once('SIGTERM', terminate)
  process.once('SIGINT', interrupt)
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      process.off('SIGTERM', terminate)
      process.off('SIGINT', interrupt)
      resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1))
    })
  })
}
