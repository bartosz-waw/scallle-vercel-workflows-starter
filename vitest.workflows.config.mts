import { workflow } from '@workflow/vitest'
import { defineConfig } from 'vitest/config'

// Workflow tests: the real Workflow runtime runs the workflows in-process
// (local world, data cleared per file). Retries really wait, so allow time.
export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ['tests/**/*.workflow.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
})
