# 前端设计规范（UI Style Guide）

> 适用范围：`packages/extension`（Chrome 扩展 UI）与 `site/`（官网）。
> 目标：让扩展弹窗、侧栏、编辑器、同步对话框与官网呈现**同一套视觉语言**，避免每次改版各自为政。
> 原则：**效率优先、用户至上、美学收敛**——多平台同步是高频操作路径，视觉应为效率服务，不堆砌装饰。

---

## 一、设计原则

| 原则 | 含义 | 反例 |
|------|------|------|
| 效率优先 | 关键路径（检测文章 → 选平台 → 同步）的视觉权重最高，CTA 必须最显眼 | 用同样强度的按钮放「同步」与「取消」 |
| 信息分层 | 用色彩/字号/阴影区分「主操作 / 次操作 / 内容 / 元信息」四层 | 全用 14px 黑字平铺 |
| 克制装饰 | 渐变、阴影、动效只用于强化交互反馈或品牌焦点，不滥用 | 给每个卡片都加彩色渐变背景 |
| 品牌一致 | 主色、圆角、按钮形态在扩展与官网严格对齐 | 扩展用青绿、官网用黄绿 |
| 可达性 | 对比度 ≥ AA，焦点环可见，禁用态语义清晰 | 用纯灰背景 + 灰文字表达禁用 |

---

## 二、色彩系统

### 主色（Brand）

扩展（HSL CSS 变量）与官网（hex）已对齐到 **green-600** 系：

| Token | 扩展（HSL） | 官网（hex） | 用途 |
|-------|------------|-------------|------|
| `--primary` | `142 72% 36%` | `#16a34a` | 主色：CTA、选中态、链接强调 |
| `--primary-strong` | `142 76% 30%` | `#15803d`（`--primary-dark`） | 主色按下/渐变下端 |
| `--primary-soft` | `138 76% 96%` | `#ecfdf3` | 主色淡背景：徽章、识别态卡片 |
| `--primary-foreground` | `0 0% 100%` | `#fff` | 主色上的文字 |

> 扩展里阴影需要硬编码 RGB 时统一用 `rgba(22,163,74, …)`（green-600），深底用 `rgba(20,40,30, …)`。
> **禁止**再次出现 `16,185,129`（emerald-500）等近似但不同的绿色。

### 中性色

| Token | 扩展（HSL） | 用途 |
|-------|------------|------|
| `--background` | `0 0% 100%` | 页面底色 |
| `--foreground` | `222 47% 11%` | 主文字（slate-900 系，避免过冷蓝） |
| `--muted` | `210 40% 96.1%` | 次级背景、分割条 |
| `--muted-foreground` | `215.4 16.3% 46.9%` | 次级文字 |
| `--border` | `220 20% 92%` | 边框（中性偏暖，不用蓝灰） |

### 语义色

| Token | 含义 | 使用规则 |
|-------|------|----------|
| `--primary` | 成功 / 进行中 / 已识别 | **默认成功语义用主色**，与品牌统一 |
| `--destructive` `0 78% 56%` | 失败 / 错误 / 删除 | 次级错误用 `destructive/[0.06]` 底 + `destructive/20` ring |
| amber-50/800 | 警告 / 限流提示 | 状态栏 `warn` 态 |
| `blue` | **仅**用于系统级提示（如新版本横幅可改用 primary） | 不作为品牌色 |

> 新增组件**禁止**用 `bg-green-100`、`text-red-600` 这类 Tailwind 默认色直接表达成功/失败；改用 `bg-primary/15` / `bg-destructive/15`，让暗色模式与品牌色自动跟随。
> 例外：网格视图角标的实色徽章（`bg-green-500` / `bg-red-500`）保留，因为其语义必须强对比、不依赖主题。

---

## 三、排版与间距

- **字体栈**：扩展走 Tailwind 默认（`ui-sans-serif` 系，含 PingFang SC / Microsoft YaHei 回退）；官网显式声明相同栈。**不引入第三方字体**。
- **字号阶梯**（扩展，基于 380px 宽弹窗）：
  - `text-sm`（14px）正文
  - `text-xs`（12px）次级文字、按钮内文字
  - `text-[11px]` 状态栏、徽章、提示
  - `text-[10px]` 仅底栏图标标签
- **字重**：标题 `font-semibold`/`font-bold` + `tracking-tight`；正文 `font-medium` 或默认。
- **数字**用 `tabular-nums`，避免计数跳动（如 `5/12`、`v2.1.22`）。
- **间距单位**统一用 Tailwind 的 `gap-2`（8px）/ `p-3`（12px）/ `p-4`（16px）；不写任意像素值。

---

## 四、圆角与阴影层级

### 圆角

| Token | 值 | 用途 |
|-------|----|------|
| `--radius` | 扩展 `0.625rem`（10px），官网 `14px` | 容器主圆角 |
| `rounded-lg` | 卡片、按钮、输入框 | 默认容器 |
| `rounded-md` | 小图标容器、次级按钮 | 内嵌元素 |
| `rounded-full` | 徽章、状态点、pill 标签 | 计数、状态 |

> 扩展弹窗比官网更紧凑，故 `--radius` 略小；形态保持一致。

### 阴影层级（仅扩展，官网用 `--shadow`）

| 层级 | 用途 | 实现 |
|------|------|------|
| 无阴影 | 平铺列表行、表单 | — |
| `shadow-[0_1px_2px_rgba(15,23,42,0.04)]` | 卡片静态态（`card-soft`）、次级按钮 | 极弱 |
| hover 提升一级 | 交互卡片（`card-interactive`） | `0_2px_8px_-2px_rgba(15,23,42,0.08)` |
| 品牌阴影 | 主 CTA、Logo | `0_4px_12px_-2px_rgba(22,163,74,0.30)` |

---

## 五、组件规范

### 按钮（三档）

扩展在 `globals.css` 预定义了三个 utility class，**新写按钮直接用 class，不要重复手写一长串 className**：

| Class | 用途 | 视觉 |
|-------|------|------|
| `btn-brand` | **主 CTA**：「同步到 N 个平台」「完成」 | 绿色垂直渐变 + 品牌阴影 + 悬停上浮 1px + 顶部高光 |
| `btn-secondary` | 次级操作：「检测当前页」「导入 Markdown」「取消」 | 白底 + 描边 + 极弱阴影 |
| 原生 `bg-primary/10 text-primary` | 第三优先级：完成态的「重试」「继续同步」 | 主色淡底文字 |

```tsx
// ✅ 正确
<button className="btn-brand w-full py-2.5 rounded-lg font-medium">同步到 5 个平台</button>

// ❌ 反例：重复手写，且与品牌按钮不一致
<button className="w-full py-2.5 rounded-lg bg-primary text-white hover:bg-primary/90">同步</button>
```

禁用态：`btn-brand` 已内置 disabled 样式（变灰、去阴影、不上浮）；不要再叠加 `bg-muted text-muted-foreground`。

### 卡片

| Class | 用途 |
|-------|------|
| `card-soft` | 静态信息卡：边框 70% + 极弱阴影 |
| `card-interactive` | 可点击卡：hover 时阴影 + 边框增强（用于 About 链接卡） |
| 内联渐变卡 | 焦点内容用 `bg-gradient-to-br from-primary/[0.07] to-primary/[0.02] border-primary/20`（如 ArticleCard 识别态） |

### 状态指示

- **状态点**（状态栏左侧）：`w-1.5 h-1.5 rounded-full`，激活 `bg-primary`，闲置 `bg-muted-foreground/40`
- **脉动点**（实时检测活跃、同步进行中）：`animate-ping` 外圈 + 实心点 + `ring-2 ring-background`
- **进度条**：`bg-gradient-to-r from-primary to-primary-strong` + 品牌光晕阴影，高度 `h-1.5`
- **计数徽章**：`rounded-full bg-primary/10 text-primary text-[11px] tabular-nums`

### 平台行/格子状态

| 状态 | 视觉 |
|------|------|
| 选中 | `bg-primary/[0.07] ring-1 ring-inset ring-primary/25` |
| 已登录未选 | 默认；hover `bg-muted/70` |
| 未登录 | `opacity-55`；hover 恢复 |
| 同步成功 | `bg-primary/[0.06] ring-1 ring-primary/20` + 主色对勾 |
| 同步失败 | `bg-destructive/[0.05] ring-1 ring-destructive/20` + destructive 叉 |
| 等待中 | 空心圆 `border-2 border-gray-300` |

> 选中态用 **ring-inset** 而非背景加深，避免与「完成态背景」语义冲突。

---

## 六、反馈与动效

| 场景 | 动效 | 时长 |
|------|------|------|
| 按钮 hover | `translate-y-px` 上浮 + 阴影加深 | `150ms` |
| 按钮 active | `translate-y-0` 回落 | — |
| 卡片 hover | 阴影 + 边框过渡 | `150ms` |
| 图标 hover | `scale-110`（仅导航项） | `150ms` |
| 进度条填充 | width 过渡 | `500ms ease-out` |
| 实时/同步脉动 | `animate-ping` | Tailwind 默认 |

**禁止**用动效拖延关键反馈：鉴权、同步开始、错误必须在 1 帧内给出视觉响应，不能用 200ms+ 的入场动画盖住。

---

## 七、可访问性

- 所有交互元素 `disabled` 时同时满足：`opacity-50/60` + `cursor-not-allowed` + 去 hover 阴影
- 焦点环：`focus-visible:ring-1 focus-visible:ring-ring`（Button 基类已含）
- 图标按钮必须有 `title` / `aria-label`（已有惯例）
- 对比度：主色 `#16a34a` 在白底上用于 `text-base` 以下文字时需加粗或加大字号，避免 AA 边缘

---

## 八、实现约定（扩展）

### 注册顺序

新增设计 token 必须同步三处：

1. `packages/extension/src/popup/styles/globals.css` — 定义 `--var`
2. `packages/extension/tailwind.config.js` — 在 `theme.extend.colors` 注册，使 `bg-/text-/from-/to-` 等变体能解析
3. 本文档「色彩系统」表格登记

> 例：`primary-strong` / `primary-soft` 必须同时在 css 变量、tailwind 配置、本规范里出现，缺一处会导致 class 静默失效。

### 复用 utility class

`globals.css` `@layer components` 已定义：`btn-brand`、`btn-secondary`、`card-soft`、`card-interactive`；
`@layer utilities` 已定义：`text-brand-gradient`、`scrollbar-thin`。

写新组件时**优先复用**，发现重复模式再下沉到此处，避免散落。

### Service Worker 约束（前端也要知道）

适配器/Service Worker 中**禁止**用 `DOMParser`、`document`、`window`；UI 内解析 HTML 同样优先正则。详情见 `docs/adapter-spec.md` 与 `CLAUDE.md`。

---

## 九、官网与扩展的一致性

| 维度 | 扩展 | 官网 | 一致点 |
|------|------|------|--------|
| 主色 | `--primary` HSL | `--primary` hex | 同为 green-600 |
| 主按钮 | `.btn-brand` 渐变 + 阴影 | `.btn-primary` | 官网主按钮保留渐变以呼应扩展 |
| 圆角 | 10px | 14px | 形态相同，尺寸按载体调整 |
| 卡片 hover | 阴影 + 微上浮 | 阴影 + 微上浮 | 一致 |
| 暗色模式 | 暂无（仅影响 token） | `data-theme="dark"` | 扩展组件用 `primary/[0.06]` 等透明度写法，未来接入暗色零成本 |

> 修改任何品牌相关数值（主色、圆角基数、按钮形态）必须**同时考虑两端**；本文档是唯一事实来源。

---

## 十、改动清单与评审门槛

新增/修改 UI 时按此自检：

- [ ] 主操作用了 `btn-brand`？次操作用了 `btn-secondary`？
- [ ] 成功/失败语义用 `primary` / `destructive`，而非裸 `green-600` / `red-500`？
- [ ] 选中态用 `ring-inset`，完成态用底色？
- [ ] 数字用了 `tabular-nums`？
- [ ] 阴影 RGB 用 `22,163,74` 而非 `16,185,129`？
- [ ] 新 token 已在 css / tailwind config / 本文档三处登记？
- [ ] 关键路径（检测→选平台→同步）视觉权重最高？
- [ ] 通过 `pnpm typecheck` 与 `vite build`？
