import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { refreshOwnerHome } from '../slack/taskCardUpdater';
import { detectLanguageFromTexts } from '../lib/i18n';

/**
 * Bulk delete — exists specifically to solve a failure mode LLMs hit with
 * exhaustive list operations.
 *
 * Background: when a user says "delete all of these except X" and there are
 * 5+ items in the visible list, the LLM may correctly identify the intent but
 * fail to enumerate every task id in its working memory. It will emit, say, 4
 * `DeleteTask` tool calls when 5 were needed — and the bot's natural-language
 * reply will say "deleted the other 4" (LLM's count of its own emitted calls,
 * not the actual number to delete). This is a known weakness of LLMs on long
 * similar-looking lists.
 *
 * The fix is to NOT make the LLM enumerate. With `keepTaskIds` mode, the LLM
 * only has to identify which 1–2 tasks to KEEP; the server queries everything
 * the speaker owns and computes the deletion set deterministically. The LLM
 * can't drop items if the server is the one enumerating.
 */

type DeleteTasksArgs = {
  /** Explicit list of taskIds to delete. Use when the user names specific items. */
  taskIds?: string[];
  /** Delete every open task owned by the speaker EXCEPT these. Use for "delete all except X". */
  keepTaskIds?: string[];
  /**
   * Confirmation knob: how many tasks should the bot expect to delete in this
   * call? If the actual count differs by >=1, the call refuses. Mostly a
   * sanity check — set to null/omit if you don't have an expected count.
   */
  expectedCount?: number;
};

export function deleteTasksFunction(): RegisteredFunction {
  return {
    name: 'DeleteTasks',
    description:
      'PLURAL bulk delete. PREFER THIS over multiple [DeleteTask] calls whenever the user asks to delete more than one task. Two modes: (a) taskIds=[<id1>,<id2>,…] for explicit ids; (b) keepTaskIds=[<id-to-keep>] for "delete all except these" — the bot enumerates server-side so you never miss one. Returns the actual count + titles of what got deleted.',
    inputExample:
      '{"keepTaskIds":["clxyz999"]}  // delete every open task owned by the speaker except clxyz999',

    handler: async (args: DeleteTasksArgs, context) => {
      const taskIdsExplicit = Array.isArray(args?.taskIds) ? args.taskIds.filter(Boolean) : [];
      const keepIds = Array.isArray(args?.keepTaskIds) ? args.keepTaskIds.filter(Boolean) : [];

      if (taskIdsExplicit.length === 0 && keepIds.length === 0) {
        return {
          status: 'error',
          message:
            'Either taskIds (explicit list to delete) or keepTaskIds (delete all except these) must be provided.',
        };
      }
      if (taskIdsExplicit.length > 0 && keepIds.length > 0) {
        return {
          status: 'error',
          message: 'taskIds and keepTaskIds are mutually exclusive — pass exactly one.',
        };
      }

      // Figure out the target set. Either:
      //   (a) taskIdsExplicit was given → that IS the target
      //   (b) keepTaskIds was given → query everything the speaker owns and
      //       remove keepIds from the set
      let toDelete: { id: string; title: string }[] = [];

      if (taskIdsExplicit.length > 0) {
        toDelete = await context.prisma.task.findMany({
          where: { id: { in: taskIdsExplicit } },
          select: { id: true, title: true },
        });
      } else {
        // Scope: tasks the speaker owns (initiator OR createdBy). Mirrors the
        // ListTasks query semantics so "delete all except X" deletes the
        // exact set the user just SAW in the list.
        const speakerId = context.slack.userId;
        const candidates = await context.prisma.task.findMany({
          where: {
            teamId: context.slack.teamId ?? null,
            enterpriseId: context.slack.enterpriseId ?? null,
            OR: [{ initiator: speakerId }, { createdBy: speakerId }],
            id: { notIn: keepIds },
          },
          select: { id: true, title: true },
        });
        toDelete = candidates;
      }

      if (toDelete.length === 0) {
        return {
          status: 'success',
          message: 'Nothing to delete.',
          data: { deletedCount: 0, titles: [], action: 'bulk_deleted' },
        };
      }

      // Optional sanity check: refuse if the count is wildly different from
      // what the LLM expected. Protects against the failure case where the
      // LLM thought there were 3 to delete but the query returns 50.
      if (typeof args.expectedCount === 'number' && Math.abs(toDelete.length - args.expectedCount) >= 2) {
        return {
          status: 'error',
          message: `Refusing bulk delete: expected ~${args.expectedCount} but the resolved set has ${toDelete.length}. Confirm with the user before retrying.`,
          data: { wouldDeleteCount: toDelete.length, titles: toDelete.map((t) => t.title) },
        };
      }

      try {
        await context.prisma.task.deleteMany({
          where: { id: { in: toDelete.map((t) => t.id) } },
        });
      } catch (error: any) {
        return {
          status: 'error',
          message: error?.message ?? 'Failed to delete tasks.',
        };
      }

      // Language-aware confirmation. Build one message that lists what got
      // deleted so the owner can immediately scan for "wait, that one
      // shouldn't have been deleted".
      const titles = toDelete.map((t) => t.title);
      const lang = detectLanguageFromTexts(titles);
      const bullet = titles.map((t) => `🗑️ ${t}`).join('\n');
      const summary =
        lang === 'zh'
          ? `已删除 ${toDelete.length} 个任务:\n${bullet}`
          : `Deleted ${toDelete.length} task${toDelete.length === 1 ? '' : 's'}:\n${bullet}`;

      await context.slack.send(summary);

      // Refresh the owner's Home view if they were the speaker.
      const ownerId = context.slack.userId;
      if (ownerId) {
        refreshOwnerHome(context.slack.client, ownerId, {
          teamId: context.slack.teamId ?? null,
          enterpriseId: context.slack.enterpriseId ?? null,
        }).catch(() => undefined);
      }

      return {
        status: 'success',
        message: `Bulk-deleted ${toDelete.length} task(s): ${titles.join(', ')}.`,
        data: {
          deletedCount: toDelete.length,
          titles,
          deletedIds: toDelete.map((t) => t.id),
          action: 'bulk_deleted',
        },
      };
    },
  };
}
