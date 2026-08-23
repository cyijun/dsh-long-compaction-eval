# DSH Long Compaction Evaluation

English | [中文](README.zh.md)

A standalone, reproducible evaluator for comparing DeepSeek Harness compact providers on long histories and end-to-end agent tasks. It does not modify the Harness repository.

The repository pins Harness `0.1.1-rc.2`, optical provider commit [`cf7814b`](https://github.com/cyijun/dsh-compaction-optical/commit/cf7814bf0c8d2651db87475a3b6a519fb62d6504), and `deepseek-v4-flash-vision-exp`.

## Arms

| Arm | Replacement | Auxiliary call |
|---|---|---:|
| `basic-text` | stock Harness text checkpoint | one |
| `optical-direct` | canonical transcript rendered to optical-memory PNG pages | none |
| `optical-summary` | stock text checkpoint rendered to optical-memory PNG pages | one |
| `no-compact` | full history | none |
| `tail-drop` | recent tail only | none; diagnostic baseline |

The optical arms explore the historical-memory direction in the [DeepSeek-OCR report](https://arxiv.org/abs/2510.18234). They evaluate a Harness-level image memory format, not the report's learned encoder.

## Evaluation tracks

1. Controlled replay seeds identical canonical DSH history and invokes the real compact provider at fixed positions. Adapters cover [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [MRCR v2](https://github.com/google-deepmind/eval_hub/tree/master/eval_hub/mrcr_v2), and deterministic exact-retention probes.
2. Harbor ACP records under [`harbor/agents`](harbor/agents) run the same DSH agent composition on real terminal tasks with only the compact provider changed. See Harbor's [generic ACP runner](https://github.com/harbor-framework/harbor/blob/main/docs/content/docs/agents/acp.mdx).

## Start

```sh
corepack prepare pnpm@11.7.0 --activate
pnpm install
pnpm run check
node dist/cli.js plan --manifest examples/experiment.json
```

The checked-in plan contains 50 real-API cells. Controlled replay defaults to a 32-estimated-token retained tail so the short smoke histories are actually compactable; set the same explicit `compaction.retainTokens` on every candidate arm for a full dataset. Start with a filtered pilot:

```sh
node dist/cli.js run --manifest examples/experiment.json --output results/pilot.jsonl --task synthetic-identifier-1 --arm basic-text
node dist/cli.js report --input results/pilot.jsonl --output results/pilot.md --baseline basic-text
```

Dataset import:

```sh
node dist/cli.js import-longmemeval --input /path/to/release.json --output data/longmemeval.jsonl
node dist/cli.js import-mrcr-v2 --input /path/to/release.csv --output data/mrcr-v2.jsonl
node dist/cli.js generate-synthetic --output data/exact-retention.jsonl --per-category 8 --seed 20260823
```

See the full [Chinese protocol](docs/protocol.zh.md) and [Chinese guide](README.zh.md). Public datasets, API keys, session logs, attachments, and results are intentionally not distributed.

## Measurement rules

- Randomize arm order within each task/cycle/replicate block and compare paired task deltas.
- Count failed cells as zero quality; report error rate separately.
- Keep provider-reported usage separate from Harness `shadowedTokenCount`, which is only an estimator.
- Do not pool experimental model aliases across dates without a model fingerprint or date block.
- Report natural-threshold and forced-pressure experiments separately.

MIT licensed. The optical provider and this evaluator are independent experiments, not official DeepSeek releases.
