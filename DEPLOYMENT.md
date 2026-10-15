# Deploying MindQuest

Render (app) · GitHub (code) · Somee (SQL Server). Pushing to `main` on GitHub makes Render build and restart automatically.

---

## The order matters

**Database first, then code.** The application expects tables and columns the migration adds. Deploy the code onto an un-migrated database and the admin and student pages 500 immediately.

```bash
# 1. migrate the live database
node scripts/migrate-module-overhaul.js --env .env.live

# 2. then push, which triggers the Render deploy
git push origin main
```

The migration is safe to re-run: every step is guarded, so a second run reports `skip` for everything and changes nothing. It adds tables and columns and widens two CHECK constraints; it deletes no data.

**Done on 2026-08-19:** `41 applied, 0 failed`, re-run `0 applied, 45 skipped`, verified 18/18 against the live schema.

---

## Environment variables Render needs

`dotenv` does not overwrite variables that already exist in the environment, so whatever Render's dashboard sets always wins over any `.env` file.

| Variable | Why |
|---|---|
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | The Somee database |
| `AI_PROVIDER=openai` | Without it the AI service silently falls back to mock questions |
| `OPENAI_API_KEY` | Pre-Assessment generation, essay grading, OCR |
| `AI_MODEL` | `gpt-4o-mini` |
| `SESSION_SECRET` | Login sessions. The code has a hardcoded fallback — set a real one |
| `SMTP_*` / `RESEND_API_KEY` | OTP email at login |
| **`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`** | See below — without persistent storage, uploaded handouts are lost on every restart |
| `UPLOAD_ROOT` | The alternative to Supabase, for a paid instance with a disk attached |

`PORT` is provided by Render and the server already reads it.

---

## ⚠️ Uploaded files and Render's ephemeral filesystem

Render rebuilds the application's filesystem from the repository on **every deploy and every restart**. Anything written at runtime is gone — while the database rows that point at those files survive. A handout uploaded on Monday is listed in the UI on Tuesday and 404s on disk.

This affects handouts, profile photos, chat attachments and AI-generated modules.

**On the free instance this is worse than it sounds.** Free instances also spin down after a period of inactivity and rebuild when the next visitor arrives, so uploads are lost on ordinary quiet days, not only when someone deploys.

There are two ways out. The application supports both, and picks between them from the environment alone.

### Option A — a Render disk (needs a paid instance)

Free instances **cannot mount a persistent disk**; the dashboard lists disks alongside SSH and one-off jobs as paid-only features. On Starter ($7/month) or above:

1. Render dashboard → your service → **Disks** → *Add Disk*
2. Mount path: `/var/data` · size: 1 GB is plenty to start
3. Add the environment variable `UPLOAD_ROOT=/var/data/uploads`
4. Redeploy

Note the mount path is `/var/data` while `UPLOAD_ROOT` is `/var/data/uploads` — the application creates that subfolder itself. Disk size can be raised later but never lowered.

### Option B — Supabase Storage (works on the free instance)

Uploads go to a **private** Supabase bucket instead of local disk, so nothing depends on this container's filesystem surviving.

1. Create a project at supabase.com
2. **Storage** → *New bucket* → name it `mindquest-uploads` → leave it **Private**
3. **Project Settings → API** → copy the project URL and the `service_role` key
4. Set on Render:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | the **service_role** key, not the anon key |
| `SUPABASE_BUCKET` | `mindquest-uploads` (optional; this is the default) |

**The bucket must stay private.** Handouts are gated behind the Pre-Assessment lock, and a public bucket URL would walk straight past it — the hole closed in Phase 0. Files are fetched server-side with the service key and streamed to the browser only after the guards have run; the key never reaches a client. The `service_role` key bypasses row-level security, so it belongs only in Render's dashboard — never in a committed file.

### Which one is running

Setting `SUPABASE_URL` **and** `SUPABASE_SERVICE_KEY` selects Supabase; leaving either unset keeps everything on local disk, which is what local development uses. Removing the two variables rolls the change back with no code change and no data migration — stored paths in the database stay in their public form (`/uploads/handouts/x.pdf`) under both backends.

The startup log states which is in effect:

```
Uploads: Supabase Storage, bucket "mindquest-uploads" (survives restarts)

Uploads: local filesystem (lost on every restart if the disk is not persistent)
  directory: /var/data/uploads (persistent, from UPLOAD_ROOT)

Uploads: local filesystem (lost on every restart if the disk is not persistent)
  directory: /opt/render/project/src/public/uploads (inside the app folder)
```

The third form means files are being written somewhere that will be erased.

---

## ⚠️ The database has a 30 MB ceiling

The Somee database is capped at **30 MB**, and about 8 MB of that was already in use before any module existed. This is why uploaded files are **not** stored in the database: a single PDF could exhaust the remaining headroom.

It still bounds what else can grow there. Extracted handout text, generated questions and every student's submitted answers all live in that 30 MB. Worth watching before a real cohort starts using the system:

```sql
SELECT name, size * 8 / 1024 AS used_mb, max_size * 8 / 1024 AS cap_mb
FROM sys.database_files;
```

---

## The installable app (PWA)

Users can install MindQuest from the browser. It needs no build step, no store
account and no extra hosting — the files ship with the app and Render serves
them like any other route. See the README for what users see and press.

Three files must be reachable at the **site root**, and `server.js` serves them
there on purpose:

| URL | Why the root matters |
|---|---|
| `/sw.js` | A service worker only controls pages at or below its own path. Under `/js/` it would speak for `/js/` alone. |
| `/manifest.webmanifest` | Kept beside it so the `scope: "/"` it declares matches where it is served from. |
| `/offline.html` | Shown by the worker when the network is gone, so it needs a stable URL. |

### What the service worker will and will not do

It **never caches a page**. Every HTML page here is rendered for one logged-in
person, so a cached page would be replayed to whoever opens the app next on that
device and would keep showing stale figures. HTML is always fetched live.

It also does not touch `/uploads/`, `/download/`, `/socket.io/`, `/webhook/`, or
any `POST`. Handouts stay gated by the server, messaging stays live, and logins,
payments and assessment submissions behave exactly as they do in a normal tab.

What it does cache is small and deliberate:

- `/css/` and `/js/` — **network-first**. These ship under fixed names with no
  content hash, so cache-first would serve the previous deploy's stylesheet for
  one more load after every release. Network-first keeps them current online and
  still works offline.
- `/assets/` — **stale-while-revalidate**. The logo and landing artwork are the
  heavy files and almost never change.

### Verifying it after a deploy

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://mindquesttutorial.com/sw.js
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://mindquesttutorial.com/manifest.webmanifest
```

Both must be `200`. Then open the site in Chrome → DevTools → **Application**:
*Manifest* lists MindQuest with its icons and no errors, and *Service Workers*
shows one **activated and running**. An install icon appears in the address bar,
and the in-page **Install App** button becomes visible.

### When the site shows the offline page and your internet is fine

The offline page appearing does **not** mean the visitor lost their connection.
The worker shows it whenever a page load fails, and a host that is asleep, down
or suspended fails in exactly the same way a dead Wi-Fi does. On the free Render
instance this is the common case, not the rare one: it spins down when idle and
takes up to a minute to wake, and the request that arrives while it is waking
can fail outright.

Find out which it is before changing anything — from a terminal, not a browser,
because the browser is the thing being misled:

```bash
nslookup mindquesttutorial.com      # must answer with Render's IPs (216.24.57.x)
curl -s -o /dev/null -w "%{http_code} in %{time_total}s\n" --max-time 90 https://mindquesttutorial.com/
```

| What you get | What it means |
|---|---|
| `200` | The server is up. The problem is the copy of the worker on that one device — unregister it in DevTools → Application → Service Workers. |
| `000` / timeout, DNS fine | The server is not answering. Render dashboard → the service → check it is not suspended, and read the deploy log. Nothing in this repo can fix it. |
| DNS fails | The custom domain is the problem, not the app. Render → Settings → Custom Domains. |

`000` with DNS resolving is the one to recognise: **the app is not broken, the
host is not serving it.** Redeploying the code changes nothing until the service
is running again.

The page itself no longer guesses. It checks `navigator.onLine` to tell the two
apart, says which one it is, and then polls the server on a backoff until it
answers — so a waking instance reloads the page on its own with nobody watching
it. The worker also retries a failed navigation twice before falling back, which
absorbs a single cold-start failure without the visitor ever seeing this page.

### If the worker ever misbehaves

Bump `CACHE_VERSION` in `public/sw.js` and deploy. The worker calls
`skipWaiting()` and `clients.claim()`, and its `activate` step deletes every
cache that is not the current one — so one deploy replaces it everywhere on the
next page load. `/sw.js` is served with `Cache-Control: no-cache` so no browser
sits on a stale copy of the worker itself.

To withdraw the feature entirely, replace the body of `public/sw.js` with a
worker that unregisters itself, and deploy that before removing anything else —
a service worker already on someone's phone does not disappear just because the
file stops being served.

---

## Verifying a deploy

Two checks that need no login and prove the new code is running:

```bash
curl -o /dev/null -w "%{http_code}\n" https://mindquesttutorial.com/uploads/handouts/nothing.pdf   # 401
curl -o /dev/null -w "%{http_code}\n" https://mindquesttutorial.com/tutor/results/1                # 302
```

`401` shows the guarded handout mount is active — study material is not publicly downloadable. `404` on either means an older build is still being served.

Then log in as admin, open a subject, add a module, and upload a handout with real text. Within about half a minute the page should say **"Pre-Assessment — Ready — 30 items"**. If it says *Waiting for a readable handout*, the file is a scan with no text layer — use **Read with AI** on the handout card. If it stays on *Building now* far longer than a minute, check `OPENAI_API_KEY` in Render.

---

## The management upgrade — what a deploy has to do

Five new tables and a data migration ship with this release. All of it is in
`sql/schema.sql`, which `lib/bootstrap.js` applies **on every boot**, so a normal
restart is the whole migration. Nothing has to be run by hand.

| Table | Holds |
|---|---|
| `payment_entries` | The billing ledger. Billing (1) → (many) payments, append-only. |
| `payment_requests` | Cash payments a student has reserved, pending confirmation. |
| `app_notifications` | Role-addressed in-app notices (payment requests, focus areas). |
| `assessment_violations` | Anti-cheating events, keyed to the live assessment tables. |
| `focus_handouts` | Auto-generated weak-topic material, flagged for a tutor. |

### The one migration worth watching

Existing rows in `payment_history` with an amount above zero are copied into
`payment_entries`, and every `billing` summary is then recomputed from that
ledger. It runs once — it is guarded on `payment_entries` being empty.

A history row whose student or billing record has since been deleted **cannot**
be copied (the ledger's foreign keys would reject it) and is left where it is.
`payment_history` is not written to or read from any more; it stays as the
pre-upgrade audit trail.

The recompute only ever **raises** a figure the ledger can justify. If a `billing`
row claims more was paid than the ledger can account for — which happens exactly
when that student's history rows were deleted along with the student — the row is
**left alone**, not rewritten down. Whether the old figure was inflated by the
overwriting bug this release fixes or the history is simply incomplete is not
something SQL can know, so it is handed to a person instead.

Check the migration before trusting the numbers:

```bash
node scripts/apply-schema.js --env .env.live      # apply + report
node scripts/apply-schema.js --env .env.live --check   # parse only, changes nothing
```

It prints how many legacy payments existed, how many were orphaned, and how many
`billing` rows still disagree with their ledger. **`billing rows needing review`
is not required to be `0`** — each one is listed by student name, billing id,
recorded amount and ledger amount, and the office reconciles them by recording
the missing payments. What must never happen is a number quietly dropping to
zero, and that is what the guard prevents.

### Back up first

This is the one release that rewrites `billing.partial_payment` for every
student. Somee's shared plans do not generally grant `BACKUP DATABASE`, so take
the scripted snapshot of the tables actually at risk:

```bash
node scripts/backup-billing.js --env .env.live
```

It only reads, so it is safe against production at any time. It writes one
timestamped file to `backups/` holding a full dump of the billing tables plus
ready-to-run `UPDATE` statements that put the four migrated columns back exactly
as they were — the rows keep their ids through the migration, so restoring is an
UPDATE and needs no downtime.

### Verifying it took

Log in as admin:

- **Student Bill** → a row per student with a **+** button. Press it, record a
  payment, press it again and record a second. Both must appear in the payment
  history with their own date, amount and recorder. Nothing overwrites anything.
- **Notifications** → a student's cash payment request appears for both Admin and
  Assistant Admin, and either can mark it Completed.
- **Analytics & Reports** → present for all four roles. Log in as an assistant and
  append `?branch_id=<another branch>`; the page must still say *your assigned
  branch*.

### Before you push: `npm test`

Three regression suites that need **no database and no API key**, so they run
anywhere in about a second:

```bash
npm test
```

- `scripts/test-anti-cheat-client.js` runs `public/js/anti-cheat.js` against a
  hand-rolled DOM: three-strike escalation, one alt-tab costing one strike rather
  than two, and — the part most likely to break silently — `required` being
  stripped before the auto-submit, without which the browser refuses the submit
  and strands the student on a page that just told them the assessment was over.
- `scripts/test-assessment-types.js` runs the real generation pipeline with the
  OpenAI transport stubbed: the prompt a Pre-Assessment sends offers Multiple
  Choice and nothing else, a module assessment offers all three of its types and
  forbids essay, and anything the model returns outside the allowed set is
  dropped rather than stored.
- `scripts/test-payment-minimum.js` runs `createPaymentRequest` against a
  scripted database: the ₱500 down payment is required on the first payment and
  on no payment after it, a bill below ₱500 lowers the floor to what is owed
  rather than becoming unpayable, and an account whose history was deleted is not
  asked to put money down twice.

None of them replaces a manual pass in a real browser after changing the
anti-cheat event wiring.

### If a tutor's Focus Areas page is empty

A finished Pre-Assessment produces focus material for the student's tutor — the
topics they scored worst on, with a plan for teaching them. It is built by the
submit handler, so it only ever runs at the moment a student presses submit.

That means a Pre-Assessment sat **before** `focus_handouts` existed has nothing,
and never will on its own: the one code path that could build it has been and
gone. The tutor opens Focus Areas, sees an empty list, and reasonably concludes
the feature is broken.

Nothing is actually missing — the per-question grading, the module each question
came from and the tutor assignment are all still stored. Rebuild from them:

```bash
node scripts/backfill-focus-handouts.js --env .env.live --dry-run   # list only
node scripts/backfill-focus-handouts.js --env .env.live             # build + notify
```

It runs the same generator the submit handler runs, so a backfilled handout is
identical to one made at submit time, and it only picks up submissions that have
no handout — so it is safe to re-run whenever the page looks emptier than it
should. Add `--quiet` to build without notifying each tutor.

### Behaviours that changed

- **The ₱500 minimum is a down payment, not a per-payment floor.** It applies to
  the first payment on an account; after that a student may pay any amount
  towards the rest. An account already carrying a payment — including one
  migrated from the old system — is never asked to put money down again, and a
  bill below ₱500 lowers the floor to what is owed instead of being unpayable.
- **Pre-Assessment and Post-Assessment are Multiple Choice only.** An existing
  generated Pre-Assessment is *not* rewritten — it keeps whatever it was built
  with until its handouts change and it regenerates.
- **Essay is no longer a question type a tutor can choose.** Module assessments
  are Multiple Choice or True or False. Assessments already holding essay
  questions still render, still submit and still grade.
- **Fill in the Blank is gone from every assessment.** No assessment can be
  created with it, by hand or by AI, and the builder has no "Question type" to
  pick — an assessment's type is read from its questions. Fill-in-the-blank
  questions written before this (8 of them, in two assessments, at the time it
  shipped) still render as "Short Answer" and still grade, so nobody's open
  assessment breaks.

### This release: tutors, days, notifications

Applied automatically by `sql/schema.sql` on the next boot; nothing to run by hand.

- **Preferred days.** `user_subject_assignments.preferred_days` and
  `tutor_schedule_applications.preferred_days` (`Weekdays` / `Weekend`). Existing
  rows stay NULL ("not chosen") and are treated as holding their slot on both,
  so nobody is double-booked. A student picks the days and time first, then sees
  only the tutors free then.
- **Attendance has four statuses**: present, late, absent, excused. The old
  unnamed CHECK is replaced by `ck_attendance_status`.
- **`assistant_admin_profiles`**: Assistant Admins are registered (name,
  address, birthdate, contact number) before an account is created for them.
- **Branch names can be edited.** The default branches are now seeded only into
  an empty `branches` table, so a renamed branch is not re-created on boot.
- **Every role has a notification bell** (left of the ☰ menu) with "See all"
  and "Mark all read"; the ☰ menu has View Archived Notifications, Notification
  History and Log Out for all four roles.

### This release: one grade per module, the last-day Post-Assessment, checked answer keys

Applied automatically by `sql/schema.sql` (section 43) on the next boot.

- **A module is for ONE grade level.** `modules.grade_level`, filled from the
  old "visible to" list (its specific grade — the year-level group saved beside
  it is what made a Grade 3 module show to Grades 1–6, so it is not expanded).
  A student sees only their own grade's modules; a module with no grade is shown
  to nobody. Module numbers count **within a grade**: English Grade 1 and English
  Grade 6 each have a Module 1; a second Module 1 in English Grade 1 is refused
  (`uq_modules_subject_grade_number`).
- **The Pre-Assessment is per subject AND grade**, written only from that grade's
  handouts (`tutor_assessments.grade_level`, `source_fingerprint`). It does not
  open while the student's grade has no module with a readable handout. The
  subject-wide Pre-Assessments from before are archived, not deleted — a student
  who sat one keeps their result and their unlocked modules.
  `uq_ta_pre_per_version` (one per subject) is replaced by `uq_ta_pre_per_grade`.
- **Module assessments** are open only to students of that module's grade, after
  their Pre-Assessment — on the POST as well as the page.
- **The Post-Assessment opens by itself at 12:01 AM (Manila) on the last day of
  the student's enrollment** in the subject (enrolled 1 January → open from
  12:01 AM on 1 February), and repeats the exact Pre-Assessment that student took
  (`uq_ta_post_per_pre`). The tutor's "Create Post Assessment" button is gone.
- **Every AI-written question's answer key is checked** before it is stored: a
  second pass at temperature 0 answers it without seeing the key, and an item is
  kept only when exactly one choice is right and it is the key. The answer is also
  written out in words (a slipped letter is corrected) and a bare sum is worked
  out. The audit that found the problem: "9 x 9" stored with the key 100, "18 ÷ 6"
  with 5, a "negative integer" question with two right answers.
  `scripts/repair-answer-keys.js` corrects the 18 stored keys that audit found
  and re-marks the answers given to them (dry run by default; `--commit`).
- **A narrow handout still yields a full Pre-Assessment.** A grade with one
  short handout came out at 20 or 24 items: the top-up, asked for more, wrote
  the first pass's questions again and every one was dropped as a repeat. The
  top-up now runs warmer (0.9 — its keys are still checked at 0), is told every
  question already written, and gets a second round when the first added
  something. Measured on live handouts: Reading & Writing Grade 5 20 → 30,
  Araling Panlipunan Grade 12 24 → 30.
- **Side tabs** on Billing Data (student) and Analytics & Reports (all four
  roles): one section at a time, the open one kept in the address.
- **No browser dialogs.** Every "are you sure?" and notice is the app's own modal;
  submitting an assessment says how many questions are still blank.
- **A tutor's profile opens in the same tab** from Select Tutor, with "Select this
  tutor" and "Back to tutors".

To verify after the deploy:

```bash
node scripts/apply-schema.js --check                      # parses cleanly
node scripts/repair-answer-keys.js                        # prints what it would correct
node scripts/repair-answer-keys.js --commit               # applies it (idempotent)
```

### This release: security and the actions behind every page

Applied automatically by `sql/schema.sql` (section 44) on the next boot.

**Accounts and login**
- **A login or reset code survives five wrong guesses** (`otps.failed_attempts`),
  then a new one must be requested. A 4-digit code with no limit could be found
  by a script inside its ten minutes — and the reset code needs only an email.
  Codes are drawn with `crypto.randomInt`, and are no longer printed to the
  server log when an email cannot be sent ("Check the server console" is gone).
- **One password rule everywhere**: reset, change, assistant accounts and
  registration all need 8+ characters with A-Z, a-z, 0-9 and a symbol (reset
  allowed any 6).
- **No plain-text passwords.** Registration, password changes and assistant
  accounts wrote the password beside its hash in `extra_json.visible_password`;
  nothing read it. The code stops, and section 44 removes it from every row.
- **The admin's own password is kept.** It was reset to `DEFAULT_ADMIN_PASSWORD`
  on every boot, so a change made in My Profile reverted at the next deploy. To
  recover a lost admin password: set `RESET_ADMIN_PASSWORD=1` on Render, restart
  once, log in with `DEFAULT_ADMIN_PASSWORD`, then remove the setting. The boot
  log no longer prints a password.
- **An archived account is logged out on its next click**, not 8 hours later.
- A student's own profile can no longer change their **grade, year level or
  login email**, nor a tutor's their **login email** (a typo locked a tutor out
  of the OTP login); the office changes them in User Management.

**Money**
- **The PayMongo webhook asks PayMongo before recording anything.** A forged
  POST naming a checkout session as paid used to settle it — the id is in the
  student's own checkout URL. Without a gateway key, "Pay online" no longer
  marks payments paid as "MindQuest Mock Pay" unless `PAYMENTS_MOCK=1`.
- An **Assistant Admin's** bill edits, "mark paid", SOA posting and re-enrolment
  are limited to their branch, like payments already were.

**Access**
- `/download?path=/uploads/handouts/...` applies the handout lock (enrolled,
  Pre-Assessment done, the student's grade) — it served any handout to anyone
  logged in (`lib/handoutAccess.js`, shared with `/uploads/handouts`).
- An assistant's subject actions (assign students, archive tutors or
  enrolments), Assessment Monitoring results and result pages are their
  branch's only.
- **Messages and calls are removed for good.** Their sidebar links were taken
  out earlier, but the pages, the send/edit/unsend actions, the public
  `/uploads/messages` folder and the Socket.IO call signalling on every
  dashboard page were still running — and the signalling trusted the browser
  for who was who (anyone could "register" as another user and receive their
  calls, and an incoming call turned the camera on unasked). The old addresses
  now land on the dashboard; the `socket.io` package is uninstalled. The
  `messages` table and its rows are left as they are.

**Records**
- "Delete permanently" keeps what the centre must keep: a person with payments,
  results, attendance, assessments they wrote or posted statements stays
  archived, with the reason; a subject with enrolments, attendance, modules or
  assessments is never deleted (its enrolments and attendance were wiped by
  cascade).
- Refused actions show their reason instead of the Server Error page (marking
  an unpaid bill paid, an email already in use, …), and archive/recover/delete
  of a user no longer says "successfully" when nothing changed.
- The retired "Assessments" pages (admin templates, the tutor's list and its
  unchecked delete/recover, the old AI "publish", the student's old exam page
  with the browser's "Leave site?" dialog) and the removed "Database cleanup"
  now explain themselves and point to Modules & Assessments / Assessment
  Monitoring.
- `/register/check-name` answers JSON again (the duplicate-name warning while
  typing never worked: `/register/:type` caught it).

Already applied on live on 2026-10-14 (a rerun changes nothing; dry-run by default):

```bash
node scripts/remove-stray-records.js            # attempts across grades, test assessments #2/#3,
                                                # the levels they set, focus handout #5
```

### This release: one subject, one hour — a User registry and Student progress reports

No migration and no new environment variable: it is code only. `npm test` now
also runs `scripts/test-reports.js` (and `scripts/test-tutor-assignment.js` was
rewritten for the new rule).

**A student picks a tutor for each subject, one by one**
- My Subjects → Select Tutor, per subject: the days (Weekdays / Weekend) first,
  then the time, and only then the tutors who teach that subject and are free.
- **One subject, one hour.** An hour a student already spends on another subject
  — or has asked a tutor for — on the same days is not offered again (not even
  for the same tutor). The same hour on the other days is still free. Filipino
  on Weekdays 7:00-8:00 AM means AP cannot take Weekdays 7:00-8:00 AM, but
  English can take Weekend 7:00-8:00 AM.
- A request covers **one subject**, and the tutor who accepts takes that subject
  alone. Before, accepting gave the tutor every open subject they teach, and
  "Keep this tutor" copied the same hour onto a new subject; both are gone.
  Ending or cancelling a session gives back that hour, on those days, only
  (Weekdays 7:00 AM and Weekend 7:00 AM with the same tutor are two sessions).
- What holds an hour is what is really held: an enrolment with its tutor and
  time, or a request still waiting for a subject that still has no tutor. An
  old accepted request whose session the office has since moved, a request left
  over from a dropped subject, and an archived learner's enrolment hold nothing.
- Only an approved, active tutor can be asked; a hand-made request for an
  archived or not-yet-approved tutor is refused.
- The office's per-subject editor (a student's profile) follows the same rule,
  and the "one tutor for every subject" form is gone: each subject has its own
  tutor, days and time. Setting one time on several subjects is refused.
- **Not changed on purpose:** students who already hold one hour for several
  subjects (every seeded account was given one slot for all its subjects, and
  older enrolments) are left as they are. The rule applies to every new choice
  and to every save in the editor, so the office moves those one subject at a
  time when it wants to.

**Analytics & Reports**
- **User registry** (admin and assistant): every account — learners, tutors and
  assistant admins, in every branch (an assistant: their own) — as one table,
  with pivot tables (branch × role, branch × year level, role × status,
  subject × branch). Print, or download as CSV.
- **Student progress** (all four roles, each in its own scope): for every
  learner and subject, the Pre-Assessment, the module activities and the
  Post-Assessment side by side with the change between them; a chart per
  subject and per learner, and pivots by subject and by branch. A tutor sees
  the subjects they teach the learner; a student, their own. Print, or CSV.
- CSV files neutralise cells a spreadsheet would run as a formula, and give each
  date as the day the page shows (Manila time).
- The page's search now narrows the Student progress table too, and the
  registry's role and status survive a search (and the other way round). A date
  in the filter bar is taken only as a plain YYYY-MM-DD.
- A tutor's subjects in the registry leave out any the office archived for them.

**Search and filters**
- The small magnifier in table headings is gone everywhere (it doubled the
  filter bars). Tables still show ten rows and scroll.
- Filter bars were added where a list can grow without limit and had none:
  Payment History, Assessment Monitoring (both sections), a branch's page and a
  subject's page (search, and branch for the main admin), and a tutor's
  Attendance Logs (learner or subject, status, from/to — a status change comes
  back to the same filtered list).
- An assistant admin's subject page no longer shows other branches' learners in
  Pre-Assessment Results, Pre vs Post or the Archived tab (which also offered a
  Recover button the server then refused). The search covers the Archived tab.
- Assessment Monitoring: "Assessments set by tutors" follows the branch too — an
  assistant sees the assessments of the tutors who teach at their branch, and
  the main admin's Branch filter narrows both sections. The Level filter
  narrows the results only (a level is how a learner did; an assessment has
  none), where it used to empty the assessments list.
- A hand-edited filter is ignored rather than trusted: a date that is not a
  real calendar day ("2026-13-45", "2026-02-30") made Analytics and Payment
  Collection (restored in the release before) a Server Error — the driver
  refuses an Invalid Date — and a subject or branch that is not a number
  quietly emptied the list. Both now fall back to "any".
- An assistant marking, archiving or recovering another branch's registration
  is told "Notification not found." — nothing was changed, and the page used to
  say it had been.
