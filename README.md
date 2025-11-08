# Slack AI COO — AI-Orchestrated Operations Copilot

This project turns a Slack mention into a fully AI-driven operations workflow. Instead of hard-coded pipelines, the AI chooses which automation tools to run, when to run them, and how to respond back to the human. Prompts train the assistant like an operator; functions give it the equipment it can use on demand.

---

## Table of Contents

1. [Key Capabilities](#key-capabilities)
2. [Architecture Overview](#architecture-overview)
3. [AI Orchestration Flow](#ai-orchestration-flow)
4. [Tool Catalog](#tool-catalog)
5. [Project Structure](#project-structure)
6. [Prerequisites](#prerequisites)
7. [Environment Variables](#environment-variables)
8. [Slack App Setup](#slack-app-setup)
9. [Local Development](#local-development)
10. [Monitoring Tool Invocations](#monitoring-tool-invocations)
11. [Adding New Tools](#adding-new-tools)
12. [Testing](#testing)
13. [Deployment Notes](#deployment-notes)
14. [Roadmap Ideas](#roadmap-ideas)

---

## Key Capabilities

- **AI-first command center**: every `@bot` mention or direct message is routed to OpenAI with a structured system prompt that describes the available tools.
- **Bracket-triggered tools**: the assistant can call any registered function by emitting tokens like `[CreateTask]{...}`. No brackets means no automation runs.
- **Unified execution context**: each tool receives Slack + database context, so it can post updates, modify records, and return status in one place.
- **Live observability**: every tool call is logged to the console and echoed in Slack so humans see exactly what the AI is doing.
- **Resilient fallbacks**: if the AI produces invalid JSON payloads or calls an unknown tool, the orchestrator captures the error and keeps the conversation going.
- **Legacy actions retained**: existing button handlers (complete, delay, delete) still work for manual overrides.

---

## Architecture Overview

```
Slack @mention or DM
          │
          ▼
Bolt receiver (app.event / app.message)
          │
          ▼
runAiOrchestrator()
  ├─ build system prompt (ai/prompt.ts)
  ├─ call OpenAI (ai/openaiClient.ts)
  ├─ parse bracket tokens (orchestrator/parseAiResponse.ts)
  ├─ log + notify tool usage
  └─ execute registered handlers (functions/*)
          │
          ▼
Prisma (tasks table), Slack messages, schedulers, etc.
```

Schedulers, reminder cards, and button actions continue to run exactly as before; the difference is that their functions are now callable by the AI itself.

---

## AI Orchestration Flow

1. **Event capture**  
   `app_mention` and Slack direct messages are intercepted in `src/index.ts`. Plain mentions are sanitized to remove the bot mention. Replies share a thread.

2. **Context build**  
   We assemble a `FunctionExecutionContext` containing:
   - Slack client + `send()` helper constrained to the same channel/thread
   - Prisma client for database operations
   - Raw user message text and metadata

3. **Prompt injection**  
   `buildSystemPrompt()` lists every registered tool with purpose and JSON example. It also enforces communication style and tool-calling etiquette (human response first, one tool per line, double-quoted JSON).

4. **Model call**  
   We run `openai.chat.completions.create()` with the system prompt + user message (model: `gpt-4o-mini`, temperature 0.2).

5. **Tool extraction**  
   `extractFunctionCalls()` scans the response for `[ToolName]` tokens followed by JSON blocks. The natural-language portion is kept as `finalReply`.

6. **Execution + logging**  
   For each tool:
   - Log to console with payload preview.
   - Notify Slack: `🤖 AI triggered tool [ToolName]`.
   - Parse JSON payload (if present).
   - Execute the handler from the `FunctionRegistry`.
   - Record success/error metadata for debugging.

7. **Human response**  
   The cleaned natural-language reply is always sent to Slack, even if no tool ran.

---

## Tool Catalog

All tools live in `src/functions/` and are registered via `registerCoreFunctions()`:

| Tool | Description | Example Payload |
| ---- | ----------- | ---------------- |
| `CreateTask` | Normalize and persist a task based on AI-provided details. Posts a confirmation card. | `{"title": "Prepare Q4 forecast", "dueTime": "2025-01-05T14:00:00-05:00", "assignee": "<@U123>"}` |
| `ListTasks` | Show pending/completed/all tasks for the requester using Block Kit. | `{"scope": "completed"}` |
| `DeleteTask` | Permanently remove a task by `taskId`. Notifies channel. | `{"taskId": "clxyz123"}` |
| `UpdateTaskStatus` | Mark a task complete or pending with optional note. | `{"taskId": "clxyz123", "completed": false, "note": "Need more data."}` |

Each handler receives (`args`, `context`) and returns `{ status, message, data? }`. Handlers are responsible for validating inputs and providing user-facing feedback.

---

## Project Structure

```
src/
  actions/              # Slack interactive button handlers (complete, delay, etc.)
  ai/
    openaiClient.ts     # OpenAI SDK client with env-driven API key
    prompt.ts           # System prompt builder for the AI COO
  orchestrator/
    functionRegistry.ts # Tool registration + execution context definitions
    parseAiResponse.ts  # Extracts [Tool] tokens + JSON payloads
    runAiOrchestrator.ts# Core AI decision loop
  functions/
    createTask.ts       # Tool implementations (AI-callable)
    deleteTask.ts
    listTasks.ts
    updateTaskStatus.ts
    index.ts            # Registers the catalog with the FunctionRegistry
  slack/
    listTasks.ts        # Shared Block Kit builders for task listings
  scheduler/
    taskReminder.ts     # Cron-driven reminder sender (unchanged)
  services/
    normalizeTask.ts    # Task normalization logic reused by CreateTask
  db/
    writeTask.ts        # Prisma task persistence helper
  utils/
    assignee.ts         # Slack mention utilities
  index.ts              # Slack Bolt entrypoint, orchestrator wiring, message routing
prisma/
  schema.prisma         # Task model
.env.example            # Sample environment configuration
```

---

## Prerequisites

- Node.js 18+
- npm
- A Slack workspace where you can create/install custom apps
- PostgreSQL database (Supabase recommended)
- OpenAI API key
- ngrok (for local testing)

---

## Environment Variables

Create `.env` (never commit secrets):

```
PORT=3000
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
OPENAI_API_KEY=...
DATABASE_URL=postgresql://postgres:<PASSWORD>@db.<ref>.supabase.co:5432/postgres
```

Optional extras (if you reuse them elsewhere):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, etc.

---

## Slack App Setup

1. Visit [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. In **OAuth & Permissions**, add bot scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`.
3. Install the app and copy:
   - **Bot User OAuth Token** (`SLACK_BOT_TOKEN`)
   - **Signing Secret** (`SLACK_SIGNING_SECRET`)
4. Under **Event Subscriptions**:
   - Enable events.
   - Request URL → later set to `https://<ngrok-id>.ngrok.io/slack/events`.
   - Subscribe to bot events: `app_mention`, `message.im`.
5. Under **Interactivity & Shortcuts**:
   - Enable interactivity.
   - Same request URL.
6. Invite the bot to the channels where you want it to operate.

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Generate Prisma client & sync schema
npx prisma db push

# 3. Start the Dev server with auto-reload
npx nodemon

# 4. Expose locally via ngrok (in a new terminal)
ngrok http 3000
```

Update Slack’s Request URLs with the ngrok HTTPS endpoint, then mention the bot in Slack:

```
@AI COO draft a task to review Q4 forecast with finance tomorrow at 9am PT
```

You should see:
- Slack response from the AI
- Console log: `🤖 AI triggered tool [CreateTask] with payload: ...`
- Slack notification about the triggered tool
- Task card confirming creation

---

## Monitoring Tool Invocations

Every AI-triggered tool generates two signals:

1. **Console log**  
   ```
   🤖 AI triggered tool [CreateTask] with payload: {"title":"..."}
   ```
2. **Slack notification**  
   The bot posts `🤖 AI triggered tool [CreateTask]` in the same thread, so the team sees what automation just ran.

If parsing fails or a tool is unknown, the orchestrator logs an error and records it in `toolResults`.

---

## Adding New Tools

1. Create a file in `src/functions/`, e.g. `scheduleStandup.ts`.
2. Export `RegisteredFunction`:
   ```ts
   import { RegisteredFunction } from '../orchestrator/functionRegistry';

   export function scheduleStandupFunction(): RegisteredFunction {
     return {
       name: 'ScheduleStandup',
       description: 'Book a daily standup meeting in Google Calendar.',
       inputExample: '{"time": "09:30", "attendees": ["<@U123>", "<@U456>"]}',
       handler: async (args, context) => {
         // validate args, call integrations, send Slack updates, return status
       },
     };
   }
   ```
3. Register it in `src/functions/index.ts`:
   ```ts
   registry.register(scheduleStandupFunction());
   ```
4. Update prompt guidance (optional but recommended) so the AI knows when to use the tool.

The tool automatically appears in the system prompt with purpose + example, so the AI can choose it.

---

## Testing

```bash
npm run test
```

> Note: if running inside a restricted sandbox, `vitest` may fail to kill worker processes (EPERM). Re-run locally outside the sandbox to validate.

Future work: add integration tests that mock OpenAI and Slack, verifying consistent tool invocation and DB interactions.

---

## Deployment Notes

- Any Node-friendly host (Render, Railway, Fly.io, AWS) works. Ensure `PORT` matches your host’s expectations.
- Slack request URLs must use your public HTTPS endpoint: `https://yourdomain.com/slack/events`.
- Keep secrets in the host’s environment settings (never commit them).
- When you deploy a new prompt or tool, redeploy the service so the runtime picks up the changes.

---

## Roadmap Ideas

- **Tool execution guardrails**: add allow/deny lists or approvals before certain tools run.
- **Stateful memory**: maintain context across conversations (e.g., current priorities, OKRs).
- **Advanced analytics**: summarize task load, overdue items, or generate weekly exec readouts.
- **External connectors**: integrate Notion, Jira, Google Calendar, HubSpot, or email digests.
- **Observability**: stream tool invocations to a datastore for auditing.
- **Self-healing prompts**: version prompts, capture AI mistakes, and auto-retrain with better instructions.

---

Built to evolve: treat prompts like playbooks and functions like toolboxes. As you teach the AI new procedures, it becomes a real operations teammate.***
