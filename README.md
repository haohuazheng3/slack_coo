# Slack AI COO — The Bridge Between Owner & Team

> "Every sentence the founder says, becomes a tracked, accountable piece of work."

The AI COO is a Slack app that sits between business owners and their team. When a leader mentions the bot in a channel and assigns work, the AI **clarifies missing details, creates a structured task card, DMs the assignee, follows up on a cadence, summarizes employee replies into owner-readable status updates, and surfaces everything in real time on the owner's App Home dashboard.**

The owner no longer has to chase. The COO does.

---

## Table of Contents

1. [What's New in v2](#whats-new-in-v2)
2. [How It Works](#how-it-works)
3. [The Tool Catalog](#the-tool-catalog)
4. [Cadence — When the COO Pings Employees](#cadence--when-the-coo-pings-employees)
5. [Project Structure](#project-structure)
6. [Setup](#setup)
7. [Environment Variables](#environment-variables)
8. [Slack App Setup](#slack-app-setup)
9. [Local Development](#local-development)
10. [Adding a New Tool](#adding-a-new-tool)
11. [Testing](#testing)
12. [Deployment](#deployment)
13. [Roadmap](#roadmap)

---

## What's New in v2

| Capability | v1 | v2 |
| --- | --- | --- |
| **Distribution** | Single workspace (hard-coded `SLACK_BOT_TOKEN`) | **Multi-tenant OAuth — anyone can install to their own workspace via `/slack/install`** |
| Ambiguous tasks | Created immediately (often wrong) | **AI asks a clarifying question first via `[AskClarification]`** |
| Progress tracking | Time-elapsed % only | **Real status enum + AI-estimated 0–100% + summary text** |
| Employee replies | Stored as raw `notCompletedReason` | **AI summarizes into one CEO-readable sentence, status auto-classified** |
| Owner notification | None | **DM + Home Tab + channel card all sync in real time** |
| Pinging cadence | Only when due | **Priority-aware: URGENT pings hourly + 2x daily; LOW once per 8h** |
| Cancel vs delete | Tangled | **`[UpdateTaskStatus] CANCELLED` is the default soft delete; `[DeleteTask]` requires the word "delete"** |
| Languages | English only | **English + 中文 (set via `OWNER_LANGUAGE`); AI auto-mirrors user's language** |
| Codebase | 1 `index.ts` with copy-paste handlers | **Modular: `lib/`, `orchestrator/`, `functions/`, `slack/`, `ui/`, `scheduler/`, `installation/`** |
| Observability | console.log | Structured logger with levels |
| Schema | 1 table, mixed flags | **`Task` + `ProgressUpdate` + `SlackInstallation` (multi-tenant token storage)** |
| Database | Hard-coded Supabase | **Works with any Postgres; Neon recommended (serverless, free tier)** |
| Tests | 2 files | **5 files / 37 tests** |

---

## How It Works

```
        ┌──────────────────────────────────────────────────────┐
        │  CHANNEL: owner @AI COO "ask Luna to ship landing    │
        │           page by Friday EOD, high priority"         │
        └──────────────────────────────────────────────────────┘
                         │
                         ▼
            Orchestrator + system prompt
                         │
       ┌─────────────────┴────────────────┐
       │  Did the owner give title +      │
       │  assignee + due time?            │
       └─────────────────┬────────────────┘
              YES        │        NO
                ▼                  ▼
      [CreateTask]          [AskClarification]
        │                          │
        │                  (owner replies → orchestrator loops back)
        │
        ├── Posts a task card in the channel (with Mark Complete / Modify)
        ├── DMs the assignee with the brief
        ├── DMs the owner with confirmation
        └── Refreshes owner's App Home tab

         ┌────────────────────────────────────────┐
         │  Scheduler runs every 10 minutes       │
         │  → for each non-completed task:        │
         │     - daily 10am check-in?             │
         │     - mid-window check for 4–24h tasks?│
         │     - 30 min before due?               │
         │     - overdue?                         │
         │     → [NudgeProgress] DMs the assignee │
         └────────────────────────────────────────┘
                         │
                         ▼
   ┌────────────────────────────────────────────────┐
   │ DM: assignee replies "got the layout done,     │
   │     waiting on copy from marketing"            │
   └────────────────────────────────────────────────┘
                         │
                         ▼
            Orchestrator → [RecordProgress]
                         │
   ┌─────────────────────┴──────────────────────────┐
   │ AI summarizer interprets reply:                │
   │   status   = BLOCKED                           │
   │   percent  = 65                                │
   │   summary  = "Layout done; waiting on          │
   │               copy from marketing."            │
   │   blocker  = "Copy from marketing"             │
   └─────────────────────┬──────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  DM the owner    Update Home Tab    Update channel card
                  with progress bar  in place
```

---

## Languages

The Home Tab, channel cards, list views, and the AI's spoken language all adapt:

- The **AI orchestrator** mirrors the user's language automatically (English / 中文). If the owner writes in 中文, the bot replies in 中文 and creates cards/dashboards with 中文 labels.
- The **default language** for the Home Tab and rendered cards is set by `OWNER_LANGUAGE` (`en` or `zh`). This is what an employee sees on a button they click, and what the owner sees on their App Home if they haven't yet typed anything in this thread.
- Adding a new language is a 1-file change: extend `COMMON`, `STATUS_LABEL`, and `PRIORITY_BADGE` in [`src/lib/i18n.ts`](src/lib/i18n.ts) and add a new code (e.g. `'ja'`) to `SupportedLanguage`.

## The Tool Catalog

The AI orchestrator is allowed to invoke these tools by emitting `[ToolName] {…json…}` tokens.

| Tool | When | Effect |
| ---- | ---- | ------ |
| `AskClarification` | Owner mentioned the bot but title / assignee / dueTime is missing | Posts a targeted question in the same channel; no DB write |
| `CreateTask` | All required fields are present | Persists the task, posts the card, DMs both parties, refreshes Home tab |
| `UpdateTaskDetails` | Owner wants to change title / assignee / due / priority of an existing task | Updates DB + re-renders the channel card + Home tab |
| `UpdateTaskStatus` | Owner directly sets status (`COMPLETED`, `CANCELLED`, etc.) | Updates DB + re-renders |
| `RecordProgress` | Employee sent a free-form status reply in DM | AI summarizes → updates DB → DMs owner → refreshes Home & card |
| `NudgeProgress` | Scheduler decides it's time, or owner asks "ping X for an update" | DMs the assignee asking for status |
| `ListTasks` | Owner says "show my tasks" / "list" / "what's open" | Posts a card list (with Modify / Delete / Complete buttons) |
| `DeleteTask` | Owner explicitly says "delete X" | Hard-deletes the row (prefer `UpdateTaskStatus: CANCELLED` for soft delete) |

---

## Cadence — When the COO Pings Employees

`shouldNudgeTask()` in [`src/scheduler/cadencePolicy.ts`](src/scheduler/cadencePolicy.ts) is the policy. It's **priority-aware** — the COO behaves like a thoughtful chief of staff, not a robot:

| Priority | Cooldown | Pre-due window | Daily check-in | Mid-window trigger (4–24h tasks) |
| -------- | -------- | -------------- | -------------- | -------------------------------- |
| URGENT 🔴 | 1h | 60 min | 10am + 3pm | At 33% of window if no update in 2h |
| HIGH 🟠 | 2h | 45 min | 10am | At 50% of window if no update in 4h |
| NORMAL 🟡 | 4h | 30 min | 10am | At 50% of window if no update in 6h |
| LOW 🟢 | 8h | 30 min | 10am | At 60% of window if no update in 12h |

Plus, regardless of priority:
- Multi-day tasks (>24h until due) get the daily check-in slot(s) above.
- Short tasks (<4h until due) only get the pre-due window ping.
- Overdue tasks get an `overdue` nudge (subject to the priority cooldown).

A separate scheduler auto-marks the task **BLOCKED** if the assignee doesn't reply within 1 hour of a nudge, and DMs the owner.

All hours / cooldowns are environment-driven; see [Environment Variables](#environment-variables).

---

## Project Structure

```
src/
  ai/
    openaiClient.ts          OpenAI SDK singleton
    prompt.ts                System prompt (decision tree, forbidden behaviors, etc.)
  lib/
    prisma.ts                PrismaClient singleton (cached in global)
    slackClient.ts           WebClient singleton + bot user id helper
    logger.ts                Structured leveled logger
    sendHelpers.ts           buildChannelSender, getConversationKey, buildUserMessagePayload, openDm
  orchestrator/
    functionRegistry.ts      Tool registry + execution context types
    parseAiResponse.ts       Extracts [ToolName] {...json} tokens
    runAiOrchestrator.ts     One-shot AI turn → executes parsed tools
    handleConversationTurn.ts Shared Slack-event → AI-turn pipeline (used by mention/DM/buttons)
    conversationStore.ts     In-memory per-thread message history (TTL-aware)
  functions/
    askClarification.ts      "I need more info" tool
    createTask.ts            Persist task + post card + DM both parties + refresh home
    updateTaskDetails.ts     Mutate title/assignee/due/priority + sync UI
    updateTaskStatus.ts      Set status enum + sync UI
    recordProgress.ts        AI summarizer + status inference + owner notification
    nudgeProgress.ts         Outbound DM asking for status
    listTasks.ts             Render task list
    deleteTask.ts            Hard delete
    index.ts                 Registry wire-up
  scheduler/
    taskReminder.ts          Deadline reminders (per reminderPolicy)
    reminderPolicy.ts        How early to remind based on length until due
    progressCheck.ts         Cadence-driven nudge + 1-hour timeout auto-mark
    cadencePolicy.ts         The "when to nudge" decision function
  services/
    normalizeTask.ts         Title/assignee/time normalization
    aiSummarizer.ts          OpenAI-backed interpretation of employee replies
  slack/
    actions.ts               Block Kit button handlers (mark_complete, edit_start, etc.)
    homeView.ts              Builds the owner's App Home view
    listTasks.ts             Builds the task list message
    taskCardUpdater.ts       Re-renders channel cards & home tab in place
  ui/
    progressBar.ts           Unicode progress bar renderer
    taskCard.ts              Reusable task Block Kit card (channel / list / home variants)
  utils/
    assignee.ts              toSlackMention / extractUserId
  index.ts                   Bolt app entry: receivers, events, schedulers, graceful shutdown

prisma/
  schema.prisma              Task + ProgressUpdate + enums

tests/
  parseAiResponse.test.ts    Bracket-token parser
  cadencePolicy.test.ts      When the scheduler should nudge
  conversationStore.test.ts  Append / cap / evict
  reminderPolicy.test.ts     Lead-time bucketing
  normalizeTask.test.ts      Time + assignee normalization
```

---

## Setup

### Prerequisites
- Node.js 18+
- npm
- A PostgreSQL database — **[Neon](https://neon.tech) recommended** (serverless, free tier, no maintenance)
- A Slack workspace where you can create a custom app
- An OpenAI API key
- ngrok (for local dev)

### Install

```bash
npm install
cp .env.example .env
# fill in SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, OPENAI_API_KEY, DATABASE_URL
npx prisma generate
npx prisma db push
```

The `prisma db push` step creates the v2 schema (new `TaskStatus`/`TaskPriority` enums, new `ProgressUpdate` table, new columns).

### Setting up Neon as your database

1. Sign in at [neon.tech](https://neon.tech) → **Create project**. Pick a region close to where the bot is hosted.
2. After creation, copy the **direct** connection string from the dashboard. It looks like:
   ```
   postgresql://<user>:<password>@ep-cool-bird-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
3. Paste it into your `.env` as `DATABASE_URL=...`.
4. Run `npx prisma db push` once — this provisions the schema in Neon.
5. (Optional) In the Neon dashboard, enable **autoscaling** and set **suspend after** = 5 min for the free tier. The bot will reconnect on the next query.

If you want pooled connections (e.g. you scale to multiple replicas later), Neon also exposes a `…-pooler.neon.tech` URL. Add `?sslmode=require&pgbouncer=true&connect_timeout=15` to it. For a single bot instance the direct connection is simpler and faster.

### Migrating from Supabase → Neon (preserving data)

If you already had data in Supabase and want to move it to Neon:

```bash
# 1. Dump the existing Supabase database (schema + data)
pg_dump --no-owner --no-acl --clean --if-exists \
  "postgresql://postgres:<old-supabase-pass>@db.<ref>.supabase.co:5432/postgres" \
  > supabase-dump.sql

# 2. Restore into the new Neon database
psql "postgresql://<neon-user>:<neon-pass>@<neon-host>.neon.tech/<db>?sslmode=require" \
  < supabase-dump.sql

# 3. Update .env DATABASE_URL to the Neon connection string
# 4. Re-run prisma to make sure the schema matches:
npx prisma db push
```

If you do **not** care about preserving old data (recommended for v1 → v2), just point `DATABASE_URL` at a fresh Neon database and run `npx prisma db push`.

### Migration note when upgrading v1 → v2 (in-place)
v1 tasks did not have `status` / `priority` / `progressPercent` / `description` / `channelMessageTs`. The new schema defaults handle this: all existing rows will be backfilled to `status=NOT_STARTED, priority=NORMAL, progressPercent=0`. If you want already-completed rows to reflect their state, run once after `prisma db push`:

```sql
UPDATE "Task" SET status = 'COMPLETED', "progressPercent" = 100
  WHERE completed = TRUE;
```

---

## Environment Variables

See [`.env.example`](./.env.example) for the full list. The required ones:

```
PORT=3000
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://user:password@host:5432/postgres
```

The interesting tunable ones:

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OPENAI_MODEL` | `gpt-4.1` | Model used for orchestrator decisions |
| `OPENAI_SUMMARY_MODEL` | `gpt-4.1-mini` | Model used to summarize employee replies |
| `PROGRESS_NUDGE_HOUR` | `10` | Hour (server local) for the daily check-in |
| `PROGRESS_NUDGE_CRON` | `*/10 * * * *` | How often the cadence scheduler ticks |
| `MIN_NUDGE_INTERVAL_MS` | `14400000` (4h) | Cooldown between two nudges for the same task |
| `CONVERSATION_HISTORY_LIMIT` | `40` | Messages kept per thread for AI context |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## Slack App Setup (multi-tenant / distribution mode)

> v2 runs in **OAuth distribution** mode. You configure ONE Slack App, and any workspace can install it via `https://<your-domain>/slack/install`. There is no per-workspace bot token to copy.

### 1. Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Name it (e.g. "AI COO"), pick any development workspace.

### 2. Bot Token Scopes

**OAuth & Permissions** → **Scopes** → **Bot Token Scopes**. Add:

- `app_mentions:read`
- `chat:write`
- `chat:write.public`
- `im:history`
- `im:read`
- `im:write`
- `users:read`

(No User Token Scopes are needed.)

### 3. OAuth Redirect URL

Still on **OAuth & Permissions** → **Redirect URLs** → **Add New Redirect URL**:

```
https://<your-domain>/slack/oauth_redirect
```

For local dev with ngrok, this is `https://<ngrok-id>.ngrok-free.app/slack/oauth_redirect`. Save.

### 4. Event Subscriptions

**Event Subscriptions** → enable.

- **Request URL**: `https://<your-domain>/slack/events`
- **Subscribe to bot events**: `app_mention`, `message.im`, `app_home_opened`, `app_uninstalled`

Save.

### 5. Interactivity & Shortcuts

**Interactivity & Shortcuts** → enable.

- **Request URL**: `https://<your-domain>/slack/events`

Save.

### 6. App Home

**App Home** → enable the **Home Tab**. (Optional: disable the Messages tab if you don't want users typing arbitrary DMs.)

### 7. Manage Distribution (this is what creates the install link)

**Manage Distribution** → review the checklist Slack shows you:

- ✅ Remove hard-coded information (the redirect URL above is dynamic)
- ✅ OAuth redirect URLs configured (step 3)
- Once green, click **Activate Public Distribution**.

After activation, the **Sharable URL** Slack shows is just for the embedded "Add to Slack" button. **The real install entrypoint for your bot is your own server's `/slack/install` URL**, which renders a friendly landing page and then hands off to Slack's OAuth flow.

### 8. Copy credentials into `.env`

From **Basic Information** → **App Credentials**:

- `Client ID`        → `SLACK_CLIENT_ID`
- `Client Secret`    → `SLACK_CLIENT_SECRET`
- `Signing Secret`   → `SLACK_SIGNING_SECRET`

Generate a state secret yourself (used to sign the OAuth state param):

```bash
openssl rand -hex 32
```

Paste that as `SLACK_STATE_SECRET`.

Also set `BASE_URL` to your public HTTPS URL (e.g. `https://abcd-1234.ngrok-free.app`).

### 9. Share with your friends 🎉

The install link you give them is:

```
<BASE_URL>/slack/install
```

When they click it:
1. They land on a friendly "Add to Slack" page.
2. They click → Slack asks them to authorize the bot for one of their workspaces.
3. Slack redirects to `<BASE_URL>/slack/oauth_redirect` with a code.
4. The bot exchanges the code for a bot token and stores it in the `SlackInstallation` Neon table.
5. They see a "🎉 You're all set!" page.
6. The bot is now live in their workspace. They invite it to a channel and `@AI COO` away.

Each workspace has its own bot token in the database. Tasks, progress updates, and Home Tab are all team-scoped.

---

## Local Development

```bash
# 1. Install deps + push schema
npm install
npx prisma db push

# 2. Dev server (auto-reload via nodemon + ts-node)
npm run dev

# 3. In another terminal, expose port 3000
ngrok http 3000
```

Update Slack's Request URLs with the ngrok HTTPS endpoint. Then in Slack:

```
@AI COO ask <@Luna> to draft the Q4 plan by Friday EOD, high priority
```

You should see:
- A task card in the channel with status, due, priority, and progress bar
- A DM to Luna with the brief
- A DM to you confirming creation
- Your App Home tab repopulates within seconds

If you say only `@AI COO draft Q4 plan`, the bot will reply asking for the assignee and due time **before** creating anything.

---

## Adding a New Tool

1. Create a file in `src/functions/`, e.g. `bookMeeting.ts`:

   ```ts
   import { RegisteredFunction } from '../orchestrator/functionRegistry';

   export function bookMeetingFunction(): RegisteredFunction {
     return {
       name: 'BookMeeting',
       description: 'Schedule a 30-min meeting in Google Calendar.',
       inputExample: '{"title":"Roadmap sync","attendees":["<@U1>","<@U2>"],"when":"tomorrow 10am"}',
       handler: async (args, context) => {
         // ... validate, call integrations, await context.slack.send(...), return result
         return { status: 'success', message: 'Booked.', data: { eventId: '...' } };
       },
     };
   }
   ```

2. Register it in `src/functions/index.ts`:

   ```ts
   registry.register(bookMeetingFunction());
   ```

3. (Optional, recommended) Add a hint to the system prompt in `src/ai/prompt.ts` so the AI knows when to use it.

The new tool auto-appears in the tool catalog the AI is shown.

---

## Testing

```bash
npm test
```

5 test files, 32 tests covering: AI response parsing, scheduler cadence policy, conversation store, reminder lead-time policy, and task normalization.

Integration tests against real Slack/OpenAI are intentionally **not** included — they require live credentials. For local dry-runs, set `LOG_LEVEL=debug` and watch the structured logs.

---

## Deployment

- Any Node host works (Render, Railway, Fly.io, AWS, Heroku).
- Set all required env vars (see [Environment Variables](#environment-variables)).
- Use `npm run build && npm start` for production (compiles TS to `dist/`).
- The schedulers run in-process. If you scale to multiple replicas, run schedulers on **exactly one** instance (e.g. via a leader lock or a singleton worker process) to avoid duplicate nudges.
- The conversation store is in-memory; restarting the app drops short-term context. For multi-replica deployments, swap `ConversationStore` for a Redis-backed implementation.

---

## Roadmap

- [ ] Persist conversation history to Postgres or Redis (multi-replica safety)
- [ ] Slash commands (`/coo new task ...`) for keyboard-driven flows
- [ ] Recurring tasks (`every Monday`, `daily standup`)
- [ ] Subtasks + dependency graph (block X until Y)
- [ ] Weekly exec digest DM (auto-generated)
- [ ] Calendar / Notion / Jira integrations
- [ ] Workspace-level priority / OKR awareness in the prompt
- [ ] Per-employee timezone-aware nudges
- [ ] Audit export of `ProgressUpdate` log

---

Built as an operations teammate, not a glorified to-do bot. Teach it new playbooks with prompts, give it new tools with functions, and it will execute on the owner's behalf.
