const BLOCKS = 12;

export function clampPercent(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

export function buildProgressBar(percent: number): string {
  const p = clampPercent(percent);
  const filled = Math.round((p / 100) * BLOCKS);
  const empty = BLOCKS - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${p}%`;
}
