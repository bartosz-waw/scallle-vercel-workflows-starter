import type { ScallleJob } from '../lib/contract'
import { draftWithClaude } from './draft-with-claude'

/**
 * This project's ONE automation.
 *
 * Each Scallle automation that runs on Vercel Workflows gets its own copy of
 * this project — its own repository and Vercel project — so each holds only
 * its own keys (to the business's SharePoint, Outlook and the like). This one
 * runs only the automation SCALLLE_AUTOMATION_ID names: the receiver refuses a
 * job for any other (src/lib/check-job.ts). Never add another automation to
 * this project: another step gets a project of its own.
 *
 * To change what it does: write a new "use workflow" function in this folder
 * that takes the job and wraps its work in runForScallle (copy
 * draft-with-claude.ts), point WORKFLOW at it, and push.
 *
 * Never rename or move a workflow file while runs of it may be in progress:
 * its name and path are its identity in Vercel Workflows. Add a new file and
 * point WORKFLOW at it instead.
 */

export type ScallleWorkflow = (job: ScallleJob) => Promise<unknown>

/** The workflow every job this project accepts runs. */
export const WORKFLOW: ScallleWorkflow = draftWithClaude
