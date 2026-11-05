/**
 * File: lib/modulePdf.js
 * Purpose: A student's own copy of a module as one PDF: every page of the
 *          office's handouts, untouched and in their order, with the lessons
 *          added for that student inserted right after the page each belongs to.
 *
 * Nothing of the original is removed or redrawn: its pages are copied whole
 * (text, pictures, layout). The added lessons are new pages of their own.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');

const A4 = [595.28, 841.89];
const MARGIN_X = 56;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 64;
const BODY_SIZE = 11;
const BODY_LEADING = 15.5;
const TITLE_SIZE = 15;
const TITLE_LEADING = 19;
const PARAGRAPH_GAP = 7;
const BULLET_INDENT = 14;

const ACCENT = rgb(0.12, 0.31, 0.55);
const BAND = rgb(0.93, 0.95, 0.98);
const INK = rgb(0.13, 0.13, 0.15);
const MUTED = rgb(0.45, 0.47, 0.5);

let fontBytesCache = null;
function fontBytes() {
  if (!fontBytesCache) {
    fontBytesCache = {
      regular: fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans.ttf')),
      bold: fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'))
    };
  }
  return fontBytesCache;
}

/** Text the fonts can draw: no control characters, no characters outside the BMP. */
function cleanText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/[​-\u200F﻿]/g, '');
}

/**
 * The text of each page of a PDF, for finding where an idea is taught.
 * @returns {Promise<Array<{ num: number, text: string }>>} empty when unreadable
 */
async function readPageTexts(buffer) {
  if (!buffer || !buffer.length) return [];
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return (result.pages || []).map((page, index) => ({
      num: Number(page.num) || index + 1,
      text: String(page.text || '').replace(/\s+\n/g, '\n').trim()
    }));
  } catch (_error) {
    return [];
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** How many pages a PDF has, or 0 when it cannot be read. */
async function countPages(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch (_error) {
    return 0;
  }
}

/**
 * Every line of the text as a block of runs ({ text, bold }), kept on its own
 * line as written. "- " starts a bullet, "## " a heading, and a line that
 * starts with "Answer:" shows that word in bold. `spaced` marks a block that
 * followed an empty line, so paragraphs keep their gap.
 */
function toBlocks(text) {
  const blocks = [];
  let spaced = false;
  for (const raw of cleanText(text).split('\n')) {
    const line = raw.trim();
    if (!line) { spaced = blocks.length > 0; continue; }
    let block;
    const answer = line.match(/^(answer|sagot)\s*:\s*(.*)$/i);
    const heading = line.match(/^#{1,6}\s*(.+)$/);
    if (/^[-•*]\s+/.test(line)) {
      block = { kind: 'bullet', runs: [{ text: line.replace(/^[-•*]\s+/, ''), bold: false }] };
    } else if (answer) {
      block = { kind: 'para', runs: [{ text: `${answer[1]}:`, bold: true }, { text: ` ${answer[2]}`, bold: false }] };
    } else if (heading) {
      block = { kind: 'heading', runs: [{ text: heading[1], bold: true }] };
    } else {
      block = { kind: 'para', runs: [{ text: line, bold: false }] };
    }
    block.spaced = spaced || block.kind === 'heading';
    blocks.push(block);
    spaced = false;
  }
  return blocks;
}

/** Break runs into lines no wider than maxWidth. Each line is a list of runs. */
function wrapRuns(runs, fonts, size, maxWidth) {
  const words = [];
  for (const run of runs) {
    const font = run.bold ? fonts.bold : fonts.regular;
    const parts = String(run.text).split(/(\s+)/).filter((part) => part.length);
    for (const part of parts) words.push({ text: part, font, bold: run.bold, space: /^\s+$/.test(part) });
  }

  const lines = [];
  let current = [];
  let width = 0;
  const push = () => {
    while (current.length && current[current.length - 1].space) current.pop();
    if (current.length) lines.push(current);
    current = [];
    width = 0;
  };

  for (const word of words) {
    const text = word.space ? ' ' : word.text;
    if (word.space && !current.length) continue;
    const wordWidth = word.font.widthOfTextAtSize(text, size);
    if (!word.space && wordWidth > maxWidth) {
      // A word longer than the line: cut it into pieces that fit.
      push();
      let piece = '';
      for (const char of text) {
        if (word.font.widthOfTextAtSize(piece + char, size) > maxWidth && piece) {
          lines.push([{ text: piece, font: word.font, bold: word.bold }]);
          piece = '';
        }
        piece += char;
      }
      current = [{ text: piece, font: word.font, bold: word.bold }];
      width = word.font.widthOfTextAtSize(piece, size);
      continue;
    }
    if (width + wordWidth > maxWidth && !word.space) push();
    if (word.space && !current.length) continue;
    current.push({ text, font: word.font, bold: word.bold, space: word.space });
    width += wordWidth;
  }
  push();
  return lines;
}

/** Draw one added lesson as one or more new pages of the given size. */
function drawAddition(doc, fonts, addition, pageSize, footer) {
  const [width, height] = pageSize;
  const textWidth = width - MARGIN_X * 2;
  let page = null;
  let y = 0;

  const newPage = (continued) => {
    page = doc.addPage([width, height]);
    page.drawRectangle({ x: 0, y: height - 44, width, height: 44, color: BAND });
    page.drawText(continued ? 'ADDED FOR YOU (CONTINUED)' : 'ADDED FOR YOU', {
      x: MARGIN_X, y: height - 28, size: 9, font: fonts.bold, color: ACCENT
    });
    if (footer) {
      const footerText = cleanText(footer).slice(0, 140);
      page.drawText(footerText, { x: MARGIN_X, y: 30, size: 8, font: fonts.regular, color: MUTED });
    }
    y = height - MARGIN_TOP - 12;
  };

  const ensureRoom = (needed) => {
    if (y - needed < MARGIN_BOTTOM) newPage(true);
  };

  newPage(false);

  const titleLines = wrapRuns([{ text: addition.title || 'Added lesson', bold: true }], fonts, TITLE_SIZE, textWidth);
  for (const line of titleLines) {
    ensureRoom(TITLE_LEADING);
    drawLine(page, line, MARGIN_X, y, TITLE_SIZE, ACCENT);
    y -= TITLE_LEADING;
  }
  y -= PARAGRAPH_GAP;

  for (const block of toBlocks(addition.text)) {
    if (block.spaced) y -= PARAGRAPH_GAP;
    const indent = block.kind === 'bullet' ? BULLET_INDENT : 0;
    const lines = wrapRuns(
      block.kind === 'heading' ? block.runs.map((run) => ({ ...run, bold: true })) : block.runs,
      fonts, BODY_SIZE, textWidth - indent
    );
    lines.forEach((line, index) => {
      ensureRoom(BODY_LEADING);
      if (block.kind === 'bullet' && index === 0) {
        page.drawText('•', { x: MARGIN_X + 2, y, size: BODY_SIZE, font: fonts.regular, color: INK });
      }
      drawLine(page, line, MARGIN_X + indent, y, BODY_SIZE, INK);
      y -= BODY_LEADING;
    });
    y -= 2;
  }
}

function drawLine(page, runs, x, y, size, color) {
  let cursor = x;
  for (const run of runs) {
    if (!run.text) continue;
    page.drawText(run.text, { x: cursor, y, size, font: run.font, color });
    cursor += run.font.widthOfTextAtSize(run.text, size);
  }
}

function drawNotice(doc, fonts, pageSize, message) {
  const [width, height] = pageSize;
  const page = doc.addPage([width, height]);
  const lines = wrapRuns([{ text: cleanText(message), bold: false }], fonts, BODY_SIZE, width - MARGIN_X * 2);
  let y = height - MARGIN_TOP - 12;
  for (const line of lines) {
    drawLine(page, line, MARGIN_X, y, BODY_SIZE, MUTED);
    y -= BODY_LEADING;
  }
}

/**
 * Build the student's copy of a module.
 *
 * @param {object} input
 * @param {string} input.moduleTitle
 * @param {string} [input.studentName]
 * @param {Array<{ name: string, buffer: Buffer|null, additions: Array<{ after_page: number, title: string, text: string }> }>} input.parts
 *        one per handout, in the module's order
 * @returns {Promise<{ bytes: Buffer, pages: number, originalPages: number, addedPages: number }>}
 */
async function composeModulePdf(input = {}) {
  const { moduleTitle = 'Module', studentName = '', parts = [] } = input;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bytes = fontBytes();
  const fonts = {
    regular: await doc.embedFont(bytes.regular, { subset: true }),
    bold: await doc.embedFont(bytes.bold, { subset: true })
  };
  doc.setTitle(cleanText(studentName ? `${moduleTitle} — ${studentName}` : moduleTitle));
  doc.setProducer('MindQuest');
  doc.setCreator('MindQuest');

  const footer = studentName ? `Added to ${moduleTitle} for ${studentName}` : `Added to ${moduleTitle}`;
  let originalPages = 0;

  for (const part of parts) {
    const additions = (part.additions || []).filter((a) => a && String(a.text || '').trim());
    let source = null;
    if (part.buffer && part.buffer.length) {
      try {
        source = await PDFDocument.load(part.buffer, { ignoreEncryption: true, updateMetadata: false });
      } catch (_error) {
        source = null;
      }
    }

    if (!source) {
      drawNotice(doc, fonts, A4, `The pages of ${part.name || 'this handout'} could not be loaded here. Open it from the module page.`);
      for (const addition of additions) drawAddition(doc, fonts, addition, A4, footer);
      continue;
    }

    const copied = await doc.copyPages(source, source.getPageIndices());
    const count = copied.length;
    originalPages += count;
    const byPage = new Map();
    for (const addition of additions) {
      const after = Math.min(Math.max(1, Math.round(Number(addition.after_page) || count)), Math.max(1, count));
      if (!byPage.has(after)) byPage.set(after, []);
      byPage.get(after).push(addition);
    }

    copied.forEach((page, index) => {
      doc.addPage(page);
      const size = page.getSize();
      for (const addition of byPage.get(index + 1) || []) {
        drawAddition(doc, fonts, addition, [size.width, size.height], footer);
      }
    });
    if (!count) {
      for (const addition of additions) drawAddition(doc, fonts, addition, A4, footer);
    }
  }

  if (!doc.getPageCount()) drawNotice(doc, fonts, A4, 'This module has no pages yet.');

  const saved = await doc.save();
  const pages = doc.getPageCount();
  return { bytes: Buffer.from(saved), pages, originalPages, addedPages: pages - originalPages };
}

module.exports = {
  readPageTexts,
  countPages,
  composeModulePdf,
  cleanText
};
