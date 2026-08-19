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

### Phase 2 — Data model migration (Section 2)
Write `sql/incremental_module_overhaul.sql` following the existing idempotent style in `sql/incremental_ai_system.sql` (`IF COL_LENGTH(...) IS NULL` / `IF OBJECT_ID(...) IS NULL` guards) so it is safe to re-run against the live somee.com DB.

1. `modules`: `+ order_number INT`, `+ target_year_levels_json NVARCHAR(MAX)`, make `level` nullable, drop the level CHECK.
2. `CREATE TABLE module_handouts` (`module_id`, `file_path`, `file_original_name`, `file_type`, `extracted_text NVARCHAR(MAX)`, `extracted_at`, `uploaded_by`, `is_archived`).
3. `subjects: + handout_version INT NOT NULL DEFAULT 1`.
4. `tutor_assessments`: `+ assessment_kind`, `+ question_type`, `+ item_count`, `+ source_pre_assessment_id`, `+ handout_version`; `module_id` → nullable.
5. `tutor_assessment_questions`: drop + recreate CHECK to include `'essay'` and `'mixed'`; `+ source_module_id`, `+ source_handout_id`, `+ answer_rubric`, `+ choice_*` or keep using `tutor_question_options`.
6. Backfill `modules.order_number` from existing rows per subject.
7. Add a matching `scripts/migrate-module-overhaul.js` runner (mirror `scripts/migrate-assessment-schema.js`).

**Exit criteria:** migration runs twice with no error; `scripts/check-assessments-schema.js`-style verification prints the new columns.

### Phase 3 — Admin: Modules + Handouts (Section 3)
1. `GET /admin/subjects/:id` — replace the resources panel with a **Modules list** (ordered by `order_number`).
2. `POST /admin/subjects/:id/modules` — "Add Module": auto-assign `order_number = MAX+1`, multi-select `target_year_levels` (source the option list from `normalizeYearLevels` in `lib/data.js:172` so it matches student `year_level` values exactly).
3. `GET /admin/modules/:id` — module page; `POST /admin/modules/:id/handouts` with `multer.array()` for multiple files.
4. `POST /admin/modules/:id/handouts/:hid/delete`; every handout add/delete bumps `subjects.handout_version`.
5. Admin Assistant gets the same read access; keep the existing "only main admin can upload" guard pattern (`routes/adminFactory.js:1168`).

**Exit criteria:** checklist items 2 and 3.

### Phase 4 — Handout text extraction (Section 6)
New `services/extractionService.js`:
- `.pdf` → `pdf-parse`; `.docx` → `mammoth.extractRawText`; `.pptx` → `jszip` over `ppt/slides/slideN.xml`, strip `<a:t>` text nodes; `.txt` → read directly.
- Add `officeparser` (or promote `jszip` to a direct dependency in `package.json` — right now it is only a transitive dep of `mammoth` and could vanish on an install).
- Cache into `module_handouts.extracted_text` on upload; never re-extract on read.
- Truncate/chunk to fit the model budget (current prompt caps at 3000 chars — raise deliberately and note token cost).

**Exit criteria:** one PDF, one DOCX, one PPTX upload each produce non-empty `extracted_text`.

### Phase 5 — AI Pre-Assessment generation (Sections 5, 6)
1. Add `generatePreAssessmentFromHandouts()` to `services/aiService.js` — **same `callOpenAI` client, no new provider.**
2. Prompt: strict JSON only, mixed types (MC / True-False / Fill-in-Blank / Essay), and **each question must carry the `source_handout_id`** it came from. Pass handouts as an id-labelled list so the model can attribute correctly; validate every returned `source_handout_id` against the real ids and drop questions that fail.
3. Store as `tutor_assessments` with `assessment_kind='pre_assessment'`, `module_id=NULL`, `handout_version = subjects.handout_version`.
4. **Regenerate-vs-reuse:** on student open, reuse the existing pre-assessment if `handout_version` matches; regenerate only when it is stale. Guard against two students triggering generation at once (single-flight lock or `UNIQUE(subject_id, assessment_kind, handout_version)`).
5. Log every call to `ai_generation_logs` (table already exists).

**Exit criteria:** checklist item 4; opening the subject twice makes exactly one OpenAI call.

### Phase 6 — Student: lock, take, grade, classify, weak areas (Section 5)
1. **Server-side lock:** a reusable `requirePreAssessment(studentId, subjectId)` guard on `GET /student/modules/:id`, on the handout download route, and on tutor-assessment routes. Not UI hiding — checklist item 5 explicitly requires this.
2. **Year-level filter:** module visible only if `student.year_level ∈ module.target_year_levels_json`. Reuse `getStudentYearLevelKeys` (`lib/data.js:250`) and `normalizeYearLevelKey` (line 224) so matching is consistent with the rest of the app.
3. **Grading:** port the `submitAssessment` engine (`lib/data.js:2964`) onto `tutor_assessment_submissions` / `tutor_student_answers`, and **fix bugs #4/#5/#6 in the port** — persist per-question `is_correct`, `points_earned`, and `ai_feedback`; do the AI call before opening the transaction.
4. **Classification:** 0–50 Beginner / 51–80 Intermediate / 81–100 Advance. `config/levelThresholds.js` + `determineLevel` already exist — verify the boundaries match these exact bands before reusing.
5. **Result page:** %, classification, right/wrong per item. `views/content/student-assessment-result.ejs` already renders exactly this shape once #4 is fixed.
6. **Weak areas:** join incorrect answers → `source_module_id` / `source_handout_id` → "Module 2 — Handout: Fractions". Surface on the student result page and on the Tutor/Admin views.

**Exit criteria:** checklist items 5, 6, 7, 8.

### Phase 7 — Tutor: module assessments (Section 4a)
1. `/tutor/modules` — list assigned subjects → modules, showing each module's target year levels (read-only).
2. `/tutor/modules/:id/create-assessment` — already exists (`routes/tutor.js:1235`); extend the form with **question type** (MC / True-False / Fill-in-Blank / Essay / Mixed) and **item count**. Keep the manual hand-write path as the required baseline; add an optional "Draft with AI from this module's handouts" button reusing Phase 5's generator scoped to one module.
3. Save with `assessment_kind='tutor_assessment'`; it must appear both in the tutor's module view and the student's module view.
4. `/tutor/student-results/:id` — per-student attempt review (route exists at `routes/tutor.js:1313`; wire it to the new attempt tables).

**Exit criteria:** checklist items 9, 10, 11.

### Phase 8 — Post-Assessment (Section 4b)
1. Completion check: all modules in the subject have handouts read/attempted **and** every `tutor_assessment` in the subject has a submission from that student → show "Create Post Assessment" on the tutor's subject page.
2. On click: clone the subject's pre-assessment rows **verbatim** (same questions, same choices, same correct answers, same source FKs) into a new `assessment_kind='post_assessment'` with `source_pre_assessment_id` set.
   ⚠️ **Corrected:** an earlier draft of this plan said to "reuse the proven `copy-as-post` logic." It was **never proven** — see bug #16: that route crashed with `MODULE_NOT_FOUND` on every click and has been deleted. Build the clone fresh, and prefer referencing the pre-assessment via `source_pre_assessment_id` over blind row duplication so "exact same items" is guaranteed by structure rather than by a copy that can drift.
3. Pre-vs-post comparison view (Beginner → Intermediate) for Student, Tutor, and Admin.

**Exit criteria:** checklist item 12.

### Phase 9 — Consolidation + final sweep
1. Retire the Gen 1 / Gen 2 code paths per **decision D2**.
2. Simplify `routes/student.js:183-305` down to a single source of truth — remove `adminModulesLocked`, `preAssessmentTaken`, `tutorPreAssessments`, `pendingAiAssessments` duplication.
3. Fix latent bug #8 in `config/db.js`.
4. Re-run the full acceptance checklist (Section 7) against a fresh DB via `scripts/init-db.js`.

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

**Rekomendasyon ko: (a) tanggalin.**

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

**Naka-assume ang Phase 8 sa per-student.**

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
