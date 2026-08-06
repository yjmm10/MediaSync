# 版本号规范（Versioning）

> 适用范围：`packages/extension`（Chrome 扩展 / Firefox / Edge）与官网、CLI/MCP 全部子包。
> 目标：版本号传达「这次变更的影响级别」，让用户从版本号就能判断要不要关注更新、会不会被 breaking change 影响。
> 基础：[Semantic Versioning 2.0.0](https://semver.org/)，并叠加项目特定的约定。

---

## 一、版本号格式

```
MAJOR.MINOR.PATCH
```

| 段位 | 含义 | 何时 bump | 项目示例 |
|------|------|-----------|----------|
| **MAJOR** | 不兼容 / 重大变更 | 架构层重构、数据/配置不兼容、UI 范式整体变化、明确废弃旧能力 | **3.0** 适配器三正交维度重构 + 前端设计系统重建；2.0 早期重构 |
| **MINOR** | 向下兼容的新能力 | 新平台适配器、新功能、能力边界扩展 | 2.1.17 新增三个云社区；2.1.20 新增 V2EX |
| **PATCH** | 向下兼容的修复 | bug 修复、单平台问题修复、文档/文案订正 | 2.1.22 InfoQ 引用换行修复 |

> 仅当本批改动里**最高档位**决定版本号。例如「新增 A 平台（minor）+ 修复 B 平台（patch）」→ minor。

---

## 二、项目历史与基线

| 版本 | 日期 | 性质 | 关键变化 |
|------|------|------|----------|
| 1.x | — | 早期 | 初代实现 |
| 2.0 | — | MAJOR | 早期重构 |
| 2.1.x | 2026-06～08 | MINOR/PATCH | 35+ 平台补齐、bug 修复 |
| **3.0.0** | **2026-08-05** | **MAJOR** | 适配器三正交维度骨架（鉴权/配置/发布）+ PipelineAdapter 迁移 20+ 平台 + 前端设计系统重建 |
| **3.1.0** | **2026-08-06** | **MINOR** | 平台类型分组 + 主路径/二级页 UI 效率布局对齐 |
| **3.1.1** | **2026-08-06** | **PATCH** | 平台列表筛选体验收敛；撤回未完工的平台发布参数配置；实时检测开关闪烁修复 |

**3.0 的特殊性**：虽为 MAJOR，但**对用户行为兼容**（35+ 平台功能不变），breaking 限于内部抽象层。changelog 必须显式说明「行为兼容」以避免用户误判升级风险。

---

## 三、硬约束（必须遵守）

### 1. 版本号不是修复流水号

- ❌ 每改一个 bug 就 bump 一个版本
- ❌ 排查中的中间态、未验收改动单独发版
- ✅ 同一批可合并交付的改动合成**一个**版本

### 2. 未验收不进 changelog

- 功能在真实环境确认正确前，**不写入** CHANGELOG / README 更新日志 / site 版本记录
- 不夸大能力（如「支持 Mermaid」但实际降级为代码块，必须标注）

### 3. MAJOR 必须说明兼容性

升 MAJOR 时，changelog 顶部必须用 `>` 引用块明确：
- 是否对用户行为兼容
- 哪些内部接口 breaking
- 用户是否需要操作

### 4. Chrome 扩展版本号限制

- Chrome `manifest.json` 的 `version` 只接受 1-4 段点分整数（如 `3.0.0`、`3.0.0.1`），**不接受**预发布后缀（`-beta.1`、`-rc.0`）
- 预发布 / 内部测试版本用第 4 段：`3.0.0.1-beta` 这种仍不行 → 改为内部分支命名约定（如 `v3.1.0-dev`），不写入 manifest
- `packages/extension/package.json` 的 `version` **必须与 manifest.json 完全一致**

---

## 四、发版同步清单

bump 版本时**必须**同步以下位置（漏改会导致扩展 / 商店 / 更新提示 / 文档不一致）：

| # | 文件 | 说明 |
|---|------|------|
| 1 | `packages/extension/manifest.json` | Chrome 读取的实际版本（最关键） |
| 2 | `packages/extension/package.json` | workspace 包版本，必须与 manifest 一致 |
| 3 | `packages/extension/src/background/index.ts` | `showChangelogVersions` 数组 + 跨 MAJOR 判断（如 `2.x→3.x`），控制升级时是否弹 changelog 页 |
| 4 | `CHANGELOG.md` | 顶部新增 `## vX.Y.Z (日期)` 条目；MAJOR 用 `>` 块说明兼容性 |
| 5 | `README.md` | 「## 更新日志」区加条目；平台表按需加 🆕 |
| 6 | `site/index.html` | `#changelog` 区新增版本块，`<span class="ver-tag">最新</span>` 移到新版本，旧版本去掉 |
| 7 | `docs/ui-style-guide.md` 等 | 若涉及视觉规范变更，同步文档里的版本示例 |

> `.claude-plugin/marketplace.json` / `plugin.json` 已不在仓库维护（历史记忆提到过，当前不存在）；若未来重新引入 Claude Code 插件市场，需补回此处。

---

## 五、发版门槛（与 CLAUDE.md 一致）

1. **功能正确性**：新平台 / 鉴权 / 图片上传等已在真实环境确认（未验证不进 changelog）
2. **批量合并**：同一批可交付的多个改动合成一个版本，取最高档位
3. **类型检查 + 构建**：`tsc --noEmit` 与 `vite build` 均通过，`dist/manifest.json` 的 version 已更新
4. **文档同步**：CHANGELOG / README / site 三处版本记录一致；平台数等营销文案一致

---

## 六、升级弹窗规则（background/index.ts）

```ts
const showChangelogVersions = [..., '3.0.0']
if (
  showChangelogVersions.includes(currentVersion) ||
  (previousVersion.startsWith('1.') && currentVersion.startsWith('2.')) ||
  (previousVersion.startsWith('2.') && currentVersion.startsWith('3.'))
) { /* 打开 changelog 页 */ }
```

- **跨 MAJOR 升级**（1.x→2.x、2.x→3.x）：**始终**弹 changelog，引导用户看 breaking / 兼容说明
- **同 MAJOR 内**：只有写入 `showChangelogVersions` 的重点版本才弹（避免每次 patch 都打扰用户）
- 新增「重点版本」时把版本号字符串加进数组

---

## 七、变更档位与 changelog emoji 约定

| 前缀 | 含义 |
|------|------|
| 🆕 | 新增平台 / 新功能 |
| 🏗️ | 架构 / 重构 |
| 🎨 | 前端 / 视觉 |
| 🔧 | bug 修复 |
| ⚠️ | 能力边界 / 已知限制（必须用户感知） |
| 📝 | 文档 / 文案 |

MAJOR 版本的 changelog 用小节分组（架构 / 前端 / 规范…），minor/patch 用扁平列表。

---

## 八、评审清单

发版前自检：

- [ ] manifest.json 与 package.json 版本一致？
- [ ] 本批最高档位 = 新版本号档位？
- [ ] 未验收的能力没写进 changelog？
- [ ] MAJOR 升级有兼容性说明？
- [ ] `background/index.ts` 的 changelog 触发逻辑已更新（重点版本 / 跨 MAJOR）？
- [ ] CHANGELOG / README / site 三处版本记录一致？
- [ ] 营销文案「N+ 平台」与实际一致？
- [ ] `vite build` 通过且 `dist/manifest.json` 版本已更新？
