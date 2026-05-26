/**
 * Scenario runner. Loads .env, runs each scenario serially (parallel is wasteful
 * because every scenario hits the same Anthropic rate window), prints a
 * narrative report, and exits non-zero if anything failed.
 *
 * Run with: npm run scenarios
 */

import dotenv from 'dotenv';
dotenv.config();

import { prisma } from '../../src/lib/prisma';
import { ALL_SCENARIOS, ScenarioResult } from './scenarios';

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

function preflight(): { ok: boolean; reason?: string } {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'ANTHROPIC_API_KEY is not set' };
  if (key === 'PUT-YOUR-ANTHROPIC-KEY-HERE') {
    return { ok: false, reason: 'ANTHROPIC_API_KEY is still the .env placeholder' };
  }
  if (!key.startsWith('sk-ant-')) {
    return { ok: false, reason: `ANTHROPIC_API_KEY doesn't look like an Anthropic key (got "${key.slice(0, 8)}…")` };
  }
  if (!process.env.DATABASE_URL) return { ok: false, reason: 'DATABASE_URL is not set' };
  return { ok: true };
}

function printResult(r: ScenarioResult) {
  const failed = r.findings.filter((f) => f.level === 'fail').length;
  const warned = r.findings.filter((f) => f.level === 'warn').length;
  const passed = r.findings.filter((f) => f.level === 'pass').length;

  const headerColor = failed > 0 ? COLOR.red : warned > 0 ? COLOR.yellow : COLOR.green;
  const statusGlyph = failed > 0 ? '✗' : warned > 0 ? '!' : '✓';

  console.log();
  console.log(`${headerColor}${COLOR.bold}${statusGlyph} ${r.name}${COLOR.reset}  ${COLOR.gray}(${r.durationMs}ms)${COLOR.reset}`);
  console.log(`  ${COLOR.dim}${r.narrative}${COLOR.reset}`);
  console.log();
  for (const f of r.findings) {
    const c = f.level === 'fail' ? COLOR.red : f.level === 'warn' ? COLOR.yellow : COLOR.green;
    const g = f.level === 'fail' ? '✗' : f.level === 'warn' ? '!' : '✓';
    console.log(`    ${c}${g}${COLOR.reset} ${f.message}`);
  }
  console.log(`  ${COLOR.gray}— ${passed} passed, ${failed} failed, ${warned} warnings${COLOR.reset}`);
}

(async () => {
  const pre = preflight();
  if (!pre.ok) {
    console.error(`${COLOR.red}Preflight failed:${COLOR.reset} ${pre.reason}`);
    console.error(`Set the env vars in .env and re-run.`);
    process.exit(2);
  }

  console.log(`${COLOR.bold}${COLOR.blue}Aiptima scenario runner${COLOR.reset}`);
  console.log(`${COLOR.gray}Running ${ALL_SCENARIOS.length} scenario(s) against real Claude Opus 4.7${COLOR.reset}`);
  console.log(`${COLOR.gray}DB: ${process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] ?? 'unknown'}${COLOR.reset}`);

  const results: ScenarioResult[] = [];
  for (const sc of ALL_SCENARIOS) {
    process.stdout.write(`${COLOR.gray}  → ${sc.name}…${COLOR.reset}\n`);
    const r = await sc();
    results.push(r);
    printResult(r);
  }

  console.log();
  console.log(`${COLOR.bold}════════ SUMMARY ════════${COLOR.reset}`);
  let totalFail = 0;
  let totalWarn = 0;
  let totalPass = 0;
  for (const r of results) {
    for (const f of r.findings) {
      if (f.level === 'fail') totalFail++;
      else if (f.level === 'warn') totalWarn++;
      else totalPass++;
    }
  }
  const c = totalFail > 0 ? COLOR.red : totalWarn > 0 ? COLOR.yellow : COLOR.green;
  console.log(`${c}${totalPass} passed · ${totalFail} failed · ${totalWarn} warnings${COLOR.reset}`);
  console.log(`Across ${results.length} scenarios in ${results.reduce((s, r) => s + r.durationMs, 0)}ms total.`);

  await prisma.$disconnect();
  process.exit(totalFail > 0 ? 1 : 0);
})().catch((err) => {
  console.error(`${COLOR.red}Runner crashed:${COLOR.reset}`, err);
  process.exit(2);
});
