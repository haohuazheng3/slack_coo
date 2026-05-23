import { PrismaClient } from '@prisma/client';
import { buildTaskCardBlocks, RenderableTask } from '../ui/taskCard';
import { detectLanguageFromTexts, getTranslator, Translator } from '../lib/i18n';

export type TaskListOptions = {
  showCompleted?: boolean;
  showAll?: boolean;
  translator?: Translator;
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
  let { translator } = options;

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

  if (!translator) {
    const samples: Array<string | null> = [];
    for (const t of tasks) {
      samples.push(t.title);
      samples.push(t.description);
      samples.push(t.lastProgressSummary);
    }
    translator = getTranslator(detectLanguageFromTexts(samples));
  }

  if (tasks.length === 0) {
    const emptyText = showCompleted
      ? translator.t('list.emptyCompleted')
      : showAll
        ? translator.t('list.emptyAll')
        : translator.t('list.empty');
    return { text: emptyText };
  }

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: showCompleted
          ? translator.t('list.headerCompleted')
          : translator.t('list.headerPending'),
      },
    },
    { type: 'divider' },
  ];

  for (const t of tasks) {
    const renderable = t as RenderableTask;
    const cardBlocks = buildTaskCardBlocks(renderable, { variant: 'list', translator });
    blocks.push(...cardBlocks);
    blocks.push({ type: 'divider' });
  }

  return {
    text: translator.t('list.summary', { n: tasks.length }),
    blocks,
  };
}
