# Slack AI COO (MVP) — End-to-End Step-by-Step Guide

Turn a single sentence in Slack into an **actionable workflow**:

> Manager speaks → LLM parses → Task is stored → Scheduler reminds → Slack card (Complete/Delay) → DB update → (Next: Daily/Weekly reports)

This README is **copy‑paste ready**. Follow it linearly. Every step is explicit and ordered to eliminate guesswork.

---

## Table of Contents

1. [What This MVP Does](#what-this-mvp-does)
2. [Tech Stack](#tech-stack)
3. [High-Level Architecture](#high-level-architecture)
4. [Repository Structure](#repository-structure)
5. [Prerequisites](#prerequisites)
6. [Security First (.env & .gitignore)](#security-first-env--gitignore)
7. [Step 1 — Clone & Install](#step-1--clone--install)
8. [Step 2 — Create & Configure Your Slack App](#step-2--create--configure-your-slack-app)
9. [Step 3 — Environment Variables](#step-3--environment-variables)
10. [Step 4 — Database (Supabase + Prisma)](#step-4--database-supabase--prisma)
11. [Step 5 — Run Locally (Nodemon + Ngrok)](#step-5--run-locally-nodemon--ngrok)
12. [Step 6 — End-to-End Test](#step-6--end-to-end-test)
13. [Step 7 — Scheduled Reminders (node-cron)](#step-7--scheduled-reminders-node-cron)
14. [Step 8 — Interactive Actions (Complete / Delay)](#step-8--interactive-actions-complete--delay)
15. [Troubleshooting & Pitfalls](#troubleshooting--pitfalls)
16. [Deploy to Railway/Render](#deploy-to-railwayrender)
17. [Push to GitHub (Safe & Repeatable)](#push-to-github-safe--repeatable)
18. [Team Onboarding Checklist](#team-onboarding-checklist)
19. [Extensibility: Next Milestones](#extensibility-next-milestones)
20. [License](#license)

---

## What This MVP Does

* **Listen in Slack** for `@mentions` to the bot.
* **Parse natural language** into a structured task via an LLM (e.g., OpenAI GPT).
  Example → "Tomorrow 9am remind me to discuss progress with Alex" → `{ title, time, assignee, channelId, createdBy }`.
* **Store tasks** in **PostgreSQL** (Supabase) via **Prisma ORM**.
* **Every minute**, find tasks whose time falls in a window (±1 min) and **post a reminder card** in Slack.
* The card includes buttons: **Complete ✅**, **Delay 15m**, **Delay 1h**.
* Clicking a button **acks** within 3 seconds, **updates DB**, and sends an **ephemeral** confirmation to the clicker.

---

## Tech Stack

* **TypeScript + Node.js**
* **Express + @slack/bolt** (events webhook, interactive actions)
* **node-cron** (scheduler)
* **OpenAI (or Claude) API** for task parsing
* **Supabase (PostgreSQL) + Prisma ORM** for persistence
* **Ngrok** for local public tunneling
* **Railway / Render** for production deployment (optional in MVP)

---

## High-Level Architecture

```
Slack @YourBot → (Event: app_mention) → Bolt/Express receiver (/slack/events)
  → LLM parses text → { title, time, assignee, channelId, createdBy }
  → Prisma stores Task
  → node-cron (every 1 min): find due tasks (time ∈ [now-1m, now+1m] & completed=false)
    → Slack posts Block Kit card (Complete / Delay 15m / Delay 1h)
      → user clicks button → app.action(...) → ack() within 3s
        → Prisma updates (completed=true or time+=15m/60m)
        → client.chat.postEphemeral() confirmation to clicker
```

---

## Repository Structure

```
src/
  actions/
    taskActions.ts           # Button actions: complete/delay handlers
  db/
    writeTask.ts             # Create task in DB after parsing
  gpt/
    parseTask.ts             # LLM transform: text → structured task JSON
  scheduler/
    taskReminder.ts          # Runs every minute; posts reminder cards
  slack/
    sendMessage.ts           # Plain text messages (generic helper)
    postTaskReminder.ts      # Post Block Kit reminder card
  ui/
    taskCard.ts              # Block Kit UI builder for the reminder card
  utils/
    assignee.ts              # Normalize assignee to <@UXXXX>
  index.ts                   # Entry point (Bolt + ExpressReceiver + cron)
prisma/
  schema.prisma              # Task model definition
.env.example                 # Example env file (no secrets)
.gitignore                   # Ensures .env and other files are not committed
README.md                    # This document
```

---

## Prerequisites

* Node.js **18+** and npm
* A Slack **workspace** where you can create and install apps
* Supabase account & project (PostgreSQL)
* LLM API key (OpenAI or Claude; examples use OpenAI)

---

## Security First (.env & .gitignore)

**Never commit secrets.** Make sure `.gitignore` contains:

```
# Node
node_modules/
dist/
build/
*.log
.DS_Store

# Env
.env
.env.*
!.env.example

# TypeScript
*.tsbuildinfo
```

Create `.env.example` with variable names only (no real tokens):

```
PORT=3000
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
OPENAI_API_KEY=
DATABASE_URL=
SUPABASE_URL=
```

Your real `.env` stays **local** or in your cloud provider as **secrets**.

---

## Step 1 — Clone & Install

```bash
git clone <your-repo-url>
cd <repo-folder>
npm i
```

---

## Step 2 — Create & Configure Your Slack App

1. Go to **[https://api.slack.com/apps](https://api.slack.com/apps)** → **Create New App** → **From scratch**.
2. Choose your Workspace, name the app (e.g., `AI COO`).
3. **OAuth & Permissions → Scopes (Bot Token Scopes)**:

   * Required: `chat:write`, `app_mentions:read`
   * Recommended for later: `users:read`, `commands`
   * Click **Install to Workspace** (top of page) and copy the **Bot User OAuth Token** (looks like `xoxb-...`).
4. **Basic Information**: copy your **Signing Secret**.
5. **Event Subscriptions**:

   * Enable Events: **On**
   * Request URL: will be set to your **ngrok URL** later → `https://<ngrok-id>.ngrok.io/slack/events`
   * **Subscribe to bot events**: add `app_mention`
   * Save
6. **Interactivity & Shortcuts**:

   * Interactivity: **On**
   * Request URL: same as Event Subscriptions → `https://<ngrok-id>.ngrok.io/slack/events`
   * Save

> Bolt’s ExpressReceiver can receive both events and interactive payloads on the same endpoint.

---

## Step 3 — Environment Variables

Create your local `.env` (do **not** commit):

```
PORT=3000
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
OPENAI_API_KEY=...
DATABASE_URL=postgresql://postgres:<YOUR_DB_PASSWORD>@db.<project-ref>.supabase.co:5432/postgres
SUPABASE_URL=<optional-if-used>
```

---

## Step 4 — Database (Supabase + Prisma)

1. Create a **Supabase** project. In **Project Settings → API**, note your project ref and DB password.
2. Set `DATABASE_URL` in `.env` as above.
3. Define your Prisma schema in `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Task {
  id          String   @id @default(cuid())
  title       String
  time        DateTime
  assignee    String    // use Slack user ID or mention string
  channelId   String
  createdBy   String    // Slack user ID who created the task
  createdAt   DateTime  @default(now())
  completed   Boolean   @default(false)
}
```

4. Push the schema to your DB:

```bash
npx prisma db push
```

---

## Step 5 — Run Locally (Nodemon + Ngrok)

1. Start the app locally:

```bash
npx nodemon
```

You should see: `⚡ Slack app is running!`

2. Start **ngrok** in a separate terminal:

```bash
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://<id>.ngrok.io`).

3. Back in **Slack App settings**:

   * **Event Subscriptions → Request URL**: `https://<id>.ngrok.io/slack/events` → Save (Slack must verify OK)
   * **Interactivity & Shortcuts → Request URL**: `https://<id>.ngrok.io/slack/events` → Save

> If Slack cannot verify: ensure your local server is running on PORT=3000 and ngrok targets 3000.

---

## Step 6 — End-to-End Test

In your Slack workspace, in any channel where the bot is present, type:

```
@AI COO  Tomorrow 9am remind me to discuss product progress with Alex
```

Expect in your server logs:

* Parsed task JSON
* `✅ Task saved` (Prisma → Supabase)

At the task time (±1 minute), the channel will receive a **Block Kit reminder card**.
Click **Complete** or **Delay** and verify:

* You receive an **ephemeral** confirmation.
* DB reflects `completed=true` or a new `time` (+15m or +60m).

---

## Step 7 — Scheduled Reminders (node-cron)

* The scheduler runs every minute and checks for tasks with `time` within `[now-1m, now+1m]` and `completed=false`.
* It posts the reminder card via `chat.postMessage` using your **Block Kit** builder.
* To avoid duplicates in the future, you can add fields like `notifiedAt` or `remindCount` (not required for MVP).

---

## Step 8 — Interactive Actions (Complete / Delay)

* Buttons carry `action_id`s: `task_complete`, `task_delay_15m`, `task_delay_60m`.
* `app.action(...)` handlers **must call `ack()`** within 3 seconds.
* On success, update Prisma, then send an ephemeral confirmation via `client.chat.postEphemeral`.

---

## Troubleshooting & Pitfalls

**Request URL verification fails**

* Local app not running; ngrok not started or wrong port.
* URL must be `https://<id>.ngrok.io/slack/events` and publicly reachable.

**Button clicks do nothing**

* Missing `ack()`; Slack retries if no ack within 3 seconds.
* Interactivity disabled or wrong URL.
* Your `app.action('...')` handlers are not registered before `app.start()`.

**Mentions show incorrectly**

* Normalize `assignee` to `<@UXXXX>` before rendering. Use a helper like `toSlackMention()` that extracts a Slack user ID.

**Time zones**

* DB stores UTC. UI currently uses `toLocaleString()`; switch to a timezone-aware formatter later.

**Repeat reminders**

* Current strategy is a ±1 minute window. Add `notifiedAt`/`remindCount` fields if you need strict de-duplication.

**Missing permissions**

* Ensure `chat:write` and `app_mentions:read` are in **Bot Token Scopes** and the app is **reinstalled** after scope changes.

---

## Deploy to Railway/Render

> Replace ngrok with a permanent cloud URL and update Slack settings accordingly.

### Railway (example)

1. Create a Railway project from your GitHub repo.
2. Railway detects Node; set **Variables (ENV)**:

   * `PORT=3000`
   * `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `OPENAI_API_KEY`, `DATABASE_URL`
3. Deploy; get a public domain (e.g., `https://yourapp.up.railway.app`).
4. In Slack App settings:

   * **Event Subscriptions / Interactivity** → `https://yourapp.up.railway.app/slack/events` → Save
5. Invite the bot to your channels and test again (no ngrok needed).

### Render (alternative)

1. New → **Web Service** → Connect your repo.
2. Environment → add the same variables as above.
3. Deploy → get public URL → update Slack URLs → test.

**Notes**

* Always store secrets in the cloud provider’s environment settings (never commit them).
* Check logs in Railway/Render if Slack verification or runtime requests fail.

---

## Push to GitHub (Safe & Repeatable)

> If you have already pushed once, follow only the **Commit & Push** part.

### One-time setup

```bash
git init -b main            # or: git init && git checkout -b main
git remote add origin https://github.com/<you>/<repo>.git
```

### Ensure `.env` is ignored

`.gitignore` must include `.env`. If you accidentally added it:

```bash
git rm --cached .env
```

### Commit & Push

```bash
git add -A
git commit -m "docs: add full English README and deployment guide"
git push -u origin main
```

### If you accidentally pushed secrets

1. **Rotate** the leaked tokens in Slack/OpenAI/Supabase immediately.
2. Rewrite history to remove files (e.g., with `git filter-repo` or BFG) and force-push.
3. Document the rotation in your internal notes.

### Optional: tags & releases

```bash
git tag v0.2.0
git push origin v0.2.0
```

Create a GitHub Release from this tag with change notes.

---

## Team Onboarding Checklist

1. Clone repo → `npm i`.
2. Copy `.env.example` → `.env`, fill values.
3. `npx prisma db push`.
4. `npx nodemon` (see `⚡ Slack app is running!`).
5. `ngrok http 3000` and update Slack URLs.
6. In Slack: `@AI COO  Tomorrow 9am remind me to ...`.
7. At the time window, check the reminder card → click Complete/Delay.
8. Verify ephemeral confirmation and DB updates.

---

## Extensibility: Next Milestones

* **Daily rollups** (6pm): summarize completed/overdue/tomorrow’s plan → post to a leader channel.
* **Weekly reports**: aggregate by assignee, team, labels.
* **Owners & labels**: multiple assignees; task categories.
* **Advance reminders**: e.g., 15m before; configurable windows.
* **De-dup**: add `notifiedAt`/`remindCount` to enforce once-only reminders.
* **Connectors**: Notion, Google Calendar, Jira, email digests.
* **Observability**: structured logs, audit tables.

---

## License

Choose one:

* **MIT** (open source), or
* proprietary (private)
