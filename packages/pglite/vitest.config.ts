import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // tinytar's package "main" points at a nonexistent src/index.js; Node
      // resolves it via its directory-index fallback but Vite does not, so
      // alias it to the real entry for source-importing tests.
      tinytar: fileURLToPath(
        new URL('./node_modules/tinytar/index.js', import.meta.url),
      ),
    },
  },
  test: {
    name: 'pglite',
    dir: './tests',
    watch: false,
    typecheck: { enabled: true },
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['**/*.{test,test.web}.{js,ts}'],
    server: {
      deps: {
        external: [/\/tests\/targets\/web\//],
      },
    },
  },
})
