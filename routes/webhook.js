const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { completeOnlinePayment } = require('../lib/data');

router.post('/paymongo', async (req, res) => {
  try {
    const payload = req.body;

    // Check if it's the expected event type from PayMongo
    if (payload && payload.data && payload.data.attributes) {
      const eventType = payload.data.attributes.type;

      if (eventType === 'checkout_session.payment.paid') {
        const session = payload.data.attributes.data;
        const checkoutSessionId = session.id;

        // The reference the student is shown and the office quotes back to the
        // gateway is the PAYMENT id, not the checkout session id — the session
        // exists from the moment they click Pay, whereas a payment id only
        // exists once money actually moved. Take the paid one if the payload
        // carries it; completeOnlinePayment falls back to the session id.
        const payments = session?.attributes?.payments || [];
        const paidPayment = payments.find((p) => p?.attributes?.status === 'paid') || payments[0] || null;
        const transactionReference = paidPayment?.id || null;
        // How it was paid — 'gcash', 'card', ... — so the ledger files it under
        // GCash rather than "Online".
        const method = session?.attributes?.payment_method_used || paidPayment?.attributes?.source?.type || null;

        // Find the pending payment using the checkout session id
        const rows = await query(
          "SELECT TOP 1 id, status FROM online_payments WHERE provider_reference = ? AND status IN ('pending', 'processing')",
          [checkoutSessionId]
        );

        if (rows && rows.length > 0) {
          const paymentId = rows[0].id;

          // Call the existing completeOnlinePayment logic to deduct bill. The
          // student's return to Billing Data may have recorded it a moment
          // earlier (reconcilePayMongoPayments); that is a success, not an error
          // for PayMongo to keep retrying.
          try {
            await completeOnlinePayment(paymentId, { transactionReference, method });
            console.log(`[PayMongo Webhook] Payment ${paymentId} completed successfully for session ${checkoutSessionId}`
              + `${transactionReference ? ` (transaction ${transactionReference})` : ''}.`);
          } catch (error) {
            if (!/already completed/i.test(error.message)) throw error;
            console.log(`[PayMongo Webhook] Payment ${paymentId} was already recorded.`);
          }
        } else {
          console.log(`[PayMongo Webhook] No pending payment found for session: ${checkoutSessionId}`);
        }
      } else {
        console.log(`[PayMongo Webhook] Ignored event type: ${eventType}`);
      }
    }

    // Always respond with 200 OK so PayMongo knows we received it
    res.status(200).send('Webhook received');
  } catch (error) {
    console.error('[PayMongo Webhook Error]', error);
    // Still return 200 or 500. PayMongo retries on 500. We'll return 200 to acknowledge unless it's a catastrophic failure
    res.status(500).send('Server Error');
  }
});

module.exports = router;
