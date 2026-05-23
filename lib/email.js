/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: lib/email.js
 * Purpose: Email service helper that builds the SMTP transporter and sends OTP emails using HTML templates.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const nodemailer = require('nodemailer');

let transporterPromise = null;

// Function: buildTransport

// Role: Provides helper logic for this file.

function buildTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    return null;
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true' || port === 465,
    auth: { user, pass },
    family: 4
  });
}

// Function: getTransporter

// Role: Handles a reusable server-side operation used by this module.

async function getTransporter() {
  if (!transporterPromise) transporterPromise = Promise.resolve(buildTransport());
  return transporterPromise;
}

/**
 * Builds a Gmail-safe HTML OTP email.
 * Rules applied:
 *  - Table-based layout (no divs for structure)
 *  - All styles are inline (no <style> blocks — Gmail strips them)
 *  - No CSS gradients, box-shadow, flexbox, or grid
 *  - No border-radius on <td> (use a wrapping table trick instead)
 *  - Font stack limited to web-safe fonts
 *  - Explicit width on tables (not %)
 *  - cellpadding/cellspacing/border set as HTML attributes
 */
// Function: buildOtpHtml
// Role: Provides helper logic for this file.
function buildOtpHtml({ title, intro, otp, purpose }) {
  const digits = String(otp).split('');

  // Render each OTP digit as its own table cell box
  const digitCells = digits.map(d => `
    <td align="center" valign="middle"
        style="width:52px;height:62px;background-color:#f0f4ff;border:2px solid #c7d2fe;font-family:Arial,Helvetica,sans-serif;font-size:32px;font-weight:700;color:#1e1b4b;letter-spacing:0;padding:0;">
      ${d}
    </td>
    <td style="width:10px;font-size:1px;line-height:1px;">&nbsp;</td>
  `).join('');

  const purposeColor = purpose === 'login' ? '#4f46e5' : '#7c3aed';
  const purposeLabel = purpose === 'login' ? 'Login Verification' : 'Email Verification';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;">

  <!--[if mso]><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->

  <!-- Outer wrapper table -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:#f3f4f6;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <!-- Card table — max 560px, white bg -->
        <table width="560" cellpadding="0" cellspacing="0" border="0"
               style="background-color:#ffffff;border:1px solid #e5e7eb;width:100%;max-width:560px;">

          <!-- ── Header band ── -->
          <tr>
            <td align="center"
                style="background-color:${purposeColor};padding:28px 40px 24px 40px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <!-- Logo / wordmark -->
                    <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:1px;">
                      🧠 MindQuest
                    </p>
                    <!-- Badge label -->
                    <p style="margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#c7d2fe;text-transform:uppercase;letter-spacing:2px;">
                      ${purposeLabel}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── Body ── -->
          <tr>
            <td style="padding:36px 40px 20px 40px;">

              <p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:#111827;">
                Your Verification Code
              </p>
              <p style="margin:0 0 28px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#4b5563;line-height:1.6;">
                ${intro}
              </p>

              <!-- OTP digit boxes -->
              <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;">
                <tr>
                  ${digitCells}
                </tr>
              </table>

              <!-- Expiry notice -->
              <table cellpadding="0" cellspacing="0" border="0" width="100%"
                     style="background-color:#fefce8;border-left:4px solid #eab308;margin:0 0 28px 0;">
                <tr>
                  <td style="padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#713f12;line-height:1.5;">
                    ⏰ &nbsp;This code expires in <strong>10 minutes</strong>. Do not share it with anyone.
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6b7280;line-height:1.6;">
                If you didn't request this code, you can safely ignore this email. Someone may have entered your email address by mistake.
              </p>

            </td>
          </tr>

          <!-- ── Divider ── -->
          <tr>
            <td style="padding:0 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-top:1px solid #e5e7eb;font-size:1px;line-height:1px;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── Footer ── -->
          <tr>
            <td style="padding:20px 40px 32px 40px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9ca3af;line-height:1.6;text-align:center;">
                © ${new Date().getFullYear()} MindQuest. All rights reserved.<br>
                This is an automated message — please do not reply.
              </p>
            </td>
          </tr>

        </table>
        <!-- /Card table -->

      </td>
    </tr>
  </table>
  <!-- /Outer wrapper -->

  <!--[if mso]></td></tr></table><![endif]-->

</body>
</html>`;
}

// Function: sendOtpEmail

// Role: Handles a reusable server-side operation used by this module.

async function sendOtpEmail({ to, otp, purpose = 'verification' }) {
  const transporter = await getTransporter();
  if (!transporter) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM in .env.');
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  const title = purpose === 'login'
    ? 'MindQuest Login Verification Code'
    : 'MindQuest Email Verification Code';

  const intro = purpose === 'login'
    ? 'Use the code below to verify your login. Enter it on the verification page to continue.'
    : 'Use the code below to verify your email address and complete your registration.';

  const html = buildOtpHtml({ title, intro, otp, purpose });

  const text = [
    title,
    '',
    intro,
    '',
    `Your 4-digit OTP is: ${otp}`,
    '',
    'This code will expire in 10 minutes.',
    '',
    'If you did not request this, please ignore this email.'
  ].join('\n');

  await transporter.sendMail({ from, to, subject: title, text, html });
}

module.exports = { sendOtpEmail };
