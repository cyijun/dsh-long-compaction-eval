/** Versioned input and output schemas for reproducible compaction experiments. */

import { z } from 'zod'

const nonEmpty = z.string().min(1)
const jsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()])
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  jsonScalar,
  z.array(jsonValue),
  z.record(z.string(), jsonValue),
]))

export const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).strict()

export const imageContentSchema = z.object({
  type: z.literal('image'),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataBase64: nonEmpty,
  name: nonEmpty.optional(),
}).strict()

export const taskMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(z.discriminatedUnion('type', [textContentSchema, imageContentSchema])).min(1),
}).strict()

export const taskSegmentSchema = z.object({
  id: nonEmpty,
  timestamp: nonEmpty.optional(),
  messages: z.array(taskMessageSchema).min(1),
}).strict()

export const scorerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('qa'),
    primary: z.enum(['exact', 'normalized-exact', 'contains', 'token-f1']).default('token-f1'),
  }).strict(),
  z.object({ kind: z.literal('mrcr-v2') }).strict(),
])

export const taskSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  dataset: nonEmpty,
  split: nonEmpty,
  query: nonEmpty,
  answers: z.array(nonEmpty).min(1),
  segments: z.array(taskSegmentSchema).min(1),
  scorer: scorerSchema,
  tags: z.record(z.string(), z.string()).default({}),
  metadata: z.record(z.string(), jsonValue).default({}),
}).strict()

const commonCompactionSchema = z.object({
  thresholdRatio: z.number().positive().max(1).default(0.8),
  retainTokens: z.number().int().positive().default(32),
  maxTokens: z.number().int().positive().default(8192),
  summarizationProvider: z.string().default(''),
  summarizationModel: z.string().default(''),
  compactionRetries: z.number().int().nonnegative().default(1),
}).strict()

const commonCompactionDefaults = {
  thresholdRatio: 0.8,
  retainTokens: 32,
  maxTokens: 8192,
  summarizationProvider: '',
  summarizationModel: '',
  compactionRetries: 1,
}

const opticalSchema = commonCompactionSchema.extend({
  maxPages: z.number().int().positive().default(8),
  maxGeneration: z.number().int().nonnegative().default(1),
  pageWidthPx: z.number().int().positive().default(800),
  pageHeightPx: z.number().int().positive().default(800),
  marginPx: z.number().int().nonnegative().default(24),
  fontSizePx: z.number().int().positive().default(12),
  lineHeightPx: z.number().int().positive().default(16),
}).strict()

const opticalDefaults = {
  ...commonCompactionDefaults,
  maxPages: 8,
  maxGeneration: 1,
  pageWidthPx: 800,
  pageHeightPx: 800,
  marginPx: 24,
  fontSizePx: 12,
  lineHeightPx: 16,
}

export const armSchema = z.discriminatedUnion('kind', [
  z.object({
    id: nonEmpty,
    kind: z.literal('basic'),
    compaction: commonCompactionSchema.default(commonCompactionDefaults),
  }).strict(),
  z.object({
    id: nonEmpty,
    kind: z.literal('optical-direct'),
    compaction: opticalSchema.default(opticalDefaults),
  }).strict(),
  z.object({
    id: nonEmpty,
    kind: z.literal('optical-summary'),
    compaction: opticalSchema.default(opticalDefaults),
  }).strict(),
  z.object({ id: nonEmpty, kind: z.literal('no-compact') }).strict(),
  z.object({
    id: nonEmpty,
    kind: z.literal('tail-drop'),
    tailFraction: z.number().positive().max(1).default(0.16),
  }).strict(),
])

export const experimentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: nonEmpty,
  taskFiles: z.array(nonEmpty).min(1),
  cycles: z.array(z.number().int().nonnegative().max(16)).min(1),
  replications: z.number().int().positive().max(100).default(1),
  arms: z.array(armSchema).min(1),
  runtime: z.object({
    provider: nonEmpty.default('deepseek-official'),
    model: nonEmpty.default('deepseek-v4-flash-vision-exp'),
    systemPrompt: z.string().default('Answer the final question using the established conversation history. Return only the answer.'),
    queryMaxTokens: z.number().int().positive().default(2048),
    temperature: z.number().min(0).max(2).default(0),
    reasoningEffort: z.enum(['off', 'low', 'high', 'max']).default('off'),
  }).strict(),
  provenance: z.object({
    harnessPackages: nonEmpty,
    opticalCommit: nonEmpty,
    datasetRevisions: z.record(z.string(), nonEmpty).default({}),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const ids = value.arms.map(arm => arm.id)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'arm ids must be unique', path: ['arms'] })
  }
  if (new Set(value.cycles).size !== value.cycles.length) {
    ctx.addIssue({ code: 'custom', message: 'cycles must be unique', path: ['cycles'] })
  }
})

export const usageSchema = z.object({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  cacheReadTokens: z.number().nonnegative().default(0),
  cacheWriteTokens: z.number().nonnegative().default(0),
  reasoningTokens: z.number().nonnegative().default(0),
  processedInputTokens: z.number().nonnegative().default(0),
}).strict()

export const scoreSchema = z.object({
  primary: z.number().min(0).max(1),
  exact: z.number().min(0).max(1),
  normalizedExact: z.number().min(0).max(1),
  contains: z.number().min(0).max(1),
  tokenF1: z.number().min(0).max(1),
  mrcrV2: z.number().min(0).max(1).optional(),
}).strict()

export const compactionMetricSchema = z.object({
  compactionId: nonEmpty,
  status: z.enum(['ok', 'error', 'open']),
  durationMs: z.number().nonnegative().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  shadowedNodes: z.number().int().nonnegative().default(0),
  shadowedTokenEstimate: z.number().nonnegative().default(0),
  opticalPages: z.number().int().nonnegative().default(0),
  opticalMaxGeneration: z.number().int().nonnegative().default(0),
  usage: usageSchema,
  error: z.string().optional(),
}).strict()

export const runResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: nonEmpty,
  experimentId: nonEmpty,
  taskId: nonEmpty,
  dataset: nonEmpty,
  split: nonEmpty,
  armId: nonEmpty,
  armKind: nonEmpty,
  cycleTarget: z.number().int().nonnegative(),
  replicate: z.number().int().nonnegative(),
  startedAt: nonEmpty,
  durationMs: z.number().nonnegative(),
  status: z.enum(['ok', 'error']),
  response: z.string().default(''),
  answers: z.array(z.string()).default([]),
  scores: scoreSchema.optional(),
  usage: z.object({
    main: usageSchema,
    compaction: usageSchema,
    total: usageSchema,
  }).strict(),
  compactions: z.array(compactionMetricSchema),
  tags: z.record(z.string(), z.string()).default({}),
  provenance: experimentSchema.shape.provenance,
  error: z.object({ name: nonEmpty, message: nonEmpty, code: nonEmpty.optional() }).strict().optional(),
}).strict()

export type Arm = z.infer<typeof armSchema>
export type Experiment = z.infer<typeof experimentSchema>
export type Task = z.infer<typeof taskSchema>
export type TaskContent = z.infer<typeof textContentSchema> | z.infer<typeof imageContentSchema>
export type TaskMessage = z.infer<typeof taskMessageSchema>
export type Usage = z.infer<typeof usageSchema>
export type Score = z.infer<typeof scoreSchema>
export type CompactionMetric = z.infer<typeof compactionMetricSchema>
export type RunResult = z.infer<typeof runResultSchema>
