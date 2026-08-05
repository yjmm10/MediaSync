# 重构迁移记录

> 分支：`refactor/adapter-architecture`
> 记录迁移过程中发现的问题、待办、行为差异。**不阻塞主推进**，按用户指示「保持现有功能，新问题先记录」。

---

## 已知待办（跨阶段）

### extension 注册代码改造（P2）
- 当前 `packages/extension/src/adapters/index.ts` 的 `adapterEntries` 只读 `meta` + `preprocessConfig`
- 因此 `registry.getProfile()` 返回默认值（`category='special'`、`publishModes=['draft']`、`authMode='sw'` 等），读不到适配器声明的 `publishSchema` / `publishDefaults`
- P2 改用 `import.meta.glob` 时，一并让注册读 `publishSchema / category / authMode / publishModes / publishDefaults`

### platforms/ 分类子目录（P2）
- 当前 `platforms/` 仍扁平（35 个文件）
- P2 按分类分子目录：`tech-community/` `media-account/` `cloud-vendor/` `social-forum/` `image-based/` `special/`

### ADAPTER_CLASSES 数组（P2）
- 当前 `extension/src/adapters/index.ts` 手工维护 36 项
- P2 用 `import.meta.glob` 自动发现后删除

### PAGE_CONTEXT_AUTH_IDS（P2）
- 当前 `extension/src/adapters/index.ts` 手工维护 `new Set(['meipian','xiaohongshu','qiehao'])`
- P2 改由 `profile.authMode` 自声明，调度层读 profile

---

## P0 功能缺陷（按用户指示暂不修，保持现有功能）

- **V2EX** `DEFAULT_NODE` 写死（节点不可选）
- **B 站** `tid: '4'` 写死（分区不可选）
- **语雀** `this.bookId` 写死（知识库不可选）
- **Reddit** 写死 profile subreddit
- **虎扑** 板块写死
- **简书** `getDefaultNotebookId` 默认文集不可选
- **CSDN / 百家号 / 博客园** 活动 id 写死

> 这些在 P2/P3 平台批迁时，配合 UI 接入一并开放为可配置项。

---

## P1 迁移记录

### CSDN（进行中）

**行为等价要点**：
1. `checkAuth` 完全保留（签名 API，不依赖 header rules）
2. `HEADER_RULES` 原来用一次 `withHeaderRules` 包**整个** publish → 迁移后拆为两次**顺序**包：
   - `uploadImages` 钩子内包一次（图片上传 `imgservice` + OBS 需要 Origin/Referer）
   - `submit` 外层由管道自动包一次（`getHeaderRules()` 返回 HEADER_RULES）
   - 两次 add/clear 顺序执行，不嵌套，避免 `clearHeaderRules` 互相清空
3. `skipPatterns: ['csdnimg.cn', 'csdn.net']` 在重写的 `uploadImages` 里保留
4. `stripDataUriImages` 在 `uploadImages` 末尾保留（上传失败的 data URI 残留清理）
5. `draftOnly` 固定返回 `true`（与原 `options?.draftOnly ?? true` 等价，因 syncToPlatform 默认 true）
6. `buildPayload` 字段写死保持等价（P2 让它读 `ctx.params`）
7. `publishSchema` 已声明（标签/分类/原创/活动/可见性），但运行时暂不读

**差异点（可接受）**：
- 原来图片去重用方法内局部 `Map`，迁移后用 `SharedImageCache`（行为等价 + 跨平台可复用）

### 掘金（已完成）

**行为等价要点**：
1. `checkAuth` 用 `SwApiAuthStrategy`（策略化鉴权，展示新架构）；fetch user/get 与原实现一致
2. `HEADER_RULES` 原来用一次 `withHeaderRules` 包整体 → 拆为两次顺序包：
   - `uploadImages` 钩子内包一次（ImageX / TOS 上传需要 Origin/Referer）
   - `submit` 外层由管道自动包一次（覆盖 `getCsrfToken` + `article_draft/create`）
3. `skipPatterns: ['juejin.cn','p1-juejin','p3-juejin','p6-juejin','p9-juejin','byteimg.com']` 在重写的 `uploadImages` 里保留
4. 掘金只用 markdown，`uploadImages` 只处理 `ctx.content.markdown`（不处理 html，等价于原 publish）
5. `uploadImageByUrl` 软失败（失败返回原 URL 不抛错）行为保留
6. `getCsrfToken` 从 publish 开头移到 `submit` 钩子内（管道 submit 外层包 header rules，覆盖到它）
7. `buildPayload` 字段写死保持等价（P2 让它读 `ctx.params`）
8. `publishSchema` 已声明（标签/分类/封面），但运行时暂不读

**差异点（可接受，等价或更优）**：
- 原来 publish 不显式 checkAuth（靠 `getCsrfToken` 隐式鉴权）；迁移后 `authorize` 钩子显式调 `SwApiAuthStrategy` → 未登录时失败点更早、错误信息更清晰（"请先登录 掘金"），最终结果一致
- 图片去重从方法内局部逻辑改为 `SharedImageCache`（同一次同步任务内跨平台可复用）

## P1 验证结果

- `tsc --noEmit` EXIT=0
- `vitest run`：**15 test files / 129 tests 全绿**（未破坏任何现有测试）
- 待真机验证：CSDN 草稿同步、掘金草稿同步（含图片上传）
