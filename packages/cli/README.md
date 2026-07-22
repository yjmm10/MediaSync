# @wechatsync/cli

命令行同步文章到多个内容平台。

## 安装

```bash
npm install -g @wechatsync/cli
```

## 快速开始

```bash
# 同步文章到知乎和掘金
wechatsync sync article.md --platforms zhihu,juejin
```

首次使用会提示安装 Chrome 扩展 - 访问 https://wechatsync.com/#install 安装。

## 命令

### sync - 同步文章

```bash
# 基本用法
wechatsync sync article.md -p zhihu,juejin

# 指定标题
wechatsync sync article.md -t "我的文章" -p zhihu

# 添加封面
wechatsync sync article.md -p juejin --cover https://example.com/cover.jpg

# 预览（不实际同步）
wechatsync sync article.md --dry-run
```

### platforms - 查看平台

```bash
# 列出所有平台
wechatsync platforms

# 显示登录状态
wechatsync platforms --auth
wechatsync ls -a
```

### auth - 检查登录

```bash
# 检查所有平台
wechatsync auth

# 检查单个平台
wechatsync auth zhihu

# 强制刷新
wechatsync auth --refresh
```

### extract - 提取文章

```bash
# 从浏览器当前页面提取
wechatsync extract

# 保存到文件
wechatsync extract -o article.md
```

## 工作原理

```
┌──────────────┐     WebSocket     ┌───────────────────┐
│  wechatsync  │◄─────────────────►│  Chrome Extension │
│    (CLI)     │    port 9527      │   (同步助手)       │
└──────────────┘                   └───────────────────┘
                                            │
                                            ▼
                                   ┌───────────────────┐
                                   │  目标平台 API      │
                                   │  (知乎/掘金/...)   │
                                   └───────────────────┘
```

CLI 启动后监听 WebSocket 端口，等待 Chrome 扩展连接。
扩展连接后，CLI 通过 WebSocket 发送请求，扩展执行实际的平台 API 调用。

## 支持的平台

知乎、掘金、简书、头条、微博、B站、百家号、CSDN、语雀、豆瓣、搜狐、雪球、微信公众号、人人都是产品经理、大鱼号、一点资讯、51CTO、搜狐焦点、慕课网、开源中国、思否、博客园

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SYNC_WS_PORT` | WebSocket 端口 | 9527 |
| `WECHATSYNC_TOKEN` | 安全验证 token | - |

## 远程桥接

CLI 支持在服务器上运行，连接本地电脑上的 Chrome 扩展。适用于在远程开发机或 CI 环境中同步文章，同时利用本地浏览器的登录态。

### 架构

```
┌─────────────────┐                        ┌─────────────────────┐
│  远程服务器       │     WebSocket          │  本地电脑            │
│                 │     port 9527           │                     │
│  wechatsync CLI │◄───────────────────────►│  Chrome Extension   │
│  / MCP Server   │                         │  (浏览器登录态)      │
└─────────────────┘                         └─────────────────────┘
```

### 配置步骤

**1. 服务器端** - 正常启动 CLI 或 MCP Server：

```bash
# CLI
WECHATSYNC_TOKEN=your-token wechatsync sync article.md -p zhihu

# MCP Server
MCP_TOKEN=your-token node packages/mcp-server/dist/index.js
```

服务器默认监听 `0.0.0.0:9527`（所有网络接口），远程可直接连接。

**2. 本地浏览器** - 在 Chrome 扩展设置中：

1. 开启「同步桥接」开关
2. 在「服务器地址」输入框填入远程地址，例如 `ws://192.168.1.100:9527`
3. 确保 Token 与服务器端一致

扩展会自动连接远程服务器，连接成功后即可远程同步。

### 注意事项

- 确保服务器防火墙放行 9527 端口（可通过 `SYNC_WS_PORT` 自定义）
- Token 在传输中以明文发送，生产环境建议配合 SSH 隧道或 VPN 使用
- 每个 Token 只允许一个扩展连接

## Claude Code 集成

安装 Skill 插件：

```bash
/plugin marketplace add yjmm10/Wechatsync
/plugin install wechatsync
```

然后在 Claude Code 中可以直接说：
- "把这篇文章同步到掘金"
- "帮我看看哪些平台已登录"
- "从浏览器提取当前文章"

## License

MIT
