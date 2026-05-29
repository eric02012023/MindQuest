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
        const checkoutSessionId = payload.data.attributes.data.id;

        // Find the pending payment using the checkout session id
        const rows = await query(
          "SELECT TOP 1 id, status FROM online_payments WHERE provider_reference = ? AND status IN ('pending', 'processing')",
          [checkoutSessionId]
        );

        if (rows && rows.length > 0) {
          const paymentId = rows[0].id;
          
          // Call the existing completeOnlinePayment logic to deduct bill
          await completeOnlinePayment(paymentId);
          console.log(`[PayMongo Webhook] Payment ${paymentId} completed successfully for session ${checkoutSessionId}.`);
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
