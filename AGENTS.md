# AGENTS.md

始终使用中文交流。当前年份是 2026 年。

本仓库是 DeepSeek Harness compact provider 的独立测评工具，不属于 Harness monorepo，也不修改 Harness 内部实现。

- Node.js 必须满足 `^22.19.0 || >=24.0.0`，包管理器使用 `pnpm@11.7.0`。
- DSH 包和 optical 插件必须固定精确版本或 commit；更新时同步修改 README、示例 manifest 和 Harbor 配置。
- 测评必须保持 Agent、模型、工具、系统提示词、任务预算一致，只改变 compact provider。
- `shadowedTokenCount` 是 Harness 启发式估值，不得当作真实提供方输入 token；真实成本使用 provider-reported usage。
- 不提交 API key、下载的数据集、运行结果、session 日志或图片附件。
- 修改后运行 `pnpm run check`，只报告实际运行的命令。
