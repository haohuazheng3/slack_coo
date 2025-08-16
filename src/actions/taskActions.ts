import { App } from '@slack/bolt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Utility: send an ephemeral confirmation message visible only to the user who clicked
async function ephemeralOk(client: any, channel: string, user: string, text: string) {
  await client.chat.postEphemeral({ channel, user, text });
}

export function registerTaskActions(app: App) {
  // Complete ✅
  app.action('task_complete', async ({ ack, body, client, action }) => {
    await ack(); // Slack’s 3-second rule

    const taskId = (action as any).value as string;
    const userId = (body as any).user.id;
    const channelId = (body as any).channel?.id;

    try {
      await prisma.task.update({
        where: { id: taskId },
        data: { completed: true }
      });

      if (channelId) {
        await ephemeralOk(client, channelId, userId, `✅ Task marked as complete (ID: ${taskId})`);
      }
    } catch (e) {
      if (channelId) {
        await ephemeralOk(client, channelId, userId, `❌ Update failed, please try again later`);
      }
      console.error('task_complete failed:', e);
    }
  });

  // Delay 15m
  app.action('task_delay_15m', async ({ ack, body, client, action }) => {
    await ack();

    const taskId = (action as any).value as string;
    const userId = (body as any).user.id;
    const channelId = (body as any).channel?.id;

    try {
      const t = await prisma.task.findUnique({ where: { id: taskId } });
      if (!t) throw new Error('Task not found');

      const newTime = new Date(t.time.getTime() + 15 * 60 * 1000);
      await prisma.task.update({
        where: { id: taskId },
        data: { time: newTime }
      });

      if (channelId) {
        await ephemeralOk(client, channelId, userId, `⏱ Delayed by 15 minutes (new time: ${newTime.toLocaleString()})`);
      }
    } catch (e) {
      if (channelId) {
        await ephemeralOk(client, channelId, userId, `❌ Delay failed, please try again later`);
      }
      console.error('task_delay_15m failed:', e);
    }
  });

  // Delay 60m
  app.action('task_delay_60m', async ({ ack, body, client, action }) => {
    await ack();

    const taskId = (action as any).value as string;
    const userId = (body as any).user.id;
    const channelId = (body as any).channel?.id;

    try {
      const t = await prisma.task.findUnique({ where: { id: taskId } });
      if (!t) throw new Error('Task not found');

      const newTime = new Date(t.time.getTime() + 60 * 60 * 1000);
      await prisma.task.update({
        where: { id: taskId },
        data: { time: newTime }
      });

      if (channelId) {
        await ephemeralOk(client, channelId, userId, `⏱ Delayed by 1 hour (new time: ${newTime.toLocaleString()})`);
      }
    } catch (e) {
      if (channelId) {
        await ephemeralOk(client, channelId, userId, `❌ Delay failed, please try again later`);
      }
      console.error('task_delay_60m failed:', e);
    }
  });
}
