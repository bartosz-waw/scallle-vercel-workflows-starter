# Scallle automations on Vercel Workflows

A starter for a business’s **own** custom AI automations in Scallle. Each
automation gets its own copy of this project — its own repository and its own
Vercel project, in the business’s own GitHub and Vercel accounts — so each
holds only its own keys. Scallle runs none of it: Scallle sends a job here,
this project does the work (usually with Claude), and posts the result back to
Scallle.

It is the **Vercel Workflows** starter, one of the two tools a business can
plug into an automated step in Scallle. For work that touches other apps, use
the [n8n starter](https://github.com/bartosz-waw/scallle-n8n-starter) instead.

```
Scallle ──signed job──▶ POST /api/scallle ──start──▶ workflow (Vercel Workflows, in this project)
                         │ refuses anything not         1. claim the run id (same run twice → work once)
                         │ signed by Scallle, current,  2. ask Claude: the step's procedure + the item as data
                         │ for this business and this      (no procedure yet: the step's title)
                         │ automation, sent to this     3. send the result (or a plain error) to the run's callback,
                         │ project and bound to this       with any rows the job asked it to fill
                         │ run's callback                    │
                         │                                   ▼
                         └─ 202 { accepted: true }    Scallle puts the draft on the step for a person to review
```

## Set it up: one press, from the step in Scallle

In Scallle’s step builder, add a **Vercel Workflows** row to the step (from
the step menu). Each step gets its own project, so do this once per step.
Then press **Set up on Vercel**. A new tab opens on Vercel:

1. **Sign in to Vercel and GitHub as the business, not as yourself.** The
   project, its bill and the business’s data all live in the accounts you are
   signed in to.
2. Vercel copies this starter into a new repository in that GitHub — **keep it
   private** — named after the step (like `scallle-draft-the-reply-3f9a1c`),
   and fills in the three settings it needs:
   - `SCALLLE_WORKSPACE_ID`: which business in Scallle this project works for;
   - `SCALLLE_AUTOMATION_ID`: which step’s automation it runs;
   - `SCALLLE_APP_URL`: where Scallle is (`https://app.scallle.com`).

   Leave them as they are. The name is part of the project’s public web
   address: change it on Vercel’s page if the step’s name shouldn’t be seen.
3. Vercel deploys it, then brings you back to Scallle, which asks you to
   confirm the project’s address, connects it to the step and sends a test.

That’s all. There is nothing secret to copy or paste (see *How Scallle proves
a job is its own*).

What the business needs:

- **One Vercel team for all its automations.** Each automation is its own
  project in it, with its own settings and keys. One Pro plan and one AI
  Gateway credit balance cover them all.
- **A Vercel Pro plan.** Hobby is for non-commercial use, caps a step at 300 s,
  and AI Gateway’s zero data retention — which this project always asks for —
  needs Pro.
- **Claude on the business’s own AI account and credit, one of two ways** —
  never Scallle’s. A step costs a few pence to about 10p of Claude (Opus 5.5’s
  thinking is billed too).
  - **AI Gateway credit (the default).** Claude is called through Vercel AI
    Gateway on the business’s own Vercel account and billed there. Claude isn’t
    in AI Gateway’s free tier: **buy credit first** (in Vercel: *AI Gateway →
    Credits*) and set a budget there. Zero data retention is mandatory: every
    call asks for it, and this code never drops it to make a call work.
    Through AI Gateway, Vercel handles the business’s data on its way to
    Anthropic, so the business names Vercel in its data agreement — or uses its
    own Anthropic key instead.
  - **Or the business’s own Anthropic key.** Add `ANTHROPIC_API_KEY` in the
    project’s *Settings → Environment Variables*, then redeploy (Vercel only
    applies changed variables to new deployments). Ideally a key from an
    Anthropic workspace just for this business, so its spend and data settings
    sit apart.

If Scallle’s test says the project “can’t run Vercel Workflows”: in Vercel open
the project → *Settings → Security* and turn on **Secure backend access with
OIDC federation**, and under *Environment Variables* tick **Automatically
expose System Environment Variables**. Then redeploy. Vercel Workflows and AI
Gateway both sign in with it.

If Scallle’s test says the project answered 401 with no reason, Vercel’s
Deployment Protection probably covers the production address: set it to cover
previews only (*Settings → Deployment Protection*). This must answer
`401 {"accepted":false,…}` in JSON, not a Vercel sign-in page:

```bash
curl -i -X POST https://<your-project>.vercel.app/api/scallle
```

The runs show in the Vercel dashboard under *Workflows*, labelled with
Scallle’s run id (`scallle_run_id`).

## How Scallle proves a job is its own

Scallle signs every job with its own Ed25519 key, and publishes the public
half at `<SCALLLE_APP_URL>/.well-known/scallle-job-keys`. The project checks
each job’s signature (`X-Scallle-Key-Id`, `X-Scallle-Signature`) over the
exact bytes it received, against those keys — fetched from `SCALLLE_APP_URL`
only, never from an address in the job. So there is no secret to keep, and
when Scallle changes its key the project picks the new one up by itself.

Scallle signs every business’s jobs with the same key, so what keeps
businesses apart is `SCALLLE_WORKSPACE_ID`: a job for any other business is
refused. The project won’t run until it is set to a workspace id (a UUID).

Each project also runs one automation: a job for any automation other than
`SCALLLE_AUTOMATION_ID` is refused. Until it is set, every job is refused with
the id to set.

## What’s in it

| Path | What it is |
|---|---|
| `src/app/api/scallle/route.ts` | The receiver. Checks every job, starts its workflow, answers 202 at once. |
| `src/workflows/draft-with-claude.ts` | The example automation: Claude follows the step’s written procedure for one item and returns a draft. |
| `src/workflows/run-for-scallle.ts` | The frame every automation runs in: claim the run, do the work, report success or a plain error. |
| `src/workflows/index.ts` | The one automation this project runs (`WORKFLOW`). |
| `src/workflows/examples/draft-then-approve.ts` | Example only, not wired: act outside only after a person approves. |
| `src/lib/` | The contract types, signature check, Scallle’s keys, job checks, callback poster, Claude helper, and what Claude is given and what comes back (`reply.ts`). |
| `scripts/` | Local mocks of Scallle and Claude, a test-job sender, and the end-to-end check. |
| `tests/` | The checks `npm test` and `npm run test:workflows` run. |
| `AGENTS.md`, `CLAUDE.md` | The rules for AI coding tools (Claude Code, Cursor and the like) that build this project’s automation. |

## Change what this automation does

1. Copy `src/workflows/draft-with-claude.ts` to a new file in `src/workflows/`
   and change the work inside `runForScallle(job, async () => { … })`.
   - Do every slow or outside thing in a **step** (`'use step'` as the first
     line of an async function). `askClaude` already is one. A step that
     finished is never repeated when something later fails.
   - Throw `FatalError` for failures that won’t fix themselves, and
     `RetryableError` (or any error) for ones that might. Their messages go to
     Scallle — write them in the code, never build them from the item.
   - In a step that parses or handles item or Claude text, catch failures and
     throw a `FatalError` with a message written in the code:
     ```ts
     try { return JSON.parse(text) } catch { throw new FatalError("Couldn't read the referral form.") }
     ```
     Scallle never sees an unexpected error’s message anyway (it gets one
     general sentence), but the Workflow runtime prints that message and its
     stack to the Vercel logs once — and `JSON.parse`, for one, quotes the
     text it choked on.
   - Give Claude `promptFor(job)` as the user message and
     `systemPromptFor(job.step, extrasOf(job))` as its instructions, as
     `draft-with-claude.ts` does. `promptFor` sends the item and the job’s
     other data, each in its own tags and as data: what each field is
     (`job.fields` — name, label, type, answers, whether it’s required; one
     missing from `job.item` was left blank), about this run (`job.context`
     — today’s date, the system’s name, who is doing it, only what was
     ticked in Scallle), a person’s send-back note on a redo
     (`job.step.sentBackNote`) and the rows it may fill (`job.fill`).
   - Return `{ result, usage }`, plus `fields` when the job names rows to
     fill: `readReply(answer.text, job.fill)` (`src/lib/reply.ts`) reads them
     from Claude’s answer, fitted to each row’s type. Only names in
     `job.fill` go back; a person checks each on its own row in Scallle.
     Several Claude calls? Add their usage with `addUsage`
     (`src/lib/claude.ts`).
   - `job.test` is true on a test run (*Send a test*, *Execute*, the first test
     after one-press setup). Anything that acts outside — sends, writes,
     books — is skipped on a test, and the result says what it would have
     done (see *Safety rules*).
2. Point `WORKFLOW` in `src/workflows/index.ts` at it. Leave the old file
   where it is.
3. Push.

**Another step gets its own project**: press **Set up on Vercel** on its row in
Scallle — or, where that isn’t offered, follow *Appendix: set it up by hand*
for that step. Never add a second automation to this project. Each project holds
only its own automation’s keys (to SharePoint, Outlook and the like), so one
project running many would let each reach every key.

Building it with an AI coding tool? On the step in Scallle, press **Copy for
your AI**: it copies a brief for that one step (its name, instructions, what
it receives, what Scallle expects back and its automation id). Paste it as
the task. The tool reads `AGENTS.md` here for the rules, which win over
anything in a brief.

Don’t rename or move a workflow file while runs of it may be in progress — its
name and path are its identity in Vercel Workflows.

## Bring an older copy up to date

A project made from this starter before 21 Oct 2026 still works: it ignores
what it doesn’t know in a job and drafts from the item as before. It just
doesn’t fill the rows after the step in Scallle, pass a person’s send-back
note to Claude, or read the about-this-run values. Scallle’s step builder
says so when a test filled none of the rows it could. If `src/lib/contract.ts`
in your copy has no `fill`, or its `AGENTS.md` doesn’t name `job.fill`, it is
one of these.

To bring it up to date, from the
[public starter](https://github.com/bartosz-waw/scallle-vercel-workflows-starter):

1. Copy every file this release changed over yours, except your workflow
   (step 2). If you changed one of them yourself, merge it instead.
   - The rules: `AGENTS.md` and this `README.md`. An AI coding tool follows
     `AGENTS.md`, and an older one doesn’t know about rows to fill.
   - The code: `src/lib/contract.ts`, `src/lib/check-job.ts`,
     `src/lib/reply.ts` (new), `src/workflows/run-for-scallle.ts` and
     `src/workflows/examples/draft-then-approve.ts`.
   - The checks: `tests/agents-md.test.ts`, `tests/app-signed-job.test.ts`,
     `tests/check-job.test.ts`, `tests/draft-with-claude.workflow.test.ts`,
     `tests/receiver.test.ts`, `tests/reply.test.ts` (new),
     `tests/system-prompt.test.ts`, `tests/fixtures/app-signed-job.json`,
     `tests/fixtures/own-fields-step.ts` (new), `scripts/e2e.mjs`,
     `scripts/mock-claude.mjs` and `scripts/send-test-job.mjs`.
2. `src/workflows/draft-with-claude.ts`: copy it too if you never changed it,
   or merge it. If `WORKFLOW` names a workflow of your own, give Claude
   `promptFor(job)` and `systemPromptFor(job.step, extrasOf(job))` there, and
   read its answer with `readReply(answer.text, job.fill)`, returning
   `fields` with the result.
3. Run every check (*Local development*, below), then push.

## Safety rules

These hold for this project’s automation, and for every copy of this starter.
They matter most for businesses whose items are about vulnerable people.

- **One project, one automation, its own keys.** This project runs only the
  automation `SCALLLE_AUTOMATION_ID` names and holds only that automation’s
  keys, in its own Environment Variables. Never use a Vercel shared
  environment variable for a key: it reaches every project it is linked to.
  The business’s `ANTHROPIC_API_KEY`, if it uses one, may be the same key in
  every project, but it too goes in each project’s own Environment Variables.
- **Draft, don’t act.** An automation returns a draft. A person approves it in
  Scallle (step set to *Reviewed*) before anything is sent or changed. Nothing
  in this starter sends, books or writes anywhere but Scallle. When an
  automation must act, the pattern is `examples/draft-then-approve.ts` — not
  wired up until the contract has an approval message.
- **An automation that acts outside skips that part on a test, and confirms
  with Scallle first.** On a test run (`job.test`, from the job’s `run.test`)
  it never sends, writes or books: it returns what it would have done. On a
  real run, before it acts it confirms with Scallle through the run’s own
  callback link and token, on the pinned `SCALLLE_APP_URL` — never an address
  from the job — and acts only on Scallle’s yes. Scallle signs every
  business’s jobs with one key, so a job’s signature alone is enough for
  drafting only. (The rule stands now; Scallle’s side of the confirmation
  comes later — until then, draft, don’t act.)
- **Item data is data.** Instructions come only from the step’s procedure and
  this code. The item goes to Claude as the user message, and Claude is told it
  is data, never instructions. So do what each field is, the about-this-run
  values and a person’s send-back note: a note may say what to change in the
  draft, never what the rules are. Anything an automation fetches from
  elsewhere is data too: it goes with the item, never in the instructions.
- **Only the rows Scallle asked for.** A result fills only the rows the job’s
  `fill` names; `runForScallle` drops any other, and a person checks each
  filled row in Scallle before it is used.
- **The business pays for its own AI — never Scallle.** The AI runs on the
  business’s own AI account and its own credit, never Scallle’s. Through AI
  Gateway (the default) every call asks for Anthropic itself as the only
  provider and for zero data retention, which is mandatory: the gateway
  refuses the call rather than send the item anywhere else, and this code
  never drops those options to make a call work. With `ANTHROPIC_API_KEY`,
  Claude is called directly.
- **Errors carry no personal data.** Scallle only gets messages written in this
  code; anything unexpected becomes one general sentence — also when a step
  runs out of retries and the runtime wraps its last error in one of its own.
  A failed run is marked failed with that same plain message. The messages
  this code writes to the logs name run ids, reasons and error names, never
  the item, the procedure or the callback address (it holds the run’s token).
  That promise covers only messages written in the code: when a step fails on
  an unexpected error, the Workflow runtime itself prints that error’s message
  and stack once, and those could quote the item. Hence the rule above —
  steps that handle item or Claude text catch their failures and throw a
  `FatalError` written in the code.
- **Only Scallle, only this business, only this automation, only this
  project, only this run.** A job must be signed with a key Scallle publishes
  at `SCALLLE_APP_URL`, issued within 5 minutes, for `SCALLLE_WORKSPACE_ID`,
  for `SCALLLE_AUTOMATION_ID`, addressed to this project (`to`), and carry a
  callback on `SCALLLE_APP_URL` naming the same automation and run. Results
  only ever go to that callback, never via a redirect.
- **The Vercel sign-in stays in the step.** The project’s Vercel token, which
  AI Gateway takes in place of a key, is fetched inside the Claude step for
  each call, never in workflow code — so it is never stored with the run.
  `npm run build` fails if workflow code reaches it.
- **Run data is deleted when the run ends.** The item, Claude’s draft and every
  step’s input and output are kept only while the run is going
  (`RUN_DATA_RETENTION = 0` in `route.ts`); run ids, step names, times and
  status stay so runs remain visible. While a run is going, Vercel encrypts its
  data (AES-256-GCM, a key per run); seeing it decrypted in the dashboard needs
  the same permission as reading the project’s environment variables, and
  Vercel’s audit log records each decryption.
- **Same run, once.** Scallle may send a run twice. The first workflow run
  claims the run id and does the work; a repeat does nothing (the claim is kept
  7 days).

### What is kept where

| Where | What | For how long |
|---|---|---|
| Vercel Workflows (Dublin) | The job and each step’s input and output, encrypted | Until the run ends |
| Vercel Workflows | Run and step ids, step names, times, status; labels `scallle_run_id`, `scallle_automation_id`; the run-id claim (`scallle-run:<id>` — Vercel keeps all hook tokens in Washington, `iad1`) | Your plan’s retention after the run ends (Pro: 7 days); the claim 7 days |
| Vercel logs | Run ids, refusal reasons, error names — plus, if a step fails on an error not written in the code, that error’s message and stack (printed by the Workflow runtime; it may quote the item) | Your Vercel plan’s log retention — not covered by `RUN_DATA_RETENTION` |
| Vercel AI Gateway (the default) | Each Claude call passes through on its way to Anthropic, asked for zero data retention; the gateway keeps usage and cost per request for the business’s Vercel account | Per Vercel’s AI Gateway terms and the business’s Vercel settings |
| Anthropic | The prompt and answer of each Claude call | Through AI Gateway: zero data retention. With `ANTHROPIC_API_KEY`: per the business’s Anthropic account settings |
| Scallle | The result or error, and token usage | Scallle’s own rules |

## Timing and retries

| What | How |
|---|---|
| Answering Scallle | 202 within milliseconds; the work runs after. |
| Claude busy (429, 5xx, 529), unreachable or too slow | The step retries up to 5 times, 5 s → 80 s apart, or as the service’s Retry-After asks. |
| Claude refuses (with an own key, after the fallback model also declined), answer cut off, key or sign-in refused, no AI Gateway credit | No retry; Scallle gets a plain error. |
| Claude still busy after the last retry | Scallle gets the last plain message, e.g. “Claude was too busy or unwell to answer (HTTP 529).” |
| Scallle’s callback: network error, 429, 5xx | Retried up to 8 times, 5 s → 5 min apart (about 15 minutes; Scallle waits 20). |
| Scallle’s callback: any 2xx, including `{ ok: false, reason: "run closed" }` | Delivered. |
| Scallle’s callback: other 4xx, or a redirect | Final; not retried. |
| A refused job | 401 (not signed by Scallle, a key Scallle doesn’t publish, or issued_at off by more than 5 min), 403 (another business), 400 (bad shape, version, address or callback, or a job for another automation than `SCALLLE_AUTOMATION_ID`), 413 (over 1 MB), 500 (the project isn’t set up — while `SCALLLE_AUTOMATION_ID` alone is missing, the reason names the id to set — or can’t run Vercel Workflows). Scallle never resends these. |
| Scallle’s keys couldn’t be fetched (and none are cached), or the workflow couldn’t start | 503, so Scallle sends the job again. |

## Appendix: set it up by hand

When one-press setup isn’t available, or for a project you deploy yourself:

1. **Copy the code** into a new **private** repository in the business’s
   GitHub organisation (on
   [the starter](https://github.com/bartosz-waw/scallle-vercel-workflows-starter):
   *Use this template*) — one repository per automation; name it after the
   step.
2. **Create the Vercel project** in the business’s Vercel account: *Add New →
   Project*, import that repo. Framework: Next.js (detected). `vercel.json`
   pins functions — and so the workflow data — to Dublin (`dub1`). The first
   deploy refuses every job until step 4 gives it its settings.
3. **Connect it in Scallle**: in the step builder, add a *Vercel Workflows*
   row to the step (from the step menu). Then paste the project’s address
   (`https://<your-project>.vercel.app`) and press *Connect*. Connecting sends
   nothing to the project. The step now shows the three settings it needs,
   under *Its settings*.
4. **Settings → Security**: turn on *Secure backend access with OIDC
   federation*. **Settings → Environment Variables**: tick *Automatically
   expose System Environment Variables*, then add, for Production, the three
   values the step shows: `SCALLLE_WORKSPACE_ID`, `SCALLLE_AUTOMATION_ID` and
   `SCALLLE_APP_URL` (`https://app.scallle.com`). Add `ANTHROPIC_API_KEY`
   only if the business uses its own Anthropic key. Never add
   `ANTHROPIC_BASE_URL` here: it is for the local mock only, and while it is
   set every job is refused. See `.env.example`.
5. **Redeploy**, check the address with the `curl` above, then send a test
   from the step.

## Local development

Everything runs on your machine with mocks — no real keys, no cost, no real
people’s data.

```bash
npm install
cp .env.example .env.local
# in .env.local: SCALLLE_WORKSPACE_ID=11111111-1111-4111-8111-111111111111 (a test id),
#   SCALLLE_AUTOMATION_ID=33333333-3333-4333-8333-333333333333 (a test id),
#   SCALLLE_APP_URL=http://127.0.0.1:4010, ANTHROPIC_API_KEY=anything-made-up,
#   ANTHROPIC_BASE_URL=http://127.0.0.1:4020

npm run mock:scallle      # terminal 1 — publishes a TEST key, prints every result it receives
npm run mock:claude       # terminal 2 — answers like the Messages API
npm run dev               # terminal 3 — this project on :3010

node --env-file=.env.local scripts/send-test-job.mjs                  # a valid job (--test: a test run;
                                                                      #   --fill: one with rows to fill)
node --env-file=.env.local scripts/send-test-job.mjs --unknown-kid    # refused (also --bad-signature, --old,
                                                                      #   --other-workspace, --other-automation,
                                                                      #   --wrong-to, --foreign-callback,
                                                                      #   --mismatched-callback)

npx workflow web          # the runs, steps and retries (local data lives in .next/workflow-data)
```

The mock Scallle and the test-job sender share a fixed key from
`scripts/test-signing-key.mjs` — TEST ONLY, and public on purpose: a deployed
project only ever trusts the keys its own `SCALLLE_APP_URL` publishes.

Locally, Vercel Workflows uses its *local world*: runs are stored as files and
not encrypted, so use made-up data only. `ANTHROPIC_BASE_URL` is only accepted
while `SCALLLE_APP_URL` is on this machine too (or, with an own key, when it is
Anthropic’s own `https://….anthropic.com` address), so a copy left in a
deployment stops jobs instead of sending items elsewhere.

To try the real AI Gateway from your machine, remove `ANTHROPIC_API_KEY` and
`ANTHROPIC_BASE_URL`, link the project (`vercel link`) and run `vercel env
pull .env.local`: it writes a Vercel sign-in (`VERCEL_OIDC_TOKEN`, valid for
12 hours) that AI Gateway accepts. Calls are then real, billed to that Vercel
account — use made-up items only.

Tests:

```bash
npm run typecheck
npm test                       # unit: receiver checks, signature, Scallle's keys, callback poster, Claude helper (both ways)
npm run test:workflows         # the workflows in the real Workflow runtime (takes ~30 s: retries really wait)
npm run build && npm run e2e   # the built app end to end against both mocks, with an own key and through the mock gateway
```

## Licence

MIT — see `LICENSE`.
