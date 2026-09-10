/**
 * File: scripts/test-storage-fallback.js
 * Purpose: Prove that losing the remote upload bucket degrades the app instead of
 * breaking it.
 *
 * Why this test exists: the configured Supabase project stopped existing, and
 * because every upload went straight through `fetch` with no fallback, the
 * failure surfaced as a 500 page on "Add handout" — with nothing in the UI, and
 * nothing in the boot banner, pointing at storage. The whole upload feature of
 * the app was dead and the reason was invisible.
 *
 * These checks pin the behaviour that replaced it:
 *   - an unreachable bucket does not throw out of putFile/getFile/deleteFile
 *   - the bytes still land somewhere the app can read back
 *   - the degraded state is reported, not swallowed
 *
 * No database and no network are needed: the point of the test is a host that
 * does not resolve, which is exactly what happened in production.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Point at a host that cannot resolve, and at a scratch upload root, BEFORE
// lib/storage is required — it reads both at module load.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-storage-test-'));
process.env.UPLOAD_ROOT = SCRATCH;
process.env.SUPABASE_URL = 'https://this-project-does-not-exist-mq-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'sb_secret_test_only_not_a_real_key';
process.env.SUPABASE_BUCKET = 'mindquest-uploads';

const storage = require('../lib/storage');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('\n== the bucket is configured, so the app intends to use it ==');
  check('storage reports Supabase as configured', storage.usingSupabase === true);

  console.log('\n== but the project does not exist ==');
  const status = await storage.checkBackend();
  check('the boot probe notices', status.healthy === false, status.reason);
  check('it says it fell back to local', status.backend === 'local');
  check('it is flagged degraded, not reported as fine', status.degraded === true);
  check(
    'the reason names DNS rather than a bare "fetch failed"',
    /does not exist|DNS/i.test(String(status.reason)),
    status.reason
  );

  console.log('\n== an upload still succeeds ==');
  const body = Buffer.from('Fractions have a numerator and a denominator.', 'utf8');
  let storedPath = null;
  try {
    storedPath = await storage.putFile('handouts', 'test-handout.txt', body, 'text/plain');
    check('putFile did not throw', true);
  } catch (error) {
    check('putFile did not throw', false, error.message);
  }
  check('it returns the usual public path', storedPath === '/uploads/handouts/test-handout.txt', storedPath);
  check(
    'the bytes really are on disk',
    fs.existsSync(path.join(SCRATCH, 'handouts', 'test-handout.txt'))
  );

  console.log('\n== and the file reads back through the same API ==');
  const fetched = await storage.getFile(storedPath);
  check('getFile returns the object', Boolean(fetched));
  check('the contents survived', fetched && fetched.buffer.toString('utf8') === body.toString('utf8'));

  console.log('\n== a missing file is still a miss, not a crash ==');
  const missing = await storage.getFile('/uploads/handouts/never-written.txt');
  check('getFile returns null rather than throwing', missing === null);

  console.log('\n== deleting works too ==');
  await storage.deleteFile(storedPath);
  check(
    'the file is gone from disk',
    !fs.existsSync(path.join(SCRATCH, 'handouts', 'test-handout.txt'))
  );
  const afterDelete = await storage.getFile(storedPath);
  check('and reads back as missing', afterDelete === null);

  console.log('\n== a crafted path cannot climb out of the upload root ==');
  check('".." is refused', storage.toObjectKey('/uploads/../../secrets.env') === null);
  check('a bare traversal is refused', storage.toObjectKey('handouts/../../../etc/passwd') === null);
  check('a windows absolute path is refused', storage.toObjectKey('C:/Windows/win.ini') === null);
  check('an ordinary path is accepted', storage.toObjectKey('/uploads/handouts/a.pdf') === 'handouts/a.pdf');

  console.log(`\n${failed ? 'STORAGE FALLBACK BROKEN' : 'The storage fallback holds.'}  (${passed} passed, ${failed} failed)`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('test-storage-fallback crashed:', error);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
});
