const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { completeOnlinePayment, fetchPayMongoCheckout } = require('../lib/data');

router.post('/paymongo', async (req, res) => {
  try {
    const payload = req.body;

    
    if (payload && payload.data && payload.data.attributes) {
      const eventType = payload.data.attributes.type;

      if (eventType === 'checkout_session.payment.paid') {
        const session = payload.data.attributes.data;
        const checkoutSessionId = String(session?.id || '');

        
        const rows = await query(
          "SELECT TOP 1 id, status FROM online_payments WHERE provider_reference = ? AND status IN ('pending', 'processing')",
          [checkoutSessionId]
        );

        if (rows && rows.length > 0) {
          const paymentId = rows[0].id;

          
          
          
          
          const checkout = await fetchPayMongoCheckout(checkoutSessionId).catch((error) => {
            console.error('[PayMongo Webhook] could not ask PayMongo about', checkoutSessionId, error.message);
            return null;
          });
          if (!checkout) {
            
            
            return res.status(503).send('Could not confirm the payment with PayMongo yet.');
          }
          if (!checkout.paidPayment) {
            
            
            
            console.warn(`[PayMongo Webhook] ${checkoutSessionId}: PayMongo does not report it paid — not recorded.`);
            return res.status(503).send('Not confirmed by PayMongo yet.');
          }

          
          
          
          
          const transactionReference = checkout.paidPayment.id || null;
          
          
          const method = checkout.attributes.payment_method_used
            || checkout.paidPayment.attributes?.source?.type || null;

          
          
          
          
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

    
    res.status(200).send('Webhook received');
  } catch (error) {
    console.error('[PayMongo Webhook Error]', error);
    
    res.status(500).send('Server Error');
  }
});

module.exports = router;
