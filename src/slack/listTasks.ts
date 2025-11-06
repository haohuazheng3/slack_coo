import { PrismaClient, Task } from '@prisma/client';
import { toSlackMention } from '../utils/assignee';

export type TaskListOptions = {
  showCompleted?: boolean;
  showAll?: boolean;
};

export type TaskListMessage = {
  text: string;
  blocks?: any[];
};

export async function buildTaskListMessage(
  prisma: PrismaClient,
  userId: string,
  options: TaskListOptions = {}
): Promise<TaskListMessage> {
  const { showCompleted = false, showAll = false } = options;

  const whereClause: any = {
    OR: [
      { createdBy: userId },
      { assignee: userId },
      { assignees: { has: userId } },
    ],
  };

  if (!showAll) {
    whereClause.completed = showCompleted ? true : false;
  }

  const tasks = await prisma.task.findMany({
    where: whereClause,
    orderBy: { time: 'desc' },
    take: 20,
  });

  if (tasks.length === 0) {
    const emptyText = showCompleted
      ? '📋 You have no completed tasks!'
      : showAll
      ? '📋 You have no tasks!'
      : '📋 You have no pending tasks!';
    return { text: emptyText };
  }

  const completedCount = tasks.filter((t) => t.completed).length;
  const pendingCount = tasks.filter((t) => !t.completed).length;

  const statusText = showCompleted
    ? `Completed Tasks (${completedCount})`
    : showAll
    ? `All Tasks (${pendingCount} pending, ${completedCount} completed)`
    : `Pending Tasks (${pendingCount})`;

  const taskBlocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📋 *${statusText}*`,
      },
    },
    { type: 'divider' },
  ];

  for (const task of tasks) {
    const blocks = buildTaskBlocks(task);
    taskBlocks.push(...blocks);
  }

  return {
    text: `You have ${tasks.length} tasks`,
    blocks: taskBlocks,
  };
}

function buildTaskBlocks(task: Task): any[] {
  const assigneeMention = toSlackMention(task.assignee);
  const timeText = task.time.toLocaleString();
  const assigneesText = Array.isArray(task.assignees) && task.assignees.length > 0
    ? task.assignees.map((a) => toSlackMention(a)).join(', ')
    : assigneeMention;

  const statusEmoji = task.completed ? '✅' : '⏰';
  const statusLabel = task.completed ? ' (Completed)' : '';

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${task.completed ? '~' : ''}*${task.title}*${task.completed ? '~' : ''}${statusLabel}\n${statusEmoji} ${timeText}\n👤 ${assigneesText}`,
      },
    },
  ];

  const actionElements: any[] = [];

  if (!task.completed) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '✅ Complete' },
      style: 'primary',
      action_id: 'task_complete',
      value: task.id,
    });
  }

  actionElements.push({
    type: 'button',
    text: { type: 'plain_text', text: '🗑️' },
    action_id: 'task_delete',
    value: task.id,
  });

  if (actionElements.length > 0) {
    blocks.push({
      type: 'actions',
      elements: actionElements,
    });
  }

  return blocks;
}

