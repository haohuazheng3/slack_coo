import { PrismaClient, Task } from '@prisma/client';
import { buildTaskCardBlocks, RenderableTask } from '../ui/taskCard';
import { detectLanguageFromTexts, getTranslator, Translator } from '../lib/i18n';
import { signDashboardToken } from '../dashboard/auth';
import { isWorkspacePaid, GateResult } from '../billing/featureGate';
import { signBillingToken } from '../billing/auth';

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

  // Billing banner — render at the top of the Home tab if there's anything to
  // say. Founding workspaces get a quiet badge; trialing gets a thin context
  // line; expiring soon turns amber; expired/suspended turns red with the
  // Upgrade button as the primary action. Only the owner ever sees their own
  // Home tab, so this is owner-visible by Slack's own design.
  const lang = (translator as any).language === 'zh' || /[一-鿿]/.test(translator.t('home.title'))
    ? 'zh'
    : 'en';
  const billingBanner = await buildBillingBanner({
    ownerId,
    teamId,
    enterpriseId,
    lang,
  });
  if (billingBanner.length > 0) {
    blocks.push(...billingBanner);
    blocks.push(divider());
  }

  // "Open in browser" — only render when we can actually produce a working URL.
  // Needs both BASE_URL (so the link resolves) and teamId (so the token has
  // a workspace to scope to). Skip silently otherwise — better no button than
  // a broken one.
  const baseUrl = (process.env.BASE_URL ?? '').replace(/\/$/, '');
  if (baseUrl && teamId) {
    const token = signDashboardToken({ userId: ownerId, teamId, enterpriseId });
    const dashboardUrl = `${baseUrl}/dashboard?token=${encodeURIComponent(token)}`;
    const actionElements: any[] = [
      {
        type: 'button',
        text: { type: 'plain_text', text: translator.t('home.openInBrowser') },
        style: 'primary',
        url: dashboardUrl,
        action_id: 'open_dashboard',
      },
    ];

    // Beta: feedback view is open to anyone in the workspace (signed-token
    // gated, but no installer-only check). Every Home tab gets the 🐞 button.
    const feedbackUrl = `${baseUrl}/feedback?token=${encodeURIComponent(token)}`;
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🐞 Feedback' },
      url: feedbackUrl,
      action_id: 'open_feedback',
    });

    blocks.push({ type: 'actions', elements: actionElements });
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

/**
 * Build the billing banner blocks at the top of the Home tab.
 *
 * Maps gate state → banner:
 *   - founding   → small "Founding workspace — free forever" context line
 *   - active     → thin "Pro · renews [date]" context with Manage button
 *   - trialing >3d left → thin "Trial — N days left" context
 *   - trialing ≤3d left → amber section + Upgrade button (primary)
 *   - trialing ≤1d left → red section + Upgrade button
 *   - grace      → amber "Payment failed — update card" + Manage
 *   - cancelled_active → gray "Cancelled — access until [date]"
 *   - expired / suspended → red "Subscription needed" + Upgrade
 *   - no_billing_row / billing_disabled → no banner (clean slate)
 *
 * Only one of the buttons (Upgrade or Manage) appears, never both — billing
 * actions are mutually exclusive in any given state.
 */
async function buildBillingBanner(args: {
  ownerId: string;
  teamId: string | null;
  enterpriseId: string | null;
  lang: 'en' | 'zh';
}): Promise<HomeViewBlock[]> {
  const gate = await isWorkspacePaid({ teamId: args.teamId, enterpriseId: args.enterpriseId });
  const zh = args.lang === 'zh';

  if (gate.isGrandfathered) {
    return [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: zh
              ? '🌟 *创始工作区* — 终身免费,感谢内测期支持'
              : '🌟 *Founding workspace* — free forever, thanks for being in beta',
          },
        ],
      },
    ];
  }

  if (gate.reason === 'no_billing_row' || gate.reason === 'billing_disabled') {
    return [];
  }

  if (gate.reason === 'active') {
    const dateStr = gate.expiresAt
      ? gate.expiresAt.toLocaleDateString(zh ? 'zh-CN' : 'en-US')
      : '';
    const text = zh ? `Pro · 下次续费 ${dateStr}` : `Pro · renews ${dateStr}`;
    return [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text }],
      },
      buildBillingActionsBlock(args, 'manage'),
    ];
  }

  if (gate.reason === 'cancelled_active') {
    const dateStr = gate.expiresAt
      ? gate.expiresAt.toLocaleDateString(zh ? 'zh-CN' : 'en-US')
      : '';
    return [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: zh ? `_已取消 · 访问到 ${dateStr}_` : `_Cancelled · access until ${dateStr}_`,
          },
        ],
      },
      buildBillingActionsBlock(args, 'manage'),
    ];
  }

  if (gate.reason === 'trialing') {
    const days = gate.expiresAt
      ? Math.max(0, Math.ceil((gate.expiresAt.getTime() - Date.now()) / 86400000))
      : 14;
    if (days > 3) {
      return [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: zh ? `_试用 — 还剩 ${days} 天_` : `_Trial — ${days} days left_`,
            },
          ],
        },
      ];
    }
    if (days > 1) {
      return [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: zh
              ? `*试用还剩 ${days} 天* — 想继续追踪手头的任务和员工进度,升级一下:`
              : `*${days} days left in trial* — keep tracking tasks and employee progress:`,
          },
        },
        buildBillingActionsBlock(args, 'upgrade'),
      ];
    }
    // Final day
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: zh
            ? '🔴 *试用最后一天* — 明天会暂停新任务和员工对话,直到升级。'
            : "🔴 *Last day of trial* — tomorrow I pause new tasks and employee check-ins until you upgrade.",
        },
      },
      buildBillingActionsBlock(args, 'upgrade'),
    ];
  }

  if (gate.reason === 'grace') {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: zh
            ? '🟡 *续费失败 — 宽限期内* — 现在更新卡片就行。'
            : '🟡 *Payment failed — within grace period.* Update your card to keep things running.',
        },
      },
      buildBillingActionsBlock(args, 'manage'),
    ];
  }

  if (gate.reason === 'expired' || gate.reason === 'suspended') {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: zh
            ? '🔴 *已暂停* — 新任务和员工对话已停止。看板和现有任务都保留着,升级后立刻恢复。'
            : "🔴 *Paused* — new tasks and employee check-ins stopped. Dashboard and existing tasks preserved; upgrade to resume.",
        },
      },
      buildBillingActionsBlock(args, 'upgrade'),
    ];
  }

  return [];
}

function buildBillingActionsBlock(
  args: { ownerId: string; teamId: string | null; enterpriseId: string | null; lang: 'en' | 'zh' },
  kind: 'upgrade' | 'manage'
): HomeViewBlock {
  const tokenArgs = {
    userId: args.ownerId,
    teamId: args.teamId,
    enterpriseId: args.enterpriseId,
    intent: kind === 'upgrade' ? ('upgrade' as const) : ('portal' as const),
  };
  const token = signBillingToken(tokenArgs);
  const zh = args.lang === 'zh';
  const price = Number(process.env.BILLING_PRICE_USD_MONTHLY ?? '99');

  if (kind === 'upgrade') {
    return {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: zh ? `升级 — $${price}/月` : `Upgrade — $${price}/mo` },
          action_id: 'billing_upgrade',
          value: token,
        },
      ],
    };
  }
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: zh ? '管理订阅' : 'Manage billing' },
        action_id: 'billing_manage',
        value: token,
      },
    ],
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
