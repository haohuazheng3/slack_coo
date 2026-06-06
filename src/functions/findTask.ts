import { RegisteredFunction } from '../orchestrator/functionRegistry';
import { resolveAssignee } from '../services/nicknameResolver';

type FindTaskArgs = {
  /** Substring or fuzzy-match against task title. Case-insensitive. */
  titleQuery?: string;
  /**
   * Free-form nickname / role / @-mention. Resolves through the same alias
   * pipeline as CreateTask, so "Lisa" / "小王" / "<@U…>" all work.
   */
  assigneeQuery?: string;
  /** 'open' = active tasks (default), 'recent' = last 14 days incl. closed, 'all' = no filter. */
  scope?: 'open' | 'recent' | 'all';
  /** Max results to return. Capped at 5 to keep the AI focused. */
  limit?: number;
};

/**
 * Lookup tool — gives the AI a way to find a named task without dumping
 * everything via ListTasks.
 *
 * Without this, three failure modes leak out:
 *   • Owner asks "how's the banner going?" → no tool to fuzzy-find one task.
 *   • Owner misattributes — "Lisa's banner" when it's Tom's → no name lookup.
 *   • Assignee replies about a DIFFERENT task than the bot pinged about.
 *
 * Returns the matches (capped at 5) so the AI can pick the right one before
 * calling RecordProgress / UpdateTaskStatus / etc. If nothing matches, returns
 * an empty list so the AI knows to ask instead of guessing.
 */
export function findTaskFunction(): RegisteredFunction {
  return {
    name: 'FindTask',
    description:
      'Look up an open task by title fragment and/or assignee nickname. Use this BEFORE RecordProgress / UpdateTaskStatus / UpdateTaskDetails when the user names a task ("how\'s the banner going?", "cancel the Q4 deck") and you don\'t already have its id in the last ToolResult. Don\'t guess the id; call this and pick the right match. If you get 0 hits, ASK rather than create something new.',
    inputExample: '{"titleQuery":"banner","scope":"open"}',

    handler: async (args: FindTaskArgs, context) => {
      const { prisma, slack } = context;
      const titleQ = (args.titleQuery || '').trim();
      const assigneeQ = (args.assigneeQuery || '').trim();
      const scope = args.scope ?? 'open';
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 5);

      if (!titleQ && !assigneeQ) {
        return {
          status: 'error',
          message: 'Either titleQuery or assigneeQuery is required.',
        };
      }

      // Resolve the assignee query through the same pipeline CreateTask uses —
      // handles "Lisa" / aliases / "<@U…>" / self-reference ("me" / "我").
      let resolvedAssignee: string | null = null;
      if (assigneeQ) {
        const result = await resolveAssignee(assigneeQ, {
          client: slack.client,
          prisma,
          teamId: slack.teamId ?? null,
          enterpriseId: slack.enterpriseId ?? null,
          speakerUserId: slack.userId,
        } as any);
        if (result.kind === 'resolved') resolvedAssignee = result.slackUserId;
      }

      const where: any = {
        teamId: slack.teamId ?? null,
        enterpriseId: slack.enterpriseId ?? null,
      };
      if (scope === 'open') {
        where.status = { notIn: ['COMPLETED', 'CANCELLED', 'FAILED'] };
      } else if (scope === 'recent') {
        const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        where.createdAt = { gte: cutoff };
      }
      if (resolvedAssignee) {
        where.OR = [{ assignee: resolvedAssignee }, { initiator: resolvedAssignee }];
      }

      const candidates = await prisma.task.findMany({
        where,
        orderBy: { time: 'asc' },
        take: 100,
      });

      // Fuzzy title match — case-insensitive substring + token overlap. We want
      // "banner" to match "Q4 launch banner", "发布页 banner", and "新发布页 banner".
      const normalizedQ = titleQ.toLowerCase();
      const queryTokens = normalizedQ.split(/\s+/).filter((t) => t.length >= 2);

      const scored = candidates
        .map((t) => {
          const title = t.title.toLowerCase();
          let score = 0;
          if (!normalizedQ) score = 50; // assignee-only filter still returns matches
          else if (title.includes(normalizedQ)) score = 100;
          else {
            const tokenHits = queryTokens.filter((tok) => title.includes(tok)).length;
            if (tokenHits > 0) score = 30 + tokenHits * 20;
          }
          return { task: t, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const matches = scored.map((s) => ({
        taskId: s.task.id,
        title: s.task.title,
        assignee: s.task.assignee,
        initiator: s.task.initiator,
        status: s.task.status,
        dueIso: s.task.time.toISOString(),
        progressPercent: s.task.progressPercent,
        lastProgressSummary: s.task.lastProgressSummary,
        lastProgressAt: s.task.lastProgressAt?.toISOString() ?? null,
      }));

      return {
        status: 'success',
        message: matches.length === 1 ? 'One match.' : `${matches.length} match(es).`,
        data: {
          action: 'found',
          matches,
          query: { titleQuery: titleQ || null, assigneeQuery: assigneeQ || null, scope },
        },
      };
    },
  };
}
