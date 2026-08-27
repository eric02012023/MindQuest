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
- Installable app (PWA) — optional for every role, see below


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

## Installing MindQuest as an app

MindQuest is installable straight from the browser — there is no separate
download, no app store, and nothing extra to pay for. It is the same website in
its own window, with its own icon, so an installed user and a browser user are
looking at exactly the same pages and the same account.

It is optional for everyone. Students, tutors, admins and admin assistants all
see the **Install App** button, and anyone who ignores it keeps using the site
in a normal tab with nothing changed.

Where the button appears:

- the landing page header
- the login page, under *Forgot Password / Go Back*
- the topbar of every dashboard, next to the notification bell

It stays hidden unless the browser confirms an install is possible, and hides
itself again once the app is installed.

| Device | How | Notes |
|---|---|---|
| Android (Chrome) | Press **Install App** | Full install, icon in the app drawer |
| Windows / macOS (Chrome, Edge) | Press **Install App** | Opens in its own window |
| iPhone / iPad (Safari) | Press **Install App**, then follow the steps shown | Apple offers no install button, so the app explains *Share → Add to Home Screen* |
| Firefox desktop | Not offered | The button stays hidden; the website works normally |

Requires HTTPS, which the live domain already has. On a developer machine
`http://localhost` also counts as secure, so installing can be tested locally —
but `http://<your-LAN-ip>:3000` cannot.

Deployment notes for this feature, including how to withdraw it, are in
[DEPLOYMENT.md](DEPLOYMENT.md).

