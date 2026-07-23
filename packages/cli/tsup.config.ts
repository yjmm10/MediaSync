import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // 把 mcp-server 的代码打包进来，不作为外部依赖
  noExternal: ['@mediasync/mcp-server'],
})
