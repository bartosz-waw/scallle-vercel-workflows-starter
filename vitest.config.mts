import { defineConfig } from 'vitest/config'

// Unit tests: plain functions, no workflow runtime ("use step" / "use
// workflow" are no-ops here). Workflow tests use vitest.workflows.config.ts.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.workflow.test.ts', 'node_modules/**'],
  },
})
