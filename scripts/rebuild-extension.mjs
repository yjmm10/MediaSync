#!/usr/bin/env node
/**
 * 一键重新构建 Chrome 扩展（可选先构建 core）
 *
 * Usage（仓库根目录）:
 *   node scripts/rebuild-extension.mjs
 *   node scripts/rebuild-extension.mjs --extension-only
 *   node scripts/rebuild-extension.mjs --pack
 *   node scripts/rebuild-extension.mjs --skip-typecheck
 *
 * 也可用: pnpm rebuild:extension / yarn rebuild:extension
 */
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { delimiter, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const extensionDir = join(root, 'packages', 'extension')
const distDir = join(extensionDir, 'dist')

const args = new Set(process.argv.slice(2))
const extensionOnly = args.has('--extension-only')
const doPack = args.has('--pack')
const skipTypecheck = args.has('--skip-typecheck')
const help = args.has('-h') || args.has('--help')

if (help) {
  console.log(`Usage: node scripts/rebuild-extension.mjs [options]

Options:
  --extension-only   Skip @mediasync/core build
  --pack             After build, run extension pack (chrome/edge/firefox zips)
  --skip-typecheck   Extension: vite build only (skip tsc --noEmit)
  -h, --help         Show help
`)
  process.exit(0)
}

function run(command, commandArgs, opts = {}) {
  const label = [command, ...commandArgs].join(' ')
  console.log(`\n→ ${label}`)
  const binDirs = [
    join(extensionDir, 'node_modules', '.bin'),
    join(root, 'node_modules', '.bin'),
  ].filter((p) => existsSync(p))
  const env = {
    ...process.env,
    NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
    PATH: [...binDirs, process.env.PATH || ''].join(delimiter),
    ...opts.env,
  }
  const r = spawnSync(command, commandArgs, {
    cwd: opts.cwd || root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) {
    console.error(`\n✗ Failed (${r.status}): ${label}`)
    process.exit(r.status ?? 1)
  }
}

function hasYarn() {
  const r = spawnSync('yarn', ['--version'], {
    cwd: root,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  })
  return r.status === 0
}

function hasPnpm() {
  const r = spawnSync('pnpm', ['--version'], {
    cwd: root,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  })
  return r.status === 0
}

const useYarn = hasYarn()
const usePnpm = !useYarn && hasPnpm()
if (!useYarn && !usePnpm) {
  console.error('Need yarn or pnpm in PATH')
  process.exit(1)
}

const pm = useYarn ? 'yarn' : 'pnpm'
console.log(`MediaSync extension rebuild (package manager: ${pm})`)
console.log(`Root: ${root}`)

if (!extensionOnly) {
  run(pm, useYarn ? ['workspace', '@mediasync/core', 'build'] : ['--filter', '@mediasync/core', 'build'])
} else {
  console.log('\n(skip core build: --extension-only)')
}

if (skipTypecheck) {
  run(pm, useYarn ? ['vite', 'build'] : ['exec', 'vite', 'build'], { cwd: extensionDir })
} else {
  // 在扩展包目录执行，确保 node_modules/.bin（tsc/vite）在 PATH 中
  run(pm, ['run', 'build'], { cwd: extensionDir })
}

if (doPack) {
  run(useYarn ? 'yarn' : 'pnpm', useYarn ? ['pack'] : ['run', 'pack'], {
    cwd: extensionDir,
  })
}

if (!existsSync(distDir)) {
  console.error(`\n✗ Expected dist missing: ${distDir}`)
  process.exit(1)
}

console.log(`
✓ Extension built

  Load / reload in Chrome:
    chrome://extensions → 开发者模式 → 加载已解压的扩展程序
    目录: ${distDir}

  若已加载过同一路径，只需点扩展卡片上的「重新加载」。
`)
