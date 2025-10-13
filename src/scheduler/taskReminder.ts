import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { WebClient } from '@slack/web-api';
import { buildTaskBlocks } from '../ui/taskCard';
import { computeReminderLeadMs } from './reminderPolicy';

dotenv.config();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const prisma = new PrismaClient();


export function startTaskReminderScheduler() {
  cron.schedule('* * * * *', async () => {
    console.log("⏰ Checking task reminders...");

    const now = new Date();
    const upper = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // look ahead 7 days
    const windowMs = 60 * 1000; // fire within ±1 minute window

    try {
      const tasks = await prisma.task.findMany({
        where: {
          completed: false,
          deadlineReminderSentAt: null,
          time: { gte: now, lte: upper }
        }
      });

      for (const task of tasks) {
        const msUntil = task.time.getTime() - now.getTime();
        if (msUntil <= 0) continue;

        const leadMs = computeReminderLeadMs(msUntil);
        const targetTs = task.time.getTime() - leadMs;

        if (Math.abs(now.getTime() - targetTs) <= windowMs) {
          try {
            const blocks = buildTaskBlocks({
              id: task.id,
              title: task.title,
              time: task.time,
              assignee: task.assignee,
              assignees: task.assignees,
            });

            await slack.chat.postMessage({
              channel: task.assignee, // DM to assignee
              text: `🔔 Upcoming task: ${task.title}`,
              blocks,
            });

            await prisma.task.update({
              where: { id: task.id },
              data: { deadlineReminderSentAt: new Date() },
            });
          } catch (err) {
            console.error("❌ Failed to send DM reminder:", err);
          }
        }
      }
    } catch (e) {
      console.error("❌ Failed to query tasks:", e);
    }
  });
}
