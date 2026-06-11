import crypto from 'crypto';

/**
 * Billing-context HMAC tokens.
 *
 * Mirrors src/dashboard/auth.ts deliberately — same algorithm, same payload
 * shape — but DOMAIN-SEPARATED via a different HMAC context string
 * ("aiptima/billing/v1"). This means a dashboard token cannot be replayed
 * against /billing routes and vice versa, even though they share the same
 * upstream secret.
 *
 * Why a separate token space at all: billing flows (Stripe Checkout, Customer
 * Portal) involve external redirects with longer-lived URLs that may end up in
 * browser history or third-party logs. We want the blast radius of a leaked
 * billing token to be small — it should let an attacker open Stripe Checkout
 * for that workspace, nothing more. Even if a dashboard token leaks, it can't
 * be used to initiate a payment.
 */

const DEFAULT_TTL_MS = Number(process.env.BILLING_TOKEN_TTL_MS ?? `${30 * 60 * 1000}`);

function getSecret(): string {
  const explicit = process.env.BILLING_TOKEN_SECRET;
  if (explicit && explicit.length >= 16) return explicit;

  const upstream = process.env.SLACK_STATE_SECRET;
  if (!upstream || upstream.length < 16) {
    throw new Error(
      'Billing tokens need a secret — set BILLING_TOKEN_SECRET, or ensure SLACK_STATE_SECRET is set (>=16 chars).'
    );
  }
  return crypto.createHmac('sha256', upstream).update('aiptima/billing/v1').digest('hex');
}

export type BillingTokenIntent = 'upgrade' | 'portal' | 'view';

export type BillingTokenPayload = {
  uid: string;
  tid: string | null;
  eid: string | null;
  exp: number;
  intent: BillingTokenIntent;
};

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function signBillingToken(args: {
  userId: string;
  teamId: string | null;
  enterpriseId: string | null;
  intent: BillingTokenIntent;
  ttlMs?: number;
}): string {
  const payload: BillingTokenPayload = {
    uid: args.userId,
    tid: args.teamId,
    eid: args.enterpriseId,
    exp: Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS),
    intent: args.intent,
  };
  const body = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = base64urlEncode(crypto.createHmac('sha256', getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: BillingTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_intent' };

export function verifyBillingToken(
  token: string | undefined | null,
  requiredIntent?: BillingTokenIntent
): VerifyResult {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }
  const [body, sig] = token.split('.', 2);
  if (!body || !sig) return { ok: false, reason: 'malformed' };

  let expected: Buffer;
  try {
    expected = crypto.createHmac('sha256', getSecret()).update(body).digest();
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }

  let provided: Buffer;
  try {
    provided = base64urlDecode(sig);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length) return { ok: false, reason: 'bad_signature' };
  if (!crypto.timingSafeEqual(provided, expected)) return { ok: false, reason: 'bad_signature' };

  let payload: BillingTokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!payload.uid || typeof payload.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };
  if (requiredIntent && payload.intent !== requiredIntent) {
    return { ok: false, reason: 'wrong_intent' };
  }

  return { ok: true, payload };
}
