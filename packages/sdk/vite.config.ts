import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@voidbase-cloud/sdk': __dirname + '/src/index.ts',
      '@': __dirname + '/src',
    },
  },
})
