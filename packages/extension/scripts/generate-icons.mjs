#!/usr/bin/env node
/**
 * MediaSync 扩展图标生成脚本
 *
 * 从 assets/icon.svg 源文件生成多尺寸 PNG（16/48/128/512）。
 * 换图标只需修改 icon.svg，然后重新运行本脚本。
 *
 * 依赖 sharp：
 *   cd packages/extension && pnpm add -D sharp
 *
 * 运行：
 *   node scripts/generate-icons.mjs
 */
import sharp from 'sharp'
import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS = resolve(__dirname, '../assets')
const svg = readFileSync(join(ASSETS, 'icon.svg'))

const TARGETS = [
  { size: 16, name: 'icon-16.png' },
  { size: 48, name: 'icon-48.png' },
  { size: 128, name: 'icon-128.png' },
  { size: 512, name: 'icon-512.png' },
]

for (const { size, name } of TARGETS) {
  await sharp(svg).resize(size, size).png().toFile(join(ASSETS, name))
  console.log(`✓ ${name} (${size}×${size})`)
}

console.log('\n图标已生成到 packages/extension/assets/')
