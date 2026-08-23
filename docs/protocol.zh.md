# 不同 compact provider 的长任务测评协议

## 决策问题

主问题不是“哪种压缩率最高”，而是：在相同 Agent、模型、提示词、工具、任务预算和历史条件下，候选 provider 能否在不显著降低任务质量的前提下降低真实输入成本，并在多次压缩后保持稳定。

预先登记两个晋级条件：

1. 候选相对 `basic-text` 的任务级配对质量差 95% bootstrap 下界不低于 `-0.02`。
2. provider-reported processed input 或可复核金额成本至少下降 20%，且错误率不增加超过 1 个百分点。

这两个条件分别判断，不合成一个加权总分。阈值应在看完整结果前固定；改变阈值必须形成新的 experiment id。

## 因子设计

主因子是 compact provider：`basic-text`、`optical-direct`、`optical-summary`。`no-compact` 是质量／成本参考，`tail-drop` 只用于确认任务确实依赖早期历史。

压力因子分两轨：

- 受控回放：固定压缩周期 `1/3/5`，所有候选在相同 segment 后压缩。
- 真实 Agent：自然阈值 `0.8/0.16` 与强制压力阈值分开运行；建议压力档 `0.05/0.01`，三个候选完全一致。

不要把 0 次压缩的 cell 当作 provider 效果。如果一个真实任务所有 arm 都没有发生压缩，它只进入 Agent 基础能力监控，不进入压缩效果主分析。

## 数据集与分层

### 受控回放

- LongMemEval：按 `question_type`、拒答／非拒答、历史长度分层。
- MRCR v2：优先 8-needle，按上下文长度、needle 位置和 needle 数分层；工具必须关闭，否则测到的是脚本检索能力。
- DSH-Exact-Retention：分别报告 identifier、knowledge-update、task-state、CJK、prompt-injection。

### 真实 Agent

先用固定的无压缩配置做一次盲 pilot，只按模型可见输入量、工具步数和墙钟时长选出长任务，不使用候选 provider 的任务得分做筛选。锁定任务清单后再运行三个候选。Terminal-Bench 2.0 至少按任务家族和预计输入量分层；若加入 SWE 类数据集，应冻结具体 release、镜像 digest 和测试补丁。

## 配对、随机化与重复

实验单元是 `task × pressure × replicate`。同一个单元内，三个 provider 使用同一任务版本、初始文件、模型 alias、参数和预算；arm 顺序由 experiment id 和 task id 确定性随机化。

- pilot：每个 cell 1 次，仅检查可运行性和成本范围。
- 正式运行：每个 cell 至少 3 次；若任务方差较高或排名接近门槛，增加到 5 次。
- 并发：不同任务可以并发，同一配对块不要因 arm 改变并发等级。
- 日期：实验模型 alias 可能漂移。尽量在短时间窗口交错运行各 arm；跨日期时按日期分块，不直接合并。

## 指标

主质量指标使用数据集官方 verifier 或 reward。受控回放另外记录 exact、normalized exact、contains、token F1；MRCR 使用官方证书约束的 SequenceMatcher ratio。

资源指标：

- 主请求、压缩请求和合计的 input/output/cache/reasoning usage。
- processed input = input + cache read + cache write；这是统一流量指标，不是金额。
- 压缩次数、压缩失败率、每次压缩耗时、总墙钟耗时。
- optical 页数、最大 aging generation。
- 被 shadow 的节点数和估算 token 只作诊断。

稳定性指标：任务错误率、超时率、无进展工具循环、输出格式失败、压缩事务 open/error、第二次及以后压缩相对第一次的质量衰减。

## 统计分析

先在每个 task 内对重复取均值，再计算候选减 `basic-text` 的配对差。使用 task 为抽样单位的非参数 bootstrap，固定 seed，10,000 次，报告均值差和 95% 区间。成本报告相对差和绝对量；重尾耗时报告中位数及 P90。

主表按 `provider × 压缩周期／压力档` 展示；至少附四个切片：精确字符串／代码、知识更新、CJK、提示注入。任何总体晋级结论都必须同时给出错误率和这些切片，避免平均分掩盖灾难性回归。

## 运行顺序

1. 固定依赖版本、模型 alias、数据 revision、系统提示词、生成参数、工具集合和预算。
2. 执行 `plan`，保存 cell 数与分层计数。
3. 每个 arm 各跑 1 个最小 cell；确认真实发生预期次数的压缩、usage 不为空、输出可评分。
4. 跑 10% pilot；只允许修复执行错误，不根据成绩改任务或阈值。
5. 锁定 manifest，完成正式矩阵；每个 cell 结束立即追加 JSONL，失败不重写为成功。
6. 生成配对报告，并人工抽查每个关键错误类型、光学页和 session 事件。
7. 只有满足预登记质量与成本门槛才进入灰度；否则保留分层结论，不宣布总体胜出。

## 可复现性清单

报告必须包含 Git commit、Harness 包版本、光学插件 commit、数据 revision、模型 alias、运行日期、阈值、保留预算、图片页配置、replication、随机 seed、失败重试政策和原始 JSONL SHA-256。密钥、原始受限数据、附件和 session 日志不进入公开仓库。
