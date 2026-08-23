# DSH 长任务压缩测评

[English](README.md) | 中文

这是一个独立于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的可复现测评工具，用来比较不同 compact provider 对长任务质量、成本和稳定性的影响。它不会修改 Harness 源码。

当前固定版本：

- DeepSeek Harness npm 包：`0.1.1-rc.2`
- 光学压缩插件：[`cf7814bf0c8d2651db87475a3b6a519fb62d6504`](https://github.com/cyijun/dsh-compaction-optical/commit/cf7814bf0c8d2651db87475a3b6a519fb62d6504)
- 目标模型：`deepseek-v4-flash-vision-exp`

## 测评对象

| Arm | 替换历史的形式 | 辅助模型调用 |
|---|---|---:|
| `basic-text` | Harness 原生文字 compact | 1 次摘要调用 |
| `optical-direct` | 原始历史直接渲染为光学记忆 | 0 次 |
| `optical-summary` | 先文字 compact，再把结果渲染为光学记忆 | 1 次 |
| `no-compact` | 完整历史 | 0 次；质量上界参考 |
| `tail-drop` | 只保留尾部历史 | 0 次；弱基线，不是候选 provider |

光学方案受 [DeepSeek-OCR 技术报告](https://arxiv.org/abs/2510.18234)启发，但此仓库测的是 Harness 层的 PNG 光学记忆，不把它等同于报告中的 learned encoder，也不预设它一定优于文字摘要。

## 两条测评轨道

### 1. 受控历史回放

同一条规范化历史、同一模型、同一最终问题，只改变 compact provider。运行器在预先确定的位置调用真实 `ctx.compaction.compactNow()`，因此每个 arm 的压缩次数一致，不受自动阈值是否恰好触发影响。

内置适配器支持：

- [LongMemEval](https://github.com/xiaowu0162/LongMemEval)：长会话记忆、时间推理、知识更新和拒答；导入时不保留 `has_answer` 等答案位置标签。
- [MRCR v2](https://github.com/google-deepmind/eval_hub/tree/master/eval_hub/mrcr_v2)：多轮同类请求中的序数检索；使用官方 12 字符证书和 Python `difflib.SequenceMatcher` 兼容评分。
- `DSH-Exact-Retention`：仓库自带的确定性探针，覆盖精确标识符、知识覆盖、任务状态、CJK 和提示注入。

### 2. Harbor 真实 Agent 任务

三份 ACP registry record 位于 [`harbor/agents`](harbor/agents)，分别启动同一 DSH Agent 组合，只替换 compact provider。它们可以用于 [Harbor 的通用 ACP runner](https://github.com/harbor-framework/harbor/blob/main/docs/content/docs/agents/acp.mdx) 和 [Terminal-Bench 2.0](https://github.com/laude-institute/terminal-bench-2)。Registry record 固定到带预构建产物的 GitHub Release tarball；`npm-shrinkwrap.json` 固定其 npm 依赖树，只放行 `dsh-subprocess-local`、`koffi` 和 `node-pty` 三个运行时需要的安装脚本。

这条轨道测最终任务 reward、超时、工具循环、压缩次数和实际 provider usage。配置中的 bash 是 task-container 内的本地执行器；不要在宿主机上对不可信任务直接启动这些配置。

## 快速开始

要求 Node.js `^22.19.0 || >=24`、Corepack 和 DeepSeek API key。

```sh
corepack prepare pnpm@11.7.0 --activate
pnpm install
pnpm run check
```

先执行无需 API 的计划检查：

```sh
node dist/cli.js plan --manifest examples/experiment.json
```

示例矩阵有 5 条任务、5 个 arm、2 个压缩周期，共 50 个 cell。为让短 smoke 历史也能形成可压缩范围，受控回放默认保留尾部 `32` 个估算 token；正式 LongMemEval／MRCR 实验应在每个候选 arm 的 `compaction.retainTokens` 中显式写入同一个预登记预算。示例会产生真实 API 成本；可先限制到一条任务和一个 arm：

```sh
node dist/cli.js run \
  --manifest examples/experiment.json \
  --output results/pilot.jsonl \
  --task synthetic-identifier-1 \
  --arm basic-text

node dist/cli.js report \
  --input results/pilot.jsonl \
  --output results/pilot.md \
  --baseline basic-text
```

导入公开数据集：

```sh
node dist/cli.js import-longmemeval --input /path/to/longmemeval.json --output data/longmemeval.jsonl
node dist/cli.js import-mrcr-v2 --input /path/to/mrcr_v2.csv --output data/mrcr-v2.jsonl
node dist/cli.js generate-synthetic --output data/exact-retention.jsonl --per-category 8 --seed 20260823
```

数据集不随仓库分发。请固定上游 revision，并把 revision 写进 experiment manifest 的 `provenance.datasetRevisions`。

## Harbor 用法

安装 Harbor 后，对每个 record 使用相同数据集、尝试次数和 Agent 环境：

```sh
harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a acp \
  -m deepseek/deepseek-v4-flash-vision-exp \
  --agent-kwarg registry_entry_path=/absolute/path/to/harbor/agents/basic-text.agent.json \
  --agent-env DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  --n-attempts 3
```

把 record 换成 `optical-direct.agent.json` 和 `optical-summary.agent.json`，其余参数保持不变。Harbor 会输出 `trajectory.json`；详细的任务筛选、配对、压力分层和晋级门槛见 [`docs/protocol.zh.md`](docs/protocol.zh.md)。

如果自然任务达不到模型上下文阈值，先用受控回放做主结论；Harbor 轨道可以另做固定压力实验，在三个 record 的 `args` 后同时追加：

```json
["--threshold-ratio", "0.05", "--retain-ratio", "0.01"]
```

压力实验与自然阈值实验必须分开报告。

## 输出与解释

`results.jsonl` 每行保留 arm、任务、目标压缩周期、重复编号、答案分数、主调用与压缩调用 usage、压缩事件、光学页数／代际、耗时、错误和版本来源。报告按任务做配对差值和 10,000 次 task bootstrap 置信区间。

不要把以下量混在一起：

- `scores.primary` 是任务质量；失败 cell 按 0 计。
- `usage.total.processedInputTokens` 是 provider 返回的 `input + cache read + cache write`，不是金额。
- `shadowedTokenEstimate` 是 Harness 估算，只用于解释被替换范围，不能当真实输入 token。
- PNG 页数和图片计费上限不是语义信息容量。

## 许可与安全

代码使用 MIT 许可证。API key、原始数据集、运行结果、session 日志和附件目录均不应提交。光学插件是独立实验项目，不是 DeepSeek 官方发布。
