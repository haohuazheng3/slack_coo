import { Task, TaskPriority, TaskStatus, PrismaClient } from '@prisma/client';
import { anthropic, extractText, PRIMARY_MODEL } from '../ai/anthropic';
import { createLogger } from '../lib/logger';

const log = createLogger('OpsJudge');

const MIN = 60 * 1000;
const HR = 60 * MIN;

/**
 * The shapes the judge can return for a task. Mirrors the only mechanisms the
 * product is allowed to use (per the red lines): ask the assignee, tell the owner
 * the bare facts of silence, or do nothing.
 *
 * Note the absence of anything like "mark blocked" or "auto-fail" — judgment about
 * the employee always stays with the owner. We surface facts; we never grade.
 */
export type OpsAction =
  | 'progress_check'        // DM the assignee asking how it's going (warm, low-friction)
  | 'deadline_heads_up'     // DM the assignee, same channel but explicitly flagging the deadline
  | 'surface_silence'       // DM the owner with bare facts about how long the assignee has been silent
  | 'wait';                 // do nothing this tick

/**
 * The text the judge wrote for whoever the message is for, in the workspace's
 * natural language. We render this into a Slack block on the executor side; no
 * hardcoded English labels live downstream.
 */
export type OpsMessage = {
  /** First line / title. Short and concrete. */
  headline: string;
  /** Multi-line markdown body. The judge writes facts, never judgment. */
  body: string;
};

export type OpsDecision = {
  taskId: string;
  action: OpsAction;
  /** Short reason the AI gave — logged for auditability, not shown to humans. */
  rationale: string;
  /** Present iff action !== 'wait'. Already in the workspace's natural language. */
  message?: OpsMessage;
};

type TaskSnapshot = {
  taskId: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  status: TaskStatus;
  progressPercent: number;
  assignee: string;
  initiator: string;
  createdIso: string;
  dueIso: string;
  hoursUntilDue: number;
  hoursSinceCreated: number;
  hoursSinceLastProgress: number | null;
  hoursSinceLastNudge: number | null;
  hoursSinceProgressPing: number | null;
  hoursSinceSilenceAlert: number | null;
  lastProgressSummary?: string | null;
  recentHistory: Array<{ atIso: string; source: string; note?: string }>;
  assigneeOpenTaskLoad: number;
};

type JudgeContext = {
  prisma: PrismaClient;
  now: Date;
};

/**
 * Cheap, mechanical pre-filter — its ONLY job is to drop tasks where, by basic
 * arithmetic, nothing could have changed since the last tick. This isn't a judgment
 * about the employee, it's a cost gate: don't pay LLM tokens to be told "wait" on a
 * task that we touched 2 minutes ago and where nothing is due for another 5 days.
 *
 * If you're tempted to put real product logic in here ("priority X should fire at Y"),
 * STOP — that's exactly the hardcoded-rule pattern this whole module exists to replace.
 * Put it in the LLM's hands.
 */
function couldSomethingHaveChanged(task: Task, now: Date): boolean {
  if (
    task.status === 'COMPLETED' ||
    task.status === 'CANCELLED' ||
    task.status === 'FAILED' ||
    task.status === 'PENDING_CLARIFICATION'
  ) {
    return false;
  }

  const nowMs = now.getTime();
  const dueMs = task.time.getTime();
  const msUntilDue = dueMs - nowMs;

  // Skip wildly overdue tasks (>14 days past) — assume the owner has moved on; we'd
  // just be noise. Owner can re-engage explicitly.
  if (msUntilDue < -14 * 24 * HR) return false;

  // If we touched this task very recently (any signal in the last 20 min), skip — the
  // LLM would just say "wait, you already did something." Cheap dedup.
  const lastTouchMs = Math.max(
    task.lastNudgeAt?.getTime() ?? 0,
    task.lastProgressAt?.getTime() ?? 0,
    task.lastSilenceAlertAt?.getTime() ?? 0,
    task.progressPingSentAt?.getTime() ?? 0
  );
  if (lastTouchMs && nowMs - lastTouchMs < 20 * MIN) return false;

  // Far-future task with a recent (last 24h) progress signal — nothing's brewing.
  if (msUntilDue > 5 * 24 * HR && task.lastProgressAt && nowMs - task.lastProgressAt.getTime() < 24 * HR) {
    return false;
  }

  return true;
}

async function buildTaskSnapshot(task: Task, ctx: JudgeContext): Promise<TaskSnapshot> {
  const nowMs = ctx.now.getTime();
  const recent = await ctx.prisma.progressUpdate.findMany({
    where: { taskId: task.id },
    orderBy: { createdAt: 'desc' },
    take: 4,
  });

  const assigneeOpenTaskLoad = await ctx.prisma.task.count({
    where: {
      assignee: task.assignee,
      teamId: task.teamId,
      enterpriseId: task.enterpriseId,
      status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED', 'PENDING_CLARIFICATION'] },
    },
  });

  const hours = (ms: number) => Math.round((ms / HR) * 10) / 10;

  return {
    taskId: task.id,
    title: task.title,
    description: task.description ?? undefined,
    priority: task.priority,
    status: task.status,
    progressPercent: task.progressPercent,
    assignee: task.assignee,
    initiator: task.initiator || task.createdBy,
    createdIso: task.createdAt.toISOString(),
    dueIso: task.time.toISOString(),
    hoursUntilDue: hours(task.time.getTime() - nowMs),
    hoursSinceCreated: hours(nowMs - task.createdAt.getTime()),
    hoursSinceLastProgress: task.lastProgressAt ? hours(nowMs - task.lastProgressAt.getTime()) : null,
    hoursSinceLastNudge: task.lastNudgeAt ? hours(nowMs - task.lastNudgeAt.getTime()) : null,
    hoursSinceProgressPing: task.progressPingSentAt ? hours(nowMs - task.progressPingSentAt.getTime()) : null,
    hoursSinceSilenceAlert: task.lastSilenceAlertAt ? hours(nowMs - task.lastSilenceAlertAt.getTime()) : null,
    lastProgressSummary: task.lastProgressSummary,
    recentHistory: recent
      .slice()
      .reverse()
      .map((p) => ({
        atIso: p.createdAt.toISOString(),
        source: p.source,
        note: (p.summary ?? p.rawText ?? '').slice(0, 160) || undefined,
      })),
    assigneeOpenTaskLoad,
  };
}

const JUDGE_SYSTEM_PROMPT = `You decide, for each active task, what the bot should do RIGHT NOW. You are NOT a scheduling rule engine — you read the whole situation and pick the move a thoughtful chief of staff would pick.

For each task in the input, return ONE of these actions:

- "progress_check"     — DM the assignee asking how it's going. Use when meaningful time has passed since we last heard from them AND the deadline is close enough to matter, but it's not yet "deadline is right around the corner" urgency. Treat this as a warm "hey, how's it going" — not a deadline alarm.
- "deadline_heads_up"  — DM the assignee, explicitly flagging the deadline. Use when the deadline is close enough that they need to feel it (you decide what "close" means based on the task — a 1-hour task feels different from a 7-day task) AND we haven't reminded them about THIS deadline yet (lastNudge within the same proximity window means we already did).
- "surface_silence"    — DM the owner with bare facts about how long the assignee has been silent after our last ping. Use ONLY when: (a) we sent a progressPing and the assignee has not replied since; (b) the duration of silence is meaningful given the deadline pressure and the assignee's normal pattern; (c) we have not surfaced this same silence window already (hoursSinceSilenceAlert is null or large). Be a scalpel, not a hammer. If you'd be annoying the owner with a vague "no reply yet" on a task that isn't urgent, choose "wait".
- "wait"               — default. Pick this whenever you're not sure. Doing nothing this tick is almost never wrong. A wrong action is far worse than a missed tick.

Rules you must respect:
1. FACTS ONLY. Your rationale and any message text must never characterize the employee ("slow", "behind", "concerning", "probably stalling"). State observable facts only. If you catch yourself wanting to judge, switch to "wait".
2. NEVER repeatedly nudge for the same window. If hoursSinceLastNudge or hoursSinceProgressPing is small (< a few hours for short tasks, < a day for week-long tasks — you judge), default to "wait".
3. NEVER stack: if the assignee has many other open tasks (assigneeOpenTaskLoad high) AND this task isn't time-critical, lean toward "wait" — don't pile on.
4. If progressPercent is already 100 or status is terminal-looking, pick "wait".

LANGUAGE OF MESSAGE TEXT — this is critical. For any decision that is NOT "wait", produce a "message" object with:
- "headline": a short, concrete first line.
- "body": a few short markdown lines. Use Slack mrkdwn (e.g. *bold*, line breaks). Include the relevant facts (task title, deadline, what we know so far). End with a low-friction invitation — for progress_check / deadline_heads_up it's "one-liner is fine, I'll handle the rest"; for surface_silence it's "want me to nudge, or will you?".

Write headline + body in the SAME LANGUAGE as the natural-language samples in the snapshot (look at title, lastProgressSummary, recentHistory.note — those reflect how this workspace talks). If everything is in 中文, write in 中文. If in English, English. If mixed or unclear, mirror the task title's language. DO NOT default to English just because this prompt is in English. The bot is invisible only when it sounds like a co-worker — and a co-worker speaks the team's language.

For "wait" decisions, omit "message" entirely.

Output a JSON object with this exact shape (your schema will enforce it):
{ "decisions": [ { "taskId": "...", "action": "progress_check|deadline_heads_up|surface_silence|wait", "rationale": "one short sentence (for logs, not humans)", "message"?: { "headline": "...", "body": "..." } }, ... ] }

The decisions array must contain exactly one entry per input task, in the same order.`;

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          action: {
            type: 'string',
            enum: ['progress_check', 'deadline_heads_up', 'surface_silence', 'wait'],
          },
          rationale: { type: 'string' },
          message: {
            type: 'object',
            properties: {
              headline: { type: 'string' },
              body: { type: 'string' },
            },
            required: ['headline', 'body'],
            additionalProperties: false,
          },
        },
        required: ['taskId', 'action', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
};

/**
 * Decide what (if anything) the bot should do for each task right now.
 * Returns one decision per input task. Does NOT execute anything — the caller
 * (the scheduler) is responsible for taking action.
 *
 * Batches all tasks for a workspace into a single Anthropic call.
 */
export async function judgeTasks(
  tasks: Task[],
  ctx: JudgeContext
): Promise<OpsDecision[]> {
  const candidates = tasks.filter((t) => couldSomethingHaveChanged(t, ctx.now));
  if (candidates.length === 0) return [];

  const snapshots = await Promise.all(candidates.map((t) => buildTaskSnapshot(t, ctx)));

  let parsed: { decisions?: any[] };
  try {
    const response = await anthropic.messages.create({
      model: PRIMARY_MODEL,
      max_tokens: 8000,
      system: [
        {
          type: 'text',
          text: JUDGE_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            nowIso: ctx.now.toISOString(),
            tasks: snapshots,
          }),
        },
      ],
      output_config: {
        format: { type: 'json_schema', schema: DECISION_SCHEMA },
      },
    } as any);
    const text = extractText(response);
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn('opsJudge LLM call failed — choosing safe default (wait everywhere)', {
      error: String(err),
      taskCount: candidates.length,
    });
    return candidates.map((t) => ({
      taskId: t.id,
      action: 'wait' as const,
      rationale: 'judge_unavailable',
    }));
  }

  const byId = new Map<string, OpsDecision>();
  for (const d of parsed.decisions ?? []) {
    if (!d?.taskId || !d?.action) continue;
    const action: OpsAction = ['progress_check', 'deadline_heads_up', 'surface_silence', 'wait'].includes(
      d.action
    )
      ? (d.action as OpsAction)
      : 'wait';
    const message: OpsMessage | undefined =
      d.message && typeof d.message.headline === 'string' && typeof d.message.body === 'string'
        ? {
            headline: d.message.headline.trim().slice(0, 200),
            body: d.message.body.trim().slice(0, 1500),
          }
        : undefined;
    byId.set(d.taskId, {
      taskId: d.taskId,
      action,
      rationale: (d.rationale ?? '').slice(0, 240),
      message: action === 'wait' ? undefined : message,
    });
  }

  return candidates.map(
    (t) =>
      byId.get(t.id) ?? {
        taskId: t.id,
        action: 'wait' as const,
        rationale: 'missing_in_judge_output',
      }
  );
}
