import type { Response } from 'express';

const STYLES = `
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
           background: #f7f8fa; color: #1d1c1d; margin: 0; padding: 0;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { max-width: 480px; background: white; padding: 40px 32px; border-radius: 16px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.08); text-align: center; }
    .emoji { font-size: 56px; line-height: 1; margin-bottom: 12px; }
    h1 { font-size: 22px; margin: 8px 0 4px; }
    p  { color: #555; line-height: 1.55; margin: 12px 0; }
    a.cta { display: inline-block; margin-top: 18px; background: #611f69; color: white;
            padding: 10px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; }
    code { background: #f0f0f3; padding: 2px 6px; border-radius: 4px; }
  </style>
`;

export function installLandingHtml(installUrl: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Install Aiptima</title>${STYLES}</head>
<body>
  <div class="card">
    <div class="emoji">🤖</div>
    <h1>Add Aiptima to your Slack workspace</h1>
    <p>Aiptima is the execution hub between you and your team. Say what you need in plain language; it turns intent into tracked work, translates between you and the team, and surfaces everything (including silence) so nothing falls through.</p>
    <p>Click below to grant the permissions it needs (chat, app mentions, DMs, App Home).</p>
    <a class="cta" href="${installUrl}">Add to Slack</a>
  </div>
</body></html>`;
}

export function successHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Installation successful</title>${STYLES}</head>
<body>
  <div class="card">
    <div class="emoji">🎉</div>
    <h1>You're all set!</h1>
    <p>Aiptima has been installed to your workspace.</p>
    <p>Open Slack and just DM the bot — or invite it to a channel and mention it, like:<br/>
       <code>@Aiptima ask Luna to ship the landing page by Friday EOD</code>.</p>
    <p>Your <strong>App Home</strong> tab is the at-a-glance dashboard.</p>
  </div>
</body></html>`;
}

export function failureHtml(error?: string): string {
  const safe = error ? error.replace(/</g, '&lt;') : 'Unknown error';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Installation failed</title>${STYLES}</head>
<body>
  <div class="card">
    <div class="emoji">⚠️</div>
    <h1>Installation didn't complete</h1>
    <p>${safe}</p>
    <p>Try the install link again, or contact support.</p>
  </div>
</body></html>`;
}

export function sendHtml(res: Response, html: string, status = 200): void {
  res.status(status).type('html').send(html);
}
