# MindQuest Web System

Full starter web system for MindQuest Tutorial Center using:
- Node.js + Express
- EJS
- Microsoft SQL Server

## Setup

1. Copy `.env.example` to `.env` and fill in your SQL Server credentials.
2. Run `npm install`
3. Run `node server.js` — the database and tables are created automatically on first run.

Default admin login: `admin@mindquest.local` / `Admin@12345`

## Included features

- Landing page based on the design reference
- Fixed header with smooth scrolling
- Logo preview modal
- Click-to-call phone number
- Login page without sign-up text
- Learner and tutor registration with two-step flow
- Dynamic year level to grade level selection
- Pending registration notifications for admin and admin assistant
- Default admin account seeded automatically
- Admin dashboard with branch filtering
- Notification inbox, archive, recover, history, accept, cancel
- User management with archive and recover
- Branch admin assistant account creation
- Student and tutor profiles
- Student billing, payment information, payment history, and SOA posting
- All subjects page with add, archive, recover, delete
- Subject assignment of students to tutors by subject and branch
- Student dashboard, tutor dashboard, attendance, subjects, messages
- Basic chat with file upload and WebRTC signaling buttons
- Pre/post assessments for students, created and managed by tutors
- Student Android app, downloaded from the **Install App** button — see below


## Admin reset and login

Default admin credentials after bootstrap or after running `scripts/reset-users.sql`:

- Email: `admin@mindquest.local`
- Password: `Admin@12345`

You can change these in `.env` with:

- `DEFAULT_ADMIN_EMAIL`
- `DEFAULT_ADMIN_PASSWORD`

To reset all users in SQL Server while keeping one admin account, run:

- `scripts/reset-users.sql`

After login, open **My Profile** in the admin sidebar to change the admin password inside the system.

## Gmail OTP setup

Configure these values in `.env` so registration and new-device login OTP can be sent by email:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

Example Gmail SMTP settings:

- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `SMTP_SECURE=false`

Use an App Password for Gmail SMTP.

## The student app (Install App)

The **Install App** button hands out the student Android app built in
[mindquest-mobile/](mindquest-mobile/). Only students can log in to it; tutors,
assistant admins and the admin use the website.

Where the button appears:

- the landing page header (inside the ☰ menu on a phone)
- the login page, under *Forgot Password / Go Back*
- the student's dashboard topbar (not shown to the other roles)

Pressing it opens a dialog first: **For students only**, the app's version and
size, then **Download the app**. On an iPhone or iPad the dialog says the app is
for Android and offers no download.

The APK is `public/downloads/MindQuest.apk`, served at `/downloads/MindQuest.apk`.
To publish a new build: replace that file (same name), raise `version` in
`mindquest-mobile/app.json`, and deploy. The dialog reads the version and size
from those two files.

The browser-installed version of the site (PWA) that this button used to offer
is withdrawn; see [DEPLOYMENT.md](DEPLOYMENT.md).

