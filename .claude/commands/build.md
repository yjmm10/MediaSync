# Build Project

构建项目并检查错误。优先按场景选择命令，细节见 `docs/build.md`。

## 场景

| 目标 | 命令 |
|------|------|
| 一键重建 Chrome 扩展（含 core） | `pnpm rebuild:extension` 或 `node scripts/rebuild-extension.mjs` |
| 仅扩展 | `pnpm build:extension` 或 `node scripts/rebuild-extension.mjs --extension-only` |
| 全量 monorepo | `pnpm build` |
| 仅 core | `pnpm build:core` |

## 执行步骤

1. 按上表运行对应构建命令
2. 若有 TypeScript / Vite 错误，分析并修复后重跑
3. 扩展产物在 `packages/extension/dist`；提醒用户在 `chrome://extensions` 重新加载
4. 报告构建结果（成功 / 失败原因）
