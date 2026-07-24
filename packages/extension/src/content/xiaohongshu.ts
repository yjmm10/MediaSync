/**
 * 小红书创作者页面 Content Script
 * 检测同步完成参数，显示提示 Toast
 */

function showSyncedToast(): void {
  const urlParams = new URLSearchParams(window.location.search)
  if (!urlParams.has('_s')) {
    return
  }

  urlParams.delete('_s')
  const qs = urlParams.toString()
  const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
  window.history.replaceState({}, '', newUrl)

  setTimeout(() => {
    const toast = document.createElement('div')
    toast.innerHTML = '✓ 草稿已保存，请到「草稿箱 → 长文笔记」查看'
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 99999;
      padding: 16px 24px;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      border-radius: 12px;
      font-size: 14px;
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.4);
      animation: mediasync-xhs-slideIn 0.3s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `

    const style = document.createElement('style')
    style.textContent = `
      @keyframes mediasync-xhs-slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes mediasync-xhs-slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
      }
    `
    document.head.appendChild(style)
    document.body.appendChild(toast)

    setTimeout(() => {
      toast.style.animation = 'mediasync-xhs-slideOut 0.3s ease-in forwards'
      setTimeout(() => {
        toast.remove()
        style.remove()
      }, 300)
    }, 5000)
  }, 1000)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', showSyncedToast)
} else {
  showSyncedToast()
}
