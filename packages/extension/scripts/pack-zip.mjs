/**
 * 按商店目标打包（Edge / Firefox 对 background 要求冲突，无法共用同一 manifest）
 *
 * Usage:
 *   node scripts/pack-zip.mjs edge
 *   node scripts/pack-zip.mjs firefox
 *   node scripts/pack-zip.mjs all
 *
 * - edge/chrome: 仅 background.service_worker（去掉 scripts；去掉 gecko）
 * - firefox: service_worker + scripts；保留 gecko.id / data_collection_permissions
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

const targetArg = (process.argv[2] || 'all').toLowerCase()
const targets =
  targetArg === 'all'
    ? ['edge', 'firefox']
    : targetArg === 'chrome'
      ? ['edge']
      : [targetArg]

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json missing — run build first')
  process.exit(1)
}

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
    // Edge / Chrome Web Store：MV3 不允许 background.scripts
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

  // Linux / macOS（CI）：zip 默认使用正斜杠
  const r = spawnSync('zip', ['-r', '-q', zipPath, '.'], {
    cwd: sourceDir,
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || 'zip failed')
    process.exit(r.status || 1)
  }
}

function packTarget(target) {
  const base = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const manifest = patchManifest(base, target)
  const stage = join(extRoot, `.pack-stage-${target}`)
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(dist, stage, { recursive: true })
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const outName = `mediasync-${version}-${target}.zip`
  const outPath = join(extRoot, outName)
  const repoOut = join(repoRoot, outName)
  zipDirectory(stage, outPath)
  copyFileSync(outPath, repoOut)
  rmSync(stage, { recursive: true, force: true })

  console.log(`\n[${target}] ${outPath}`)
  console.log(`         ${repoOut}`)
  console.log(`         size ${(statSync(outPath).size / 1024).toFixed(1)} KB`)
  console.log(`         background ${JSON.stringify(manifest.background)}`)
  if (manifest.browser_specific_settings) {
    console.log(`         gecko ${JSON.stringify(manifest.browser_specific_settings.gecko)}`)
  }
}

for (const t of targets) {
  if (t !== 'edge' && t !== 'firefox') {
    console.error(`Unknown target: ${t} (use edge | firefox | all)`)
    process.exit(1)
  }
  packTarget(t)
}

console.log('\nNote: Edge 与 Firefox 请分别上传对应 zip，不再提供 universal 包。')
