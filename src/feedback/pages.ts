/**
 * Admin web view at `/feedback?token=…`.
 *
 * The job of this page: show the developer (= workspace installer) every
 * feedback report, and give them a single "copy as markdown" button per
 * report that produces a clipboard-ready block they can paste straight into
 * Claude for diagnosis.
 *
 * Auth reuses the dashboard's HMAC token mechanism — same signing key,
 * same expiry. We additionally check that the token's `uid` matches the
 * workspace installer (not just any user) before showing reports.
 *
 * Visual language: same blue Stripe-ish palette as the install landing /
 * dashboard pages — designed for consistency, not to be its own thing.
 */

import type { FeedbackReport } from '@prisma/client';

export type FeedbackPageInput = {
  reports: FeedbackReport[];
  workspaceName: string | null;
  baseUrl: string;
  /** Whether to render the "mark triaged" / "mark resolved" controls. */
  showActions: boolean;
};

const STYLES = `
<style>
  :root {
    --bg: #ffffff;
    --bg-soft: #f8fafc;
    --ink: #0f172a;
    --ink-muted: #475569;
    --ink-faint: #94a3b8;
    --border: #e2e8f0;
    --border-soft: #f1f5f9;
    --brand: #2563eb;
    --brand-hover: #1d4ed8;
    --brand-soft: #eff6ff;
    --amber: #d97706;
    --amber-soft: #fffbeb;
    --green: #16a34a;
    --green-soft: #f0fdf4;
    --red: #dc2626;
    --red-soft: #fef2f2;
    --shadow-card: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 32px rgba(15, 23, 42, 0.06);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI",
                 system-ui, sans-serif;
    color: var(--ink);
    background: var(--bg-soft);
    line-height: 1.5;
  }
  nav.top {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 32px;
    max-width: 1280px; margin: 0 auto;
    background: var(--bg);
    border-bottom: 1px solid var(--border-soft);
  }
  .brand-mark {
    display: inline-flex; align-items: center; gap: 10px;
    font-weight: 700; font-size: 16px; color: var(--ink);
  }
  .brand-dot {
    width: 22px; height: 22px; border-radius: 6px;
    background: linear-gradient(135deg, var(--brand) 0%, #4f46e5 100%);
  }
  .shell { max-width: 1280px; margin: 0 auto; padding: 32px 32px 64px; }

  h1 {
    font-size: 28px; font-weight: 700; letter-spacing: -0.02em;
    margin: 0 0 8px; color: var(--ink);
  }
  .hero p {
    color: var(--ink-muted); margin: 0 0 32px; font-size: 15px;
  }

  .empty {
    text-align: center; padding: 80px 32px;
    color: var(--ink-faint);
  }
  .empty .glyph { font-size: 48px; margin-bottom: 12px; }

  .report-card {
    background: #fff; border: 1px solid var(--border-soft);
    border-radius: 12px; padding: 24px; margin-bottom: 16px;
    box-shadow: var(--shadow-card);
  }
  .report-card.status-triaged { border-left: 4px solid var(--amber); }
  .report-card.status-resolved { border-left: 4px solid var(--green); opacity: 0.7; }
  .report-card.status-dismissed { border-left: 4px solid var(--ink-faint); opacity: 0.6; }
  .report-card.status-new { border-left: 4px solid var(--brand); }

  .report-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 16px; flex-wrap: wrap; margin-bottom: 16px;
  }
  .report-meta {
    display: flex; flex-wrap: wrap; gap: 12px;
    font-size: 13px; color: var(--ink-muted);
  }
  .report-meta strong { color: var(--ink); font-weight: 600; }
  .status-pill {
    display: inline-flex; align-items: center;
    padding: 3px 10px; border-radius: 999px;
    font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .status-pill.new { background: var(--brand-soft); color: var(--brand); }
  .status-pill.triaged { background: var(--amber-soft); color: var(--amber); }
  .status-pill.resolved { background: var(--green-soft); color: var(--green); }
  .status-pill.dismissed { background: var(--border-soft); color: var(--ink-faint); }

  .description {
    background: var(--bg-soft);
    border-left: 3px solid var(--brand);
    padding: 14px 18px;
    border-radius: 0 8px 8px 0;
    font-size: 15px; color: var(--ink);
    white-space: pre-wrap; word-wrap: break-word;
    margin: 8px 0 16px;
  }

  .section-head {
    font-size: 12px; font-weight: 700; color: var(--ink-faint);
    text-transform: uppercase; letter-spacing: 0.06em;
    margin: 16px 0 6px;
  }

  details {
    margin: 8px 0;
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    padding: 4px 14px;
  }
  details > summary {
    cursor: pointer; padding: 8px 0;
    font-size: 13px; font-weight: 600; color: var(--ink-muted);
  }
  details[open] > summary { margin-bottom: 8px; }
  details pre {
    background: var(--bg-soft);
    padding: 14px;
    border-radius: 6px;
    font-size: 12px;
    overflow-x: auto;
    font-family: "SF Mono", Menlo, Consolas, monospace;
    color: var(--ink);
    line-height: 1.5;
  }

  .trigger-text {
    background: var(--bg-soft);
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 13px;
    color: var(--ink);
    white-space: pre-wrap;
    margin-bottom: 8px;
  }

  .actions {
    display: flex; gap: 8px; flex-wrap: wrap;
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px solid var(--border-soft);
  }
  button.btn, a.btn {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 13px; font-weight: 600;
    padding: 8px 14px; border-radius: 8px;
    border: 1px solid var(--border);
    background: #fff; color: var(--ink);
    cursor: pointer;
    font-family: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    text-decoration: none;
  }
  button.btn:hover, a.btn:hover { border-color: var(--brand); color: var(--brand); }
  button.btn.primary {
    background: var(--brand); color: #fff; border-color: var(--brand);
  }
  button.btn.primary:hover { background: var(--brand-hover); color: #fff; }
  button.btn.copied { background: var(--green); border-color: var(--green); color: #fff; }
</style>
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The markdown block that the "copy" button puts on the clipboard. Designed
 * to be pasted directly into Claude for diagnosis. Field order matters —
 * description first (what the user wants help with), then context, then raw
 * snapshots fenced as code blocks.
 */
function buildMarkdown(r: FeedbackReport): string {
  const lines: string[] = [];
  lines.push(`# Aiptima feedback report \`${r.id}\``);
  lines.push('');
  lines.push(`**Reporter**: ${r.reporterName ?? '(unknown)'} (\`${r.reporterId}\`)`);
  lines.push(`**Submitted**: ${r.createdAt.toISOString()}`);
  lines.push(`**Status**: ${r.status}`);
  lines.push(
    `**Channel**: \`${r.triggerChannelId || '(none)'}\`${r.triggerMessageTs ? `  ·  message ts \`${r.triggerMessageTs}\`` : ''}`
  );
  if (r.metadata) {
    lines.push(`**Metadata**: \`${JSON.stringify(r.metadata)}\``);
  }
  lines.push('');
  lines.push('## What the user said went wrong');
  lines.push('');
  lines.push(r.description);
  lines.push('');

  if (r.triggerText) {
    lines.push('## The bot message they clicked on');
    lines.push('');
    lines.push('```');
    lines.push(r.triggerText);
    lines.push('```');
    lines.push('');
  }

  if (Array.isArray(r.conversationSnapshot) && r.conversationSnapshot.length > 0) {
    lines.push('## Conversation context (chronological)');
    lines.push('');
    lines.push('```');
    for (const m of r.conversationSnapshot as any[]) {
      lines.push(`[${m.role}]`);
      lines.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      lines.push('');
    }
    lines.push('```');
    lines.push('');
  }

  if (Array.isArray(r.taskSnapshot) && r.taskSnapshot.length > 0) {
    lines.push('## Tasks belonging to this user at submit time');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(r.taskSnapshot, null, 2));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

export function renderFeedbackAdmin(input: FeedbackPageInput): string {
  const { reports, workspaceName } = input;
  const total = reports.length;
  const counts = {
    new: reports.filter((r) => r.status === 'new').length,
    triaged: reports.filter((r) => r.status === 'triaged').length,
    resolved: reports.filter((r) => r.status === 'resolved').length,
    dismissed: reports.filter((r) => r.status === 'dismissed').length,
  };

  const body =
    total === 0
      ? `
        <div class="empty">
          <div class="glyph">🐞</div>
          <h1>No reports yet</h1>
          <p>When a user clicks the 🐞 button under a bot reply, the report shows up here.</p>
        </div>`
      : reports.map((r) => renderOneReport(r)).join('\n');

  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Aiptima · Feedback</title>
  <meta name="robots" content="noindex, nofollow" />
  ${STYLES}
</head>
<body>
  <nav class="top">
    <div class="brand-mark">
      <span class="brand-dot"></span>
      <span>Aiptima · Feedback</span>
    </div>
  </nav>

  <div class="shell">
    <div class="hero">
      <h1>🐞 Feedback reports</h1>
      <p>
        ${total} total · ${counts.new} new · ${counts.triaged} triaged · ${counts.resolved} resolved · ${counts.dismissed} dismissed${workspaceName ? `  ·  workspace <strong>${escapeHtml(workspaceName)}</strong>` : ''}
      </p>
    </div>
    ${body}
  </div>

  <script>
    function copyMarkdown(id) {
      const el = document.getElementById('md-' + id);
      if (!el) return;
      const text = el.textContent || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          const btn = document.getElementById('btn-' + id);
          if (btn) {
            const original = btn.textContent;
            btn.textContent = '✓ Copied';
            btn.classList.add('copied');
            setTimeout(function () {
              btn.textContent = original;
              btn.classList.remove('copied');
            }, 1500);
          }
        });
      } else {
        // Fallback for older browsers
        const range = document.createRange();
        range.selectNode(el);
        const sel = window.getSelection();
        sel && sel.removeAllRanges();
        sel && sel.addRange(range);
        document.execCommand('copy');
        sel && sel.removeAllRanges();
      }
    }
  </script>
</body></html>`;
}

function renderOneReport(r: FeedbackReport): string {
  const md = buildMarkdown(r);
  const taskCount = Array.isArray(r.taskSnapshot) ? r.taskSnapshot.length : 0;
  const convCount = Array.isArray(r.conversationSnapshot) ? r.conversationSnapshot.length : 0;

  return `
  <div class="report-card status-${r.status}">
    <div class="report-head">
      <div class="report-meta">
        <span class="status-pill ${r.status}">${r.status}</span>
        <span><strong>${escapeHtml(r.reporterName ?? r.reporterId)}</strong></span>
        <span>${r.createdAt.toISOString()}</span>
        <span>id <code>${r.id}</code></span>
      </div>
      <button id="btn-${r.id}" class="btn primary" onclick="copyMarkdown('${r.id}')">📋 Copy as markdown for Claude</button>
    </div>

    <div class="section-head">What went wrong</div>
    <div class="description">${escapeHtml(r.description)}</div>

    ${
      r.triggerText
        ? `
    <div class="section-head">The bot message they reacted to</div>
    <div class="trigger-text">${escapeHtml(r.triggerText)}</div>`
        : ''
    }

    <details>
      <summary>Conversation context (${convCount} messages)</summary>
      <pre>${escapeHtml(JSON.stringify(r.conversationSnapshot, null, 2))}</pre>
    </details>

    <details>
      <summary>Task snapshot (${taskCount} tasks)</summary>
      <pre>${escapeHtml(JSON.stringify(r.taskSnapshot, null, 2))}</pre>
    </details>

    <pre id="md-${r.id}" style="display: none;">${escapeHtml(md)}</pre>
  </div>`;
}

export function renderFeedbackEmpty(reason: string): string {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <title>Aiptima · Feedback</title>
  <meta name="robots" content="noindex, nofollow" />
  ${STYLES}
</head>
<body>
  <nav class="top">
    <div class="brand-mark"><span class="brand-dot"></span><span>Aiptima · Feedback</span></div>
  </nav>
  <div class="shell">
    <div class="empty">
      <div class="glyph">🔒</div>
      <h1>Can't show this page</h1>
      <p>${escapeHtml(reason)}</p>
    </div>
  </div>
</body></html>`;
}
