import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Github,
  Globe,
  Heart,
  MessageSquare,
  ExternalLink,
  Shield,
  Layers,
  PanelRight,
} from 'lucide-react'

const LINKS = [
  {
    href: 'https://yjmm10.github.io/MediaSync/?utm_source=extension_about',
    label: '官网',
    desc: '功能介绍与下载',
    icon: Globe,
  },
  {
    href: 'https://github.com/yjmm10/MediaSync',
    label: 'GitHub',
    desc: '源码与更新日志',
    icon: Github,
  },
  {
    href: 'https://github.com/yjmm10/MediaSync/issues',
    label: '反馈',
    desc: 'Bug / 新平台需求',
    icon: MessageSquare,
  },
  {
    href: 'https://github.com/yjmm10',
    label: '作者',
    desc: 'lusca',
    icon: Heart,
    iconClass: 'text-red-500',
  },
] as const

const HIGHLIGHTS = [
  {
    icon: Layers,
    title: '35+ 平台',
    desc: '一键同步草稿或发布',
  },
  {
    icon: Shield,
    title: '本地直连',
    desc: '用浏览器登录态，不经第三方服务器',
  },
  {
    icon: PanelRight,
    title: '侧栏常驻',
    desc: '支持 Markdown 导入与编辑',
  },
] as const

export function AboutPage() {
  const navigate = useNavigate()
  const version = chrome.runtime.getManifest().version

  const openExternal = (url: string) => {
    chrome.tabs.create({ url, active: true }).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer')
    })
  }

  return (
    <div className="page-root flex flex-col h-[500px]">
      <header className="flex-shrink-0 flex items-center gap-2 px-4 py-3 border-b">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="p-1.5 rounded-lg hover:bg-muted transition-colors"
          aria-label="返回"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="font-semibold">关于</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Brand */}
        <section className="px-5 pt-5 pb-4 text-center border-b border-border/60">
          <img
            src="/assets/icon-128.png"
            alt=""
            className="w-14 h-14 mx-auto mb-2.5 rounded-xl"
          />
          <div className="flex items-center justify-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">同步派</h2>
            <span className="text-[11px] tabular-nums text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              v{version}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed max-w-[280px] mx-auto">
            开源免费的多平台文章同步工具，把一篇内容分发到知乎、掘金、头条等平台。
          </p>
        </section>

        {/* Highlights */}
        <section className="px-5 py-4 border-b border-border/60">
          <ul className="space-y-2.5">
            {HIGHLIGHTS.map(({ icon: Icon, title, desc }) => (
              <li key={title} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-muted">
                  <Icon className="w-3.5 h-3.5 text-foreground/80" />
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-sm font-medium leading-none">{title}</p>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Links */}
        <section className="px-5 py-4 border-b border-border/60">
          <h3 className="text-xs font-medium text-muted-foreground mb-2.5">链接</h3>
          <div className="grid grid-cols-2 gap-2">
            {LINKS.map(({ href, label, desc, icon: Icon, ...rest }) => (
              <button
                key={label}
                type="button"
                onClick={() => openExternal(href)}
                className="group flex items-start gap-2 rounded-lg border px-2.5 py-2 hover:bg-muted/70 transition-colors text-left w-full"
              >
                <Icon
                  className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${'iconClass' in rest ? rest.iconClass : 'text-foreground/70'}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-sm font-medium">
                    {label}
                    <ExternalLink className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </span>
                  <span className="block text-[11px] text-muted-foreground truncate">{desc}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* WeChat */}
        <section className="px-5 py-4">
          <h3 className="text-xs font-medium text-muted-foreground mb-1">微信</h3>
          <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
            扫码加好友或赞赏。赞赏将在官网致谢；加好友可备注昵称便于公示。
          </p>
          <div className="grid grid-cols-2 gap-3">
            <figure className="flex flex-col items-center gap-1.5 m-0">
              <img
                src="/assets/wechat-friend-qr.png"
                alt="微信好友二维码"
                className="w-full max-w-[120px] aspect-square object-contain rounded-lg border bg-white p-1"
              />
              <figcaption className="text-xs text-muted-foreground">加好友</figcaption>
            </figure>
            <figure className="flex flex-col items-center gap-1.5 m-0">
              <img
                src="/assets/wechat-reward-qr.png"
                alt="微信赞赏二维码"
                className="w-full max-w-[120px] aspect-square object-contain rounded-lg border bg-white p-1"
              />
              <figcaption className="text-xs text-muted-foreground">赞赏支持</figcaption>
            </figure>
          </div>
        </section>

        <p className="px-5 pb-5 text-center text-[11px] text-muted-foreground">
          开源免费 · 欢迎 Star 与分享
        </p>
      </div>
    </div>
  )
}
