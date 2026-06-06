import { PrismaClient, Task } from '@prisma/client';
import { detectLanguageFromTexts } from '../lib/i18n';
import { formatDateTime } from '../lib/timezone';
import { signDashboardToken } from '../dashboard/auth';
import { toSlackMention } from '../utils/assignee';

export type TaskListOptions = {
  showCompleted?: boolean;
  showAll?: boolean;
  /** Workspace ids — used to mint a signed dashboard URL alongside the summary. */
  teamId?: string | null;
  enterpriseId?: string | null;
};

export type TaskListMessage = {
  text: string;
  blocks?: any[];
};

/**
 * Conversational task summary — replaces the legacy card-stack render.
 *
 * Old shape: one section block per task with bold title + 📅 due + 👤 assignee
 * + 📈 progress bar + per-task action buttons, dividers between. Reads like a
 * dashboard report dumped into chat — the user explicitly asked us to stop
 * doing that.
 *
 * New shape: ONE compact mrkdwn section with the count + bullet-style one-liners
 * grouped by status, followed by ONE "open dashboard" button. Bullets only have
 * what a person would say out loud — title, assignee, when it's due. No bars,
 * no per-task buttons.
 */
export async function buildTaskListMessage(
  prisma: PrismaClient,
  userId: string,
  options: TaskListOptions = {}
): Promise<TaskListMessage> {
  const { showCompleted = false, showAll = false, teamId = null, enterpriseId = null } = options;

  const whereClause: any = {
    OR: [
      { createdBy: userId },
      { assignee: userId },
      { assignees: { has: userId } },
      { initiator: userId },
    ],
  };

  if (!showAll) {
    if (showCompleted) {
      whereClause.status = 'COMPLETED';
    } else {
      whereClause.status = { notIn: ['COMPLETED', 'CANCELLED'] };
    }
  }

  const tasks = await prisma.task.findMany({
    where: whereClause,
    orderBy: { time: 'asc' },
    take: 50,
  });

  const samples: Array<string | null> = [];
  for (const t of tasks) {
    samples.push(t.title);
    samples.push(t.description);
    samples.push(t.lastProgressSummary);
  }
  const lang = detectLanguageFromTexts(samples);

  if (tasks.length === 0) {
    return {
      text:
        lang === 'zh'
          ? showCompleted
            ? '没看到已完成的任务。'
            : '名下没什么活在跑。'
          : showCompleted
            ? 'no completed tasks to show.'
            : 'nothing currently running.',
    };
  }

  const now = Date.now();
  const groups = {
    overdue: [] as Task[],
    inFlight: [] as Task[],
    blocked: [] as Task[],
    awaiting: [] as Task[],
    completed: [] as Task[],
  };
  for (const t of tasks) {
    if (t.status === 'COMPLETED') groups.completed.push(t);
    else if (t.status === 'BLOCKED') groups.blocked.push(t);
    else if (t.status === 'PENDING_CLARIFICATION') groups.awaiting.push(t);
    else if (t.time.getTime() < now) groups.overdue.push(t);
    else groups.inFlight.push(t);
  }

  const lines: string[] = [];
  const total = tasks.length;
  lines.push(lang === 'zh' ? `*你的任务 (${total})*` : `*your tasks (${total})*`);
  lines.push('');

  const renderBullet = (t: Task): string => {
    const due = formatDateTime(t.time, { tz: process.env.DEFAULT_TIMEZONE, locale: lang });
    return lang === 'zh'
      ? `• *${t.title}* — ${toSlackMention(t.assignee)} · ${due}`
      : `• *${t.title}* — ${toSlackMention(t.assignee)} · ${due}`;
  };

  const groupHeader = (zh: string, en: string) => (lang === 'zh' ? zh : en);

  if (groups.overdue.length) {
    lines.push(groupHeader(`⚠️ 逾期 (${groups.overdue.length})`, `⚠️ overdue (${groups.overdue.length})`));
    for (const t of groups.overdue) lines.push(renderBullet(t));
    lines.push('');
  }
  if (groups.blocked.length) {
    lines.push(groupHeader(`⛔ 受阻 (${groups.blocked.length})`, `⛔ blocked (${groups.blocked.length})`));
    for (const t of groups.blocked) lines.push(renderBullet(t));
    lines.push('');
  }
  if (groups.inFlight.length) {
    lines.push(groupHeader(`🚧 进行中 (${groups.inFlight.length})`, `🚧 in flight (${groups.inFlight.length})`));
    for (const t of groups.inFlight) lines.push(renderBullet(t));
    lines.push('');
  }
  if (groups.awaiting.length) {
    lines.push(groupHeader(`❓ 待补充 (${groups.awaiting.length})`, `❓ awaiting info (${groups.awaiting.length})`));
    for (const t of groups.awaiting) lines.push(renderBullet(t));
    lines.push('');
  }
  if (showCompleted && groups.completed.length) {
    lines.push(groupHeader(`✅ 已完成 (${groups.completed.length})`, `✅ done (${groups.completed.length})`));
    for (const t of groups.completed) lines.push(renderBullet(t));
    lines.push('');
  }

  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').trim() } }];

  // ONE dashboard button below, IF we have what's needed to mint a URL.
  const baseUrl = (process.env.BASE_URL ?? '').replace(/\/$/, '');
  if (baseUrl && teamId) {
    const token = signDashboardToken({ userId, teamId, enterpriseId });
    const dashboardUrl = `${baseUrl}/dashboard?token=${encodeURIComponent(token)}`;
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: lang === 'zh' ? '🌐 在浏览器看完整看板' : '🌐 open full dashboard',
          },
          style: 'primary',
          url: dashboardUrl,
          action_id: 'open_dashboard_from_list',
        },
      ],
    });
  }

  return {
    text:
      lang === 'zh' ? `你的任务 — 共 ${total} 个` : `your tasks — ${total} total`,
    blocks,
  };
}
