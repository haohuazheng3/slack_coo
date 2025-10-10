import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { postTaskReminder } from '../slack/postTaskReminder';

const prisma = new PrismaClient();

export function startTaskReminderScheduler() {
  cron.schedule('* * * * *', async () => {
    console.log("⏰ Checking task reminders...");

    const now = new Date();
    const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const twoHoursBefore = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    try {
      const tasks = await prisma.task.findMany({
        where: {
          completed: false,
          time: { gte: twoHoursBefore, lte: twoHoursLater }
        }
      });

      for (const task of tasks) {
        await postTaskReminder({
          id: task.id,
          title: task.title,
          time: task.time,
          assignee: task.assignee,
          channelId: task.channelId
        });
      }
    } catch (e) {
      console.error("❌ Failed to query tasks:", e);
    }
  });
}
