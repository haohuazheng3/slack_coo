import cron from 'node-cron';
import { computeReminderLeadMs } from './reminderPolicy';
import { toSlackMention } from '../utils/assignee';
import { prisma } from '../lib/prisma';
import { getClientForTeam } from '../lib/slackClient';
import { openDm } from '../lib/sendHelpers';
import { createLogger } from '../lib/logger';

const log = createLogger('TaskReminder');

const REMINDER_CRON = process.env.REMINDER_CRON || '* * * * *';
const LOOKAHEAD_DAYS = Number(process.env.REMINDER_LOOKAHEAD_DAYS ?? '7');
const REMINDER_WINDOW_MS = Number(process.env.REMINDER_WINDOW_MS ?? `${90 * 1000}`);
const REMINDER_CATCHUP_MS = Number(process.env.REMINDER_CATCHUP_MS ?? `${5 * 60 * 1000}`);

export function startTaskReminderScheduler() {
  cron.schedule(REMINDER_CRON, async () => {
    const now = new Date();
    const upper = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

    try {
      const tasks = await prisma.task.findMany({
        where: {
          status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED', 'PENDING_CLARIFICATION'] },
          deadlineReminderSentAt: null,
          time: { gte: now, lte: upper },
        },
        take: 100,
      });

      for (const task of tasks) {
        const msUntil = task.time.getTime() - now.getTime();
        if (msUntil <= 0) continue;

        const leadMs = computeReminderLeadMs(msUntil);
        const targetTs = task.time.getTime() - leadMs;
        const inWindow = Math.abs(now.getTime() - targetTs) <= REMINDER_WINDOW_MS;
        const catchingUp = targetTs < now.getTime() && now.getTime() - targetTs <= REMINDER_CATCHUP_MS;
        if (!inWindow && !catchingUp) continue;

        const client = await getClientForTeam(task.teamId, task.enterpriseId);
        if (!client) {
          log.warn('No client for task team', { taskId: task.id, teamId: task.teamId });
          continue;
        }

        const dmChannel = await openDm(client, task.assignee);
        if (!dmChannel) {
          log.warn('Could not open DM for reminder', { taskId: task.id, assignee: task.assignee });
          continue;
        }

        const assigneeMentions =
          Array.isArray(task.assignees) && task.assignees.length > 0
            ? task.assignees.map((a) => toSlackMention(a)).join(', ')
            : toSlackMention(task.assignee);

        try {
          await client.chat.postMessage({
            channel: dmChannel,
            text: `🔔 Reminder: ${task.title}`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: [
                    `🔔 *Reminder: ${task.title}*`,
                    task.description ? `📝 ${task.description}` : '',
                    `📅 Due: ${task.time.toLocaleString()}`,
                    `👤 ${assigneeMentions}`,
                  ]
                    .filter(Boolean)
                    .join('\n'),
                },
              },
            ],
          });

          await prisma.task.update({
            where: { id: task.id },
            data: { deadlineReminderSentAt: new Date() },
          });
          log.info('Reminder sent', { taskId: task.id });
        } catch (err) {
          log.error('Failed to send reminder', { taskId: task.id, error: String(err) });
        }
      }
    } catch (e) {
      log.error('Reminder cron failed', { error: String(e) });
    }
  });

  log.info('Task reminder scheduler started', { cron: REMINDER_CRON });
}
