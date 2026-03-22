import babel from '@rolldown/plugin-babel'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vite-plus'

const generateWorkerTypes = 'pnpm exec wrangler types worker-configuration.d.ts --strict-vars=false'

function decoratorPreset(options: Record<string, unknown>) {
  return {
    preset: () => ({
      plugins: [['@babel/plugin-proposal-decorators', options]],
    }),
    rolldown: {
      filter: {
        code: '@',
      },
    },
  }
}

export default defineConfig({
  plugins: [
    babel({
      presets: [decoratorPreset({ version: '2023-11' })],
    }),
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
  run: {
    tasks: {
      build: {
        command: `${generateWorkerTypes} && pnpm exec tsc -p tsconfig.json --noEmit`,
      },
      check: {
        command: `${generateWorkerTypes} && pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run`,
      },
    },
  },
})
