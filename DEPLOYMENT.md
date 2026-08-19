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
| **`UPLOAD_ROOT`** | See below — without it, uploaded handouts are lost on every deploy |

`PORT` is provided by Render and the server already reads it.

---

## ⚠️ Uploaded files and Render's ephemeral filesystem

Render rebuilds the application's filesystem from the repository on **every deploy and every restart**. Anything written at runtime is gone — while the database rows that point at those files survive. A handout uploaded on Monday is listed in the UI on Tuesday and 404s on disk.

This affects handouts, profile photos, chat attachments and AI-generated modules.

**The fix:** attach a Render disk and point `UPLOAD_ROOT` at its mount path.

1. Render dashboard → your service → **Disks** → *Add Disk*
2. Mount path: `/var/data` · size: 1 GB is plenty to start
3. Add the environment variable `UPLOAD_ROOT=/var/data/uploads`
4. Redeploy

Nothing else changes: `lib/paths.js` is the only place that decides where uploads live, and stored paths in the database stay in their public form (`/uploads/handouts/x.pdf`) either way. The startup log tells you which is in effect:

```
Uploads directory: /var/data/uploads (persistent, from UPLOAD_ROOT)
Uploads directory: /opt/render/project/src/public/uploads (inside the app folder)
```

The second line means files are being written somewhere that will be erased.

---

## Verifying a deploy

Two checks that need no login and prove the new code is running:

```bash
curl -o /dev/null -w "%{http_code}\n" https://mindquesttutorial.com/uploads/handouts/nothing.pdf   # 401
curl -o /dev/null -w "%{http_code}\n" https://mindquesttutorial.com/tutor/results/1                # 302
```

`401` shows the guarded handout mount is active — study material is not publicly downloadable. `404` on either means an older build is still being served.

Then log in as admin, open a subject, add a module, and upload a handout with real text. Within about half a minute the page should say **"Pre-Assessment — Ready — 30 items"**. If it says *Waiting for a readable handout*, the file is a scan with no text layer — use **Read with AI** on the handout card. If it stays on *Building now* far longer than a minute, check `OPENAI_API_KEY` in Render.
