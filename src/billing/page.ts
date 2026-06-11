import { prisma } from '../lib/prisma';
import { isWorkspacePaid, GateResult } from './featureGate';

/**
 * Plan summary page at GET /billing?token=... — signed-token-gated.
 *
 * Shows current plan + status + next action (Upgrade or Manage billing).
 * Founding workspaces see "free, lifetime" with no buttons. The Upgrade /
 * Manage buttons POST to internal routes that mint Stripe Checkout / Portal
 * sessions and 302-redirect — keeping all Stripe secrets server-side.
 */

const PRICE_USD = Number(process.env.BILLING_PRICE_USD_MONTHLY ?? '99');

export async function renderBillingPageHtml(args: {
  userId: string;
  teamId: string | null;
  enterpriseId: string | null;
  token: string;
  lang: 'en' | 'zh';
}): Promise<string> {
  const gate = await isWorkspacePaid({ teamId: args.teamId, enterpriseId: args.enterpriseId });

  const install = await prisma.slackInstallation.findFirst({
    where: { teamId: args.teamId, enterpriseId: args.enterpriseId },
    include: { billing: true },
  });

  const planLabel = describePlan(gate, args.lang);
  const subtitle = describeSubtitle(gate, install?.billing?.currentPeriodEnd ?? null, args.lang);

  // Founding workspaces see no buttons — just the badge.
  let actionsHtml = '';
  if (gate.isGrandfathered) {
    actionsHtml = '';
  } else if (gate.reason === 'active' || gate.reason === 'grace' || gate.reason === 'cancelled_active') {
    actionsHtml = `<a class="btn primary" href="/billing/manage?token=${encodeURIComponent(args.token)}">${
      args.lang === 'zh' ? '管理订阅' : 'Manage subscription'
    }</a>`;
  } else {
    // Trialing, expired, suspended, no_billing_row — all show Upgrade.
    actionsHtml = `<a class="btn primary" href="/billing/upgrade?token=${encodeURIComponent(args.token)}">${
      args.lang === 'zh' ? `升级 — $${PRICE_USD}/月` : `Upgrade — $${PRICE_USD}/month`
    }</a>`;
  }

  const included =
    args.lang === 'zh'
      ? [
          '不限任务数,不限团队规模',
          'Claude Opus 4.7 主交互 + Haiku 4.5 后台判断',
          'Slack 频道、DM、Home tab 全覆盖',
          '中英文自动切换',
          '网页看板:任务卡片、工作量热力图、活动时间线',
          '员工进度自动翻译给老板',
          '智能沉默预警',
          '邮件支持(48 小时内回复)',
        ]
      : [
          'Unlimited tasks, unlimited team members',
          'Claude Opus 4.7 for orchestration + Haiku 4.5 for background',
          'Slack channels, DMs, and Home tab',
          'Auto-switching between English and 中文',
          'Web dashboard: task cards, workload heatmap, activity timeline',
          'Employee progress auto-translated for the owner',
          'Smart silence detection',
          'Email support (48h response)',
        ];

  const includedHtml = included.map((line) => `<li>${escapeHtml(line)}</li>`).join('');

  const title = args.lang === 'zh' ? '订阅 — Aiptima' : 'Billing — Aiptima';
  const headingEn = 'Your plan';
  const headingZh = '你的订阅';

  return `<!doctype html>
<html lang="${args.lang === 'zh' ? 'zh' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafbfc; color: #0a2540; margin: 0; padding: 0; }
    .wrap { max-width: 640px; margin: 8vh auto; padding: 0 24px; }
    .card { background: white; border-radius: 12px; padding: 40px 36px; box-shadow: 0 2px 16px rgba(10, 37, 64, 0.08); }
    h1 { font-size: 24px; margin: 0 0 8px 0; font-weight: 600; }
    .plan { font-size: 32px; font-weight: 600; color: #635bff; margin: 12px 0 4px 0; }
    .subtitle { font-size: 15px; color: #6b7280; margin: 0 0 24px 0; }
    .included { list-style: none; padding: 0; margin: 28px 0 32px 0; }
    .included li { padding: 8px 0 8px 28px; position: relative; color: #425466; }
    .included li::before { content: "✓"; position: absolute; left: 0; color: #635bff; font-weight: 700; }
    .btn { display: inline-block; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; transition: background 0.15s; }
    .btn.primary { background: #635bff; color: white; }
    .btn.primary:hover { background: #524acc; }
    .founding-badge { display: inline-block; background: #ffe9b0; color: #6b4f00; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 500; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${args.lang === 'zh' ? headingZh : headingEn}</h1>
      <div class="plan">${escapeHtml(planLabel)}</div>
      <p class="subtitle">${escapeHtml(subtitle)}</p>
      <ul class="included">${includedHtml}</ul>
      ${actionsHtml}
    </div>
  </div>
</body>
</html>`;
}

function describePlan(gate: GateResult, lang: 'en' | 'zh'): string {
  if (gate.isGrandfathered) {
    return lang === 'zh' ? '创始工作区 — 免费' : 'Founding workspace — free';
  }
  switch (gate.reason) {
    case 'active':
      return lang === 'zh' ? `Pro — $${PRICE_USD}/月` : `Pro — $${PRICE_USD}/month`;
    case 'trialing':
      return lang === 'zh' ? '试用中' : 'Trial';
    case 'grace':
      return lang === 'zh' ? '付款失败 — 宽限期' : 'Payment failed — grace period';
    case 'cancelled_active':
      return lang === 'zh' ? '已取消(继续访问到周期末)' : 'Cancelled (access through period end)';
    case 'expired':
      return lang === 'zh' ? '试用已结束' : 'Trial ended';
    case 'suspended':
      return lang === 'zh' ? '已暂停' : 'Suspended';
    default:
      return lang === 'zh' ? '未订阅' : 'Not subscribed';
  }
}

function describeSubtitle(gate: GateResult, currentPeriodEnd: Date | null, lang: 'en' | 'zh'): string {
  if (gate.isGrandfathered) {
    return lang === 'zh'
      ? '感谢你在内测期支持 Aiptima — 永久免费。'
      : 'Thank you for backing Aiptima during beta — free forever, no card needed.';
  }
  if (gate.reason === 'active' && currentPeriodEnd) {
    const dateStr = currentPeriodEnd.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US');
    return lang === 'zh' ? `下次续费:${dateStr}` : `Renews on ${dateStr}`;
  }
  if (gate.reason === 'trialing' && gate.expiresAt) {
    const days = Math.max(0, Math.ceil((gate.expiresAt.getTime() - Date.now()) / 86400000));
    return lang === 'zh' ? `试用剩余 ${days} 天` : `${days} days left in trial`;
  }
  if (gate.reason === 'grace' && gate.expiresAt) {
    const days = Math.max(0, Math.ceil((gate.expiresAt.getTime() - Date.now()) / 86400000));
    return lang === 'zh'
      ? `卡片被拒。还有 ${days} 天宽限期 — 现在更新支付方式继续使用。`
      : `Card declined. ${days} days of grace remaining — update payment to continue.`;
  }
  if (gate.reason === 'cancelled_active' && gate.expiresAt) {
    const dateStr = gate.expiresAt.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US');
    return lang === 'zh' ? `访问到:${dateStr}` : `Access through ${dateStr}`;
  }
  return lang === 'zh' ? `$${PRICE_USD}/月,14 天免卡试用` : `$${PRICE_USD}/month, 14-day no-card trial`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
