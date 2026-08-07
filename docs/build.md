# 插件与 Monorepo 构建说明

> 适用范围：Chrome / Edge / Firefox 扩展（`packages/extension`），以及共享的 `core` / `mcp-server` / `cli`。  
> 当前主开发分支：`v2`。Node **≥ 20**，Chrome **≥ 110**（MV3）。

---

## 一、包与产物

| 包 | 命令（根目录） | 产物目录 | 用途 |
|----|----------------|----------|------|
| `@mediasync/core` | `pnpm build:core` / `yarn build:core` | `packages/core/dist` | 适配器与运行时；扩展经 workspace 引用源码，MCP/CLI 多用构建产物 |
| `@mediasync/extension` | `pnpm build:extension` | **`packages/extension/dist`** | **Chrome 扩展加载目录** |
| `@mediasync/mcp-server` | `pnpm build:mcp` | `packages/mcp-server/dist` | MCP Server |
| `@mediasync/cli` | `pnpm build:cli` | `packages/cli/dist` | CLI |

根目录 `pnpm build` / `yarn build` = 对所有 workspace 执行各自的 `build`。

扩展构建步骤（`packages/extension`）：

1. `tsc --noEmit`（类型检查，不写 js 到 `src`）
2. `vite build`（`@crxjs/vite-plugin`）
3. 复制 `reader.js` / `Readability.js` 并更新 `manifest.json`

---

## 二、日常改代码后怎么重建插件

| 场景 | 推荐命令 |
|------|----------|
| 只改扩展 UI / 扩展侧逻辑 | `pnpm build:extension` 或一键脚本 |
| 改了 `packages/core` 适配器且要验证扩展 | **先 core 再 extension**（见一键脚本） |
| 改 MCP / CLI | `pnpm build:mcp` / `pnpm build:cli` |
| 全量发版前 | `pnpm build` |

### 一键重新构建扩展（推荐）

在仓库根目录：

```bash
# 跨平台（Node）
pnpm rebuild:extension
# 或
yarn rebuild:extension
# 或
node scripts/rebuild-extension.mjs
```

Windows 也可双击 / 在资源管理器运行：

```text
scripts\rebuild-extension.cmd
```

脚本默认会：

1. 构建 `@mediasync/core`（`NODE_OPTIONS=--max-old-space-size=8192`，避免 tsup OOM）
2. 构建 `@mediasync/extension`
3. 打印 `packages/extension/dist` 路径与 Chrome 加载提示

常用参数：

```bash
node scripts/rebuild-extension.mjs --extension-only   # 跳过 core，更快
node scripts/rebuild-extension.mjs --pack             # 构建后再打商店 zip
node scripts/rebuild-extension.mjs --skip-typecheck   # 仅 vite build（不推荐日常用）
```

### 开发热更新

```bash
pnpm install   # 或 yarn install
pnpm dev       # 等同 yarn workspace @mediasync/extension dev → vite
```

Chrome 加载 **`packages/extension/dist`**；保存后 Vite 会更新产物，扩展管理页点「重新加载」。

---

## 三、在浏览器中加载

1. 打开 `chrome://extensions`（Edge：`edge://extensions`）
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择  
   `packages/extension/dist`
4. 改代码并重建后：在同一页对该扩展点 **重新加载**（不必重新「加载已解压」）

打包商店安装包（可选）：

```bash
cd packages/extension
pnpm build && pnpm pack          # 或 pnpm prod
# 产物：mediasync-{ver}-chrome.zip / -edge.zip / -firefox.zip 等
```

---

## 四、包管理器说明

仓库同时存在 `pnpm-workspace.yaml` 与 yarn workspaces。根目录 `package.json` 的 scripts 以 **`yarn workspace`** 驱动；文档与 Claude 命令里常见 `pnpm xxx`，二者一般可互换，例如：

| pnpm | yarn |
|------|------|
| `pnpm install` | `yarn install` |
| `pnpm build:extension` | `yarn build:extension` |
| `pnpm rebuild:extension` | `yarn rebuild:extension` |

任选其一即可，避免混用两套 lockfile 策略导致依赖不一致。

---

## 五、常见问题

**1. 改了代码 Chrome 里没变化**  
未重建，或重建了但未在扩展管理页点「重新加载」。确认加载路径是 `dist` 而不是 `packages/extension` 源码根。

**2. `tsc` 报错导致 build 失败**  
扩展 `build` 含 `tsc --noEmit`。先 `pnpm typecheck` 或只看 extension：`yarn workspace @mediasync/extension typecheck`。

**3. core 构建 OOM**  
一键脚本已加大堆内存。手动时可：

```bash
# PowerShell
$env:NODE_OPTIONS='--max-old-space-size=8192'; yarn build:core
```

**4. 仅改 core、扩展仍像旧逻辑**  
扩展通过 workspace 引用 core 源码时，多数情况 `build:extension` 即可；若怀疑缓存，跑完整一键脚本，并硬刷新扩展。

**5. 发版与版本号**  
构建 ≠ 发版。版本 bump、changelog 见 [`docs/versioning.md`](./versioning.md)。

---

## 六、相关文档与命令

| 资源 | 说明 |
|------|------|
| [`CLAUDE.md`](../CLAUDE.md) | 架构与常用命令总览 |
| [`.claude/commands/build.md`](../.claude/commands/build.md) | Claude Code `/build` |
| [`docs/versioning.md`](./versioning.md) | 版本与发版门槛 |
| [`packages/extension/scripts/pack-zip.mjs`](../packages/extension/scripts/pack-zip.mjs) | 商店 zip / xpi 打包 |
