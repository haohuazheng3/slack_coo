import { PrismaClient, Task } from '@prisma/client';
import { buildTaskCardBlocks, RenderableTask } from '../ui/taskCard';
import { defaultTranslator, Translator } from '../lib/i18n';

type HomeViewBlock = {
  type: string;
  [key: string]: any;
};

function header(text: string): HomeViewBlock {
  return { type: 'header', text: { type: 'plain_text', text } };
}
function context(markdown: string): HomeViewBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: markdown }] };
}
function divider(): HomeViewBlock {
  return { type: 'divider' };
}
function sectionGroup(title: string, count: number): HomeViewBlock {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${title}* — ${count}` },
  };
}

export async function buildHomeView(
  prisma: PrismaClient,
  ownerId: string,
  translator: Translator = defaultTranslator
) {
  const tasks = await prisma.task.findMany({
    where: {
      OR: [{ initiator: ownerId }, { createdBy: ownerId }],
    },
    orderBy: [{ status: 'asc' }, { time: 'asc' }],
    take: 200,
  });

  const now = Date.now();
  const groups = {
    needsClarification: [] as Task[],
    inFlight: [] as Task[],
    blocked: [] as Task[],
    overdue: [] as Task[],
    completed: [] as Task[],
    other: [] as Task[],
  };

  for (const t of tasks) {
    if (t.status === 'PENDING_CLARIFICATION') groups.needsClarification.push(t);
    else if (t.status === 'BLOCKED') groups.blocked.push(t);
    else if (t.status === 'COMPLETED') groups.completed.push(t);
    else if (t.status === 'CANCELLED' || t.status === 'FAILED') groups.other.push(t);
    else if (t.time.getTime() < now) groups.overdue.push(t);
    else groups.inFlight.push(t);
  }

  const blocks: HomeViewBlock[] = [
    header(translator.t('home.title')),
    context(translator.t('home.hint')),
    divider(),
    context(buildHeaderSummary(groups, translator)),
    divider(),
  ];

  const renderGroup = (label: string, list: Task[]) => {
    if (list.length === 0) return;
    blocks.push(sectionGroup(label, list.length));
    for (const t of list) {
      const renderable = t as RenderableTask;
      const cardBlocks = buildTaskCardBlocks(renderable, {
        variant: 'home',
        showActions: false,
        translator,
      });
      blocks.push(...cardBlocks);
      blocks.push(divider());
    }
  };

  renderGroup(translator.t('home.group.needsInput'), groups.needsClarification);
  renderGroup(translator.t('home.group.inFlight'), groups.inFlight);
  renderGroup(translator.t('home.group.blocked'), groups.blocked);
  renderGroup(translator.t('home.group.overdue'), groups.overdue);
  renderGroup(translator.t('home.group.completed'), groups.completed.slice(0, 10));
  renderGroup(translator.t('home.group.other'), groups.other.slice(0, 10));

  if (tasks.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: translator.t('home.empty') },
    });
  }

  return {
    type: 'home' as const,
    blocks,
  };
}

function buildHeaderSummary(groups: { [k: string]: Task[] }, translator: Translator): string {
  const parts: string[] = [];
  if (groups.needsClarification.length)
    parts.push(translator.t('home.summary.needInput', { n: groups.needsClarification.length }));
  if (groups.inFlight.length)
    parts.push(translator.t('home.summary.inFlight', { n: groups.inFlight.length }));
  if (groups.blocked.length)
    parts.push(translator.t('home.summary.blocked', { n: groups.blocked.length }));
  if (groups.overdue.length)
    parts.push(translator.t('home.summary.overdue', { n: groups.overdue.length }));
  if (groups.completed.length)
    parts.push(translator.t('home.summary.done', { n: groups.completed.length }));
  return parts.length ? parts.join('  •  ') : translator.t('home.summary.clean');
}
