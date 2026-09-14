/**
 * File: lib/paymentSlip.js
 * Purpose: The student's payment slip — the thing they SHOW at the counter —
 * and the PDF of it they can keep, send to a parent, or open offline.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Cash used to be a "payment request": the student typed an amount, the system
 * held it as an intention, and an admin later confirmed it from the Notifications
 * page. That made the student's screen a half-finished transaction, and it made
 * the office's job "find the matching request" rather than "take the money".
 *
 * The POS model inverts it. The student's side stops at a STATEMENT — this is
 * what I owe, this is where I pay it, here is the code that identifies me — and
 * the money is only ever entered once, at the counter, by staff (routes POS
 * screen -> lib/billing.addPaymentEntry). Nothing about a slip moves a balance.
 *
 * WHY THE PDF IS WRITTEN BY HAND
 * ------------------------------
 * A slip has to survive leaving the browser: shown on a phone with no signal,
 * forwarded to a parent, printed at the counter. That means a real file, not a
 * page. Every PDF library worth having is a large dependency for what is, for a
 * text-only receipt on one page, about a hundred lines of a very stable format.
 * So this writes PDF 1.4 directly with the two base-14 Helvetica faces, which
 * every reader has built in — no font embedding, no install, no build step.
 *
 * The one thing that costs: the base-14 fonts are WinAnsi-encoded and have no
 * peso sign (U+20B1). Writing one would silently produce a wrong glyph, so money
 * in the PDF is written "PHP 1,800.00". On screen the HTML slip uses the real
 * sign — see views/content/student-payment-slip.ejs.
 */

const { getBillingLedger, paymentFloorFor, SUBJECT_MONTHLY_FEE } = require('./billing');
const { titleCaseName, money } = require('./utils');

/** Slips are identified by their payment_requests row, shown as SLIP-000123. */
const SLIP_PREFIX = 'SLIP-';

function slipCode(requestId) {
  const n = Number(requestId);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${SLIP_PREFIX}${String(n).padStart(6, '0')}`;
}

/**
 * Read a slip code back to its row id, forgivingly: staff retype these from a
 * phone screen, so case, spacing and a missing prefix all still resolve. A bare
 * number is accepted because "123" is what people actually type.
 */
function parseSlipCode(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return null;
  const withoutPrefix = raw.startsWith(SLIP_PREFIX) ? raw.slice(SLIP_PREFIX.length) : raw;
  if (!/^\d+$/.test(withoutPrefix)) return null;
  const id = Number(withoutPrefix);
  return id > 0 ? id : null;
}

/**
 * Everything printed on one slip.
 *
 * Money comes from the ledger (getBillingLedger), never from the billing row's
 * cached columns, so a slip can never quote a balance the payment history does
 * not support. The floor comes from the same paymentFloorFor the payment forms
 * and the server-side refusal use.
 *
 * @param {object} input
 * @param {object} input.student   the user row
 * @param {string} [input.branchName]
 * @param {Array}  [input.assignments]  from getStudentAssignments
 * @param {object} [input.request]      the payment_requests row, when one exists
 */
async function buildSlipModel(input = {}) {
  const { student, branchName = '', assignments = [], request = null } = input;
  const ledger = await getBillingLedger(student.id);
  const bill = ledger?.bill || null;
  const totals = ledger?.totals || { totalBilled: 0, totalPaid: 0, remaining: 0, paymentCount: 0 };
  const floor = paymentFloorFor(bill, totals.totalPaid);

  const subjects = (assignments || []).map((item) => ({
    name: item.subject_name || '—',
    tutor: item.tutor_name || 'Not yet assigned',
    timeSlot: item.time_slot || '',
    // Each subject runs its own month from its own enrolment date (Phase 4.2).
    // enrolled_at is the fallback for a row predating the start_date column.
    startDate: item.start_date || item.enrolled_at || null,
    endDate: item.end_date || null,
    // Every subject costs the same flat monthly fee (Phase 4.1), so the line
    // items on the slip add up to the total billed and a parent reading it can
    // see WHY it is what it is.
    amount: item.subject_fee != null ? Number(item.subject_fee) : SUBJECT_MONTHLY_FEE
  }));

  return {
    slipCode: request ? slipCode(request.id) : '',
    requestId: request?.id || null,
    issuedAt: request?.created_at ? new Date(request.created_at) : new Date(),
    student: {
      id: student.id,
      code: student.user_id || '',
      name: [student.first_name, student.middle_name, student.last_name]
        .map((p) => titleCaseName(p || '')).filter(Boolean).join(' '),
      contact: student.contact_number || ''
    },
    branchName: titleCaseName(branchName || ''),
    subjects,
    totals: {
      billed: Number(totals.totalBilled || 0),
      paid: Number(totals.totalPaid || 0),
      remaining: Number(totals.remaining || 0)
    },
    // What the counter should expect at minimum, and what the student declared.
    minimumNow: Number(floor.amount || 0),
    floorKind: floor.kind,
    declaredAmount: request ? Number(request.amount || 0) : null,
    dueDate: bill?.payment_due || null,
    hasBill: Boolean(bill)
  };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Make a JS string safe inside a PDF literal string.
 *
 * Two separate jobs: escape the three characters that end or nest a literal,
 * and get rid of anything WinAnsi cannot represent. The peso sign is the one
 * that actually turns up, so it is spelled out rather than dropped silently.
 */
function pdfText(value) {
  return String(value == null ? '' : value)
    .replace(/₱/g, 'PHP ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/·/g, '-')
    // Anything still outside Latin-1 would be mis-encoded by the base-14 fonts.
    .replace(/[^\x20-\xFF]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** "PHP 1,800.00" — the PDF's money, with no glyph the base fonts lack. */
function pdfMoney(value) {
  return `PHP ${money(value)}`;
}

function formatSlipDate(value) {
  if (!value) return 'Not set';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Character widths for the two base-14 faces, in 1/1000 em, for ASCII 32..126.
 *
 * These are the fonts' published metrics rather than a guess. Estimating instead
 * (say half an em per character) drifts by several points across "PHP 3,600.00",
 * which on a column of figures is visible as a ragged right edge — not something
 * to ship on a document about money. Anything outside the range falls back to
 * the width of a digit, which is the common case in this document.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

/** Width of a string in points, for the face and size it will be drawn at. */
function textWidth(value, size, bold) {
  const widths = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  const text = String(value == null ? '' : value);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    total += (code >= 32 && code <= 126) ? widths[code - 32] : 556;
  }
  return (total / 1000) * size;
}

/**
 * A tiny content-stream builder. Coordinates are PDF points from the BOTTOM-left,
 * so the cursor counts DOWN from the top of the page and every helper takes the
 * y it wants rather than tracking state across calls.
 */
function createCanvas({ width, height, margin }) {
  const ops = [];
  return {
    width,
    height,
    margin,
    text(value, x, y, { size = 10, bold = false, color = '0 0 0' } = {}) {
      ops.push(`BT ${color} rg /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfText(value)}) Tj ET`);
    },
    textRight(value, right, y, opts = {}) {
      // Measured, not estimated — see the metrics tables above. A column of
      // figures has to line up on its right edge to be read as a column.
      const size = opts.size || 10;
      this.text(value, right - textWidth(pdfText(value), size, Boolean(opts.bold)), y, opts);
    },
    rect(x, y, w, h, color = '0.9 0.9 0.9') {
      ops.push(`${color} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    },
    line(x1, y1, x2, y2, color = '0.8 0.8 0.8', lineWidth = 0.7) {
      ops.push(`${color} RG ${lineWidth} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
    },
    build() {
      return ops.join('\n');
    }
  };
}

/** Draw the slip onto a canvas. Pure layout — no I/O, no formatting decisions. */
function drawSlip(canvas, model) {
  const { width, height, margin } = canvas;
  const right = width - margin;
  const inner = width - margin * 2;
  let y = height - margin;

  // ---- header band
  canvas.rect(margin, y - 54, inner, 54, '0.09 0.20 0.42');
  canvas.text('MINDQUEST TUTORIAL CENTER', margin + 14, y - 22, { size: 13, bold: true, color: '1 1 1' });
  canvas.text('PAYMENT SLIP', margin + 14, y - 40, { size: 10, color: '0.85 0.89 0.96' });
  if (model.slipCode) {
    canvas.textRight(model.slipCode, right - 14, y - 22, { size: 13, bold: true, color: '1 1 1' });
  }
  canvas.textRight(`Issued ${formatSlipDate(model.issuedAt)}`, right - 14, y - 40, { size: 8, color: '0.85 0.89 0.96' });
  y -= 78;

  // ---- who, and where they pay
  const pairs = [
    ['Student name', model.student.name],
    ['Student ID', model.student.code || '-'],
    ['Pay at', model.branchName || 'Your MindQuest branch'],
    ['Payment due', formatSlipDate(model.dueDate)]
  ];
  for (const [label, value] of pairs) {
    canvas.text(String(label).toUpperCase(), margin, y, { size: 7.5, color: '0.45 0.45 0.45' });
    canvas.text(value, margin + 110, y, { size: 10.5, bold: label === 'Pay at' });
    y -= 20;
  }

  y -= 4;
  canvas.line(margin, y, right, y);
  y -= 20;

  // ---- subjects
  canvas.text('ENROLLED SUBJECTS', margin, y, { size: 8, bold: true, color: '0.45 0.45 0.45' });
  y -= 16;
  if (!model.subjects.length) {
    canvas.text('No active subject enrolments on this account.', margin, y, { size: 9.5, color: '0.4 0.4 0.4' });
    y -= 18;
  } else {
    canvas.text('Subject', margin, y, { size: 8, bold: true, color: '0.45 0.45 0.45' });
    canvas.text('Period', margin + 190, y, { size: 8, bold: true, color: '0.45 0.45 0.45' });
    canvas.textRight('Amount', right, y, { size: 8, bold: true, color: '0.45 0.45 0.45' });
    y -= 6;
    canvas.line(margin, y, right, y, '0.88 0.88 0.88');
    y -= 14;

    for (const subject of model.subjects) {
      canvas.text(subject.name, margin, y, { size: 10 });
      const period = subject.endDate
        ? `${formatSlipDate(subject.startDate)} - ${formatSlipDate(subject.endDate)}`
        : formatSlipDate(subject.startDate);
      canvas.text(period, margin + 190, y, { size: 8.5, color: '0.35 0.35 0.35' });
      if (subject.amount != null) canvas.textRight(pdfMoney(subject.amount), right, y, { size: 10 });
      y -= 17;
      if (y < margin + 190) break; // one page; the totals below must still fit
    }
  }

  y -= 6;
  canvas.line(margin, y, right, y);
  y -= 22;

  // ---- the money
  const totals = [
    ['Total billed', pdfMoney(model.totals.billed), false],
    ['Total paid', pdfMoney(model.totals.paid), false],
    ['BALANCE DUE', pdfMoney(model.totals.remaining), true]
  ];
  for (const [label, value, bold] of totals) {
    canvas.text(label, margin, y, { size: bold ? 11 : 9.5, bold, color: bold ? '0 0 0' : '0.35 0.35 0.35' });
    canvas.textRight(value, right, y, { size: bold ? 11 : 9.5, bold });
    y -= bold ? 24 : 18;
  }

  // ---- what to hand over
  canvas.rect(margin, y - 42, inner, 42, '0.95 0.96 0.98');
  canvas.text(
    model.floorKind === 'down_payment' ? 'MINIMUM DOWN PAYMENT' : 'MINIMUM PAYMENT NOW',
    margin + 12, y - 17, { size: 8, bold: true, color: '0.35 0.40 0.50' }
  );
  canvas.textRight(pdfMoney(model.minimumNow), right - 12, y - 17, { size: 13, bold: true });
  canvas.text(
    model.floorKind === 'down_payment'
      ? 'First payment on the account. You may pay more, up to the balance due.'
      : 'One third of the remaining balance. You may pay more, up to the balance due.',
    margin + 12, y - 33, { size: 8, color: '0.40 0.45 0.52' }
  );
  y -= 60;

  if (model.declaredAmount != null) {
    canvas.text('Amount the student intends to pay', margin, y, { size: 9, color: '0.35 0.35 0.35' });
    canvas.textRight(pdfMoney(model.declaredAmount), right, y, { size: 10, bold: true });
    y -= 20;
  }

  // ---- footer
  const footerY = margin + 40;
  canvas.line(margin, footerY + 34, right, footerY + 34, '0.88 0.88 0.88');
  canvas.text(
    `Present this slip at ${model.branchName || 'your MindQuest branch'}. The cashier records the payment on the POS.`,
    margin, footerY + 20, { size: 8.5, color: '0.35 0.35 0.35' }
  );
  canvas.text(
    'This slip is a statement of what is owed. It is not a receipt and it is not proof of payment.',
    margin, footerY + 8, { size: 8.5, color: '0.35 0.35 0.35' }
  );
}

/**
 * Assemble the PDF. Offsets in the cross-reference table are BYTE offsets, so
 * everything is measured in latin1 — counting characters would put the table a
 * few bytes out on any accented name and some readers would reject the file.
 */
function renderSlipPdf(model) {
  const canvas = createCanvas({ width: 595.28, height: 841.89, margin: 48 });
  drawSlip(canvas, model);
  const content = canvas.build();

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] '
      + '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** The filename the browser saves it under. */
function slipFilename(model) {
  const who = String(model.student.code || model.student.name || 'student').replace(/[^A-Za-z0-9-]+/g, '-');
  return `MindQuest-payment-slip-${model.slipCode || who}.pdf`;
}

module.exports = {
  SLIP_PREFIX,
  slipCode,
  parseSlipCode,
  buildSlipModel,
  renderSlipPdf,
  slipFilename,
  formatSlipDate
};
