/**
 * Static-ish HTML for the post-Checkout return pages. Visual style mirrors
 * src/installation/pages.ts (light, blue accent, sentence-case copy).
 *
 * IMPORTANT: these pages render whatever they got from Stripe (success vs
 * cancel) but DO NOT trust the URL — the route also re-verifies the signed
 * billing token before rendering, and for success pulls the Session from
 * Stripe to confirm payment actually went through.
 */

export function renderReturnSuccessHtml(args: { lang: 'en' | 'zh'; teamId: string | null }): string {
  const slackDeepLink = args.teamId
    ? `slack://app?team=${encodeURIComponent(args.teamId)}&tab=home`
    : 'slack://open';

  if (args.lang === 'zh') {
    return baseHtml({
      title: '已订阅 — Aiptima',
      heading: '订阅完成 ✓',
      body: `<p>感谢支持。我这就回 Slack 继续干活了。</p>
        <p>如果浏览器没自动跳回 Slack，<a class="back" href="${slackDeepLink}">点这里返回 Slack</a>。</p>`,
    });
  }
  return baseHtml({
    title: 'You are in — Aiptima',
    heading: 'You are in ✓',
    body: `<p>Thanks. Heading back to Slack to pick up where we left off.</p>
      <p>If your browser didn't bounce you back, <a class="back" href="${slackDeepLink}">return to Slack</a>.</p>`,
  });
}

export function renderReturnCancelHtml(args: { lang: 'en' | 'zh'; teamId: string | null }): string {
  const slackDeepLink = args.teamId
    ? `slack://app?team=${encodeURIComponent(args.teamId)}&tab=home`
    : 'slack://open';
  if (args.lang === 'zh') {
    return baseHtml({
      title: '没问题 — Aiptima',
      heading: '没问题',
      body: `<p>等你想好了再回来。看板和任务都还在。</p>
        <p><a class="back" href="${slackDeepLink}">回 Slack</a></p>`,
    });
  }
  return baseHtml({
    title: 'No rush — Aiptima',
    heading: 'No rush',
    body: `<p>Here when you're ready. Your dashboard and tasks are all preserved.</p>
      <p><a class="back" href="${slackDeepLink}">Back to Slack</a></p>`,
  });
}

function baseHtml(args: { title: string; heading: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(args.title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fafbfc; color: #0a2540; margin: 0; padding: 0; }
    .card { max-width: 480px; margin: 12vh auto; padding: 48px 40px; background: white; border-radius: 12px; box-shadow: 0 2px 16px rgba(10, 37, 64, 0.08); }
    h1 { font-size: 28px; margin: 0 0 16px 0; font-weight: 600; }
    p { font-size: 16px; line-height: 1.6; color: #425466; }
    a.back { color: #635bff; text-decoration: none; font-weight: 500; }
    a.back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(args.heading)}</h1>
    ${args.body}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
