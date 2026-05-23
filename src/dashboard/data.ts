import { PrismaClient, Task, ProgressUpdate, TaskStatus } from '@prisma/client';

/**
 * Everything the dashboard page needs to render — pulled in one shot so the
 * route handler stays trivial.
 *
 * Scoping rule: a user sees tasks where they are either the initiator
 * (the owner who created it) or the createdBy (the person whose message
 * led to the task). Same scope we already use in the Slack Home tab —
 * keep them consistent so the web view is never a superset/subset of
 * what they saw in Slack.
 */
export type WorkloadEntry = {
  assigneeId: string;
  total: number;
  blocked: number;
  overdue: number;
  /** Most recent open task title, for context next to the bar. */
  topTaskTitle?: string;
};

export type ActivityEntry = {
  at: Date;
  taskId: string;
  taskTitle: string;
  source: string;
  summary: string;
};

export type DashboardSnapshot = {
  ownerSlackId: string;
  teamId: string | null;
  enterpriseId: string | null;

  summary: {
    open: number;
    blocked: number;
    overdue: number;
    completedThisWeek: number;
  };

  /** Tasks the owner most likely wants to look at first — overdue + blocked + silence-flagged. */
  riskTasks: Task[];
  /** All non-terminal tasks, sorted by deadline ascending. */
  activeTasks: Task[];
  /** Last 6 completed tasks for context. */
  recentlyCompleted: Task[];

  workload: WorkloadEntry[];
  activity: ActivityEntry[];

  /** Sample text used downstream to auto-detect the dashboard's display language. */
  languageSamples: Array<string | null>;
};

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function buildDashboardSnapshot(args: {
  prisma: PrismaClient;
  ownerId: string;
  teamId: string | null;
  enterpriseId: string | null;
}): Promise<DashboardSnapshot> {
  const { prisma, ownerId, teamId, enterpriseId } = args;

  // Tasks "this owner cares about" — same scope as Slack Home tab.
  const baseScope = {
    teamId,
    enterpriseId,
    OR: [{ initiator: ownerId }, { createdBy: ownerId }],
  };

  const allTasks = await prisma.task.findMany({
    where: baseScope,
    orderBy: [{ status: 'asc' }, { time: 'asc' }],
    take: 500,
  });

  const now = Date.now();
  const weekAgo = new Date(now - ONE_WEEK_MS);

  let openCount = 0;
  let blockedCount = 0;
  let overdueCount = 0;
  let completedThisWeekCount = 0;

  const active: Task[] = [];
  const completed: Task[] = [];
  const risks: Task[] = [];
  const silenceFlaggedIds = new Set<string>();

  for (const t of allTasks) {
    const isTerminal =
      t.status === 'COMPLETED' || t.status === 'CANCELLED' || t.status === 'FAILED';
    if (isTerminal) {
      if (t.status === 'COMPLETED' && t.completedAt && t.completedAt >= weekAgo) {
        completedThisWeekCount++;
      }
      if (t.status === 'COMPLETED') completed.push(t);
      continue;
    }

    openCount++;
    if (t.status === 'BLOCKED') blockedCount++;
    const isOverdue = t.time.getTime() < now;
    if (isOverdue) overdueCount++;

    active.push(t);

    // Risk surface: silence-alerted in last 48h, overdue, or blocked.
    const recentlySilenceAlerted =
      t.lastSilenceAlertAt && now - t.lastSilenceAlertAt.getTime() < 48 * 60 * 60 * 1000;
    if (recentlySilenceAlerted) silenceFlaggedIds.add(t.id);
    if (recentlySilenceAlerted || isOverdue || t.status === 'BLOCKED') {
      risks.push(t);
    }
  }

  // Sort risks: silence-flagged first, then overdue (most overdue first), then blocked.
  risks.sort((a, b) => {
    const aSilent = silenceFlaggedIds.has(a.id) ? 1 : 0;
    const bSilent = silenceFlaggedIds.has(b.id) ? 1 : 0;
    if (aSilent !== bSilent) return bSilent - aSilent;
    return a.time.getTime() - b.time.getTime();
  });

  // Sort recently completed by completedAt desc.
  completed.sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));

  // ─────────── workload by assignee ───────────
  const byAssignee = new Map<string, WorkloadEntry>();
  for (const t of active) {
    const existing = byAssignee.get(t.assignee) ?? {
      assigneeId: t.assignee,
      total: 0,
      blocked: 0,
      overdue: 0,
      topTaskTitle: undefined,
    };
    existing.total++;
    if (t.status === 'BLOCKED') existing.blocked++;
    if (t.time.getTime() < now) existing.overdue++;
    // Track the most-pressing (earliest deadline) task title as label hint.
    if (!existing.topTaskTitle) existing.topTaskTitle = t.title;
    byAssignee.set(t.assignee, existing);
  }
  const workload = Array.from(byAssignee.values()).sort((a, b) => b.total - a.total);

  // ─────────── recent activity feed ───────────
  const taskIds = allTasks.map((t) => t.id);
  const activityRows: Array<ProgressUpdate & { task: { id: string; title: string } | null }> =
    taskIds.length
      ? ((await prisma.progressUpdate.findMany({
          where: { taskId: { in: taskIds } },
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: { task: { select: { id: true, title: true } } },
        })) as any)
      : [];

  const activity: ActivityEntry[] = activityRows
    .filter((r) => r.task)
    .map((r) => ({
      at: r.createdAt,
      taskId: r.task!.id,
      taskTitle: r.task!.title,
      source: r.source,
      summary: r.summary ?? r.rawText ?? '',
    }))
    .filter((e) => e.summary);

  // ─────────── language samples ───────────
  // Used by the page renderer to auto-detect display language. Mirrors what
  // the Slack Home tab does so the two surfaces never disagree.
  const languageSamples: Array<string | null> = [];
  for (const t of allTasks.slice(0, 30)) {
    languageSamples.push(t.title);
    languageSamples.push(t.description);
    languageSamples.push(t.lastProgressSummary);
  }

  return {
    ownerSlackId: ownerId,
    teamId,
    enterpriseId,
    summary: {
      open: openCount,
      blocked: blockedCount,
      overdue: overdueCount,
      completedThisWeek: completedThisWeekCount,
    },
    riskTasks: risks.slice(0, 10),
    activeTasks: active,
    recentlyCompleted: completed.slice(0, 6),
    workload,
    activity,
    languageSamples,
  };
}

export function statusBucket(status: TaskStatus): 'open' | 'blocked' | 'done' | 'other' {
  if (status === 'BLOCKED') return 'blocked';
  if (status === 'COMPLETED') return 'done';
  if (status === 'CANCELLED' || status === 'FAILED' || status === 'PENDING_CLARIFICATION')
    return 'other';
  return 'open';
}
