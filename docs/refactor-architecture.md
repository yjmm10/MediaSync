# 适配器架构重构蓝图

> 分支：`refactor/adapter-architecture`
> 目标：将平台适配器的「鉴权 / 配置 / 发布」三类共性抽象成正交的可组合抽象，让新增平台与维护成本下降，同时**保证现有 35+ 平台功能完全不变**。

---

## 一、背景与痛点

### 现状痛点

1. **`PublishOptions` 过薄**：只有 `draftOnly` 与 `onImageProgress`。所有平台差异（标签、分类、可见性、原创/转载、活动、专栏、封面、定时…）全部以常量写死在每个适配器请求体里，用户无法在 UI 调整。
2. **`draftOnly` 在大多数平台是"幻觉"**：只有 CSDN / 微信 / V2EX / 虎扑 真正支持"发布"语义。其余 30+ 平台 API 只有草稿接口，`draftOnly: false` 实际无效。
3. **`capabilities` 声明失修**：仅掘金/知乎/微博/东方财富声明了 `tags/categories/cover`，其它平台明明有分类/标签字段却没声明。
4. **功能缺陷**（用户当前完全无法配置）：
   - V2EX `DEFAULT_NODE` 写死、B 站 `tid: '4'` 写死、语雀 `bookId` 写死、Reddit 写死 profile、虎扑板块写死、简书默认文集写死
   - CSDN / 百家号 / 博客园 活动 id 写死
5. **`publish()` 是胖方法**：30+ 适配器各自重抄"鉴权 → 图片 → 签名 → 请求 → 解析"样板。
6. **跨平台无共享**：同一张外链图，每个平台适配器各自 fetch + 上传；`imageCache` 是方法内局部变量。
7. **鉴权方式散落**：每个适配器手写一套 checkAuth（SW API / 拉 HTML / Cookie / 临时标签 / CSRF 提取），CSRF/Token 提取在 7+ 平台重复。
8. **目录平铺**：`platforms/` 下 35+ 文件扁平，难维护；`ADAPTER_CLASSES` 数组与 `PAGE_CONTEXT_AUTH_IDS` 列表手工维护，每加平台要改。

### 重构目标

| 目标 | 含义 |
|------|------|
| 共性下沉 | publish 与 checkAuth 的样板流程抽象成可组合管道/策略 |
| 差异声明化 | 平台用 Schema 声明可配置字段，UI 自动渲染 |
| 每平台配置 | 用户可为每个平台保存默认发布参数 + 同步时临时覆盖 |
| 鉴权策略化 | 鉴权方式变成可组合积木，按 CLAUDE.md 优先级级联 |
| 高效并发 | 跨平台共享图片缓存（方案 A：同平台去重）|
| 用户友好 | UI 由 Schema 驱动，预览 + 折叠 + 覆盖 |
| 渐进迁移 | 老适配器零改动，两套模式共存 |

---

## 二、三正交维度

适配器 = 三个维度的组合声明（互不耦合）：

```
适配器 = 鉴权策略（Auth）   ×   配置 Schema（Config）   ×   发布管道（Publish）
         checkAuth 怎么做       用户能配什么               发布流程怎么走
```

| 维度 | 抽象 | 落点 |
|------|------|------|
| 鉴权 | `AuthStrategy` 积木 + `CompositeAuthStrategy` 级联 | `auth-strategy.ts` |
| 配置 | `PublishSchema` 声明式 + `PublishParams` 语义化 | `publish-schema.ts` / `publish-params.ts` |
| 发布 | `PipelineAdapter` 基类 + 7 钩子 | `pipeline.ts` |

---

## 三、全平台功能盘点

### 平台分类（6 类）

| 分类 | 平台 | 共性 |
|------|------|------|
| **tech-community** | 掘金、知乎、CSDN、博客园、思否、51CTO、开源中国、InfoQ、简书、语雀 | Markdown 草稿 + 标签/分类/专栏 |
| **media-account** | 百家号、搜狐号、微博、微信、网易号、一点号、大鱼号、企鹅号、东方财富、imooc、woshipm、雪球 | HTML + 原创声明 + 媒体字段 |
| **cloud-vendor** | 腾讯云、阿里云、百度开发者、火山引擎、千帆、魔搭 | Markdown + 摘要 + CSRF/Session |
| **social-forum** | V2EX、虎扑、Reddit、豆瓣 | node/board 必填 + 直接发帖 |
| **image-based** | 美篇、小红书 | 封面优先 + blocks/richJson 内容 |
| **special** | ZipDownload、私有（X/Twitter） | 非标准 |

### 可配置维度提取（来自全平台 publish 请求体盘点）

图例：**●** = 原生有字段（当前写死，重构开放）｜**○** = 部分｜空白 = 无

**A. 主流技术社区**

| 平台 | 发布模式 | 标签 | 分类 | 专栏/合集 | 封面 | 原创 | 可见性 | 活动 | 评论 | 摘要 |
|------|---------|------|------|----------|------|------|--------|------|------|------|
| 掘金 | draft | ●tag_ids | ●category_id | | ●cover_image | | | | | ●brief_content |
| 知乎 | draft | ●话题 | | ●专栏 | ● | | | | | |
| CSDN | **draft+publish** | ● | ● | | ●cover_images | ●type | ●level/readType | **●creator_activity_id** | | |
| 博客园 | draft | ●tags | ●categoryIds | ●collectionIds | ●featuredImage | | ●accessPermission/password | **●activity** | ●isAllowComments | ●description |
| 思否 | draft | ●tags | | | | | | | | |
| 51CTO | draft | ●tag | ●cate_id | | ●banner_type | ●orig | ●is_hide | | ●is_comment | ●abstract |
| 开源中国 | draft | | ●catalog | | | | ●privacy | | ●disableComment | |
| InfoQ | draft | | | | ● | | | | | ●summary(自动) |
| 简书 | draft | | | **●notebookId** | | | | | | |
| 语雀 | draft | | | **●book_id** | | | ●status | | | |

**B. 媒体号**

| 平台 | 模式 | 标签 | 分类 | 专栏 | 封面 | 原创 | 可见性 | 活动/话题 | 评论 | 摘要 | 定时 |
|------|------|------|------|------|------|------|--------|----------|------|------|------|
| 百家号 | draft | | ●feed_cat | | | ●original_status | | **●activity_list** / ●bjhtopic_id | | ●subtitle | |
| 搜狐号 | draft | ●customTags | ●channelId | ●userColumnId | ●cover | ●declareOriginal | ●visibleToLoginedUsers | ●topicIds | | ●brief | |
| 微博 | draft | | | | ●cover | | | | ●isreward/**●pay_setting** | ●summary | **●publish_at** |
| 微信 | **draft+publish** | | | | ●cdn_url | **●copyright_type** | ●only_fans_can_comment | | ●need_open_comment/**●can_reward/fee** | ●digest | **●定时** |
| 东方财富 | draft | | ●columns | | ●cover | ●isoriginal | | | ●replyauthority | | |
| 网易号/一点号/大鱼号/企鹅号/imooc/woshipm/雪球 | draft | ○ | ○ | | ○ | ○ | | | | ○ | |

**C. 云厂商**

| 平台 | 标签 | 分类 | 专栏 | 封面 | 评论 | 摘要 |
|------|------|------|------|------|------|------|
| 腾讯云 | ●tagIds | ●classifyIds | **●columnIds** | ●pic | ●openComment | ●summary |
| 千帆 | ●tagIds | ●categoryId/subPartitionId | | ●coverImageUrl | | ●summary |
| 阿里云/百度开发者/火山/魔搭 | | ○ | | | | ○ |

**D. 社区 + 图片型**

| 平台 | 类型 | 关键可配项（当前写死） |
|------|------|----------------------|
| V2EX | 社区直发 | **●node**（DEFAULT_NODE 写死）|
| 虎扑 | 社区直发 | **●板块** |
| Reddit | 社区草稿 | **●subreddit**（写死 profile）|
| B 站 | 草稿 | **●tid（分区）**（写死 '4'）|
| 美篇 | 图片型直发 | ●cover(自动首图) / ●privacy / ●has_reward / ●enable_comment |
| 小红书 | 图片型草稿 | ●封面(未暴露) |
| 豆瓣 | 草稿 | ●note_privacy / ●is_original / ●accept_donation |
| ZipDownload | 非发布 | 打包下载 |

---

## 四、目录结构

新增文件全部落在 `packages/core/src/adapters/` 下（紧邻现有 `code-adapter.ts`），**不新建顶层 package**：

```
packages/core/src/adapters/
├── code-adapter.ts          # 现有，保留（兼容期）
├── base.ts                  # 现有
├── registry.ts              # 现有，扩展：getProfile / getByCategory
├── types.ts                 # 现有，扩展：PublishOptions 增可选字段
├── content-origin.ts        # 现有
├── index.ts                 # 现有
│
├── pipeline.ts              # 新：PipelineAdapter 基类 + 7 钩子调度
├── publish-schema.ts        # 新：PublishSchema / SchemaField
├── publish-params.ts        # 新：PublishParams / PublishRequest / PublishMode
├── platform-profile.ts      # 新：PlatformProfile / PlatformCategory / authMode
├── image-cache.ts           # 新：SharedImageCache（同平台去重）
├── auth-strategy.ts         # 新：AuthStrategy 接口 + 5 种实现 + Composite
├── token-provider.ts        # 新：CSRF/Session Token Provider
├── category-profiles.ts     # 新：6 类分类的默认 profile
│
└── platforms/               # 现有；分类子目录在 P2 迁移期引入，初期保持扁平
    ├── tech-community/      # （迁移期）掘金 知乎 CSDN 博客园 思否 51CTO 开源中国 InfoQ 简书 语雀
    ├── media-account/       # （迁移期）百家号 搜狐 微博 微信 网易号 一点号 大鱼号 企鹅号 东方财富 imooc woshipm 雪球
    ├── cloud-vendor/        # （迁移期）腾讯云 阿里云 百度开发者 火山 千帆 魔搭
    ├── social-forum/        # （迁移期）V2EX 虎扑 Reddit 豆瓣
    ├── image-based/         # （迁移期）美篇 小红书
    ├── special/             # （迁移期）ZipDownload
    ├── private/             # submodule，不变
    └── index.ts             # import.meta.glob 自动聚合（迁移期引入）
```

**原则**：
- 骨架阶段（本批）只在 `adapters/` 下新增 8 个文件，**不移动任何现有文件**
- `platforms/` 分类子目录与 `import.meta.glob` 自动发现在 P2 批量迁移期引入
- `extension/src/adapters/index.ts` 的 `ADAPTER_CLASSES` 数组在迁移完成后才移除

---

## 五、核心类型定义

### `publish-params.ts`

```ts
export type PublishMode = 'draft' | 'publish' | 'schedule'

export interface PublishParams {
  // 发布模式 + 定时
  mode?: PublishMode
  scheduleAt?: number
  // 内容元数据
  tags?: string[]
  category?: string
  column?: string                     // 专栏/合集/文集
  cover?: string                      // 'auto' | 'none' | URL
  summary?: string
  subtitle?: string
  // 原创与版权
  originalType?: 'original' | 'reprint' | 'translate'
  originalLink?: string
  // 可见性
  visibility?: string
  // 社区型必填
  node?: string                       // 节点/分区/板块/subreddit
  // 活动与话题
  activityId?: string
  topicId?: string
  // 互动开关
  commentsEnabled?: boolean
  // 变现
  reward?: boolean
  paid?: { enabled: boolean; price?: number }
  // 平台特有兜底（微信图文专属字段等）
  extra?: Record<string, unknown>
}

export interface PublishRequest {
  article: Article
  perPlatform?: Record<string, PublishParams>
  defaultMode?: PublishMode           // 对话框顶部一次性默认，不持久化
}
```

**合并优先级（高 → 低）**：
```
perPlatform[id]  ⊕  用户保存的平台默认值  ⊕  publishDefaults  ⊕  Schema 兜底
```

### `publish-schema.ts`

```ts
export type SchemaField =
  | TagsField | CategoryField | ColumnField | CoverField
  | VisibilityField | OriginalTypeField | ActivityField | TopicField | NodeField
  | ScheduleField | CommentsField | RewardField | PaidField
  | SubtitleField | SummaryField
  | ToggleField | TextField | SelectField   // 平台特有兜底

export interface PublishSchema {
  fields: SchemaField[]
  groups?: Array<{ title: string; fields: string[]; defaultOpen?: boolean }>
  unsupportedModes?: Array<'publish' | 'schedule'>
}
```

每个 `*Field` 带 `kind` + `key`（对应 `PublishParams` 字段名）+ `label` + `source: 'remote' | 'static'` + `options?` + `refKey?`（远程引用）等。UI 据此自动渲染表单。

### `platform-profile.ts`

```ts
export type PlatformCategory =
  | 'tech-community' | 'media-account' | 'cloud-vendor'
  | 'social-forum' | 'image-based' | 'special'

export type AuthMode = 'sw' | 'page-context' | 'hybrid'

export interface PlatformProfile {
  meta: PlatformMeta
  category: PlatformCategory
  preprocessConfig: PreprocessConfig
  publishModes: PublishMode[]           // 取代形同虚设的 draftOnly
  authMode: AuthMode                    // 取代手工的 PAGE_CONTEXT_AUTH_IDS
  publishSchema?: PublishSchema
  publishDefaults?: PublishParams
}
```

---

## 六、发布管道（`pipeline.ts`）

```ts
export interface PublishContext {
  article: Article
  params: PublishParams                // 已合并的最终参数
  content: { markdown: string; html: string }
  imageCache: SharedImageCache
  refs: PublishRefs                    // resolveReferences 填充，buildPayload 消费
  signal: AbortSignal
  onImageProgress?: (current: number, total: number) => void
  payload?: unknown                    // buildPayload 填充，submit 消费
  response?: unknown                   // submit 填充，finalize 消费
  token?: string                       // TokenProvider 填充
}

export abstract class PipelineAdapter extends CodeAdapter {
  readonly profile!: PlatformProfile
  readonly authStrategies: AuthStrategy[] = []
  readonly tokenProvider?: TokenProvider

  // 钩子（带默认实现，按需重写）
  protected async authorize(ctx): Promise<void>           // 默认 CompositeAuthStrategy 级联
  protected async normalizeContent(ctx): Promise<void>    // 默认从 platformContents[id] 取
  protected async uploadImages(ctx): Promise<void>        // 默认 SharedImageCache + processImages
  protected async resolveReferences(ctx): Promise<void>   // 默认空；拉分类/标签/节点列表
  protected abstract buildPayload(ctx): Promise<void>     // 核心差异点
  protected abstract submit(ctx): Promise<void>           // API 路径/签名/method
  protected async finalize(ctx): Promise<SyncResult>      // 默认从 ctx.response 解析

  // 管道入口（基类实现，子类不再写 publish）
  async publish(article, options?): Promise<SyncResult> {
    // authorize → normalizeContent → uploadImages → resolveReferences
    // → buildPayload → withHeaderRules(submit) → finalize
    // finally: releaseEphemeralTabs()
  }

  // checkAuth 默认实现：按 authStrategies 顺序级联
  async checkAuth(): Promise<AuthResult>
}
```

### 钩子职责

| 钩子 | 默认实现 | 何时重写 |
|------|---------|---------|
| authorize | CompositeAuthStrategy 级联 | 几乎不重写 |
| normalizeContent | 从 `article.platformContents[id]` 取 md/html | 图片型平台（生成 blocks/richJson）|
| uploadImages | SharedImageCache + processImages（concurrency=3）| 几乎不重写 |
| resolveReferences | 空 | 需把 tag/category/node 名 → id、拉活动列表 |
| buildPayload | — | **核心差异点**：组装平台原生请求体 |
| submit | — | API 路径/method/签名 |
| finalize | 从 ctx.response 解析 postId/postUrl | 各平台响应解析 |

### 兼容性矩阵

| 适配器类型 | publish 实现 | 行为 |
|-----------|-------------|------|
| 老 `CodeAdapter` 子类 | 自己实现 | 完全不变 |
| 新 `PipelineAdapter` 子类 | 基类调度钩子 | 走新管道 |

`syncToPlatform` 对两者透明：都调 `adapter.publish(article, options)`。

---

## 七、鉴权策略层

### `auth-strategy.ts`

```ts
export interface AuthStrategy {
  readonly name: string
  check(ctx: AuthContext): Promise<AuthResult | null>  // null = 不适用，交给下一个
}

export interface AuthContext {
  runtime: RuntimeInterface
  ephemeralTabIds: Set<number>   // 仅供 PageContext 策略，自动 release
}
```

**5 种内置积木**（覆盖现有所有鉴权方式，对齐 CLAUDE.md 三档优先级）：

| 策略 | 对应 CLAUDE.md 优先级 | 代表平台 |
|------|---------------------|---------|
| `SwApiAuthStrategy` | 1（首选）SW 直调 API | CSDN、掘金、知乎 |
| `SwHtmlAuthStrategy` | 2 SW 拉 HTML 正则 | 阿里云、百度、腾讯云 |
| `CookieAuthStrategy` | 2 读关键 Cookie 弱判定 | 部分云社区 |
| `PageContextAuthStrategy` | 3（最后）临时标签 + executeScript | 美篇、小红书、企鹅号 |
| `CompositeAuthStrategy` | — 组合：按序级联 | 火山、腾讯云（SW 失败回退）|

`CompositeAuthStrategy` 按声明顺序级联，第一个**明确判定**即停；策略抛错或返回 null 才继续下一个。`PageContextAuthStrategy` 内置 ephemeralTab 管理，`finally` 自动 `release`。

### `token-provider.ts`

CSRF / Session Token 在 7+ 平台重复（博客园、B 站、百家号、语雀、思否、51CTO…）。抽成前置准备：

```ts
export interface TokenProvider {
  get(): Promise<string>   // 来源：cookie / meta tag / API，内部缓存
}
```

管道在 `submit` 前 `ctx.token = await this.tokenProvider?.get()`，submit 直接用。

---

## 八、图片缓存（`image-cache.ts`）

**方案 A（首版）：同平台去重**。同一 `platformId + src` 只上传一次。跨平台字节共享（`fetchBlob`）留第二阶段。

```ts
export interface SharedImageCache {
  getUploadedUrl(platformId: string, src: string): Promise<string | undefined>
  setUploadedUrl(platformId: string, src: string, url: string | Promise<string>): void
}
```

`uploadImages` 默认实现：把基类 `processImages` 的 `uploadFn` 包装为「先查 cache → 未命中调 `uploadImageByUrl` → setUploadedUrl」。

---

## 九、分类 Profile（`category-profiles.ts`）

每个分类一个默认 profile（**配置对象 + mixin，非深继承**）：

```ts
export const techCommunityProfile = {
  defaultPreprocess: { outputFormat: 'markdown', ... },
  defaultSchemaFields: [tags, category, cover],
  defaultPublishModes: ['draft'] as PublishMode[],
}
export const socialForumProfile = {
  defaultSchemaFields: [{ kind: 'node', key: 'node', required: true }],
  defaultPublishModes: ['publish'] as PublishMode[],
}
// mediaAccountProfile / cloudVendorProfile / imageBasedProfile / specialProfile
```

新平台 `extends PipelineAdapter`，应用 profile 默认值 + 重写差异点。

---

## 十、注册与自动发现（迁移期引入）

**现状**：`extension/src/adapters/index.ts` 维护 36 项 `ADAPTER_CLASSES` + 手工 `PAGE_CONTEXT_AUTH_IDS`。

**重构后**（迁移期）：
- `platforms/index.ts` 用 `import.meta.glob` 自动发现所有分类目录下的适配器类
- `adapterRegistry` 扩展 `getProfile(id)` / `getByCategory(cat)` / `getProfiles()`
- 调度层读 `profile.authMode` 决定批量刷新是否跳过（取代 `PAGE_CONTEXT_AUTH_IDS`）

**新增平台 = 加一个文件 + 在分类 `_index.ts` 导出**，零改动注册。

---

## 十一、新平台接入流程

新增「华为云开发者」为例：

| 步骤 | 动作 |
|------|------|
| 1 | 判定分类 → `platforms/cloud-vendor/huaweicloud.ts` |
| 2 | `extends PipelineAdapter`，声明 `profile = cloudVendorProfile` |
| 3 | 声明 `authStrategies`（云厂商典型：SwApi + PageContext 回退）+ `tokenProvider`（如需）|
| 4 | 声明 `publishSchema`（分类默认字段 + 平台增量）|
| 5 | 实现 `buildPayload` / `submit` / `finalize`（**唯一必写的差异代码**）|
| 6 | 可选：`resolveReferences` 拉远程分类/标签列表 |

**不再需要**：手写 checkAuth、图片处理样板、header 规则包装、改 ADAPTER_CLASSES、改 PAGE_CONTEXT_AUTH_IDS。

---

## 十二、迁移路线图

| 阶段 | 内容 | 触发条件 |
|------|------|---------|
| **基础设施（本批）** | 8 个新文件 + PipelineAdapter + 5 鉴权策略 + TokenProvider；typecheck 通过；老适配器零改动 | 启动即做 |
| **P0** | 修复功能缺陷：V2EX 节点、B 站分区、语雀知识库、Reddit subreddit、虎扑板块、简书文集 | 基础设施完成后 |
| **P1 试点** | **CSDN**（字段丰富、draft+publish 双模式）+ **掘金**（远程引用：category/tag）真实环境验证 | P0 完成 |
| **P2** | 主流平台批迁 + `platforms/` 分类子目录 + `import.meta.glob` 自动发现 | 试点验收后，合成一个版本 |
| **P3** | 图片型（美篇/小红书封面）+ 微信完整 Schema（赏赞/付费/原创/定时）| P2 验证后 |
| **P4** | 其余简单平台（思否/51CTO/开源中国/豆瓣/InfoQ/云厂商余下/媒体号余下）| P3 后 |

**发版约束**（对齐 CLAUDE.md）：每个 P 级别内部合成**一个版本**发版，禁止"一修一版"。

---

## 十三、与 CLAUDE.md 约束对齐

| 约束 | 落地方式 |
|------|---------|
| 鉴权优先级 1→2→3 强制 | `CompositeAuthStrategy` 按声明顺序级联 |
| `PAGE_CONTEXT_AUTH_IDS` 登记 | 改为 `profile.authMode` 自声明 |
| ephemeralTabIds 必须 release | `PageContextAuthStrategy` 内置 + 管道 `publish` 的 finally 兜底 |
| 首次加载可开标签、日常不得 | 调度层读 `authMode` + `forceRefresh` 判断 |
| Service Worker 禁 DOM | 策略实现严守；DOM 访问只在 executeScript 回调（页面上下文）|
| 同步逻辑落在独立适配器 | 鉴权/图片/发布全在适配器内，扩展侧只做编排 |
| 发版门槛 | 按 P 级别合并发版 |

---

## 十四、兼容性保证（重构不动现有功能）

骨架阶段严格遵守：

1. **只增不改**：`PublishOptions` 仅新增可选字段（`params`/`imageCache`/`signal`），老字段保留；`registry` 仅新增方法；不删任何现有 API。
2. **不动适配器**：35+ 现有适配器零改动，继续走老 `publish()` 路径。
3. **不动调度**：`syncToPlatform` / `syncToMultiplePlatforms` / `performSync` 不改。
4. **不动 platforms 布局**：分类子目录在 P2 才引入。
5. **typecheck 必须通过**：骨架引入后 `tsc --noEmit` 零错误。

老适配器什么时候才动？P1 试点 CSDN/掘金时，**逐个**迁移到 PipelineAdapter，每个迁完都真机验证草稿/直发/标签/分类/活动。
