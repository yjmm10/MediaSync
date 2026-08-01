# Core Adapters 开发规范

## 1. 运行环境

### 1.1 执行上下文

适配器运行在 **Chrome Extension Service Worker** 中，这是一个受限的 JavaScript 环境。

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Extension                      │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Service Worker (Background)          │   │
│  │  ┌──────────────────────────────────────────┐    │   │
│  │  │           Platform Adapters               │    │   │
│  │  │  - ZhihuAdapter                          │    │   │
│  │  │  - JuejinAdapter                         │    │   │
│  │  │  - ...                                   │    │   │
│  │  └──────────────────────────────────────────┘    │   │
│  │                      │                            │   │
│  │                      ▼                            │   │
│  │  ┌──────────────────────────────────────────┐    │   │
│  │  │          RuntimeInterface                │    │   │
│  │  │  - fetch (with cookies)                  │    │   │
│  │  │  - headerRules (declarativeNetRequest)   │    │   │
│  │  │  - storage / session                     │    │   │
│  │  └──────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 1.2 环境限制

Service Worker **不可用** 的 API：

| API | 说明 | 替代方案 |
|-----|------|----------|
| `DOMParser` | DOM 解析 | 正则表达式提取 |
| `document` | 文档对象 | 正则表达式 / runtime.dom |
| `window` | 全局窗口对象 | 不可用 |
| `XMLHttpRequest` | 传统 AJAX | `fetch` API |
| `localStorage` | 本地存储 | `runtime.storage` |
| `sessionStorage` | 会话存储 | `runtime.session` |
| `alert/confirm/prompt` | 对话框 | 不可用 |
| `Image` | 图片对象 | `fetch` + `Blob` |
| `Canvas` | 画布操作 | 不可用 |

Service Worker **可用** 的 API：

| API | 说明 |
|-----|------|
| `fetch` | HTTP 请求 |
| `Request/Response` | 请求响应对象 |
| `Headers` | HTTP 头部 |
| `URL/URLSearchParams` | URL 处理 |
| `FormData` | 表单数据 |
| `Blob/File` | 二进制数据 |
| `FileReader` | 文件读取 |
| `TextEncoder/TextDecoder` | 文本编码 |
| `crypto` | 加密 API |
| `setTimeout/setInterval` | 定时器 |
| `Promise/async-await` | 异步编程 |
| `JSON` | JSON 处理 |
| `RegExp` | 正则表达式 |

## 2. 架构设计

### 2.1 适配器继承关系

```
PlatformAdapter (interface)
        │
        ▼
  CodeAdapter (abstract class)
        │
        ▼
  XxxAdapter (concrete class)
```

### 2.2 RuntimeInterface 抽象

适配器不直接调用浏览器 API，而是通过 `RuntimeInterface` 抽象层：

```typescript
interface RuntimeInterface {
  type: 'extension' | 'node'

  // HTTP 请求（自动携带 cookies）
  fetch(url: string, options?: RequestInit): Promise<Response>

  // Cookie 管理
  cookies: {
    get(domain: string): Promise<Cookie[]>
    set(cookie: Cookie): Promise<void>
    remove(name: string, domain: string): Promise<void>
  }

  // 持久化存储
  storage: {
    get<T>(key: string): Promise<T | null>
    set<T>(key: string, value: T): Promise<void>
    remove(key: string): Promise<void>
  }

  // 会话存储
  session: {
    get<T>(key: string): Promise<T | null>
    set<T>(key: string, value: T): Promise<void>
  }

  // Header 规则（仅扩展环境，用于 CORS 绕过）
  headerRules?: {
    add(rule: HeaderRule): Promise<string>
    remove(ruleId: string): Promise<void>
    clear(): Promise<void>
  }
}
```

## 3. 适配器开发规范

### 3.1 基本结构

```typescript
import { CodeAdapter, ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('PlatformName')

export class PlatformAdapter extends CodeAdapter {
  // 平台元信息（必须）
  meta: PlatformMeta = {
    id: 'platform-id',           // 唯一标识，小写
    name: '平台名称',             // 显示名称
    icon: 'https://...',         // 图标 URL
    homepage: 'https://...',     // 平台首页
    capabilities: ['article', 'draft', 'image_upload'],
  }

  // 私有状态
  private someToken: string | null = null
  private headerRuleId: string | null = null

  // 检查登录状态（必须实现）
  async checkAuth(): Promise<AuthResult> { ... }

  // 发布文章（必须实现）
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> { ... }

  // 上传图片（可选实现）
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> { ... }
}
```

### 3.2 HTML 解析规范

**禁止使用 DOMParser**，必须使用正则表达式：

```typescript
// ❌ 错误：Service Worker 中不可用
const parser = new DOMParser()
const doc = parser.parseFromString(html, 'text/html')
const element = doc.querySelector('.user-avatar')

// ✅ 正确：使用正则表达式
const userIdMatch = html.match(/data-user-id="(\d+)"/)
const avatarMatch = html.match(/class="avatar"[^>]*src="([^"]+)"/)

if (!userIdMatch) {
  return { isAuthenticated: false, error: '未登录' }
}

const userId = userIdMatch[1]
```

### 3.3 Header 规则使用规范

某些平台 API 需要特定的 Origin/Referer 头，使用 `headerRules` 处理：

```typescript
// 添加规则时必须检查 headerRules 是否存在
private async addHeaderRules(): Promise<void> {
  if (!this.runtime.headerRules) return  // 必须检查！

  this.headerRuleId = await this.runtime.headerRules.add({
    urlFilter: '*://api.example.com/*',
    headers: {
      Origin: 'https://example.com',
      Referer: 'https://example.com/',
    },
  })
}

// 清理规则
private async removeHeaderRules(): Promise<void> {
  if (!this.runtime.headerRules) return  // 必须检查！

  if (this.headerRuleId) {
    await this.runtime.headerRules.remove(this.headerRuleId)
    this.headerRuleId = null
  }
}

// 在 publish 中使用
async publish(article: Article): Promise<SyncResult> {
  try {
    await this.addHeaderRules()
    // ... 发布逻辑
    return result
  } finally {
    await this.removeHeaderRules()  // 确保清理
  }
}
```

### 3.4 图片上传规范

> **图片例外（v2.1.20+）**：
> - **外链中转**：`qianfan`、`v2ex` **暂不支持**（不上图床）；其余平台均支持将 http(s) 转存到平台图床。
> - `qianfan`：本地图亦不支持（data URI 剥离；http(s) 仅原样保留）。
> - `tencentcloud` / `volcengine`：支持外链中转；**不支持本地 data URI**（中间层 `STRIP_LOCAL_DATA_URI` + 适配器剥离）。中间层跳过本地 `uploadImage`（`SKIP_MIDDLEWARE_IMAGE_UPLOAD`）。
> - `aliyun-developer` / `baidu-developer`：**支持外链与本地图转存**；`aliyun-developer` 不传摘要（用户在草稿箱手工补）；Mermaid 保留为普通代码块（平台不渲染图）。
> - `modelscope`（魔搭研习社）：支持外链中转；**不支持本地 data URI**；**不支持 Mermaid / 公式**（降级为普通代码块，平台不渲染）；创建需勋章。
> - `v2ex`：**直接发布**到节点 `algorithm`；**暂不支持**中转图片链接、公式、Mermaid 代码块（本地 data URI 剥离；http(s) 图链 Markdown 原样保留、不转存图床）。
> - 另：部分平台有图片稳定性/整段关闭问题（如小红书、美篇、Reddit），见 README 平台限制，与「外链中转策略」分开标注。

```typescript
async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
  // 1. 下载图片
  const imageResponse = await this.runtime.fetch(url)
  const blob = await imageResponse.blob()

  // 2. 构建 FormData
  const formData = new FormData()
  const filename = `${Date.now()}.jpg`
  formData.append('image', blob, filename)

  // 3. 上传
  const response = await this.runtime.fetch('https://api.example.com/upload', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })

  const res = await response.json()

  // 4. 返回结果
  if (!res.url) {
    throw new Error('图片上传失败')
  }

  return { url: res.url }
}
```

### 3.5 错误处理规范

```typescript
async publish(article: Article): Promise<SyncResult> {
  const now = Date.now()

  try {
    // ... 发布逻辑

    return {
      platform: this.meta.id,
      success: true,
      postId: result.id,
      postUrl: `https://example.com/post/${result.id}`,
      draftOnly: true,  // 是否仅保存草稿
      timestamp: now,
    }
  } catch (error) {
    return {
      platform: this.meta.id,
      success: false,
      error: (error as Error).message,
      timestamp: now,
    }
  }
}
```

### 3.6 日志规范

使用统一的 logger，生产环境自动降级：

```typescript
import { createLogger } from '../../lib/logger'

const logger = createLogger('PlatformName')

// 调试信息（生产环境不输出）
logger.debug('Processing image:', imageUrl)

// 警告信息
logger.warn('Rate limited, retrying...')

// 错误信息
logger.error('Upload failed:', error)
```

## 4. 类型定义

### 4.1 PlatformMeta

```typescript
interface PlatformMeta {
  id: string           // 平台唯一标识
  name: string         // 显示名称
  icon: string         // 图标 URL
  homepage: string     // 平台首页 URL
  capabilities: Array<'article' | 'draft' | 'image_upload' | 'video'>
}
```

### 4.2 AuthResult

```typescript
interface AuthResult {
  isAuthenticated: boolean
  userId?: string
  username?: string
  avatar?: string
  error?: string
}
```

### 4.3 Article

```typescript
interface Article {
  title: string
  html?: string      // HTML 格式内容
  markdown?: string  // Markdown 格式内容
  cover?: string     // 封面图 URL
  summary?: string   // 摘要
  tags?: string[]    // 标签
}
```

### 4.4 SyncResult

```typescript
interface SyncResult {
  platform: string   // 平台 ID
  success: boolean
  postId?: string    // 文章 ID
  postUrl?: string   // 文章 URL
  draftOnly?: boolean // 是否仅草稿
  error?: string
  timestamp: number
}
```

## 5. 注册新适配器

### 5.1 导出适配器

编辑 `packages/core/src/adapters/platforms/index.ts`：

```typescript
export { NewPlatformAdapter } from './new-platform'
```

### 5.2 注册到扩展

编辑 `packages/extension/src/adapters/index.ts`：

```typescript
// 导入
import {
  // ...existing imports
  NewPlatformAdapter,
} from '@mediasync/core'

// 添加到适配器列表
const ADAPTER_CLASSES = [
  // ...existing adapters
  NewPlatformAdapter,
] as const
```

## 6. 常见模式

### 6.1 获取 CSRF Token

```typescript
private async getCsrfToken(): Promise<string> {
  const response = await this.runtime.fetch('https://example.com/editor', {
    credentials: 'include',
  })
  const html = await response.text()

  const tokenMatch = html.match(/csrf[_-]?token["']?\s*[:=]\s*["']([^"']+)["']/i)
  if (!tokenMatch) {
    throw new Error('获取 CSRF token 失败')
  }

  return tokenMatch[1]
}
```

### 6.2 解析 JSON 配置

```typescript
private async getPageConfig(): Promise<PageConfig> {
  const response = await this.runtime.fetch('https://example.com/write', {
    credentials: 'include',
  })
  const html = await response.text()

  // 提取嵌入的 JSON 配置
  const configMatch = html.match(/window\.__CONFIG__\s*=\s*(\{[\s\S]*?\});/)
  if (!configMatch) {
    throw new Error('获取页面配置失败')
  }

  return JSON.parse(configMatch[1])
}
```

### 6.3 处理 JSONP 响应

```typescript
async checkAuth(): Promise<AuthResult> {
  const response = await this.runtime.fetch('https://example.com/api/user?callback=cb', {
    credentials: 'include',
  })
  let text = await response.text()

  // 去除 JSONP 包装
  text = text.replace(/^cb\(/, '').replace(/\);?$/, '')
  const result = JSON.parse(text)

  // ...
}
```

## 7. 测试

### 7.1 本地测试

1. 构建扩展：`pnpm build`
2. Chrome 加载 `packages/extension/dist` 目录
3. 打开目标平台并登录
4. 测试同步功能

### 7.2 调试技巧

- Service Worker 控制台：`chrome://extensions` -> 点击 "Service Worker"
- 网络请求：Service Worker DevTools -> Network 面板
- 存储数据：Application -> Storage -> Extension Storage

## 8. 版本兼容性

| 环境 | 版本要求 |
|------|---------|
| Chrome | >= 110 (MV3 支持) |
| Node.js | >= 18 (MCP Server) |
| TypeScript | >= 5.0 |

## 9. 参考适配器

推荐参考这些实现良好的适配器：

| 适配器 | 特点 |
|--------|------|
| `zhihu.ts` | 完整的 Header 规则管理 |
| `juejin.ts` | Markdown 优先 + 图片上传 |
| `bilibili.ts` | 多步骤发布流程 |
| `csdn.ts` | 复杂的 API 签名 |
