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
    const windowMs = 90 * 1000; // broaden to ±1.5 minutes to avoid timing misses

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
        const deltaMs = now.getTime() - targetTs;
        const shouldSend =
          Math.abs(now.getTime() - targetTs) <= windowMs ||
          (targetTs < now.getTime() && deltaMs <= 5 * 60 * 1000);

        console.log(
          "[ReminderDebug]",
          JSON.stringify({
            id: task.id,
            title: task.title,
            now: now.toISOString(),
            deadline: task.time.toISOString(),
            msUntil,
            leadMs,
            target: new Date(targetTs).toISOString(),
            deltaMs,
            windowMs,
            shouldSend
          })
        );

        // Fire within window or catch-up up to 5 minutes late if missed while app was down
        if (shouldSend) {
          try {
            const blocks = buildTaskBlocks({
              id: task.id,
              title: task.title,
              time: task.time,
              assignee: task.assignee,
              assignees: task.assignees,
            });

            // Open IM channel to DM the assignee properly (fallback to createdBy if assignee is the bot)
            const botId = process.env.SLACK_BOT_USER_ID;
            const dmUser = botId && task.assignee === botId ? task.createdBy : task.assignee;
            const conv = await slack.conversations.open({ users: dmUser });
            const dmChannel = (conv as any).channel?.id || dmUser;

            console.log("[ReminderSend]", { user: dmUser, dmChannel });

            await slack.chat.postMessage({
              channel: dmChannel,
              text: `🔔 Upcoming task: ${task.title}`,
              blocks,
            });

            await prisma.task.update({
              where: { id: task.id },
              data: { deadlineReminderSentAt: new Date() },
            });
            console.log("[ReminderMark]", { id: task.id, setAt: new Date().toISOString() });
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
