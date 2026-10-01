/**
 * File: scripts/backfill-online-payment-methods.js
 * Purpose: Re-file online payments written as "Online" under the method the
 *          student actually used — GCash, Maya, GrabPay or Card.
 *
 * Run:  node scripts/backfill-online-payment-methods.js            (report only)
 *       node scripts/backfill-online-payment-methods.js --commit   (write)
 *       add --env .env.live to point at another database
 *
 * WHY THIS EXISTS
 * Every PayMongo payment was written to the ledger as "Online", so Payment
 * Collection's GCash filter missed every student who paid with GCash. New
 * payments are now filed under the method PayMongo reports. This asks PayMongo
 * about each older "Online" entry (by its cs_… / pay_… reference) and changes
 * that entry's method label — nothing else: amount, reference and balance stay
 * exactly as they are. An entry PayMongo cannot account for is left alone.
 *
 * The server does the same at every start (lib/data.js,
 * resolveOnlinePaymentMethods), so this is for running it now, by hand.
 */

const envArgIndex = process.argv.indexOf('--env');
require('dotenv').config({ path: envArgIndex > -1 ? process.argv[envArgIndex + 1] : '.env' });

const { resolveOnlinePaymentMethods } = require('../lib/data');

const commit = process.argv.includes('--commit');

(async () => {
  const outcome = await resolveOnlinePaymentMethods({ commit });
  console.log(`${outcome.checked} entr${outcome.checked === 1 ? 'y' : 'ies'} filed as "Online".`);
  outcome.changed.forEach((change) => {
    console.log(`  #${change.id}  ${change.reference}  ${change.from} -> ${change.to}${commit ? '' : '  (not written)'}`);
  });
  if (outcome.unresolved.length) {
    console.log(`  PayMongo could not say how these were paid, left as they are: #${outcome.unresolved.join(', #')}`);
  }
  if (!commit && outcome.changed.length) console.log('\nReport only. Run again with --commit to write.');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
