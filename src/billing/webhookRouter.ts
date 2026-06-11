import { Router, raw } from 'express';
import { getStripe } from './stripeClient';
import { dispatchEvent } from './webhookHandlers';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const log = createLogger('Billing.WebhookRouter');

/**
 * Build the Stripe webhook router. Mount this at /webhooks/stripe on the
 * underlying Express app BEFORE the global json parser runs — Bolt's
 * ExpressReceiver attaches express.json() during construction, which would
 * pre-parse our body and break stripe.webhooks.constructEvent's signature
 * verification.
 *
 * The pattern that works with Bolt v3+:
 *   const webhookRouter = buildWebhookRouter();
 *   receiver.app.use('/webhooks/stripe', webhookRouter);
 *
 * The router uses express.raw() as middleware on its single route — this is
 * route-local, so it doesn't affect anything else mounted on the receiver.
 */
export function buildWebhookRouter(): Router {
  const router = Router();

  router.post('/', raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!sig || !whSecret) {
      log.warn('Webhook rejected — missing signature or secret', {
        hasSig: Boolean(sig),
        hasSecret: Boolean(whSecret),
      });
      res.status(400).send('missing signature');
      return;
    }

    let event;
    try {
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(req.body, sig as string, whSecret);
    } catch (err: any) {
      log.warn('Webhook signature verification failed', { error: err?.message ?? String(err) });
      res.status(400).send(`signature verification failed: ${err?.message}`);
      return;
    }

    try {
      const result = await dispatchEvent(prisma, event);
      if (result.handled) {
        res.status(200).send('ok');
      } else {
        // Handler-level error — return 500 so Stripe retries with backoff.
        res.status(500).send(`handler error: ${result.error ?? 'unknown'}`);
      }
    } catch (err: any) {
      log.error('Webhook dispatch threw at top level', {
        eventId: event.id,
        type: event.type,
        error: err?.message ?? String(err),
      });
      res.status(500).send('internal error');
    }
  });

  return router;
}
