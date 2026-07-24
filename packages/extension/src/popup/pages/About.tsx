import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Github, Globe, Heart, MessageSquare, ExternalLink } from 'lucide-react'

export function AboutPage() {
  const navigate = useNavigate()
  const version = chrome.runtime.getManifest().version

  return (
    <div className="page-root flex flex-col h-[500px]">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center gap-2 px-4 py-3 border-b">
        <button
          onClick={() => navigate(-1)}
          className="p-1.5 rounded-lg hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="font-semibold">关于</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="flex flex-col items-center">
          {/* Logo & Title */}
          <img src="/assets/icon-128.png" alt="Logo" className="w-16 h-16 mb-3" />
          <h2 className="text-lg font-semibold">同步派</h2>
          <p className="text-sm text-muted-foreground mt-1">v{version}</p>

          {/* Description */}
          <p className="text-sm text-muted-foreground text-center mt-4 leading-relaxed">
            开源免费的多平台文章同步工具。支持 29+ 平台一键分发、本地 Markdown 导入与浏览器侧栏常驻。
          </p>

          {/* Links */}
          <div className="flex flex-col gap-2 mt-6 w-full max-w-[240px]">
            <a
              href="https://github.com/yjmm10/MediaSync"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border hover:bg-muted transition-colors text-sm"
            >
              <Github className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">GitHub</span>
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
            </a>
            <a
              href="https://yjmm10.github.io/MediaSync/?utm_source=extension_about"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border hover:bg-muted transition-colors text-sm"
            >
              <Globe className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">官网</span>
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
            </a>
            <a
              href="https://github.com/yjmm10"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border hover:bg-muted transition-colors text-sm"
            >
              <Heart className="w-4 h-4 flex-shrink-0 text-red-400" />
              <span className="flex-1">作者: lusca</span>
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
            </a>
            <a
              href="https://github.com/yjmm10/MediaSync/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border hover:bg-muted transition-colors text-sm"
            >
              <MessageSquare className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">问题反馈</span>
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
            </a>
          </div>

          {/* WeChat QR codes */}
          <div className="mt-7 w-full max-w-[280px]">
            <p className="text-sm font-medium text-center mb-3">微信联系 / 赞赏</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col items-center gap-1.5">
                <img
                  src="/assets/wechat-friend-qr.png"
                  alt="微信好友码"
                  className="w-full rounded-lg border bg-white"
                />
                <span className="text-xs text-muted-foreground">好友码</span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <img
                  src="/assets/wechat-reward-qr.png"
                  alt="微信赞赏码"
                  className="w-full rounded-lg border bg-white"
                />
                <span className="text-xs text-muted-foreground">赞赏码</span>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground text-center mt-3 leading-relaxed">
              所有赞赏的朋友将在官网主页留名致谢。可扫码添加微信备注昵称，便于公示。
            </p>
          </div>

          {/* Footer */}
          <p className="text-xs text-muted-foreground mt-6 mb-2">
            如果觉得不错，请分享给你的朋友 ✌️
          </p>
        </div>
      </div>
    </div>
  )
}
