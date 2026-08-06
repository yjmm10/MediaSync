# MediaSync 问题与修复跟踪

> 记录**已发现问题**、**目标行为**与**修复状态**。与 `packages/extension/ROADMAP.md`（功能规划）分开：本文件偏缺陷 / 行为债。  
> 当前对照版本：**v2.1.22**（2026-08-05）。

## 图例

| 状态 | 含义 |
|------|------|
| 🔴 待修 | 已确认，尚未改 |
| 🟡 进行中 | 正在改 |
| 🟢 已修 | 已合入并验证 |
| 📝 备注 | 仅记录，非必须改 |

---

## 🟢 鉴权开标签：仅允许手动检测（v2.1.22）

### 现象

打开扩展 / 后台 TTL 刷新 / 全量鉴权时，下列平台会在 `checkAuth` 里走 `pageFetchJson` / `runOnPageTab` / `ensurePageTab`，**自动新建或导航标签**探测登录，干扰浏览：

| 平台 ID | 名称 | 说明 |
|---------|------|------|
| `volcengine` | 火山引擎开发者社区 | SW 失败后页面探测会开页 |
| `baidu-developer` | 百度开发者中心 | 注释写明可 `pageFetchJson(CREATE_URL)` 自动开页 |
| `tencentcloud` | 腾讯云开发者社区 | `detectAuthViaPageContext` → `runOnPageTab` |

同类风险（同样会开页，建议一并纳入白名单）：

| 平台 ID | 名称 |
|---------|------|
| `aliyun-developer` | 阿里云开发者社区 |
| `modelscope` | 魔搭研习社 |

（`qianfan` 登录探测已改为 SW 优先 + **仅复用已开标签**，不 `create`；图片上传仍可能 `ensurePageTab`，属发布路径，与「鉴权自动开页」分开跟踪。）

### 现状代码

- 扩展侧 `TAB_AUTH_PLATFORM_IDS`（`packages/extension/src/adapters/index.ts`）含：
  - `meipian` / `xiaohongshu` / `qiehao` / `volcengine` / `baidu-developer` / `tencentcloud` / `aliyun-developer` / `modelscope` / `v2ex`
- 上述平台：**全量检查（含 forceRefresh）不自动 `checkAuth`**；仅手动「重新检测」真检。
- 临时鉴权标签经 `runtime.tabs.addToAuthGroup` 归入标题为「鉴权」的标签组；`releaseEphemeralTabs` 只关 ephemeral。

### 目标行为（需修正）

1. **凡依赖打开标签页的登录检测，一律禁止自动执行**  
   - 包括：插件打开、后台预检、TTL 过期刷新、全量 forceRefresh。  
   - **第一次使用也不自动开页检测**。
2. **仅用户手动点击「重新检测 / 去登录后检测」时**才允许 `ensurePageTab` / `pageFetchJson` 建标签。
3. **检测用标签进入独立标签组**（Chrome `tabGroups`），避免散落在普通标签栏。
4. **检测结束（成功或失败）后自动关闭**本次为鉴权创建的临时标签，并尽量解散/清理空标签组。  
   - 用户原本已打开的同站标签：**不要误关**（仅关 ephemeral / 本次 create 的）。

### 建议改法（实现时参考）

1. 扩展 `PAGE_CONTEXT_AUTH_IDS` 扩为「会开标签鉴权」全集，至少含：  
   `volcengine`、`baidu-developer`、`tencentcloud`、`aliyun-developer`、`modelscope`（及后续同类）。
2. 或适配器侧增加能力标记（如 `authRequiresTab: true`），由 registry 驱动，避免只维护一处 Set 易漏。
3. Runtime / `ensurePageTab`：创建 ephemeral 时 `groupId` 归入固定名标签组（如「同步派·鉴权」）；`releaseEphemeralTabs` 关闭后清理组。
4. 单测 / 手工：冷启动无缓存 → 上述平台显示未登录或缓存态，**零新标签**；点手动检测 → 组内出现临时页 → 结束后关闭。

### 验收

- [x] 冷启动 / 刷新扩展：火山、百度开发、腾讯云 **不**自动开标签（调度层已跳过；待手工确认）
- [x] 仅手动「重新检测」开标签，且在「鉴权」标签组内（实现已合入；待手工确认）
- [x] 检测结束后临时标签关闭；用户原有站点标签仍在（原有 `releaseEphemeralTabs`；待手工确认）
- [x] 美篇 / 小红书 / 企鹅号原有「不自动真检」行为不变

---

## 其它已知问题（待补）

| 状态 | 版本 | 问题 | 备注 |
|------|------|------|------|
| 📝 | v2.1.22 | 千帆：同步时可开页上传图片 | 发布路径，非鉴权；若也要「绝不自动开页」需另定策略 |
| 📝 | — | （后续问题按行追加） | |

---

## 已修复摘录（便于对照）

| 版本 | 项 |
|------|-----|
| v2.1.22 | InfoQ：多行引用换行；图片 `upload/urls` → `upload/base64` 回退 |
| v2.1.21 | CSDN 本地图 base64 残留；魔搭表格/列表等 |
| 更早 | 美篇 / 小红书 / 企鹅号已纳入 `PAGE_CONTEXT_AUTH_IDS` 禁止自动开标签鉴权 |

---

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-08-05 | 初建：记录 v2.1.22 鉴权自动开标签问题与目标行为 |
| 2026-08-06 | 实现：`TAB_AUTH_PLATFORM_IDS` 扩至 8 平台；临时页入「鉴权」组；用户自定义平台分组 |
