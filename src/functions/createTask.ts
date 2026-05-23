import { TaskPriority } from '@prisma/client';
import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { ParsedTaskInput, normalizeToDBTask } from '../services/normalizeTask';
import { extractUserId, toSlackMention } from '../utils/assignee';
import { prisma } from '../lib/prisma';
import { openDm } from '../lib/sendHelpers';
import {
  syncChannelTaskCard,
  persistChannelMessageTs,
  refreshOwnerHome,
} from '../slack/taskCardUpdater';
import { createLogger } from '../lib/logger';
import { resolveAssignee, ResolvedCandidate } from '../services/nicknameResolver';

const log = createLogger('CreateTask');

type CreateTaskArgs = {
  title: string;
  description?: string;
  dueTime?: string;
  reminder?: string;
  /** A Slack mention "<@U…>" OR a bare user id. */
  assignee?: string;
  assignees?: string[];
  /**
   * A free-form nickname or role the owner used ("小王", "Lisa", "design").
   * If `assignee` is missing, the bot resolves this via the three-layer resolver
   * (alias table → Slack workspace member match → ask once on ambiguity).
   * The AI should pass whatever the owner literally said; do NOT invent a Slack id.
   */
  assigneeQuery?: string;
  initiator?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
};

function defaultDueTime(now: Date = new Date()): string {
  // End of this week (Friday 18:00 local). If it's already past Friday EOD, push to next Friday.
  const target = new Date(now);
  const day = target.getDay(); // 0=Sun ... 5=Fri ... 6=Sat
  const daysUntilFriday = (5 - day + 7) % 7;
  target.setDate(target.getDate() + daysUntilFriday);
  target.setHours(18, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 7);
  }
  return target.toISOString();
}

function normalizePriority(value: unknown): TaskPriority {
  if (typeof value !== 'string') return 'NORMAL';
  const upper = value.trim().toUpperCase();
  if (upper === 'LOW' || upper === 'HIGH' || upper === 'URGENT' || upper === 'NORMAL') {
    return upper as TaskPriority;
  }
  return 'NORMAL';
}

export function createTaskFunction(): RegisteredFunction {
  return {
    name: 'CreateTask',
    description:
      'Persist a task. Provide title + dueTime (default to a sensible week-end if not given) and EITHER an explicit Slack assignee ("<@U…>") OR an assigneeQuery nickname/role string the owner used ("小王", "Lisa", "design"). The bot will resolve the nickname against the workspace; if it cannot resolve unambiguously it will return resolvedAssignee=null with disambiguation candidates — then you should call [AskClarification] presenting those candidates verbatim.',
    inputExample:
      '{"title":"Banner for landing page","description":"Sized for hero, copy from main visual","dueTime":"2025-01-10T18:00:00-05:00","assigneeQuery":"Lisa","priority":"NORMAL"}',

    handler: async (args: CreateTaskArgs, context) => {
      if (!args || typeof args !== 'object') {
        return { status: 'error', message: 'Invalid arguments received.' };
      }

      const title = (args.title || '').trim();
      if (!title) {
        return { status: 'error', message: 'Task title is required.' };
      }

      // ── Resolve the assignee (three-layer fallback, product brief §4.2) ─────────
      //   1. explicit "<@U…>" / bare user id      → use directly
      //   2. AI passed a nickname/role string     → PersonAlias → Slack workspace match
      //   3. neither given                         → caller must ask
      let resolvedAssignee: string | null = null;
      let resolverNote: string | null = null;
      let disambiguation: ResolvedCandidate[] | null = null;

      const primaryAssignee = (args.assignee || '').trim();
      if (primaryAssignee) {
        const directId = extractUserId(primaryAssignee);
        if (directId) {
          resolvedAssignee = directId;
        }
      }

      // If no direct id yet, try the resolver on whatever string we have (assignee field
      // or assigneeQuery — the AI sometimes drops a nickname in either slot).
      if (!resolvedAssignee) {
        const queryStr = (args.assigneeQuery || primaryAssignee || '').trim();
        if (queryStr) {
          const result = await resolveAssignee(queryStr, {
            client: context.slack.client,
            prisma,
            teamId: context.slack.teamId ?? null,
            enterpriseId: context.slack.enterpriseId ?? null,
          });
          if (result.kind === 'resolved') {
            resolvedAssignee = result.slackUserId;
            if (result.autoLearned) {
              // Phrasing for the owner so they can correct if we guessed wrong.
              resolverNote = `I matched "${queryStr}" to <@${result.slackUserId}> from the workspace. Tell me if I picked the wrong person.`;
            }
          } else if (result.kind === 'needs_disambiguation') {
            disambiguation = result.candidates;
          }
        }
      }

      if (!resolvedAssignee) {
        if (disambiguation && disambiguation.length > 0) {
          // Don't fail-then-leak-to-AI: post the disambiguation question directly to the
          // same channel so the owner sees ONE coherent reply instead of "✅ done… oh wait,
          // who exactly?". Per red line #2: confirm once, then remember.
          const queryStr = (args.assigneeQuery || primaryAssignee || '').trim();
          const candidateLines = disambiguation
            .map((c, i) => `${i + 1}. <@${c.slackUserId}> — ${c.display}`)
            .join('\n');
          await context.slack.send({
            text: `Which "${queryStr}" did you mean?`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: [
                    `❓ I see more than one *"${queryStr}"* in your workspace. Which one?`,
                    ``,
                    candidateLines,
                    ``,
                    `_Just reply with the number, the @-mention, or the name. I'll remember next time._`,
                  ].join('\n'),
                },
              },
            ],
          });
          // Return success so the orchestrator does NOT echo a generic "tool failed".
          // The data carries the candidates so the AI's next turn can finalize the
          // CreateTask (and call [ConfirmAlias] with the chosen user).
          return {
            status: 'success',
            message: `Asked owner to disambiguate "${queryStr}".`,
            data: {
              action: 'awaiting_disambiguation',
              query: queryStr,
              candidates: disambiguation,
              pendingTaskDraft: {
                title,
                description: args.description ?? null,
                dueTime: args.dueTime ?? defaultDueTime(),
                priority: args.priority ?? 'NORMAL',
              },
            },
          };
        }
        return {
          status: 'error',
          message:
            'No assignee resolved. If you have a name/nickname the owner said, retry with assigneeQuery=<that string>. Only if truly nothing in context, call [AskClarification].',
        };
      }

      // Default deadline: end-of-week 18:00 local. The owner can correct on the next turn —
      // that's cheaper than blocking the whole creation with a clarification question.
      const dueTime = args.dueTime ?? defaultDueTime();

      const payload: ParsedTaskInput = {
        title,
        task: args.description ?? args.title,
        time: dueTime,
        reminder_time: args.reminder,
        assignee: resolvedAssignee,
        assignees: args.assignees,
        initiator: args.initiator ?? context.slack.userId,
        channelId: context.slack.channelId,
        createdBy: context.slack.userId,
        rawText: context.slack.rawText,
      };

      let normalized;
      try {
        normalized = normalizeToDBTask(payload);
      } catch (e: any) {
        return { status: 'error', message: e?.message ?? 'Failed to normalize task.' };
      }

      const priority = normalizePriority(args.priority);
      const description = (args.description || '').trim() || null;

      const created = await prisma.task.create({
        data: {
          title: normalized.title,
          description,
          time: normalized.time,
          assignee: normalized.assignee,
          assignees: normalized.assignees,
          channelId: normalized.channelId,
          threadTs: context.slack.threadTs ?? null,
          createdBy: normalized.createdBy,
          initiator: normalized.initiator,
          teamId: context.slack.teamId ?? null,
          enterpriseId: context.slack.enterpriseId ?? null,
          status: 'NOT_STARTED',
          priority,
          deadlineReminderSentAt: new Date(),
        },
      });
      log.info('Task created', { taskId: created.id, title: created.title });

      const cardTs = await syncChannelTaskCard(context.slack.client, created);
      if (cardTs) {
        await persistChannelMessageTs(created.id, cardTs);
      }

      const dueText = created.time.toLocaleString();
      const assigneeMention = toSlackMention(created.assignee);
      const assigneesMention = Array.isArray(created.assignees) && created.assignees.length > 0
        ? created.assignees.map((a) => toSlackMention(a)).join(', ')
        : assigneeMention;

      const assigneeDm = await openDm(context.slack.client, created.assignee);
      if (assigneeDm) {
        const ownerMention = toSlackMention(created.initiator || created.createdBy);
        // Notification framing (per product brief §2.2 / §3 red line #4):
        //   - explain the *why* / context so the employee knows it matters
        //   - give them a question channel back through the bot (shielding them from the owner)
        //   - lower the reply bar to "one sentence is fine" so honest replies stay cheap
        const intro = `Hey — ${ownerMention} just asked me to set this up with you.`;
        const contextLine = description
          ? `📝 ${description}`
          : `_Heads up: this came in as part of a wider request from ${ownerMention}. If anything's unclear about scope or expectations, ask me here and I'll loop in with them so you don't have to re-ping the owner._`;
        const questionChannel =
          `❓ *Something unclear?* Just reply here — I'll ask the owner for you so you don't have to chase them, and that saves you a rework later.`;
        const replyHint =
          `💬 No formal updates needed. A one-line "started", "halfway", "blocked on X", or "done" whenever it changes is plenty.`;

        await context.slack.client.chat.postMessage({
          channel: assigneeDm,
          text: `New task: ${created.title}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: [
                  intro,
                  ``,
                  `*${created.title}*`,
                  `📅 Due: ${dueText}` + (priority !== 'NORMAL' ? `  ·  🏷 ${priority}` : ''),
                  ``,
                  contextLine,
                  ``,
                  questionChannel,
                  replyHint,
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            },
          ],
        });
      }

      const initiatorId = created.initiator || created.createdBy;
      if (initiatorId && initiatorId !== created.assignee) {
        const ownerDm = await openDm(context.slack.client, initiatorId);
        if (ownerDm) {
          // If we auto-learned the assignee from a fuzzy profile match, surface that fact
          // explicitly so the owner can correct us (red line #2 — confirm-and-allow-fix
          // beats silent guessing).
          const lines = [`✅ Task created for ${assigneesMention}: ${created.title}`];
          if (resolverNote) lines.push(`_${resolverNote}_`);
          await context.slack.client.chat.postMessage({
            channel: ownerDm,
            text: lines.join('\n'),
          });
        }
      }

      if (initiatorId) {
        refreshOwnerHome(context.slack.client, initiatorId).catch(() => undefined);
      }

      return {
        status: 'success',
        message: `Created task "${created.title}" for ${assigneeMention}.`,
        data: {
          taskId: created.id,
          title: created.title,
          assignee: created.assignee,
          initiator: initiatorId,
          time: created.time.toISOString(),
          priority: created.priority,
          action: 'created',
          // Surfaced so the AI can phrase the human reply as "I assigned this to Lisa — say
          // so if I got it wrong" instead of silently letting a wrong guess stand.
          resolverNote,
        },
      };
    },
  };
}
