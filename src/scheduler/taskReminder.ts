import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { postTaskReminder } from '../slack/postTaskReminder';

const prisma = new PrismaClient();

export function startTaskReminderScheduler() {
  cron.schedule('* * * * *', async () => {
    console.log("⏰ Checking task reminders...");

    const now = new Date();
    const oneMinuteLater = new Date(now.getTime() + 60 * 1000);
    const oneMinuteBefore = new Date(now.getTime() - 60 * 1000);

    try {
      const tasks = await prisma.task.findMany({
        where: {
          completed: false,
          time: { gte: oneMinuteBefore, lte: oneMinuteLater }
        }
      });

      for (const task of tasks) {
        await postTaskReminder({
          id: task.id,
          title: task.title,
          time: task.time,
          assignee: task.assignee,
          assignees: task.assignees,
          channelId: task.channelId
        });
      }
    } catch (e) {
      console.error("❌ Failed to query tasks:", e);
    }
  });
}
