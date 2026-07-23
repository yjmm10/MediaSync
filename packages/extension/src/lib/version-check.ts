/**
 * 版本检查模块
 * 用于检查远程是否有新版本，提醒 ZIP 安装的用户更新
 */

import { createLogger } from './logger'

const logger = createLogger('VersionCheck')

const VERSION_CHECK_URL = 'https://wpics.oss-cn-shanghai.aliyuncs.com/mediasync-version.json'
const CHECK_INTERVAL_HOURS = 24
const STORAGE_KEY_LAST_CHECK = 'version_last_check'
const STORAGE_KEY_UPDATE_INFO = 'version_update_info'
const STORAGE_KEY_DISMISSED = 'version_dismissed'

export interface VersionInfo {
  version: string
  downloadUrl: string
  releaseNotes: string
  releaseDate: string
}

export interface UpdateCheckResult {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  info?: VersionInfo
}

/**
 * 比较版本号
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    if (p1 > p2) return 1
    if (p1 < p2) return -1
  }
  return 0
}

/**
 * 获取当前扩展版本
 */
function getCurrentVersion(): string {
  return chrome.runtime.getManifest().version
}

/**
 * 检查是否需要进行版本检查（基于时间间隔）
 */
async function shouldCheck(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_LAST_CHECK)
    const lastCheck = result[STORAGE_KEY_LAST_CHECK]

    if (!lastCheck) return true

    const now = Date.now()
    const elapsed = now - lastCheck
    const intervalMs = CHECK_INTERVAL_HOURS * 60 * 60 * 1000

    return elapsed >= intervalMs
  } catch (e) {
    return true
  }
}

/**
 * 记录检查时间
 */
async function recordCheckTime(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_LAST_CHECK]: Date.now() })
}

/**
 * 从远程获取最新版本信息
 */
async function fetchLatestVersion(): Promise<VersionInfo | null> {
  try {
    const response = await fetch(VERSION_CHECK_URL, {
      cache: 'no-cache',
      headers: {
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      logger.warn('Version check failed:', response.status)
      return null
    }

    const data = await response.json()
    return data as VersionInfo
  } catch (e) {
    logger.warn('Failed to fetch version info:', e)
    return null
  }
}

/**
 * 检查更新
 * @param force 是否强制检查（忽略时间间隔）
 */
export async function checkForUpdates(force = false): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion()

  // 检查是否需要检查
  if (!force && !(await shouldCheck())) {
    // 返回缓存的结果
    const cached = await chrome.storage.local.get(STORAGE_KEY_UPDATE_INFO)
    if (cached[STORAGE_KEY_UPDATE_INFO]) {
      return cached[STORAGE_KEY_UPDATE_INFO]
    }
    return { hasUpdate: false, currentVersion }
  }

  logger.info('Checking for updates...')

  // 获取远程版本
  const latestInfo = await fetchLatestVersion()

  // 记录检查时间
  await recordCheckTime()

  if (!latestInfo) {
    return { hasUpdate: false, currentVersion }
  }

  // 比较版本
  const hasUpdate = compareVersions(latestInfo.version, currentVersion) > 0

  const result: UpdateCheckResult = {
    hasUpdate,
    currentVersion,
    latestVersion: latestInfo.version,
    info: hasUpdate ? latestInfo : undefined,
  }

  // 缓存结果
  await chrome.storage.local.set({ [STORAGE_KEY_UPDATE_INFO]: result })

  if (hasUpdate) {
    logger.info(`New version available: ${latestInfo.version} (current: ${currentVersion})`)
  } else {
    logger.info(`Already up to date: ${currentVersion}`)
  }

  return result
}

/**
 * 获取缓存的更新信息
 */
export async function getCachedUpdateInfo(): Promise<UpdateCheckResult | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_UPDATE_INFO)
    return result[STORAGE_KEY_UPDATE_INFO] || null
  } catch (e) {
    return null
  }
}

/**
 * 检查用户是否已忽略当前版本的更新提示
 */
export async function isUpdateDismissed(version: string): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_DISMISSED)
    return result[STORAGE_KEY_DISMISSED] === version
  } catch (e) {
    return false
  }
}

/**
 * 忽略当前版本的更新提示
 */
export async function dismissUpdate(version: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_DISMISSED]: version })
}

/**
 * 清除忽略状态（用于新版本发布后）
 */
export async function clearDismissed(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY_DISMISSED)
}
