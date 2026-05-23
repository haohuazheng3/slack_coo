import { PrismaClient, Task } from '@prisma/client';
import { buildTaskCardBlocks, RenderableTask } from '../ui/taskCard';
import { detectLanguageFromTexts, getTranslator, Translator } from '../lib/i18n';
import { signDashboardToken } from '../dashboard/auth';

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

export type HomeViewOptions = {
  translator?: Translator;
  /** Pass through so we can mint a signed dashboard URL for the "Open in browser" button. */
  teamId?: string | null;
  enterpriseId?: string | null;
};

export async function buildHomeView(
  prisma: PrismaClient,
  ownerId: string,
  optionsOrTranslator?: HomeViewOptions | Translator
) {
  // Back-compat: older call sites pass a bare Translator as the 3rd arg.
  const options: HomeViewOptions =
    optionsOrTranslator && 'language' in (optionsOrTranslator as Translator)
      ? { translator: optionsOrTranslator as Translator }
      : ((optionsOrTranslator as HomeViewOptions) ?? {});
  let { translator } = options;
  const { teamId = null, enterpriseId = null } = options;
  const tasks = await prisma.task.findMany({
    where: {
      OR: [{ initiator: ownerId }, { createdBy: ownerId }],
    },
    orderBy: [{ status: 'asc' }, { time: 'asc' }],
    take: 200,
  });

  // Detect language from the owner's own task content if the caller didn't
  // pre-supply a translator. The Home Tab has no configured language — it
  // mirrors how this workspace actually talks.
  if (!translator) {
    const samples: Array<string | null> = [];
    for (const t of tasks) {
      samples.push(t.title);
      samples.push(t.description);
      samples.push(t.lastProgressSummary);
    }
    translator = getTranslator(detectLanguageFromTexts(samples));
  }

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
  ];

  // "Open in browser" — only render when we can actually produce a working URL.
  // Needs both BASE_URL (so the link resolves) and teamId (so the token has
  // a workspace to scope to). Skip silently otherwise — better no button than
  // a broken one.
  const baseUrl = (process.env.BASE_URL ?? '').replace(/\/$/, '');
  if (baseUrl && teamId) {
    const token = signDashboardToken({ userId: ownerId, teamId, enterpriseId });
    const dashboardUrl = `${baseUrl}/dashboard?token=${encodeURIComponent(token)}`;
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: translator.t('home.openInBrowser') },
          style: 'primary',
          url: dashboardUrl,
          action_id: 'open_dashboard',
        },
      ],
    });
    blocks.push(context(translator.t('home.openInBrowserHint')));
  }

  blocks.push(divider());

  // First-time onboarding: if the owner has no tasks yet, show a short walkthrough card
  // at the top instead of just an empty board. Disappears the moment a task exists.
  // Per product brief P1: explain "talk to me, no forms" rather than letting them guess.
  if (tasks.length === 0) {
    blocks.push(buildOnboardingCard(translator));
    blocks.push(divider());
  } else {
    blocks.push(context(buildHeaderSummary(groups, translator)));
    blocks.push(divider());
  }

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

function buildOnboardingCard(translator: Translator): HomeViewBlock {
  // Short, no-form onboarding — fulfills the product brief's "make the first minute feel
  // like 'just talk', not 'enroll your roster'" principle (red line #3 + P1 onboarding).
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*${translator.t('onboarding.title')}*`,
        ``,
        translator.t('onboarding.body'),
        ``,
        translator.t('onboarding.example1'),
        translator.t('onboarding.example2'),
        translator.t('onboarding.example3'),
        ``,
        `_${translator.t('onboarding.footer')}_`,
      ].join('\n'),
    },
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
