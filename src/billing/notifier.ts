import { WebClient } from '@slack/web-api';
import { prisma } from '../lib/prisma';
import { openDm, postMessageWithFeedback } from '../lib/sendHelpers';
import { signBillingToken } from './auth';
import { createLogger } from '../lib/logger';

const log = createLogger('Billing.Notifier');

const PRICE_USD = Number(process.env.BILLING_PRICE_USD_MONTHLY ?? '99');

export type NotifyKind =
  | 'founding_welcome'
  | 'trial_started'
  | 'trial_t3' // 3 days left in trial
  | 'trial_t1' // 1 day left
  | 'trial_expired'
  | 'grace_d1' // grace period day 1
  | 'grace_d4'
  | 'grace_d7'
  | 'suspended'
  | 'reactivated'
  | 'cancelled_confirm';

/**
 * Decide language from any text we have on the install. Defaults English.
 * We pull a recent task title (if any) — that's the most reliable workspace-
 * language signal we have without making LLM calls.
 */
async function pickLang(installationId: string): Promise<'en' | 'zh'> {
  const install = await prisma.slackInstallation.findUnique({
    where: { id: installationId },
  });
  if (!install) return 'en';
  const recentTask = await prisma.task.findFirst({
    where: { teamId: install.teamId, enterpriseId: install.enterpriseId },
    orderBy: { createdAt: 'desc' },
    select: { title: true, description: true },
  });
  const sample = `${recentTask?.title ?? ''} ${recentTask?.description ?? ''}`;
  return /[一-鿿]/.test(sample) ? 'zh' : 'en';
}

function buildUpgradeButton(args: {
  userId: string;
  teamId: string | null;
  enterpriseId: string | null;
  lang: 'en' | 'zh';
}) {
  const token = signBillingToken({
    userId: args.userId,
    teamId: args.teamId,
    enterpriseId: args.enterpriseId,
    intent: 'upgrade',
    ttlMs: 24 * 60 * 60 * 1000, // 24h so a DM clicked tomorrow still works
  });
  return {
    type: 'button',
    style: 'primary',
    text: { type: 'plain_text', text: args.lang === 'zh' ? `升级 $${PRICE_USD}/月` : `Upgrade $${PRICE_USD}/mo` },
    action_id: 'billing_upgrade',
    value: token,
  };
}

function buildManageButton(args: {
  userId: string;
  teamId: string | null;
  enterpriseId: string | null;
  lang: 'en' | 'zh';
}) {
  const token = signBillingToken({
    userId: args.userId,
    teamId: args.teamId,
    enterpriseId: args.enterpriseId,
    intent: 'portal',
    ttlMs: 24 * 60 * 60 * 1000,
  });
  return {
    type: 'button',
    text: { type: 'plain_text', text: args.lang === 'zh' ? '管理订阅' : 'Manage billing' },
    action_id: 'billing_manage',
    value: token,
  };
}

/**
 * Send the right DM for a billing milestone. Always to the installer (the
 * "owner"); never to channels or anyone else. No-ops if the install / DM
 * channel can't be resolved.
 */
export async function sendBillingDM(
  client: WebClient,
  args: { installationId: string; kind: NotifyKind }
): Promise<void> {
  const install = await prisma.slackInstallation.findUnique({
    where: { id: args.installationId },
    include: { billing: true },
  });
  if (!install || !install.installerUserId) return;

  const lang = await pickLang(args.installationId);
  const dm = await openDm(client, install.installerUserId);
  if (!dm) return;

  const ctx = {
    userId: install.installerUserId,
    teamId: install.teamId,
    enterpriseId: install.enterpriseId,
    lang,
  };

  const blocks = buildBlocksFor(args.kind, ctx, install.billing);
  const fallbackText = fallbackTextFor(args.kind, lang);

  try {
    await postMessageWithFeedback(client, {
      channel: dm,
      text: fallbackText,
      blocks,
    });
  } catch (err: any) {
    log.warn('sendBillingDM failed', {
      installationId: args.installationId,
      kind: args.kind,
      error: err?.message ?? String(err),
    });
  }
}

function buildBlocksFor(
  kind: NotifyKind,
  ctx: { userId: string; teamId: string | null; enterpriseId: string | null; lang: 'en' | 'zh' },
  billing: { currentPeriodEnd: Date | null; trialEndsAt: Date | null; graceEndsAt: Date | null } | null
): any[] {
  const zh = ctx.lang === 'zh';
  const upgradeBtn = buildUpgradeButton(ctx);
  const manageBtn = buildManageButton(ctx);

  const sect = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const acts = (els: any[]) => ({ type: 'actions', elements: els });

  switch (kind) {
    case 'founding_welcome':
      return [
        sect(
          zh
            ? "刚上线了付费计划。你的工作区是内测期就装的,所以**永久免费**,什么都不用做。\n\n如果哪天看到付费提示,那是 bug,直接回我。"
            : "We just launched paid plans for new workspaces. Yours was here during beta, so it's marked **lifetime free** — no card, no expiry, nothing for you to do.\n\nIf you ever see a paywall, that's a bug — reply here."
        ),
      ];

    case 'trial_started': {
      const days = billing?.trialEndsAt
        ? Math.ceil((billing.trialEndsAt.getTime() - Date.now()) / 86400000)
        : 14;
      return [
        sect(
          zh
            ? `你在 ${days} 天免费试用期内,全部功能开放,不需要绑卡。\n试用结束前 3 天我会提醒你一次。`
            : `You're on a ${days}-day free trial — full access, no card required.\nI'll remind you 3 days before it ends.`
        ),
      ];
    }

    case 'trial_t3':
      return [
        sect(
          zh
            ? "试用还剩 3 天。想继续追踪手头的任务和员工进度,升级一下:"
            : "3 days left in your trial. To keep tracking tasks and employee progress, upgrade here:"
        ),
        acts([upgradeBtn]),
      ];

    case 'trial_t1':
      return [
        sect(
          zh
            ? "试用最后一天。明天我会停止创建新任务,暂停员工对话 — 你的历史数据和现有任务都还在,升级随时恢复。"
            : "Last day of trial. Tomorrow I'll stop creating new tasks and pause employee check-ins — your existing data stays safe, ready to resume the moment you upgrade."
        ),
        acts([upgradeBtn]),
      ];

    case 'trial_expired':
      return [
        sect(
          zh
            ? "试用结束了。我暂停了新任务创建和员工对话。看板和现有任务都保留着,升级后立刻恢复。"
            : "Trial ended. I've paused new task creation and employee check-ins. Dashboard and existing tasks are preserved — upgrade and I pick up where we left off."
        ),
        acts([upgradeBtn]),
      ];

    case 'grace_d1':
      return [
        sect(
          zh
            ? "本月续费的卡被拒了。我先保持一切运行 7 天,你方便时更新一下支付方式:"
            : "Your card was declined on this month's renewal. I'll keep everything running for 7 days while you sort it out:"
        ),
        acts([manageBtn]),
      ];

    case 'grace_d4':
      return [
        sect(
          zh
            ? "提醒一下,卡片续费还没成功。还有 3 天宽限期。"
            : "Just a heads-up — card still declined. 3 days of grace left."
        ),
        acts([manageBtn]),
      ];

    case 'grace_d7':
      return [
        sect(
          zh
            ? "宽限期最后一天。明天会暂停新任务和员工对话,直到支付方式更新。"
            : "Last day of grace. Tomorrow I pause new tasks and employee check-ins until payment is updated."
        ),
        acts([manageBtn]),
      ];

    case 'suspended':
      return [
        sect(
          zh
            ? "卡片 7 天后依然被拒。我暂停了新任务和员工对话 — 数据都安全,你更新后立刻恢复。"
            : "Card still declined after 7 days. I've paused new tasks and employee check-ins. Data is safe; resume the moment payment updates."
        ),
        acts([manageBtn]),
      ];

    case 'reactivated':
      return [
        sect(
          zh
            ? "回来了。员工对话和新任务都恢复运行了。"
            : "You're back. Employee check-ins and new task creation are running again."
        ),
      ];

    case 'cancelled_confirm': {
      const dateStr = billing?.currentPeriodEnd?.toLocaleDateString(zh ? 'zh-CN' : 'en-US') ?? '';
      return [
        sect(
          zh
            ? `已经取消了。你可以继续用到 ${dateStr}。任何时候想回来都行。`
            : `Got it — you're cancelled. You keep full access until ${dateStr}. Reactivate anytime.`
        ),
        acts([manageBtn]),
      ];
    }
  }
}

function fallbackTextFor(kind: NotifyKind, lang: 'en' | 'zh'): string {
  const z = lang === 'zh';
  switch (kind) {
    case 'founding_welcome':
      return z ? '创始工作区 — 终身免费' : 'Founding workspace — lifetime free';
    case 'trial_started':
      return z ? '试用已开始' : 'Trial started';
    case 'trial_t3':
      return z ? '试用还剩 3 天' : '3 days left in trial';
    case 'trial_t1':
      return z ? '试用最后一天' : 'Last day of trial';
    case 'trial_expired':
      return z ? '试用结束' : 'Trial ended';
    case 'grace_d1':
      return z ? '续费失败,7 天宽限期' : 'Renewal failed — 7 days of grace';
    case 'grace_d4':
      return z ? '续费提醒' : 'Renewal reminder';
    case 'grace_d7':
      return z ? '宽限期最后一天' : 'Last day of grace';
    case 'suspended':
      return z ? '已暂停' : 'Suspended';
    case 'reactivated':
      return z ? '已恢复' : 'Reactivated';
    case 'cancelled_confirm':
      return z ? '已取消' : 'Cancelled';
  }
}

/**
 * Mark that a notification was sent so we don't re-send it on every cron tick.
 */
export async function recordReminderSent(args: {
  installationId: string;
  stage: 'EXPIRING_SOON' | 'FINAL_DAY' | 'EXPIRED';
}): Promise<void> {
  await prisma.workspaceBilling.update({
    where: { installationId: args.installationId },
    data: { lastTrialReminderStage: args.stage },
  });
}

export async function recordGraceReminderSent(args: {
  installationId: string;
  stage: 'D1' | 'D4' | 'D7';
}): Promise<void> {
  await prisma.workspaceBilling.update({
    where: { installationId: args.installationId },
    data: { lastGraceReminderStage: args.stage },
  });
}
