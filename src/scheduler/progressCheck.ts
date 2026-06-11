import cron from 'node-cron';
import { Task } from '@prisma/client';
import { FunctionRegistry } from '../orchestrator/functionRegistry';
import { prisma } from '../lib/prisma';
import { getClientForTeam } from '../lib/slackClient';
import { createLogger } from '../lib/logger';
import { judgeTasks, OpsDecision } from '../orchestrator/opsJudge';
import { refreshOwnerHome } from '../slack/taskCardUpdater';
import { conversationStore } from '../orchestrator/conversationStore';
import { openDm, postMessageWithFeedback } from '../lib/sendHelpers';

const log = createLogger('ProgressCheck');

const ONE_HOUR_MS = 60 * 60 * 1000;
// 20-minute cadence (was 15). 75% of the responsiveness, ~75% of the cost.
// Override with OPS_JUDGE_CRON env var if a workspace needs tighter loops.
const OPS_CRON = process.env.OPS_JUDGE_CRON || '*/20 * * * *';
const CONVERSATION_TTL_CRON = '0 3 * * *';
const CONVERSATION_TTL_MS = 7 * 24 * ONE_HOUR_MS;

/**
 * The operations loop. ONE cron tick:
 *   1. Pulls every active task across every workspace.
 *   2. Groups them by workspace (so we can resolve a Slack client once per workspace).
 *   3. Hands each workspace's batch to opsJudge — the LLM decides per task what to do
 *      AND writes the headline + body in the workspace's natural language.
 *   4. Executes the decisions, posting the LLM-written text verbatim.
 *
 * What this loop is NOT:
 *   - Not a rule engine. No "if priority X and silence > Y hours" logic lives here.
 *   - Not a place to hardcode English (or any other language) labels. If you find
 *     yourself adding a string literal in a specific language to a user-visible
 *     message, STOP — that's the wrong layer. The opsJudge LLM produces text in
 *     the workspace's language; this file just renders structure (buttons, blocks).
 */
export function startProgressCheckScheduler(_registry: FunctionRegistry) {
  cron.schedule(OPS_CRON, async () => {
    try {
      await runOnce();
    } catch (err) {
      log.error('Ops loop tick failed', { error: String(err) });
    }
  });

  cron.schedule(CONVERSATION_TTL_CRON, () => {
    const evicted = conversationStore.evictStale(CONVERSATION_TTL_MS);
    if (evicted > 0) log.info('Evicted stale conversations', { count: evicted });
  });

  log.info('Ops scheduler started', { cron: OPS_CRON });
}

async function runOnce() {
  const tasks = await prisma.task.findMany({
    where: {
      completed: false,
      status: { notIn: ['COMPLETED', 'CANCELLED', 'PENDING_CLARIFICATION'] },
    },
    take: 500,
  });
  if (tasks.length === 0) return;

  const byWorkspace = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = `${t.teamId ?? '-'}|${t.enterpriseId ?? '-'}`;
    const arr = byWorkspace.get(key) ?? [];
    arr.push(t);
    byWorkspace.set(key, arr);
  }

  const now = new Date();

  for (const [, group] of byWorkspace) {
    const sample = group[0];
    const slackClient = await getClientForTeam(sample.teamId, sample.enterpriseId);
    if (!slackClient) {
      log.warn('No Slack client for workspace, skipping batch', {
        teamId: sample.teamId,
        enterpriseId: sample.enterpriseId,
      });
      continue;
    }

    const decisions = await judgeTasks(group, { prisma, now });
    if (decisions.length === 0) continue;

    const byId = new Map(group.map((t) => [t.id, t] as const));
    for (const decision of decisions) {
      const task = byId.get(decision.taskId);
      if (!task) continue;
      if (decision.action === 'wait') continue;
      if (!decision.message) {
        log.warn('Decision had non-wait action but no message — skipping', {
          taskId: task.id,
          action: decision.action,
        });
        continue;
      }

      try {
        await executeDecision(decision, task, slackClient);
      } catch (err) {
        log.error('Failed to execute ops decision', {
          taskId: task.id,
          action: decision.action,
          error: String(err),
        });
      }
    }
  }
}

async function executeDecision(decision: OpsDecision, task: Task, slackClient: any) {
  switch (decision.action) {
    case 'progress_check':
    case 'deadline_heads_up':
      await dmAssignee(decision, task, slackClient);
      break;
    case 'surface_silence':
      await dmOwnerAboutSilence(decision, task, slackClient);
      break;
  }
}

async function dmAssignee(decision: OpsDecision, task: Task, slackClient: any) {
  const dmChannel = await openDm(slackClient, task.assignee);
  if (!dmChannel) {
    log.warn('Could not open DM with assignee', { taskId: task.id, assignee: task.assignee });
    return;
  }

  const { headline, body } = decision.message!;

  // Routine progress_check DMs render the body alone — no bolded headline, no
  // widget shape. For deadline_heads_up, the LLM may provide a headline; we
  // render it bold on its own line so it scans. Buttons appear only on
  // deadline_heads_up (one-tap matters there); routine check-ins let the
  // assignee reply naturally.
  const isRoutine = decision.action === 'progress_check';
  const renderedText = isRoutine || !headline ? body : `*${headline}*\n${body}`;

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: renderedText } },
  ];
  if (!isRoutine) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅' },
          style: 'primary',
          action_id: 'progress_task_completed',
          value: task.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '⛔' },
          action_id: 'progress_task_blocked',
          value: task.id,
        },
      ],
    });
  }

  await postMessageWithFeedback(slackClient, {
    channel: dmChannel,
    text: headline || body.slice(0, 80),
    blocks,
  });

  const now = new Date();
  await prisma.task.update({
    where: { id: task.id },
    data: { lastNudgeAt: now, progressPingSentAt: now },
  });
  await prisma.progressUpdate.create({
    data: {
      taskId: task.id,
      source: 'system',
      summary: `${decision.action} sent — ${decision.rationale}`,
      progressPercent: task.progressPercent,
      statusAtTime: task.status,
    },
  });

  // Tag the DM conversation so the next employee reply lands in the right task.
  const convKey = `DM:${dmChannel}`;
  conversationStore.append(convKey, {
    role: 'assistant',
    content: `ToolResult: ${JSON.stringify({
      name: 'NudgeProgress',
      data: { taskId: task.id, title: task.title, assignee: task.assignee },
    })}`,
  });

  log.info('Sent assignee DM', { taskId: task.id, action: decision.action, rationale: decision.rationale });
}

async function dmOwnerAboutSilence(decision: OpsDecision, task: Task, slackClient: any) {
  const ownerId = task.initiator || task.createdBy;
  if (!ownerId) return;

  const dm = await openDm(slackClient, ownerId);
  if (!dm) return;

  const { headline, body } = decision.message!;

  await postMessageWithFeedback(slackClient, {
    channel: dm,
    text: headline,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${headline}*\n${body}` },
      },
      {
        type: 'actions',
        elements: [
          // Action IDs are matched server-side; labels are emoji-only so they
          // read across any language without us choosing one. The body text
          // (produced by the LLM in the workspace language) tells the owner
          // what each button does — buttons just need to be tappable.
          {
            type: 'button',
            text: { type: 'plain_text', text: '👋' },
            style: 'primary',
            action_id: 'silence_nudge_assignee',
            value: task.id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🙋' },
            action_id: 'silence_owner_handles',
            value: task.id,
          },
        ],
      },
    ],
  });

  await prisma.task.update({
    where: { id: task.id },
    data: { lastSilenceAlertAt: new Date() },
  });

  await prisma.progressUpdate.create({
    data: {
      taskId: task.id,
      source: 'system',
      summary: `Surfaced silence to owner. ${decision.rationale}`,
      statusAtTime: task.status,
      progressPercent: task.progressPercent,
    },
  });

  refreshOwnerHome(slackClient, ownerId).catch(() => undefined);

  log.info('Silence surfaced to owner', {
    taskId: task.id,
    rationale: decision.rationale,
  });
}
