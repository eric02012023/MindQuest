/**
 * File: scripts/test-page-styles.js
 * Purpose: Every dashboard page must ask for a stylesheet that EXISTS.
 *
 * Run:  node scripts/test-page-styles.js       (needs no database, no keys)
 *
 * WHY THIS EXISTS
 * Each role's PAGE stylesheet carries the base layout — sidebar, topbar, content
 * shell. theme.css is 82 bytes of variables. So a section whose sheet is missing
 * does not just look a bit plain: the request 404s and the page renders as raw
 * document flow, with the logo at full size and the nav as a row of underlined
 * links.
 *
 * Nothing throws. The route still answers 200, every server-side assertion still
 * passes, and the only way to notice is to open the page and look at it. That is
 * precisely how a POS section shipped with no layout at all.
 *
 * So this walks the `section:` value of every render in routes/, resolves it
 * exactly as the shell does (lib/pageStyles.js — the same module the template
 * uses, so the two cannot drift), and checks the file is really on disk.
 */

const fs = require('fs');
const path = require('path');
const { resolvePageStyles, stylesheetExists } = require('../lib/pageStyles');

let failures = 0;
const ok = (l, c, e = '') => {
  if (c) console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`);
  else { failures++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

/** Which basePaths a given routes file renders under. */
const ROUTE_FILES = {
  'adminFactory.js': ['/admin', '/assistant'],
  'student.js': ['/student'],
  'tutor.js': ['/tutor']
};

console.log('\n== every section a route renders resolves to a real stylesheet ==');

const found = [];
for (const [file, basePaths] of Object.entries(ROUTE_FILES)) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
  // `section: 'users'` / `section: "users"` in a buildShell(...) call.
  const sections = [...new Set([...src.matchAll(/\bsection:\s*['"]([a-z0-9_-]+)['"]/gi)].map((m) => m[1]))];
  ok(`${file}: found sections to check`, sections.length > 0, `${sections.length}`);
  for (const section of sections) {
    for (const basePath of basePaths) found.push({ file, basePath, section });
  }
}

console.log(`\n  checking ${found.length} role/section combinations\n`);

const missing = [];
for (const { basePath, section } of found) {
  const resolved = resolvePageStyles(basePath, section);
  for (const href of resolved.styles) {
    if (!stylesheetExists(href)) missing.push({ basePath, section, href });
  }
}

for (const { basePath, section, href } of missing) {
  console.log(`  FAIL  ${basePath} section "${section}" -> ${href} DOES NOT EXIST`);
}
failures += missing.length;
if (!missing.length) {
  console.log('  PASS  every role/section pair resolves to a stylesheet that exists');
}

console.log('\n== the resolver itself ==');
ok('/assistant maps to the assistant-admin folder',
  resolvePageStyles('/assistant', 'billing').roleFolder === 'assistant-admin');
ok('/admin maps to the admin folder',
  resolvePageStyles('/admin', 'billing').roleFolder === 'admin');
ok('an unmapped section uses its own name',
  resolvePageStyles('/admin', 'subjects').sectionSlug === 'subjects');
ok('underscores become hyphens',
  resolvePageStyles('/admin', 'student_results').sectionSlug === 'student-results');
ok('a mapped section is redirected to a sheet that exists',
  resolvePageStyles('/admin', 'income').sectionSlug === 'dashboard');
ok('role-specific mappings win over the shared map',
  resolvePageStyles('/admin', 'notifications').sectionSlug === 'notification-history');
ok('both a theme and a page sheet are requested',
  resolvePageStyles('/admin', 'billing').styles.length === 2);
ok('the body class matches the resolved slug',
  resolvePageStyles('/admin', 'income').pageClass === 'admin-dashboard-page');

console.log('\n== a genuinely missing sheet IS detected (the check has teeth) ==');
ok('a made-up section is reported missing',
  !stylesheetExists(resolvePageStyles('/admin', 'no-such-section-xyz').pageCss));
ok('a real one is not',
  stylesheetExists(resolvePageStyles('/admin', 'billing').pageCss));

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Every page asks for a stylesheet that exists.'}`);
process.exit(failures ? 1 : 0);
