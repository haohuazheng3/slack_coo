import { TaskStatus } from '@prisma/client';
import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { interpretEmployeeProgress } from '../services/aiSummarizer';
import { openDm, postMessageWithFeedback } from '../lib/sendHelpers';
import { refreshOwnerHome } from '../slack/taskCardUpdater';
import { createLogger } from '../lib/logger';

const log = createLogger('RecordProgress');

type RecordProgressArgs = {
  taskId?: string;
  employeeReply: string;

  status?: TaskStatus;
  progressPercent?: number;
  summary?: string;

  /**
   * Who reported this update.
   *   - 'assignee' (default): the employee themselves replied — the normal flow.
   *   - 'owner': the OWNER is reporting on behalf of the assignee (e.g. "Lisa
   *     told me face-to-face she's done"). Don't DM the owner a confirmation of
   *     their own statement; do DM the assignee a "fyi I closed this out" note.
   */
  reportedBy?: 'assignee' | 'owner';
};

export function recordProgressFunction(): RegisteredFunction {
  return {
    name: 'RecordProgress',
    description:
      "When an employee replies in DM about a task (or in any context that gives you their status), interpret the reply, store the owner-facing summary, and DM the owner. Pass the raw reply as `employeeReply`. If the OWNER is reporting on behalf of the assignee (\"Lisa told me she's done\"), pass `reportedBy: 'owner'` — we won't DM the owner about their own statement, and we'll FYI the assignee instead. Bare acknowledgments (\"ok\", \"好的\") are NOT progress — don't call this tool for them.",
    inputExample:
      '{"taskId":"clxyz123","employeeReply":"drafted slides, blocked on finance data","reportedBy":"assignee"}',

    handler: async (args: RecordProgressArgs, context) => {
      const { prisma, slack } = context;

      const taskId = (args?.taskId || '').trim();
      const reply = (args?.employeeReply || '').trim();

      if (!taskId) {
        return { status: 'error', message: 'taskId is required.' };
      }
      if (!reply) {
        return { status: 'error', message: 'employeeReply is required.' };
      }

      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task) {
        return { status: 'error', message: 'Task not found.' };
      }

      const reportedBy = args.reportedBy ?? 'assignee';

      const interpretation = await interpretEmployeeProgress({
        taskTitle: task.title,
        taskDescription: task.description,
        dueAt: task.time,
        previousSummary: task.lastProgressSummary,
        employeeReply: reply,
      });

      // ACKNOWLEDGED short-circuit: a bare "ok" / "好的" from the assignee is a
      // signal of presence, not progress. Update lastProgressAt so we know we
      // heard them, then return without DMing the owner or fabricating a
      // status. Reply to the assignee with a short nod and stop.
      if (interpretation.status === 'ACKNOWLEDGED' && reportedBy === 'assignee') {
        await prisma.task.update({
          where: { id: taskId },
          data: { lastProgressAt: new Date() },
        });
        // Short nod back to the assignee — locale matches the reply itself.
        const ackBack = /[一-鿿]/.test(reply) ? '收到。' : 'got it.';
        await context.slack.send(ackBack);
        return {
          status: 'success',
          message: 'Acknowledged-only reply, no progress recorded.',
          data: { taskId, action: 'acknowledged' },
        };
      }

      const finalStatus = (args.status && isValidStatus(args.status)
        ? args.status
        : interpretation.status === 'ACKNOWLEDGED'
          ? 'IN_PROGRESS'
          : interpretation.status) as TaskStatus;
      const finalPercent =
        typeof args.progressPercent === 'number'
          ? clamp(args.progressPercent)
          : interpretation.progressPercent ?? 50;
      const finalSummary = (args.summary?.trim() || interpretation.ownerSummary || reply).slice(0, 500);

      const isComplete = finalStatus === 'COMPLETED';
      const isFailure = finalStatus === 'FAILED';

      const updated = await prisma.task.update({
        where: { id: taskId },
        data: {
          status: finalStatus,
          progressPercent: isComplete ? 100 : finalPercent,
          lastProgressSummary: finalSummary,
          lastProgressAt: new Date(),
          completed: isComplete,
          completedAt: isComplete ? new Date() : null,
          notCompletedReason:
            isFailure || finalStatus === 'BLOCKED'
              ? interpretation.blocker || finalSummary
              : null,
          notCompletedReasonAt:
            isFailure || finalStatus === 'BLOCKED' ? new Date() : null,
        },
      });

      await prisma.progressUpdate.create({
        data: {
          taskId: updated.id,
          // Source distinguishes assignee speaking vs owner speaking on behalf.
          source: reportedBy === 'owner' ? 'owner_reported_for_employee' : 'employee_reply',
          authorId: context.slack.userId,
          rawText: reply,
          summary: finalSummary,
          progressPercent: updated.progressPercent,
          statusAtTime: updated.status,
        },
      });

      log.info('Progress recorded', {
        taskId: updated.id,
        status: updated.status,
        progress: updated.progressPercent,
      });

      // No channel card sync anymore — channel cards were dropped in favor of
      // natural conversational confirmations. Owner-facing summary follows.

      const ownerId = updated.initiator || updated.createdBy;
      if (ownerId) {
        if (reportedBy === 'owner') {
          // Owner just told us themselves — don't DM the owner their own
          // statement back. Instead, FYI the assignee that we closed it out.
          if (updated.assignee && updated.assignee !== context.slack.userId) {
            try {
              const assigneeDm = await openDm(slack.client, updated.assignee);
              if (assigneeDm) {
                const isZh = /[一-鿿]/.test(updated.title + ' ' + reply);
                const note = isZh
                  ? `<@${ownerId}> 那边说《${updated.title}》已经完成了 — 我这边关掉了,有不对告诉我。`
                  : `<@${ownerId}> mentioned "${updated.title}" is done — closing it out on my end. flag if that's wrong.`;
                await postMessageWithFeedback(slack.client, {
                  channel: assigneeDm,
                  text: note,
                });
              }
            } catch {
              // best-effort
            }
          }
        } else {
          // Normal flow: assignee reported, owner gets the DM.
          const ownerDm = await openDm(slack.client, ownerId);
          if (ownerDm) {
            const blocker = interpretation.blocker?.trim();
            const quotedReply = reply
              .trim()
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n');
            const bodyLines = [finalSummary, blocker, '', quotedReply].filter(Boolean) as string[];

            await postMessageWithFeedback(slack.client, {
              channel: ownerDm,
              text: finalSummary,
              mrkdwn: true,
              blocks: [{ type: 'section', text: { type: 'mrkdwn', text: bodyLines.join('\n') } }],
            });
          }
        }

        refreshOwnerHome(slack.client, ownerId, {
          teamId: slack.teamId ?? null,
          enterpriseId: slack.enterpriseId ?? null,
        }).catch(() => undefined);
      }

      return {
        status: 'success',
        message: 'Progress recorded.',
        data: {
          taskId: updated.id,
          title: updated.title,
          status: updated.status,
          progressPercent: updated.progressPercent,
          summary: finalSummary,
          reportedBy,
          action: 'progress_recorded',
        },
      };
    },
  };
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function isValidStatus(s: unknown): s is TaskStatus {
  const all: TaskStatus[] = [
    'PENDING_CLARIFICATION',
    'NOT_STARTED',
    'IN_PROGRESS',
    'BLOCKED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ];
  return typeof s === 'string' && all.includes(s as TaskStatus);
}

