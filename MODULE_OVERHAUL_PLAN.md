# Module & Assessment System Overhaul — Audit + Phased Plan

Audit date: 2026-08-19 · Branch: `main`

---

## PART A — System audit (Section 0)

### A1. Blockers (fix before anything else)

| # | Severity | Where | Problem |
|---|---|---|---|
| 1 | **CRITICAL** | `services/aiService.js:281, 346, 392, 431, 432, 455` | Calls `isOpenAIConfigured()` but the function defined at line 123 is named `isAiConfigured()`. Verified at runtime: `getAiStatus()` throws `ReferenceError: isOpenAIConfigured is not defined`. **Every AI code path is dead** — AI question generation, module generation, and essay grading all throw. The `ReferenceError` is thrown *outside* the surrounding `try` in `generateAssessmentFromModule`, so it propagates into the route as a 500 instead of falling back to mock. This is an uncommitted regression (`git status` shows `M services/aiService.js`). |
| 2 | **HIGH (security)** | `server.js:60` | `app.use('/uploads', express.static(...))` is mounted with **no auth**, before every role check. Any handout/module file is downloadable by guessing or reusing its URL. This defeats the whole Section 5 lock requirement and makes the `/download/module/:id` role checks in `routes/download.js:29` pointless. |
| 3 | **HIGH** | `lib/uploads.js:27-39` | `createUploader()` has no `fileFilter` and no `limits`. Files are written to disk *first*, then extension-validated after the fact (`routes/adminFactory.js:1795-1802`) — rejected files stay on disk as orphans. No size cap at all. |

### A2. Architectural defect — three overlapping generations of the same feature

This is the root cause of the "wrong or stale data" symptom. Three complete module/assessment systems were built on top of each other and **all three are still live**:

| Gen | Tables | Entry points |
|---|---|---|
| **Gen 1** — "Phase 2 AI system" | `subject_resources`, `module_reads`, `student_learning_cycles`, `assessments`, `assessment_questions`, `assessment_results`, `assessment_attempts`, `student_assessment_answers`, `assessment_requests`, `ai_generation_logs` | Admin subject page → resources; student read → request assessment → AI generates → cycle advances |
| **Gen 2** — "Phase 4" | `assessment_templates`, `assessment_template_questions`, + subject-level pre/post on `assessments` | Admin subject page → **"Create Assessment"** (`views/content/admin-subject-detail.ejs:66`), `copy-as-post` |
| **Gen 3** — "Phase 5/6" | `modules`, `tutor_assessments`, `tutor_assessment_questions`, `tutor_question_options`, `tutor_assessment_submissions`, `tutor_student_answers`, `student_subject_levels` | Admin **"Module Management"**, Tutor "Modules & Assessments" |

**Proof of the collision** — `routes/student.js:183-305` (one route) loads all three at once:

- Two competing pre-assessments: `preAssessment` (Gen 2, line 211) *and* `tutorPreAssessments` (Gen 3, line 263).
- Two competing lock flags: `adminModulesLocked` (Gen 2, lines 218-232) *and* `studentLevel` (Gen 3, line 250).
- Two competing module lists: `resources` (Gen 1, line 191) *and* `assignedModule` (Gen 3, line 255).

The view has to guess which one wins. The spec in this prompt is effectively **Gen 4** — so the plan below consolidates rather than stacking a fourth layer.

### A3. Correctness bugs found

| # | Where | Problem |
|---|---|---|
| 4 | `lib/data.js:2964-3108` (`submitAssessment`) | Never writes to `student_assessment_answers`. Only `answers_json` (the student's raw answer text) + aggregate score are persisted — **per-question `is_correct` and AI essay feedback are thrown away**. |
| 5 | `lib/data.js:3047-3073` | Consequence of #4: essay correctness is decided by AI at submit time but not stored. Any per-question breakdown must re-derive correctness by text match, which will **disagree with the score the student was shown**. |
| 6 | `lib/data.js:3047` | The OpenAI essay-grading call runs **inside `withTransaction`**. A 10–30s network call holds an open SQL transaction against a remote host (`mindquestdb.mssql.somee.com`) — risks transaction timeout and lock contention under concurrent submits. Grade first, then open the transaction to write. |
| 7 | `views/content/student-assessment-result.ejs:45-81` | Expects `answers[].is_correct / points_earned / points / correct_answer`, which only the Gen 3 `tutor_student_answers` path supplies. The Gen 2 `submitAssessment` path (the one with working essay grading) **cannot feed this page** — different tables. Result: the good grading engine and the good result UI are on opposite sides of the split. |
| 8 | `config/db.js:63` | `transformSql` replaces *every* `?` in the SQL string with a bind param, including a literal `?` inside a quoted string literal. Latent — no current query trips it, but it will silently corrupt any future query containing a question mark in text. |
| 9 | `services/aiService.js:70-121` | `callAnthropic()` is fully implemented and **never called** — dead code, and it contradicts the Section 6 rule "do not introduce a separate AI provider." Delete. |
| 16 | `routes/adminFactory.js:1284` (found during Phase 1) | **Broken button.** The "Copy as Post" handler did `require('../../lib/data')`, which resolves to `C:\Users\ADMIN\OneDrive\Desktop\lib\data` — outside the project root. Verified: `MODULE_NOT_FOUND`. Every click 500'd, so this feature **never worked once**. Corrects an assumption in Phase 8 below: there was no "proven copy-as-post logic" to reuse. |
| 17 | every per-page CSS file (design) | The duplicated base rule `.bubble-row, .subject-list-cards, .attendance-boxes { display: grid; gap: 14px }` sets `display: grid` but **never sets `grid-template-columns`**, so every card collection collapsed into a single column. `.mini-bubble` chips (tutor names, time slots) stacked vertically instead of flowing inline. |

### A4. Model/spec conflicts (not bugs — design mismatches to resolve)

| # | Spec asks for | Codebase currently has |
|---|---|---|
| 10 | `modules.order_number` (unlimited Module 1, 2, 3…) + `target_year_levels` multi-select | `modules.level` ∈ `('Beginner','Intermediate','Advanced')` (`sql/schema.sql:666`), accessed via `getModuleBySubjectAndLevel()` → effectively **max 3 modules per subject**, and gated by score level, not year level |
| 11 | Multiple Handouts per Module | `modules` has a single `file_path` column. No handout table. |
| 12 | Assessment `question_type` incl. `essay` | `tutor_assessment_questions.question_type` CHECK allows only `('multiple_choice','true_false','fill_blank')` (`sql/schema.sql:735`) — **`essay` is rejected by the DB** |
| 13 | `source_handout_id` FK for weak-area traceability | Only `assessment_questions.source_module_title` — a free-text string added ad hoc by `scripts/add-q-source.js`. No FK, no handout granularity. |
| 14 | Pre-assessment auto-generated from handouts | Pre-assessment is a **tutor-hand-created** `tutor_assessments` row with `purpose='pre'` (`routes/student.js:1017-1023`) |
| 15 | Regenerate only when handouts change | No versioning/caching field anywhere |

### A5. What already works and should be reused (good news)

- **OpenAI connection is valid.** Verified live: `HTTP 200`, `gpt-4o-mini-2024-07-18`, JSON mode confirmed working. Key is in `.env` (164 chars) — note that `dotenv` loads **`.env`**, not `.env.live`; both contain the same `AI_PROVIDER`/`OPENAI_API_KEY`/`AI_MODEL` values. `services/aiService.js` is the single existing client to reuse (once bug #1 is fixed).
- **Grading engine ~70% built.** `submitAssessment` (`lib/data.js:2964`) already handles Multiple Choice (with letter/text/index normalization), True or False, Fill in the Blank, and Essay-via-AI, and already computes a **per-module score breakdown** (`perModuleScores` → `per_module_scores_json`). That is most of the weak-area feature. Needs: FK-based source instead of title string, and persistence of per-question results (bugs #4, #5).
- **Extraction libraries already installed.** `pdf-parse` (PDF), `mammoth` (DOCX), `jszip` (can unzip PPTX to read slide XML). No new provider needed for PDF/DOCX.
- **`tutor_assessment_submissions` + `tutor_student_answers` already persist per-question `is_correct` / `points_earned`** — the correct target shape for AssessmentAttempt.
- **No broken static links.** Cross-checked every `href`/`action` in `views/` against all defined routes in `routes/`: zero dead targets.
- **Auth middleware is sound.** `authorize()` (`middleware/auth.js:35`) is applied at router level for all four roles; `setUserLocals` re-reads the user each request so revoked/archived accounts drop out. No role-bleed found in the route tables.

### A6. Needs a decision from you — see Part D. Do not guess on these.

---

## PART B — Target architecture

**Principle: consolidate onto Gen 3's tables (they are closest to the spec and already persist per-question results), migrate Gen 2's grading engine onto them, retire Gen 1/Gen 2 UI.**

```
subjects (exists)
  └── modules                      ← ALTER: + order_number, + target_year_levels_json; level → nullable
        ├── module_handouts        ← NEW: many files per module, + extracted_text cache
        └── tutor_assessments      ← ALTER: + assessment_kind (pre_assessment|tutor_assessment|post_assessment)
                                            + question_type, + item_count
                                            module_id → nullable (pre/post are subject-level)
                                            + source_pre_assessment_id (post reuses pre's items)
                                            + handout_version (cache key for regeneration)
              ├── tutor_assessment_questions  ← ALTER: CHECK += 'essay'
              │                                        + source_module_id, + source_handout_id FKs
              │                                        + answer_rubric (essay key points)
              ├── tutor_question_options (exists)
              └── tutor_assessment_submissions  = AssessmentAttempt
                    └── tutor_student_answers   = per-question correctness + ai_feedback

student_subject_levels  ← keeps the Beginner/Intermediate/Advance classification (see decision D1)
subjects.handout_version ← NEW int, bumped on any handout add/delete → drives regenerate-vs-reuse
```

**WeakArea** is computed, not stored as its own table: `tutor_student_answers WHERE is_correct = 0` → `tutor_assessment_questions.source_module_id / source_handout_id` → module title + handout name. Reuses the existing `perModuleScores` logic from `lib/data.js:3002`.

---

## PART C — Phases

### Phase 0 — Stabilize (no new features) — ✅ **DONE 2026-08-19**

| # | Fix | Status |
|---|---|---|
| 1 | Bug #1 — renamed the definition to `isOpenAIConfigured()` so it matches all 6 call sites; made it swallow errors so a bad config degrades to mock instead of 500ing | ✅ `getAiStatus()` → `{provider:'openai', configured:true, model:'gpt-4o-mini'}` |
| 2 | Bug #9 — deleted `callAnthropic()`; zero Anthropic references remain | ✅ |
| 3 | Bug #2 — `/uploads` split: `profiles/` + `messages/` stay public and mount *before* the session middleware (no DB round trip per avatar); `modules/`, `resources/`, `ai-modules/`, `handouts/` mount *after* `setUserLocals` behind a login check | ✅ verified live: protected → `401`, public → `200` |
| 4 | Bug #3 — `createUploader` now has per-folder `fileFilter` + `limits.fileSize` (docs 25 MB, profiles 5 MB, messages 15 MB). Rejects **before** writing to disk, so no orphan files. Reports via `req.uploadRejections` + `describeUploadRejection()` instead of erroring, so existing route handling is unchanged | ✅ |
| 5 | Bug #6 — extracted `gradeSubmittedAssessment()`; reads + AI essay grading now run with **no transaction open**, and `submitAssessment()` keeps only the write inside `withTransaction`. Return shape unchanged, so no caller breaks. Exported for Phase 6 to reuse | ✅ |
| 6 | Added a `LIMIT_FILE_SIZE` branch to the global error handler so an oversized upload flashes and redirects instead of rendering the 500 page | ✅ |

**Verified end-to-end with real OpenAI calls** (`provider: openai`, not mock): question generation returned 3 valid questions / 595 tokens; essay grading returned `{isCorrect:true, score:0.9, feedback:"..."}`. Server boots clean against `mindquest1_db`, no errors in log.

⚠️ **Known gap, by design:** the upload guard currently only proves the requester is *logged in*. A logged-in student can still fetch another subject's handout by URL. Closing that needs the per-student pre-assessment + year-level check — scheduled in **Phase 6** and marked with a `TODO(Phase 6)` in `server.js`.

⚠️ **Deferred, needs your call:** `uploads/messages/` stays public and type-unrestricted (only size-capped) so messaging keeps working. Because it is served from the app's own origin, an uploaded `.html`/`.svg` is a stored-XSS vector. Out of D3's agreed scope — flagging rather than silently expanding.

### Phase 1 — Remove Module Management + old admin Create Assessment — ✅ **DONE 2026-08-19**

| # | Change | Status |
|---|---|---|
| 1 | Module Management link removed from `views/partials/sidebar.ejs` (covers Admin **and** Admin Assistant — they share `basePath`) | ✅ |
| 2 | Deleted `GET/POST /modules`, `POST /modules/:id/delete`, and `moduleUploader` from `routes/adminFactory.js` | ✅ |
| 3 | Deleted `views/content/admin-modules.ejs`, `public/css/admin/modules.css`, `public/css/assistant-admin/modules.css` (via `git rm`, so recoverable) | ✅ |
| 4 | Removed the "Create Assessment" panel + its `toggleQF`/`addAQ` script from `admin-subject-detail.ejs`, and the routes `POST /subjects/:id/assessments/create` and `.../copy-as-post` | ✅ |
| 5 | Removed the now-dead imports `createSubjectAssessment`, `upsertModule`, `deleteModule`, `getAllModulesAdmin` from `adminFactory.js` | ✅ |
| 6 | "Subject Assessments" table kept as **read-only legacy history** (View only; Publish retained, Copy-as-Post button removed with its route) | ✅ |

**Verified by router introspection** — the three removed paths are gone from the admin router while the 66 surviving routes are intact:

```
gone   /modules
gone   /subjects/:id/assessments/create
gone   /subjects/:id/assessments/:assessmentId/copy-as-post
ok     /subjects, /subjects/:id, /assessment-monitoring, /student-results, /subjects/:id/resources
```

Static link re-scan across all of `views/` found no reference to any removed route.

**Note:** `createSubjectAssessment` and `upsertModule`/`deleteModule`/`getAllModulesAdmin` still **exist in `lib/data.js`** — only their admin call sites were removed. `createSubjectAssessment`'s essay + `source_module_title` insert logic is the reference for Phase 5, and the module helpers get replaced in Phase 2/3.

**Deliberately NOT removed (scope discipline):** `POST /assessments/create` on the separate Admin *Assessments* page (`assessment_templates`, Gen 2) is untouched — Section 1 did not ask for it, and Phase 9 handles retiring Gen 2 as a whole.

---

### Design pass — grid view — ✅ **DONE 2026-08-19**

Root cause (bug #17): the shared base rule declares `display: grid` with **no `grid-template-columns`**, so card collections rendered one-per-row.

Fixed **page-scoped** using the shell's existing `.{role}-{section}-page` body class, appended to the matching per-page CSS file — which is exactly the convention `public/css/README_CSS_STRUCTURE.txt` documents. Scoping matters: it converts the card collections *without* turning genuinely-vertical lists (profile, billing, notification archives, the tutor-picker modal) into grids.

| File | Selector | Effect |
|---|---|---|
| `student/subjects.css` | `.student-subjects-page .subject-list-cards` | Enrolled subject cards tile |
| `student/subjects.css` | `.student-subjects-page .bubble-row` | Time-slot chips flow inline + wrap |
| `student/dashboard.css` | `.student-dashboard-page .subject-list-cards` / `.bubble-row` | Subject cards tile; tutor chips inline |
| `tutor/subjects.css` | `.tutor-subjects-page .subject-list-cards`, `.list-stack` | Subject cards + subject-detail lists tile |
| `tutor/dashboard.css` | `.tutor-dashboard-page .subject-list-cards` / `.bubble-row` | Subject cards tile; chips inline |
| `tutor/students.css` | `.tutor-students-page .list-stack` | Student cards tile |
| `admin/subjects.css` | `.admin-subjects-page .list-stack` | Posted handouts + enrolled students tile |
| `assistant-admin/subjects.css` | `.assistant-admin-subjects-page .list-stack` | Same as Admin |

Grid: `repeat(auto-fit, minmax(260px, 1fr))`, `gap: 16px` — matches the existing house pattern (`.subject-grid` uses `minmax(240px,1fr)`, `.module-level-cards` uses `minmax(300px,1fr)`). `auto-fit` collapses to one column on narrow screens, so no extra media query is needed.

Verified: all 7 files served `HTTP 200` with the rules present; braces balanced in every file; the applier script is idempotent (second run applied 0). `.admin-subjects-page .subject-grid` already tiled correctly and was left alone.

**Still single-column on purpose:** `.page-stack`, `.stack-form`, `.sidebar-nav`, `.list-stack` on profile/billing/notification pages, and the tutor-picker list inside the Select Tutor modal.

### Phase 2 — Data model migration — ✅ **DONE 2026-08-19**

Delivered as **`scripts/migrate-module-overhaul.js`** (one executable source of truth, following the working `scripts/migrate-assessment-schema.js` pattern) rather than a `.sql` file plus a runner — two copies of the same DDL would drift.

**Critical discovery before writing it:** all Gen 3 tables were **empty** — `modules`, `tutor_assessments`, `tutor_assessment_questions`, `tutor_question_options`, `tutor_assessment_submissions`, `tutor_student_answers`, `student_subject_levels` all had 0 rows locally (only `subjects` had 10). So the restructure carried no local data risk. **The live DB may differ — re-check row counts there before running.**

**Also critical:** CHECK/UNIQUE constraint names here are SQL-Server-generated (`CK__modules__level__2EF0D041`, `CK__tutor_ass__quest__46C859D2`) and **differ between databases**. Every constraint drop resolves its name from `sys.*` at runtime; nothing is hardcoded. This is what makes the script safe to run against live.

| Area | Change | Status |
|---|---|---|
| `subjects` | `+ handout_version INT NOT NULL DEFAULT 1` — the regenerate-vs-reuse cache key | ✅ |
| `modules` | `+ order_number`, `+ target_year_levels_json` | ✅ |
| `modules` | Dropped `uniq_module_subject_level` — **this UNIQUE(subject_id, level) was the hard cap of 3 modules per subject** | ✅ |
| `modules` | Dropped the `level` CHECK, made `level` nullable (now vestigial, kept so legacy rows read) | ✅ |
| `module_handouts` | **NEW table** — many files per module, with `extracted_text` / `extracted_at` / `extraction_error` so a file is parsed once, not per request. `ON DELETE CASCADE` from `modules` | ✅ |
| `tutor_assessments` | `module_id` → **nullable** (dropped + re-added `fk_ta_module` around the ALTER, since the FK indexes the column) | ✅ |
| `tutor_assessments` | `+ assessment_kind` (CHECK: `pre_assessment`/`tutor_assessment`/`post_assessment`), `+ question_type`, `+ item_count`, `+ source_pre_assessment_id`, `+ handout_version`; backfills `assessment_kind` from the legacy `purpose` | ✅ |
| `tutor_assessment_questions` | CHECK recreated to include **`'essay'`** — the old constraint rejected essay questions outright, so the spec's essay requirement was physically unstorable | ✅ |
| `tutor_assessment_questions` | `+ source_module_id`, `+ source_handout_id` (indexed), `+ answer_rubric` | ✅ |
| Classification | `'Advanced'` → `'Advance'` everywhere; realigned the `student_subject_levels.level` CHECK | ✅ |

**Idempotency:** first run `applied 25, skipped 4, failed 0`; re-run `applied 0, skipped 29, failed 0`. (The first re-run was *not* clean — `dropColumnCheck` was dropping the constraint the script had just installed and re-adding it. Fixed with a `keepName` guard.)

**Design decision — no FK on `source_module_id` / `source_handout_id`.** They are plain indexed INTs. `ON DELETE SET NULL` is what the behaviour wants (delete a handout, keep the question, lose the precise attribution), but SQL Server rejects that path because `subjects → modules → module_handouts` already cascades. Readers `LEFT JOIN`, so a deleted source renders as "unknown source" rather than erroring. This also matches how the codebase already handled it (`source_module_title` was a bare string).

#### Classification bug fixed alongside the migration

Three schemes coexisted and **none matched the spec**:

| Source | Bands | Returned |
|---|---|---|
| `determineLevel()` (`config/levelThresholds.js`) | 0–59 / 60–79 / 80–100 | …/`Advanced` |
| `scoreToLevel()` (`lib/data.js`) | 0–40 / 41–70 / 71–100 | …/`Advance` |
| **Spec Section 5** | **0–50 / 51–80 / 81–100** | …/`Advance` |

A student scoring 55% was **Beginner on one code path and Intermediate on the other** (`routes/student.js:1088` used `determineLevel`, `lib/data.js` used `scoreToLevel`). And the spellings were load-bearing: `assessment_results.level` / `assessment_attempts.level` only accept `'Advance'`, so `determineLevel`'s `'Advanced'` would have failed those inserts, while `student_subject_levels` only accepted `'Advanced'`.

`config/levelThresholds.js` is now the single source of truth on the spec's bands, and `scoreToLevel()` delegates to it. Verified across 11 boundary values (0, 50, 50.6, 51, 80, 80.4, 81, 100…) — all three columns agree.

#### Functional proof

A smoke test exercised what the **old** schema made impossible, then cleaned up after itself:

```
PASS  inserted 5 modules in one subject (old schema allowed max 3)
PASS  target_year_levels_json round-trips ("Kinder 1")
PASS  3 handouts attached to one module
PASS  pre_assessment stored with module_id = NULL and question_type = mixed
PASS  all 4 types stored, including 'essay' (previously blocked by CHECK)
PASS  traced: "Module 1" -> handout "fractions.pdf"        <- weak-area join
PASS  subject v2 vs cached assessment v1 -> detected as stale
PASS  invalid question_type 'crossword' correctly rejected
PASS  invalid assessment_kind correctly rejected
PASS  deleting a module cascaded its handouts away (no orphans)
```

DB left clean afterwards (all 0 rows, `handout_version` back to 1); server boots with no errors.

### Phase 3 — Admin: Modules + Handouts — ✅ **DONE 2026-08-19**

| # | Change | Status |
|---|---|---|
| 1 | `GET /admin/subjects/:id` now leads with a **Modules grid** (`Module 1..N` by `order_number`), each card showing handout count, assessment count and its target year levels | ✅ |
| 2 | `POST /admin/subjects/:id/modules` — "Add Module" with auto-numbering (`MAX+1` **inside a transaction**, so two admins adding at once cannot both land on "Module 3") and a grouped year-level multi-select | ✅ |
| 3 | `GET /admin/modules/:id` — new `admin-module-detail.ejs`: handout grid, multi-file upload, module settings, remove-module | ✅ |
| 4 | `POST /admin/modules/:id/handouts` — `multer.array('handouts', 10)`, multiple files per submit | ✅ |
| 5 | `POST /admin/modules/:id/handouts/:handoutId/delete` + `POST /modules/:id/update` + `POST /modules/:id/archive` | ✅ |
| 6 | Every handout add/delete and module removal bumps `subjects.handout_version` **in the same transaction** as the write — a handout can never change without the cached assessment being marked stale | ✅ |
| 7 | Legacy `subject_resources` panel demoted to a labelled read-only "Legacy Modules" section (its upload form removed; full removal in Phase 9) | ✅ |
| 8 | Assistant admin keeps read access; every mutating route retains the `role !== 'admin'` guard | ✅ |

#### The year-level trap — plan corrected

The original Phase 3/6 text said to reuse `normalizeYearLevelKey()` for targeting "so matching is consistent with the rest of the app." **That would have been a bug.** That helper collapses every grade into one of four groups:

```
"Kinder 1" -> "primary level"      "Grade 5"  -> "primary level"
Kinder 1 == Grade 5 ?  true
```

So a module targeted at "Kinder 1" would have shown to Grade 5 students — precisely the case the spec calls out ("restrict a module to show only for Kinder 1"). Real data confirms the granularity needed: the one student in the DB is `year_level='Pre School Level'`, `grade_level='Kinder 1'`.

`moduleTargetsStudent()` therefore matches on the **exact label** against both `year_level` and `grade_level`, never the collapsed key. Selecting a group also matches its member grades, so targeting "Pre School Level" still reaches a student recorded only as "Kinder 1". Unrecognised labels are dropped by `sanitizeModuleTargets()` so a typo cannot silently hide a module from everyone. Empty list = visible to all.

Verified across 10 cases including `[Kinder 1]` vs Grade-5 → **false**, `[Pre School Level]` vs Kinder 1 → **true**, and case/space insensitivity.

#### Grid view

`.module-grid` and `.handout-grid` are `repeat(auto-fit, minmax(260px/240px, 1fr))`, matching the `.subject-grid` pattern already in the file. Also had to define `.badge*` in `subjects.css`: those styles only existed in `analytics.css`, and because this project copies base styles per page instead of sharing a global sheet, every badge on the subject page was rendering unstyled.

#### End-to-end proof

Driven over real HTTP with a real admin session (admins skip OTP — `routes/auth.js:90`). 30/30 checks passed:

```
PASS  Modules panel + .module-grid + Add Module modal render
PASS  auto-numbered 1, 2, 3
PASS  module 1 targets exactly ["Kinder 1"]
PASS  module 3 has no restriction (visible to all)
PASS  2 handouts stored from one submit; files exist on disk; sizes recorded
PASS  handout_version bumped 1 -> 2 on upload, 2 -> 3 on delete
PASS  .exe rejected, no orphan written to disk, redirects with a flash not a 500
PASS  targets replaced with ["Kinder 2"] on update
PASS  anonymous GET of a handout -> 401, logged-in -> 200
```

DB and disk left clean afterwards; no server errors.

⚠️ **Weak spot in that run:** the "assistant admin restrictions" check only proved the route is reachable — it ran as *admin*, not as an assistant. The `role !== 'admin'` guards are in the code but are **not yet proven by test**. Worth a real assistant-account test before final sign-off.

**Exit criteria:** checklist items 2 and 3 — met.

### Phase 4 — Handout text extraction — ✅ **DONE 2026-08-19**

New **`services/extractionService.js`**. `.pdf` → `pdf-parse`, `.docx` → `mammoth`, `.pptx` → `jszip`, `.txt` → direct read. `jszip` **promoted to a direct dependency** in `package.json` — it was only a transitive dep of `mammoth`, so an `npm install` could have removed it and broken PPTX silently.

**`pdf-parse` here is v2.4.5, not v1** — the API is `new PDFParse({ data: buffer })` then `await parser.getText()` → `{ text, pages, total }`, and the parser is `destroy()`ed in a `finally`. v1 examples found online will not work.

#### The finding that shaped this phase

Running extraction over the project's own existing uploads:

```
3 of 8 existing PDFs have NO text layer at all (0 usable chars) — they are scans.
The other 5 yield 14,937 - 47,368 chars.
```

Handing an empty string to the model would make it **invent questions unrelated to the handout**. So extraction reports `usable: false` with a human-readable reason instead, `extracted_at` is left NULL, and **no empty text is stored**. `getSubjectHandoutTexts()` — the query that feeds generation — only returns rows with `extracted_at IS NOT NULL`, so unusable handouts are structurally excluded rather than filtered by convention.

#### Design points

- **Inline, not a background job.** Extraction is local CPU: ~200ms per PDF, measured 1,761ms for a two-PDF upload over HTTP. The admin gets immediate feedback on which files can produce questions.
- **Cached once** on `module_handouts.extracted_text`; generation never re-parses a file.
- **12,000-char budget per handout**, with the true source length kept in the response so the admin is told "only the first 12,000 of 47,368 characters are used". The old prompt capped at 3,000.
- **Never throws.** One bad file must not fail an upload of ten. Failures return `{ usable: false, error }`.
- **Formats accepted but not extractable** (`.doc`, `.ppt`, `.xls`, `.xlsx`) stay downloadable as study material and get an actionable message ("Re-save as .docx to use it for assessment generation").
- **Retry action** (`POST /modules/:id/handouts/:handoutId/extract`). Without it a handout whose first parse failed would be permanently unusable with no recovery short of delete-and-reupload.
- **PPTX ordering:** slides are sorted numerically, so `slide10` comes after `slide2` rather than between `slide1` and `slide2`. `slideLayouts/` is ignored — only real slides are read.
- **XML entities** are decoded with `&amp;` **last**, so `&amp;lt;` stays the literal text `&lt;` instead of being double-decoded into `<`.

#### Verification

**Unit, 20/20** — including PPTX slide ordering, layout exclusion, entity decoding and the no-double-decode case, DOCX, TXT, the real scanned PDF from this project, legacy `.doc`, missing file, corrupt PDF, corrupt PPTX, and truncation.

**End-to-end over HTTP, 21/21** — uploading a text PDF and a scanned PDF in one submit:

```
PASS  upload 302 in 1761ms (extraction ran inline)
PASS  12000 chars cached in the DB; respects the prompt budget
PASS  scanned PDF: extracted_at NULL, reason recorded, no empty text stored
PASS  generation source query returns 1 of 2, excluding the scan
PASS  carries module_id + handout_id for weak-area attribution
PASS  module page shows Text ready / No text for questions / char count / Re-read
PASS  retry on the scan stays honest (does not pretend to succeed)
```

One wording fix after the run: the badge said "Extract failed" for a scanned PDF. That is inaccurate — the file is a perfectly valid handout, it just has no text layer. Now "No text for questions", with the reason below it.

**Exit criteria:** met, and extended — PPTX and the unusable-file path are covered too.

---

### Phase 4b — OCR for scanned handouts — ✅ **DONE 2026-08-19**

Added because the scanned-PDF limitation was unacceptable: a handout the system cannot read is a handout that cannot become an assessment.

**Correction to the Phase 4 framing above.** The 3 "unusable" PDFs were inspected by rendering them to PNG and looking at them. They are **not teaching material** — they are this project's own **ER diagram and Administrator DFD**, thesis documentation uploaded as test files. So the earlier "37% of your PDFs are unusable" framing overstated the problem for real handouts. The capability gap was still worth closing, since photographing a worksheet is a realistic way to produce a handout.

**How it works — no new dependency, no new provider:**

1. `pdf-parse`'s own `getScreenshot()` renders each page to a `data:image/png;base64` URL. It renders internally, so **no `node-canvas` or native build toolchain** is needed — which matters on Windows.
2. `aiService.transcribeImage()` sends the page to **`gpt-4o-mini`**, which is multimodal, over the **existing** OpenAI config. Section 6's "do not introduce a separate AI provider" is respected; no OCR engine is added.

**Cost and speed, measured:** ~3.0–3.6s and ~$0.004 per page; ~25,500 tokens per page. A 16-page scan is roughly **$0.06**. Capped at `MAX_OCR_PAGES = 10` so a 60-page book cannot run away with time or budget.

**Opt-in, not automatic.** Upload does the fast text pass only. If that finds nothing, the handout card shows "No text for questions" and a **"Read with AI"** button. One click transcribes it. Automatic OCR on every upload would risk request timeouts (10 pages ≈ 36s) and spend money without the admin choosing to.

`extraction_method` (`'text'` / `'ocr'`) was added to `module_handouts` via the migration script, and the badge reads "Text ready (AI-read scan)" when OCR produced the text, so the provenance is never hidden.

#### A prompt bug worth recording

The first version of the transcription prompt ended with *"If the page genuinely contains no readable words at all, output exactly: NO_TEXT"*. The model **took that escape hatch on diagram-heavy pages** and returned `NO_TEXT` for a page whose labels it transcribed perfectly once the escape was removed. Offering a model an easy out invites it to take one. The instruction is gone; emptiness is now judged by the caller from the length of what came back, and a separate guard catches a model that describes a page instead of transcribing it.

#### Result: every PDF in this project is now usable

| File | Before | After |
|---|---|---|
| ER diagram, 3 pages | 0 chars | **1,884 chars** in 8.6s |
| Administrator DFD, 1 page | 0 chars | **452 chars** in 3.0s |
| 5 text-layer PDFs | already fine | unchanged, no OCR spend |

#### Proof that the pipeline produces a real assessment

Run against the project's own largest real handout — **STI `IT2501` "Social Engineering Techniques and Countermeasures"**, 16 pages, 47,368 characters:

```
provider=openai model=gpt-4o-mini tokens=1268 (4899ms)

1. [Identification]    What is social engineering?
                       -> The art of manipulating people to divulge sensitive information
2. [True or False]     Social engineering attacks can be easily detected.  -> false
3. [Multiple Choice]   Which method is NOT a type of social engineering attack?
                       A) Impersonation  B) Phishing  C) Tailgating  D) Data Encryption  -> D
4. [Identification]    What kind of information do attackers typically gather from official websites?
                       -> Employees' IDs, names, and email addresses
5. [True or False]     Security policies completely prevent social engineering attacks.  -> false
```

These are grounded in the handout, not generic. A useful signal: the call deliberately passed `subject: 'Mathematics'` while the handout was about social engineering, and the questions followed **the handout**, not the subject label.

**Caveat — this used the pre-existing generator**, which emits `Multiple Choice` / `True or False` / `Identification` and does not yet carry `source_handout_id`. Phase 5 replaces it with the spec's four types (adding **essay** and **fill-in-the-blank**), per-question source attribution, and `handout_version` caching. What is proven here is that the extraction → generation pipeline yields real, handout-specific questions.

Extraction unit suite re-run after the OCR changes: **20/20 still passing.**

### Phase 5 — AI Pre-Assessment generation — ✅ **DONE 2026-08-19**

`aiService.generateAssessmentFromHandouts()` reuses the same `callOpenAI` client — no new provider. Stored via `createGeneratedAssessment()`; served by `getOrCreatePreAssessment()`.

| Requirement | How | Status |
|---|---|---|
| Strict JSON, four spec types | `response_format: json_object`; mix planned by `planQuestionMix()` — 40/20/20/20 MC/TF/fill-blank/essay, every type guaranteed at least one slot once `itemCount >= 4` | ✅ |
| Per-question `source_handout_id` | Handouts are presented with their real DB ids; questions citing an unknown id are **discarded, not guessed at** | ✅ |
| Stored as subject-level | `assessment_kind='pre_assessment'`, `module_id=NULL`, `tutor_id=NULL`, `handout_version` stamped | ✅ |
| Regenerate-vs-reuse | Reused while `handout_version` matches; one regeneration when a handout changes | ✅ |
| Concurrency safe | In-process single-flight map **plus** the DB's `uq_ta_pre_per_version` filtered unique index; a lost race re-reads the winner's row instead of paying for a second generation | ✅ |
| Logged | `ai_generation_logs` per generation | ✅ |

**Schema additions this phase needed:** `tutor_assessments.tutor_id` → **nullable** (a generated assessment has no author, and it spans students with different tutors — `NOT NULL` would have forced inventing an owner), plus the `uq_ta_pre_per_version` unique index.

#### Two integration bugs caught before they could bite

1. `logAiGeneration()` tests `data.success !== false`, so passing `success: 0` recorded a **failure as a success**. Now passes `false`.
2. `ai_generation_logs.assessment_id` has an FK to the **legacy `assessments` table**, not `tutor_assessments`. Passing the new id would have violated it — and my original `.catch(() => {})` would have swallowed that silently. The id now goes in `output_summary`, and the catch logs instead of discarding.

#### Three quality defects found by reading the actual generated output

The first run passed almost every structural check, but the questions themselves were flawed:

- **Duplicated letters** — `A) A. Confidentiality...`. The model prefixed its own labels inside the choice text. Now stripped, and the prompt forbids it.
- **Identical choices** — options A and C came back as the same string, making the item unanswerable. Such questions are now **rejected**, and the prompt requires distinct choices.
- **All 8 questions from handout 1**, none from handout 2 — which would have made the weak-area view blind to the other module. Asking the model to "spread across handouts" was not enough; the prompt now states a **mandatory per-handout quota by id**.

#### Verification — 30/30

```
PASS  generated in 11862ms; kind=pre_assessment, module_id NULL, tutor_id NULL
PASS  all four types present: {multiple_choice:2, true_false:2, fill_blank:2, essay:2}
PASS  every MC answer letter matches a real choice
PASS  every essay has a grading rubric (needed for AI grading)
PASS  every cited handout id is real (hallucinated ids were rejected)
PASS  questions drawn from BOTH handouts, not just one
PASS  second open REUSED the stored copy in 32ms (no API call) — 12055ms -> 32ms
PASS  exactly 1 generation logged for 2 opens
PASS  3 simultaneous opens returned ONE assessment
PASS  exactly 1 live pre-assessment (old version archived)
PASS  2 generations total for 5 opens across 2 handout versions
```

Real output after the fixes — a clean 4/4 split across two modules, all four types in each:

```
1. [multiple_choice] Which of the following is NOT one of the five major elements
                     of Information Security?
                     A) Confidentiality  B) Integrity  C) Reliability  D) Authenticity  -> C
2. [true_false]      The main goal of insider attacks is to bypass security policies. -> true
3. [fill_blank]      The assurance that information is accessible only to authorized
                     people is known as ____.  -> Confidentiality
4. [essay]           Discuss the significance of non-repudiation in information security.
                     rubric: Definition of non-repudiation, Importance of accountability,
                             Legal implications
   ...1-4 from Module 1 / lesson-1.pdf, 5-8 from Module 2 / lesson-2.pdf
```

**Not yet wired to the student UI** — that is Phase 6. What exists now is the generation engine, its caching, and its storage.

**Exit criteria:** checklist item 4 met; opening the subject repeatedly makes exactly one OpenAI call per handout version.

#### Amendment — 30 items, and one call per handout (2026-08-19)

Requirement clarified: **a Pre-Assessment is 30 items, drawn from all handouts of all modules in the subject.** The source query already read every module's handouts; the size was 10. It now lives in **`config/assessmentDefaults.js`** as `PRE_ASSESSMENT_ITEM_COUNT`, so the route that opens the exam and the service that builds it cannot drift apart.

Scaling to 30 broke the single-call design, in three ways that only showed up by reading the output:

| Symptom | Cause | Fix |
|---|---|---|
| `invalid JSON` risk | `max_tokens: 4000` was sized for 10 items; a JSON reply that hits the cap is **truncated**, which surfaces as a parse error, not a length error | `callOpenAI` takes a `maxTokens`; generation scales it with the request |
| 29 of 30 items, twice | Validation rejects malformed items and de-duplication drops repeats, so asking for exactly N lands under N | Over-request (`+8`), and a top-up pass that also asks for more than the shortfall |
| **16/11/3 and 15/2/13** across three handouts; **10 essays** out of 30 | The per-handout quota lived in the prompt and the model **ignored it**. Truncating the surplus in arrival order then starved whichever handout the model left for last | **One call per handout**, each asked only for its own quota |

The last one is the real lesson: *a quota a model may ignore is not a quota*. With one call per handout the split is structural — a reply cannot cite a handout it was never shown — and the calls run concurrently, so three handouts cost about the wall time of one. Two further defects were caught the same way and are now rejected by the validator: a `fill_blank` with no blank in it (graded by exact match, so it was unanswerable), and a multiple-choice item with its own options baked into the question text (rendering the choices twice).

**Result, same three real handouts:** 30/30 items, **10/10/10 per handout**, all four types, no duplicates, **18s** — down from 36s, and from 77s once a top-up was involved.

⚠️ **Open UX question:** those 18 seconds are paid by the *first student* who opens the subject, since generation is triggered by their click and cached afterwards. Pre-generating when an admin adds or removes a handout would move the wait off the student. Not built — say the word.

### Phase 6 — Student: lock, take, grade, classify, weak areas (Section 5) — ✅ **DONE 2026-08-19**

Shipped in two parts: **part 1** the student path (grading engine, lock, result page), **part 2** the Tutor/Admin views of the same results.

#### Part 1 — student

| # | Change | Status |
|---|---|---|
| 1 | **Server-side lock** on `GET /student/modules/:id` **and** on `/uploads/handouts` — the file URL resolves back to its handout and takes the same three checks (enrolment → Pre-Assessment → year level), so typing a URL does not bypass it. Closes the `TODO(Phase 6)` left in `server.js` by Phase 0 | ✅ |
| 2 | **Year-level filter** via `moduleTargetsStudent()` from Phase 3 — exact labels, never the collapsed key | ✅ |
| 3 | **`gradeAndSubmitAssessment()`** replaces `submitTutorAssessment`; AI essay grading runs with no transaction open, and per-question `is_correct` / `points_earned` / `ai_feedback` are persisted (audit bugs #4/#5/#6) | ✅ |
| 4 | **Classification** via `determineLevel()` on the spec bands 0–50 / 51–80 / 81–100 → `Advance` | ✅ |
| 5 | **Result page** `student-assessment-breakdown.ejs` — %, classification against the three bands, correct/incorrect counts, item-by-item with feedback and source attribution. Takes a `viewerRole` so staff reuse it | ✅ |
| 6 | **Weak areas** group wrong answers by `source_module_id` / `source_handout_id`; a question whose handout was since deleted falls into an "Unattributed" bucket so the totals still add up | ✅ |

**Audit finding #18 — the grading engine never worked.** `submitTutorAssessment()` did `const questions = await connection.query(...)` without destructuring, but `withTransaction`'s `connection.query` returns `[rows]`. The loop therefore iterated once over the rows *array*, every `q.id` / `q.points` was `undefined`, and `totalPoints` came out `NaN`. Every other call site in the file destructures; this one did not. It went unnoticed because these tables were empty and the path had never been exercised.

**Schema this part needed:** `tutor_assessment_submissions` + `level` (checked), `started_at`, `time_spent_seconds`, and a unique index on `(assessment_id, student_id)` so a double submit is stopped by the DB rather than by a read-then-insert two concurrent requests could both pass. `tutor_student_answers` + `ai_feedback`, and `points_earned` → `DECIMAL(6,2)` because essay grading gives fractional credit.

**A bug the first test run caught — the lock rejected students from their own modules.** The year-level check was handed `req.session.user`, but neither the login query nor `setUserLocals` selects `year_level` / `grade_level`, so the session copy has neither. `moduleTargetsStudent()` found no year level and matched nothing. Dangerous shape: the subject page *listed* the module correctly (it loads the student via `getUserById()`), so only clicking through failed — the UI and the guard disagreed and the guard was the strict one, which reads as "the lock works" rather than "the lock is wrong". Both guards now load the student with `getUserById()`.

**Student end-to-end: 44/44** over real HTTP with a real student session — the lock blocks modules and handouts before the Pre-Assessment (403 on a direct handout URL), all four types render and grade, a wrong fill-blank and a blank essay are marked incorrect, AI feedback is persisted, 60% classifies as Intermediate, weak-area totals trace to a named handout, and afterwards the Kinder 1 module opens (200) while the Grade 5 module stays blocked (302/403) for the same student.

#### Part 2 — Tutor / Admin (acceptance item 8)

| # | Change | Status |
|---|---|---|
| 1 | `GET /admin/results/:submissionId` and `GET /tutor/results/:submissionId` render the **same** breakdown view with `viewerRole` set — one page, three audiences, no third copy of the weak-area logic | ✅ |
| 2 | The tutor route checks the submission's subject against `getTutorAssignedSubjects()`; a result from another subject redirects with a flash | ✅ |
| 3 | Admin/Assistant **subject page** gains a Pre-Assessment Results table (student, year level, score, %, classification, link to the breakdown) | ✅ |
| 4 | Tutor **subject page** gains a read-only Modules grid (Admin owns creation) plus the same results table; its legacy panel is relabelled "Legacy Modules" | ✅ |
| 5 | `.target-chip*` / `.module-card-meta` appended to `tutor/subjects.css` — the tutor page reuses the Admin module card, and this project keeps one CSS file per page rather than a shared sheet | ✅ |

**A separate route, not a reuse of `/tutor/student-results/:id`.** That older review INNER JOINs `modules` and filters on `ta.tutor_id` — both NULL for a generated Pre-Assessment, so it can never return one.

**The same two joins were hiding Pre-Assessments from the Student Results lists.** `getStudentResultsAdmin()` and `getTutorStudentResults()` had the identical `JOIN modules` + `tutor_id` shape, so every generated Pre-Assessment was silently missing from the page staff actually navigate to. The module join is now `LEFT`, the tutor query also accepts the subjects that tutor is assigned to (matching the route guard), and `level` now comes from the submission — the student's classification, which is what that column always claimed to show — instead of the module's difficulty. Both lists link each row to the new breakdown.

#### Verification — 35/35 over real HTTP

Seeded one module, two handouts, a four-type Pre-Assessment attributed to them, and a graded submission answered **right on handout A and wrong on handout B**; then deleted everything (`modules 0, handouts 0, assessments 0, submissions 0, answers 0` afterwards).

```
PASS  syllables.pdf flagged "Needs review"; letters.pdf not flagged
PASS  admin + assistant + tutor subject pages show the results table
PASS  admin breakdown names the weak handout, uses staff wording not "Your answer"
PASS  Pre-Assessment now appears in both Student Results lists (was hidden)
PASS  tutor list does NOT leak a submission from an unassigned subject
PASS  tutor CANNOT open a result from an unassigned subject
PASS  unknown submission id redirects with a flash, no 500
PASS  anonymous request redirects to login
```

Staff logins in that run used **throwaway accounts created and deleted by the test**, so no real user's password was touched; the tutor/student OTP was skipped with a temporary `trusted_devices` row rather than by sending mail. This also closes the Phase 3 gap: the assistant-admin restriction is now proven by a real assistant session, not assumed.

**Exit criteria:** checklist items 5, 6, 7, 8 — met.

### Phase 7 — Tutor: module assessments (Section 4a) — ✅ **DONE 2026-08-19**

| # | Change | Status |
|---|---|---|
| 1 | `/tutor/modules` rebuilt on `getSubjectModules` — Module 1..N with handout counts, assessment counts and target year levels, instead of the old three Beginner/Intermediate/Advanced cards | ✅ |
| 2 | `/tutor/modules/:id` now shows Admin's **handouts** (readable, with the same "Text ready / No text for questions" provenance badge as the Admin page) alongside the tutor's assessments | ✅ |
| 3 | The builder gained **question type** (MC / True or False / Fill in the Blank / Essay / Mixed) and **item count**, and **Essay** as a manual question type with a rubric field — the rubric is the answer key the AI grader marks against | ✅ |
| 4 | **"Draft with AI"** reuses Phase 5's generator scoped to one module's handouts. It renders the questions **into the builder**, saving nothing: the tutor edits and presses Create, so the AI drafts but never publishes | ✅ |
| 5 | Saved with `assessment_kind='tutor_assessment'`, the chosen `question_type`, the real `item_count`, and `source_module_id` on every question — so a tutor assessment feeds the same weak-area view as the Pre-Assessment | ✅ |
| 6 | `/tutor/student-results/:id` and `/student/assessment-result/:id` now **redirect** to the Phase 6 breakdown | ✅ |

#### The authorization hole this phase closed

Every `/tutor/modules/*` route read the id straight from the URL. **Any tutor could open — and build an assessment on — any module in the system**, including subjects they do not teach. `resolveTutorModule()` now applies the same assigned-subject check as `/tutor/results/:id`. Proven by test: a module in an unassigned subject is not listed, and opening it directly redirects.

#### Two dead-end paths removed rather than left in place

- **`submitTutorAssessment()` deleted.** It was still the grader for every tutor assessment, and it was the function with audit finding #18 — the missing destructure that made `totalPoints` come out `NaN`. It also cannot grade an essay, which the builder can now create. `/student/tutor-assessments/:id/submit` uses `gradeAndSubmitAssessment` — the same engine as the Pre-Assessment — so per-question correctness and AI feedback are stored, and the breakdown page works for tutor assessments too.
- **`tutor-result-detail.ejs` and `student-assessment-result.ejs` deleted.** Both were second, weaker copies of the breakdown — no weak areas, no source attribution, and both fed by queries that INNER JOIN `modules`. The old URLs still work; they redirect.

**A real bug found by reading the take page:** an essay item rendered as a one-line text box labelled "Fill in the Blank", because that view's type check had no `essay` branch and fell through to its `else`. A one-line box invites a one-word answer to a question graded on key points. Now a textarea, labelled Essay.

#### Verification — 48/48 over real HTTP

A throwaway tutor and student, a real module with a real text handout, cleaned up afterwards:

```
PASS  tutor CANNOT open a module from an unassigned subject (and it is not listed)
PASS  AI draft rendered 5 questions into the builder in 8.7s
PASS  drafting saves NOTHING until the tutor presses Create
PASS  stored as assessment_kind=tutor_assessment, purpose=activity, item_count=4
PASS  the essay question was accepted (the old CHECK rejected essay outright)
PASS  every question attributed to its module
PASS  the tutor's assessment is visible to the student, essay as a textarea
PASS  percentage is a real number (the old engine produced NaN here)
PASS  the essay was graded by AI and its feedback stored
PASS  tutor reviews the attempt; both old URLs redirect
```

Phase 6's 35/35 re-run clean afterwards.

**Exit criteria:** checklist items 9, 10, 11 — met.

### Phase 8 — Post-Assessment (Section 4b) — ✅ **DONE 2026-08-19**

| # | Change | Status |
|---|---|---|
| 1 | **Completion is per student** (decision D5): Pre-Assessment done, every *visible* module opened, every published tutor assessment on those modules submitted | ✅ |
| 2 | **`student_module_reads`** — a new table, because "opened the module" was not recorded anywhere for the new module system | ✅ |
| 3 | `POST /tutor/subjects/:id/create-post-assessment` clones the Pre-Assessment **verbatim** — questions, choices, answers, rubrics and source attribution — into `assessment_kind='post_assessment'` with `source_pre_assessment_id` set | ✅ |
| 4 | Student takes it through the same view as the Pre-Assessment, parameterised by `kind` | ✅ |
| 5 | **Pre-vs-post comparison** on the Student subject page (before → after with the classification move), the Tutor subject page (per student, with readiness) and the Admin subject page (read-only) | ✅ |

#### Why a new table rather than reusing `module_reads`

`module_reads.resource_id` points at the legacy `subject_resources`, not at `modules`. Writing module ids into it would have silently mixed two id spaces that both look like plain integers — the kind of bug that surfaces months later as a student credited for a module they never opened. `student_module_reads` has its own FK to `modules` and a unique index on `(student_id, module_id)`, so a second open updates a timestamp instead of inflating the count. Migration re-run: `applied 0, skipped 45, failed 0`.

#### The completion rule counts only what the student can actually see

`getStudentSubjectCompletion` measures against `getStudentSubjectModules` — the modules **targeted at this student's year level**. Counting every module in the subject would leave a Kinder 1 student permanently one short because of a Grade 5 module they are not allowed to open, and the Post-Assessment would never unlock. Proven by test: a Grade 5 module is excluded from a Kinder 1 student's total *and* stays blocked to them.

#### The clone is a real copy, not a reference

`source_pre_assessment_id` records provenance, but the questions are **duplicated rows**. A student answering the post version writes `tutor_student_answers` against post question ids, so pointing both assessments at one set of question rows would have made the two attempts indistinguishable in the answer table. Nothing is regenerated — a second AI call would produce different questions and the comparison would measure the exam, not the student.

⚠️ The earlier plan text said to reuse the "proven `copy-as-post` logic". It was **never proven** — audit bug #16: that route crashed with `MODULE_NOT_FOUND` on every click and was deleted in Phase 1. This was written fresh.

#### Verification — 41/41 over real HTTP

One student walked through the entire cycle with throwaway accounts, cleaned up afterwards:

```
PASS  the Grade 5 module is excluded from a Kinder 1 student's total
PASS  student cannot open the Post-Assessment yet; tutor cannot create it either
PASS  opening a module counts once — opening it twice still counts once
PASS  complete student STILL cannot take it before the tutor opens it
PASS  same items: text, answers, choices and source attribution all identical
PASS  pressing Create twice does not make a second one
PASS  a retake sends them to their result instead
PASS  comparison shows improvement and the classification moved
PASS  Student, Tutor and Admin all see the before-and-after
```

Phases 6 (35/35) and 7 (48/48) re-ran clean afterwards.

**Exit criteria:** checklist item 12 — met.

### Phase 9 — Consolidation + final sweep — ✅ **DONE 2026-08-19**

**Decision D2 answered: remove Gen 1.** Carried out as **code removal only — no table was dropped.** Deleted code comes back with `git revert`; a dropped table does not, and the records in `student_learning_cycles`, `assessment_requests` and `module_reads` are part of the project's history. `-1,310 / +84` lines.

| # | Change | Status |
|---|---|---|
| 1 | **Student:** `POST .../modules/:resourceId/read`, `.../request-assessment` and `.../generate-assessment` deleted — the whole mark-read → ask permission → AI-generates loop | ✅ |
| 2 | **Student:** the AI "review module" generator deleted from the submit handler. It wrote a standalone HTML page per submission that **pulled a markdown parser from a CDN** — the only part of the system that reached an outside host at view time | ✅ |
| 3 | **Tutor:** `POST /assessment-requests/:id/accept` and `.../decline` deleted, and the pending-request card removed from the notification bell — a badge counting rows no page can act on is worse than no badge | ✅ |
| 4 | **Tutor:** `POST /subjects/:id/post-consolidated-assessment` deleted. It generated one AI exam over every legacy resource and pushed it to the class, **competing with the real Post-Assessment** from Phase 8. Two buttons called "Post Assessment" is how the wrong one gets clicked during a demo | ✅ |
| 5 | **`lib/data.js`:** 9 Gen 1 helpers removed; `generateModuleFromAssessmentResult` removed from `aiService` | ✅ |
| 6 | **The three-generation subject page** collapsed to one source of truth (below) | ✅ |
| 7 | Latent bug #8 in `config/db.js` fixed | ✅ |

#### The subject page, before and after

`GET /student/subjects/:id` was the exhibit in the original audit: it loaded **three competing answers** to "what does this student do next?" — a Gen 1 learning cycle, a Gen 2 admin pre/post pair with its own `adminModulesLocked` flag, and a Gen 3 level-gated single module — plus the pending AI assessments and tutor pre-assessments that went with them. The view had to guess which won, and that guess is what produced the stale-data symptom.

The route now loads the Pre-Assessment gate, the modules targeted at this student, and the Post-Assessment. The view lost four panels (`Current Learning Cycle`, `Module Level System`, the Gen 2 `Subject Assessments` block, and the lock branches inside the legacy module list) and dropped from 455 to 240 lines.

#### Verification

- **All three suites re-run against the changed code:** Phase 6 **35/35**, Phase 7 **48/48**, Phase 8 **41/41**.
- **Every view compiles:** 61/61.
- **Every page of every role renders:** a new sweep logs in as Admin, Admin Assistant, Tutor and Student and opens **36 pages** — all 200 or a deliberate 302, no 500. This is the check that catches a template still referencing a variable its route no longer passes, which nothing else would find.
- **No form posts to a missing route:** every `action=` in `views/` cross-checked against the routers.
- Server log clean across every run.

⚠️ **Deliberately left alone:** the Gen 2 admin *Assessments* page (`assessment_templates`) and the legacy student `/assessments` pages still work. D2 named the learning-cycle / request / AI-review-module feature, and those pages are neither — removing them would have been scope the decision did not cover.

---

## PART D — Mga desisyong kailangan mula sa'yo

Huwag hulaan ang mga ito. Kailangan ng sagot bago mag-Phase 2.

---

### D1 — Ang Beginner / Intermediate / Advance: **gate** pa rin ba, o **label** na lang?

**Ngayon:** ang `student_subject_levels.level` ang nagdedesisyon kung **aling isang module lang** ang mabubuksan ng student (`routes/student.js:1128`). Kung Beginner ka, Beginner module lang ang makikita mo.

**Sa bagong spec:** **year level** ang basehan ng pagpapakita ng module (Kinder 1, etc.), at sabi sa Section 5 na pagkatapos ng pre-assessment ay "*can browse Modules/Handouts*" ang student. Ang ibig sabihin nito: ang classification ay **label + pantukoy ng weak area na lang** — hindi na lock.

**Kung hindi ka sasagot, ito ang aakalain ko:** label na lang.

⚠️ Ito ang **pinakamalaking sanga** sa buong plano — dito nakasalalay kung mananatili pa ba ang `getModuleBySubjectAndLevel` at ang buong level-gating layer.

---

### D2 — Ano ang gagawin sa lumang Gen 1 na sistema?

Ang `student_learning_cycles`, `assessment_requests` (kung saan ang student ang humihingi ng assessment sa tutor), at ang AI-generated na **review modules** (`generateModuleFromAssessmentResult`) — isang buong feature ito na **hindi na binanggit** sa bagong spec mo.

- **(a) Tanggalin lahat** — pinakamalinis, kaunti na lang ang aalagaan
- **(b) Pabayaan itong tumakbo kasama ng bago** — pero ito mismo ang duplication na sanhi ng stale-data bugs na nakita natin

**Rekomendasyon ko: (a) tanggalin.** — ✅ **Ito ang sinunod (2026-08-19).** Tanging ang *code* ang tinanggal; **walang table na ni-drop**. Nababalik ang code sa ; ang na-drop na table, hindi na.

❗ Sabihin mo agad kung kailangan mo ang alinman dito para sa **defense** mo — kapag natanggal na, mahirap nang ibalik.

---

### D3 — Gaano kalawak ang lockdown ng `/uploads`?

Ang isang static mount na 'yon ay hindi lang handouts ang pinapadaan — kasama rin dito ang **profile pictures** at **chat attachments**.

- **(a) I-lock lang ang module/handout folders** — public pa rin ang mga larawan
- **(b) I-lock lahat, ipasa lahat sa `/download`**

**Rekomendasyon ko: (a)** — natutugunan ang requirement ng Section 6 nang hindi ginagalaw ang messaging at profile UI na gumagana naman.

---

### D4 — I-extend ang `tutor_assessments`, o gumawa ng bagong malinis na tables?

Ang Part B sa itaas ay naka-assume na **i-extend ang `tutor_assessments`**. Dahilan: ang `tutor_assessment_submissions` + `tutor_student_answers` ay **nag-iimbak na ng per-question correctness** — mga **isang linggong trabaho** ang natitipid dito.

- **Bayad:** matitiis natin ang pangalang `tutor_` kahit sa pre/post assessments na walang tutor na gumawa
- **Alternatibo:** bagong `assessments_v2` — mas magandang pangalan, pero kailangang i-rewrite ang buong submission/answer layer at i-migrate ang live data

**Rekomendasyon ko: i-extend.** Kumpirmahin mo lang kung okay lang sa'yo ang pangalan.

---

### D5 — Kailan ba "tapos na ang cycle" para sa Post-Assessment?

Sabi ng Section 4b: "*after all modules + all tutor assessments in a subject are completed*."

Ang tanong: **per-student** ba o **per-class**?

- **Per-student** — lalabas ang button kapag *itong* student ay natapos na lahat
- **Per-class** — lalabas lang kapag **lahat** ng student sa subject ay tapos na

**Naka-assume ang Phase 8 sa per-student.** — ✅ **Ito ang ipinatupad (2026-08-19).** Bawat estudyante ang binibilang: bumubukas ang Post-Assessment para sa sinumang tapos na, hindi hinihintay ang buong klase. Nakikita pa rin ng tutor kung ilan ang handa bago niya ito buksan.

---

## Acceptance checklist → phase mapping

| # | Item | Phase |
|---|---|---|
| 1 | Module Management removed from both sidebars | 1 |
| 2 | Unlimited modules per subject + year-level targeting | 2, 3 |
| 3 | Multiple handouts per module | 2, 3 |
| 4 | Pre-Assessment auto-served, generated from handouts | 4, 5 |
| 5 | Modules/handouts locked until Pre-Assessment done (server-side) | 0, 6 |
| 6 | All 4 question types auto-graded, incl. essay | 6 |
| 7 | %, classification, right/wrong breakdown | 6 |
| 8 | Tutor/Admin see results + weak areas by module/handout | 6 |
| 9 | Tutor creates module assessments (type + item count) | 7 |
| 10 | Tutor assessments visible to students, trackable | 7 |
| 11 | Tutor reviews student scores per assessment | 7 |
| 12 | "Create Post Assessment" reusing pre-assessment items exactly | 8 |
