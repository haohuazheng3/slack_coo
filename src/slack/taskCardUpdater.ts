import { Task } from '@prisma/client';
import { WebClient } from '@slack/web-api';
import { buildTaskCardBlocks, buildTaskFallbackText, RenderableTask } from '../ui/taskCard';
import { buildHomeView } from './homeView';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const log = createLogger('TaskCardUpdater');

/**
 * Re-render the channel card for a task in place (using stored channelMessageTs).
 * Falls back to posting a new card if the original message ts is missing.
 * Returns the messageTs of the (now) live card so the caller can persist it.
 */
export async function syncChannelTaskCard(
  client: WebClient,
  task: Task
): Promise<string | null> {
  if (!task.channelId) return null;

  const renderable = task as RenderableTask;
  const blocks = buildTaskCardBlocks(renderable, { variant: 'channel' });
  const text = buildTaskFallbackText(renderable);

  try {
    if (task.channelMessageTs) {
      await client.chat.update({
        channel: task.channelId,
        ts: task.channelMessageTs,
        text,
        blocks,
      });
      return task.channelMessageTs;
    }

    const res = await client.chat.postMessage({
      channel: task.channelId,
      thread_ts: task.threadTs ?? undefined,
      text,
      blocks,
    });
    return (res as any).ts ?? null;
  } catch (err: any) {

    if (
      task.channelMessageTs &&
      typeof err?.data?.error === 'string' &&
      (err.data.error === 'message_not_found' || err.data.error === 'cant_update_message')
    ) {
      log.warn('Original card not found, reposting', { taskId: task.id, channelId: task.channelId });
      try {
        const res = await client.chat.postMessage({
          channel: task.channelId,
          thread_ts: task.threadTs ?? undefined,
          text,
          blocks,
        });
        return (res as any).ts ?? null;
      } catch (e) {
        log.error('Failed to repost channel card', { taskId: task.id, error: String(e) });
        return null;
      }
    }
    log.error('Failed to update channel card', { taskId: task.id, error: String(err) });
    return null;
  }
}

/**
 * Persist the latest channelMessageTs onto the task row (only if changed).
 */
export async function persistChannelMessageTs(taskId: string, ts: string | null) {
  if (!ts) return;
  await prisma.task.update({
    where: { id: taskId },
    data: { channelMessageTs: ts },
  });
}

/**
 * Publishes a fresh App Home view to the given owner. Safe to call frequently.
 */
export async function refreshOwnerHome(client: WebClient, ownerId: string) {
  try {
    const view = await buildHomeView(prisma, ownerId);
    await client.views.publish({ user_id: ownerId, view });
  } catch (err) {
    log.error('Failed to publish home view', { ownerId, error: String(err) });
  }
}
