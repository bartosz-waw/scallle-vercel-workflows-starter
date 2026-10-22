import type { NextConfig } from 'next'
import { withWorkflow } from 'workflow/next'

const nextConfig: NextConfig = {
  // An API-only project: one route (/api/scallle) plus the routes Vercel
  // Workflows adds under /.well-known/workflow/.
  poweredByHeader: false,
}

// withWorkflow compiles the "use workflow" / "use step" functions and adds
// the routes that run them.
export default withWorkflow(nextConfig)
