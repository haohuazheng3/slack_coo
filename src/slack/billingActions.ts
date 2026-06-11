import { App, BlockAction, ButtonAction } from '@slack/bolt';
import { prisma } from '../lib/prisma';
import { verifyBillingToken } from '../billing/auth';
import { createCheckoutSession } from '../billing/checkout';
import { createPortalSession } from '../billing/portal';
import { isBillingConfigured } from '../billing/stripeClient';
import { createLogger } from '../lib/logger';

const log = createLogger('Slack.BillingActions');

/**
 * Register the billing-related Bolt action handlers. Mounted alongside
 * src/slack/actions.ts handlers via the same app instance.
 *
 * Flow for billing_upgrade:
 *   1. User clicks "Upgrade" button in Home tab (signed token in `value`)
 *   2. Handler verifies token + ensures the click came from the installer
 *   3. Creates Stripe Checkout Session
 *   4. Opens a modal with a single "Open secure checkout" link button —
 *      Slack doesn't allow auto-redirects, so the user clicks once more to
 *      land on checkout.stripe.com in their browser.
 */
export function registerBillingActions(app: App) {
  app.action<BlockAction<ButtonAction>>('billing_upgrade', async ({ ack, body, client, action }) => {
    await ack();

    if (!isBillingConfigured()) {
      await postFailureEphemeral(client, body, 'billing_not_configured');
      return;
    }

    const tokenStr = action.value;
    const verified = verifyBillingToken(tokenStr, 'upgrade');
    if (!verified.ok) {
      log.warn('billing_upgrade token rejected', { reason: verified.reason });
      await postFailureEphemeral(client, body, 'token_invalid');
      return;
    }
    const payload = verified.payload;
    if (payload.uid !== body.user.id) {
      // Token was minted for a different user — refuse.
      log.warn('billing_upgrade user mismatch', { tokenUid: payload.uid, clickUid: body.user.id });
      await postFailureEphemeral(client, body, 'user_mismatch');
      return;
    }

    const install = await prisma.slackInstallation.findFirst({
      where: { teamId: payload.tid, enterpriseId: payload.eid },
    });
    if (!install) {
      await postFailureEphemeral(client, body, 'no_install');
      return;
    }

    // Only the installer (the "owner" in our model) can act on billing.
    if (install.installerUserId && install.installerUserId !== body.user.id) {
      await postFailureEphemeral(client, body, 'not_installer');
      return;
    }

    try {
      const session = await createCheckoutSession({
        installationId: install.id,
        userId: body.user.id,
        teamId: payload.tid,
        enterpriseId: payload.eid,
      });
      await openCheckoutModal(client, body, session.url);
    } catch (err: any) {
      log.error('createCheckoutSession failed', { error: err?.message ?? String(err) });
      await postFailureEphemeral(client, body, 'checkout_create_failed');
    }
  });

  app.action<BlockAction<ButtonAction>>('billing_manage', async ({ ack, body, client, action }) => {
    await ack();

    if (!isBillingConfigured()) {
      await postFailureEphemeral(client, body, 'billing_not_configured');
      return;
    }

    const verified = verifyBillingToken(action.value, 'portal');
    if (!verified.ok) {
      await postFailureEphemeral(client, body, 'token_invalid');
      return;
    }
    const payload = verified.payload;
    if (payload.uid !== body.user.id) {
      await postFailureEphemeral(client, body, 'user_mismatch');
      return;
    }

    const install = await prisma.slackInstallation.findFirst({
      where: { teamId: payload.tid, enterpriseId: payload.eid },
    });
    if (!install) {
      await postFailureEphemeral(client, body, 'no_install');
      return;
    }
    if (install.installerUserId && install.installerUserId !== body.user.id) {
      await postFailureEphemeral(client, body, 'not_installer');
      return;
    }

    try {
      const session = await createPortalSession({
        installationId: install.id,
        userId: body.user.id,
        teamId: payload.tid,
        enterpriseId: payload.eid,
      });
      await openPortalModal(client, body, session.url);
    } catch (err: any) {
      log.error('createPortalSession failed', { error: err?.message ?? String(err) });
      await postFailureEphemeral(client, body, 'portal_create_failed');
    }
  });
}

async function openCheckoutModal(client: any, body: any, url: string) {
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'billing_upgrade_modal',
      title: { type: 'plain_text', text: 'Upgrade Aiptima' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              "Stripe-hosted checkout opens in your browser. Card details never touch our servers.",
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Open secure checkout' },
              url,
              action_id: 'billing_open_checkout_external',
            },
          ],
        },
      ],
    },
  });
}

async function openPortalModal(client: any, body: any, url: string) {
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'billing_portal_modal',
      title: { type: 'plain_text', text: 'Manage billing' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Opens the Stripe customer portal in your browser — update card, view invoices, or cancel.',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Open portal' },
              url,
              action_id: 'billing_open_portal_external',
            },
          ],
        },
      ],
    },
  });
}

async function postFailureEphemeral(client: any, body: any, reason: string) {
  const channel = body.channel?.id || body.container?.channel_id || body.user?.id;
  if (!channel) return;
  const msgByReason: Record<string, string> = {
    billing_not_configured: "Billing isn't configured on this deployment.",
    token_invalid: "That link expired — open billing from the Home tab again.",
    user_mismatch: "That button wasn't for you. Open billing from your Home tab.",
    not_installer: "Only the workspace owner can manage billing.",
    no_install: "Workspace not found.",
    checkout_create_failed: "Stripe couldn't open checkout — try again in a moment.",
    portal_create_failed: "Couldn't open the billing portal — try again in a moment.",
  };
  try {
    await client.chat.postEphemeral({
      channel,
      user: body.user.id,
      text: msgByReason[reason] ?? 'Could not open billing.',
    });
  } catch {
    // best-effort
  }
}
