/** Lossless JSON and JSONL filesystem helpers. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { z } from 'zod'

/** Read and validate one JSON document. */
export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const source = await readFile(path, 'utf8')
  return schema.parse(JSON.parse(source) as unknown)
}

/** Read and validate newline-delimited JSON objects. */
export async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const source = await readFile(path, 'utf8')
  return source.split(/\r?\n/u).flatMap((line, index) => {
    if (line.trim().length === 0) return []
    try {
      return [schema.parse(JSON.parse(line) as unknown)]
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSONL record`, { cause: error })
    }
  })
}

/** Write one JSON document with a stable trailing newline. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Write newline-delimited JSON with a stable trailing newline. */
export async function writeJsonl(path: string, values: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const body = values.map(value => JSON.stringify(value)).join('\n')
  await writeFile(path, body.length === 0 ? '' : `${body}\n`, 'utf8')
}

/** Resolve a path relative to the manifest that names it. */
export function relativeTo(ownerPath: string, childPath: string): string {
  return resolve(dirname(resolve(ownerPath)), childPath)
}
