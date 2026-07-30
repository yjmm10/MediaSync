/**
 * 按商店目标打包（Chrome/Edge 与 Firefox 对 background 要求冲突，无法共用同一 manifest）
 *
 * Usage:
 *   node scripts/pack-zip.mjs edge
 *   node scripts/pack-zip.mjs chrome
 *   node scripts/pack-zip.mjs firefox
 *   node scripts/pack-zip.mjs all
 *
 * - chrome/edge: 仅 background.service_worker（去掉 scripts；去掉 gecko）
 * - firefox: service_worker + scripts；保留 gecko.id / data_collection_permissions
 *
 * 产物：
 *   mediasync-{ver}-chrome.zip / -edge.zip（同内容）
 *   mediasync-{ver}-chrome.crx（需密钥，否则跳过）
 *   mediasync-{ver}-firefox.zip / -firefox.xpi（同内容）
 *
 * Zip 条目强制正斜杠路径（Windows 默认 Compress-Archive 会写成反斜杠，AMO 会拒收）。
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const extRoot = join(__dirname, '..')
const dist = join(extRoot, 'dist')
const require = createRequire(import.meta.url)
const version = require(join(extRoot, 'package.json')).version
const repoRoot = join(extRoot, '..', '..')

const REQUIRED_ICONS = ['icon-16.png', 'icon-48.png', 'icon-128.png']

const targetArg = (process.argv[2] || 'all').toLowerCase()
/** @type {Array<'chrome' | 'firefox'>} */
const targets =
  targetArg === 'all'
    ? ['chrome', 'firefox']
    : targetArg === 'edge'
      ? ['chrome']
      : targetArg === 'chrome' || targetArg === 'firefox'
        ? [targetArg]
        : []

if (targets.length === 0) {
  console.error(`Unknown target: ${targetArg} (use chrome | edge | firefox | all)`)
  process.exit(1)
}

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json missing — run build first')
  process.exit(1)
}

function assertIcons() {
  const missing = REQUIRED_ICONS.filter((name) => !existsSync(join(dist, 'assets', name)))
  if (missing.length) {
    console.error(`dist/assets missing required icons: ${missing.join(', ')}`)
    process.exit(1)
  }
}

assertIcons()

const viteDir = join(dist, '.vite')
if (existsSync(viteDir)) rmSync(viteDir, { recursive: true, force: true })

function patchManifest(base, target) {
  const m = structuredClone(base)
  const sw = m.background?.service_worker
  if (!sw) throw new Error('manifest.background.service_worker missing')

  if (target === 'firefox') {
    m.background = {
      service_worker: sw,
      scripts: [sw],
      type: 'module',
    }
    m.browser_specific_settings = {
      gecko: {
        id: 'mediasync@yjmm10.github.io',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    }
  } else {
    // Chrome / Edge：MV3 不允许 background.scripts
    m.background = {
      service_worker: sw,
      type: 'module',
    }
    delete m.browser_specific_settings
  }
  return m
}

function zipDirectory(sourceDir, zipPath) {
  if (existsSync(zipPath)) rmSync(zipPath)

  if (process.platform === 'win32') {
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dist = '${sourceDir.replace(/'/g, "''")}'
$zipPath = '${zipPath.replace(/'/g, "''")}'
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
$fs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
try {
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -Path $dist -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($dist.Length).TrimStart('\\','/')
      $entryName = $rel -replace '\\\\', '/'
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal
      )
    }
  } finally { $zip.Dispose() }
} finally { $fs.Dispose() }
`
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    if (r.status !== 0) {
      console.error(r.stderr || r.stdout)
      process.exit(r.status || 1)
    }
    return
  }

  const r = spawnSync('zip', ['-r', '-q', zipPath, '.'], {
    cwd: sourceDir,
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || 'zip failed')
    process.exit(r.status || 1)
  }
}

function writeOutputs(srcPath, names) {
  for (const name of names) {
    const outPath = join(extRoot, name)
    const repoOut = join(repoRoot, name)
    if (srcPath !== outPath) copyFileSync(srcPath, outPath)
    copyFileSync(outPath, repoOut)
    console.log(`  → ${outPath}`)
    console.log(`    ${repoOut}  (${(statSync(outPath).size / 1024).toFixed(1)} KB)`)
  }
}

/** @returns {string | null} PEM contents or null */
function resolveCrxPrivateKey() {
  if (process.env.EXTENSION_CRX_PRIVATE_KEY?.trim()) {
    return process.env.EXTENSION_CRX_PRIVATE_KEY.replace(/\\n/g, '\n')
  }
  const localKey = join(extRoot, 'crx-key.pem')
  if (existsSync(localKey)) {
    return readFileSync(localKey, 'utf8')
  }
  return null
}

async function packCrx(stageDir, crxName) {
  const privateKey = resolveCrxPrivateKey()
  if (!privateKey) {
    console.warn(
      '[crx] skipped — set EXTENSION_CRX_PRIVATE_KEY or place packages/extension/crx-key.pem'
    )
    return
  }

  let ChromeExtension
  try {
    ChromeExtension = (await import('crx')).default
  } catch (err) {
    console.warn(`[crx] skipped — failed to load crx package: ${err?.message || err}`)
    return
  }

  try {
    const crx = new ChromeExtension({ privateKey })
    await crx.load(stageDir)
    const buf = await crx.pack()
    const outPath = join(extRoot, crxName)
    writeFileSync(outPath, buf)
    writeOutputs(outPath, [crxName])
    console.log(`[crx] packed ${crxName}`)
  } catch (err) {
    console.warn(`[crx] skipped — pack failed: ${err?.message || err}`)
  }
}

async function packTarget(target) {
  const base = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const manifest = patchManifest(base, target)
  const stage = join(extRoot, `.pack-stage-${target}`)
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(dist, stage, { recursive: true })
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const zipPrimary =
    target === 'firefox'
      ? `mediasync-${version}-firefox.zip`
      : `mediasync-${version}-chrome.zip`
  const zipPath = join(extRoot, zipPrimary)
  zipDirectory(stage, zipPath)

  console.log(`\n[${target}]`)
  if (target === 'firefox') {
    writeOutputs(zipPath, [
      `mediasync-${version}-firefox.zip`,
      `mediasync-${version}-firefox.xpi`,
    ])
  } else {
    writeOutputs(zipPath, [
      `mediasync-${version}-chrome.zip`,
      `mediasync-${version}-edge.zip`,
    ])
    await packCrx(stage, `mediasync-${version}-chrome.crx`)
  }

  console.log(`         background ${JSON.stringify(manifest.background)}`)
  if (manifest.browser_specific_settings) {
    console.log(`         gecko ${JSON.stringify(manifest.browser_specific_settings.gecko)}`)
  }

  rmSync(stage, { recursive: true, force: true })
}

for (const t of targets) {
  await packTarget(t)
}

console.log(
  '\nNote: Chrome/Edge 与 Firefox 请分别上传对应包；Release 含 zip / xpi / crx（crx 需密钥）。'
)
