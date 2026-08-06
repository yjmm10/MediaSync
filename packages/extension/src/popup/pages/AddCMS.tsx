import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Globe, Loader2 } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { SubPageHeader } from '../components/SubPageHeader'
import { useCMSStore, type CMSType } from '../stores/cms'
import { trackPageView, trackPlatformExpansion } from '../../lib/analytics'
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  getPlatformCategory,
  type PlatformCategory,
} from '@/lib/platform-categories'

interface CMSOption {
  id: CMSType
  name: string
  description: string
  icon: string
}

const cmsOptions: CMSOption[] = [
  {
    id: 'wordpress',
    name: 'WordPress',
    description: '支持 XML-RPC 或 REST API',
    icon: 'https://s.w.org/style/images/about/WordPress-logotype-simplified.png',
  },
  {
    id: 'typecho',
    name: 'Typecho',
    description: '支持 XML-RPC 接口',
    icon: '/assets/typecho.ico',
  },
  {
    id: 'metaweblog',
    name: 'MetaWeblog API',
    description: '通用博客接口协议（博客园等）',
    icon: 'https://www.cnblogs.com/favicon.ico',
  },
]

interface ThirdPartyPlatform {
  id: string
  name: string
  icon: string
  homepage: string
}

export function AddCMSPage() {
  const navigate = useNavigate()
  const { addAccount } = useCMSStore()
  const [step, setStep] = useState<'select' | 'config'>('select')
  const [selectedCMS, setSelectedCMS] = useState<CMSType | null>(null)
  const [config, setConfig] = useState({
    url: '',
    username: '',
    password: '',
    name: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [thirdPartyPlatforms, setThirdPartyPlatforms] = useState<ThirdPartyPlatform[]>([])
  const [platformsLoading, setPlatformsLoading] = useState(true)

  useEffect(() => {
    trackPageView('add_cms').catch(() => {})

    chrome.runtime.sendMessage({ type: 'GET_PLATFORMS' }).then((response) => {
      if (response?.platforms) {
        const platforms = response.platforms
          .filter((p: ThirdPartyPlatform) => p.id !== 'weixin')
          .map((p: ThirdPartyPlatform) => ({
            id: p.id,
            name: p.name,
            icon: p.icon,
            homepage: p.homepage,
          }))
        setThirdPartyPlatforms(platforms)
      }
      setPlatformsLoading(false)
    }).catch(() => {
      setPlatformsLoading(false)
    })
  }, [])

  const platformGroups = useMemo(() => {
    const groups: Array<{ category: PlatformCategory; platforms: ThirdPartyPlatform[] }> = []
    for (const category of CATEGORY_ORDER) {
      const items = thirdPartyPlatforms.filter(p => getPlatformCategory(p.id) === category)
      if (items.length > 0) groups.push({ category, platforms: items })
    }
    return groups
  }, [thirdPartyPlatforms])

  const handleSelectCMS = (cmsId: CMSType) => {
    setSelectedCMS(cmsId)
    setStep('config')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const result = await addAccount({
        type: selectedCMS!,
        name: config.name,
        url: config.url,
        username: config.username,
        password: config.password,
      })

      if (result.success) {
        chrome.storage.local.get('cmsAccounts').then((storage) => {
          const total = (storage.cmsAccounts || []).length
          trackPlatformExpansion(`cms_${selectedCMS}`, total).catch(() => {})
        })
        navigate('/')
      } else {
        setError(result.error || '添加失败')
      }
    } catch (err) {
      setError((err as Error).message)
    }

    setLoading(false)
  }

  return (
    <div className="page-root flex flex-col h-[500px]">
      <SubPageHeader
        title={step === 'config' ? `配置 ${cmsOptions.find(c => c.id === selectedCMS)?.name || ''}` : '添加平台'}
        onBack={() => (step === 'config' ? setStep('select') : navigate('/'))}
      />

      <div className="flex-1 overflow-y-auto p-4">
        {step === 'select' && (
          <div className="space-y-5">
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground mb-0.5">自建站点</h2>
              <p className="text-[11px] text-muted-foreground mb-2">添加你的博客系统</p>

              <div className="space-y-2">
                {cmsOptions.map(cms => (
                  <button
                    key={cms.id}
                    type="button"
                    onClick={() => handleSelectCMS(cms.id)}
                    className="card-interactive w-full flex items-center gap-3 p-3 text-left"
                  >
                    <img
                      src={cms.icon}
                      alt={cms.name}
                      className="w-8 h-8 rounded-md"
                      onError={e => {
                        (e.target as HTMLImageElement).src = '/assets/icon-48.png'
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{cms.name}</div>
                      <div className="text-xs text-muted-foreground">{cms.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h2 className="text-xs font-semibold text-muted-foreground mb-0.5">第三方平台</h2>
              <p className="text-[11px] text-muted-foreground mb-2">点击前往登录，登录后自动识别</p>

              {platformsLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                </div>
              ) : (
                <div className="space-y-3">
                  {platformGroups.map(group => (
                    <div key={group.category} className="space-y-1.5">
                      <div className="flex items-center gap-2 px-0.5">
                        <span className="w-0.5 h-3 rounded-full bg-primary flex-shrink-0" />
                        <span className="text-[11px] font-semibold text-foreground">
                          {CATEGORY_LABELS[group.category]}
                        </span>
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {group.platforms.length}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {group.platforms.map(platform => (
                          <button
                            key={platform.id}
                            type="button"
                            onClick={() => chrome.tabs.create({ url: platform.homepage })}
                            className="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-muted/70 transition-colors"
                            title={`前往 ${platform.name} 登录`}
                          >
                            <img
                              src={platform.icon}
                              alt={platform.name}
                              className="w-6 h-6 rounded"
                              onError={e => {
                                (e.target as HTMLImageElement).src = '/assets/icon-48.png'
                              }}
                            />
                            <span className="text-[10px] text-muted-foreground truncate w-full text-center">
                              {platform.name}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {step === 'config' && selectedCMS && (
          <form onSubmit={handleSubmit} className="space-y-3">
            <p className="text-[11px] text-muted-foreground mb-1">输入站点信息以连接</p>

            <div>
              <label className="block text-xs font-medium mb-1">站点名称</label>
              <input
                type="text"
                value={config.name}
                onChange={e => setConfig({ ...config, name: e.target.value })}
                placeholder="我的博客"
                className="input-soft"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">站点地址</label>
              <div className="relative">
                <Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="url"
                  value={config.url}
                  onChange={e => setConfig({ ...config, url: e.target.value })}
                  placeholder="https://example.com"
                  className="input-soft pl-8"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">用户名</label>
              <input
                type="text"
                value={config.username}
                onChange={e => setConfig({ ...config, username: e.target.value })}
                placeholder="admin"
                className="input-soft"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">密码</label>
              <input
                type="password"
                value={config.password}
                onChange={e => setConfig({ ...config, password: e.target.value })}
                placeholder="••••••••"
                className="input-soft"
                required
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                密码仅存储在本地，不会上传到任何服务器
              </p>
            </div>

            {error && (
              <div className="text-xs text-destructive bg-destructive/[0.06] border border-destructive/20 p-2.5 rounded-lg">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full btn-brand" disabled={loading}>
              {loading ? '连接中...' : '添加站点'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
