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

## Verifying a deploy

Two checks that need no login and prove the new code is running:

```bash
curl -o /dev/null -w "%{http_code}\n" https://mindquesttutorial.com/uploads/handouts/nothing.pdf   # 401
curl -o /dev/null -w "%{http_code}\n" https://mindquesttutorial.com/tutor/results/1                # 302
```

`401` shows the guarded handout mount is active — study material is not publicly downloadable. `404` on either means an older build is still being served.

Then log in as admin, open a subject, add a module, and upload a handout with real text. Within about half a minute the page should say **"Pre-Assessment — Ready — 30 items"**. If it says *Waiting for a readable handout*, the file is a scan with no text layer — use **Read with AI** on the handout card. If it stays on *Building now* far longer than a minute, check `OPENAI_API_KEY` in Render.
