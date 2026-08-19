/**
 * File: services/extractionService.js
 * Purpose: Pull plain text out of uploaded handout files so the AI can generate
 *          Pre/Post assessment questions from real course material.
 *
 * Extracted text is cached on module_handouts.extracted_text, so a file is
 * parsed once at upload time rather than on every generation.
 *
 * Libraries already in the project are reused: pdf-parse for PDF, mammoth for
 * DOCX, jszip for PPTX (which is a zip of XML). jszip was previously only a
 * transitive dependency of mammoth and is now declared directly, so an
 * `npm install` cannot quietly remove it.
 *
 * A real finding from this project's own uploads: 3 of 8 existing PDFs are
 * scans with no text layer at all. Extraction "succeeds" on those and returns
 * nothing usable. Silently handing an empty string to the model would make it
 * invent questions unrelated to the handout, so this module reports that case
 * explicitly via `usable: false` and a human-readable `warning`.
 */

const fs = require('fs');
const path = require('path');

/** Formats we can pull text from. */
const EXTRACTABLE = ['.pdf', '.docx', '.pptx', '.txt'];

/**
 * Formats the uploader accepts as study material but that we cannot read.
 * They stay downloadable for students; they just cannot feed generation.
 */
const NOT_EXTRACTABLE = {
  '.doc': 'Legacy .doc is not readable. Re-save as .docx to use it for assessment generation.',
  '.ppt': 'Legacy .ppt is not readable. Re-save as .pptx to use it for assessment generation.',
  '.xls': 'Spreadsheets are not used for assessment generation.',
  '.xlsx': 'Spreadsheets are not used for assessment generation.'
};

/**
 * Below this many characters we treat the file as having no usable text — the
 * typical signature of a scanned PDF, where the parser returns only page
 * markers.
 */
const MIN_USABLE_CHARS = 120;

/** Hard cap per handout, to keep the generation prompt within a sane token budget. */
const MAX_CHARS_PER_HANDOUT = 12000;

/**
 * Cap on pages sent through OCR. Each page is one vision call — roughly 3.6s and
 * $0.004 — so an unbounded scan of a 60-page book would be slow and costly.
 * Ten pages is plenty of source material for generating an assessment.
 */
const MAX_OCR_PAGES = 10;

function cleanText(raw) {
  return String(raw || '')
    // pdf-parse v2 inserts "-- 1 of 3 --" page markers; they are not content.
    .replace(/--\s*\d+\s+of\s+\d+\s*--/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdf(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text || '', pages: result.total || null };
  } finally {
    if (typeof parser.destroy === 'function') {
      try { await parser.destroy(); } catch (_e) { /* nothing useful to do */ }
    }
  }
}

/**
 * OCR a scanned PDF: render each page to a PNG with pdf-parse's own renderer,
 * then have the existing OpenAI vision model transcribe it.
 *
 * pdf-parse renders internally, so this needs no node-canvas or other native
 * dependency — which matters on Windows, where those require a build toolchain.
 *
 * Pages are transcribed sequentially rather than in parallel: a handout upload is
 * not latency-critical, and serial calls avoid hitting rate limits.
 */
async function ocrPdf(buffer) {
  const { transcribeImage, isOpenAIConfigured } = require('./aiService');
  if (!isOpenAIConfigured()) {
    return { text: '', pages: 0, ocrPages: 0, error: 'AI is not configured, so scanned pages cannot be read.' };
  }

  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  let shot;
  try {
    shot = await parser.getScreenshot({});
  } finally {
    if (typeof parser.destroy === 'function') {
      try { await parser.destroy(); } catch (_e) { /* nothing useful to do */ }
    }
  }

  const pages = (shot.pages || []).slice(0, MAX_OCR_PAGES);
  if (!pages.length) return { text: '', pages: 0, ocrPages: 0, error: 'The PDF could not be rendered for reading.' };

  const parts = [];
  let failed = 0;
  for (const page of pages) {
    if (!page.dataUrl) { failed++; continue; }
    try {
      const { text } = await transcribeImage(page.dataUrl);
      if (text) parts.push(text);
    } catch (_error) {
      failed++;
    }
  }

  return {
    text: parts.join('\n\n'),
    pages: shot.total || pages.length,
    ocrPages: pages.length,
    truncatedPages: (shot.total || pages.length) > MAX_OCR_PAGES ? (shot.total - MAX_OCR_PAGES) : 0,
    error: parts.length ? null : (failed ? 'Could not read any page of this scan.' : null)
  };
}

async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value || '', pages: null };
}

/**
 * PPTX is a zip. Slide text lives in <a:t> nodes inside ppt/slides/slideN.xml.
 * Slides are ordered numerically, not lexically, so slide10 does not sort
 * before slide2.
 */
async function extractPptx(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);

  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)[1]);
      const nb = Number(b.match(/slide(\d+)\.xml$/)[1]);
      return na - nb;
    });

  const slides = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async('string');
    const parts = [];
    for (const m of xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) {
      parts.push(decodeXmlEntities(m[1]));
    }
    const slideText = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (slideText) slides.push(slideText);
  }

  return { text: slides.join('\n\n'), pages: slideNames.length || null };
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/**
 * Extract text from one handout file.
 *
 * Never throws: a bad file must not break an upload of several files. Failures
 * come back as `{ usable: false, error }` so the caller can store the reason and
 * show it on the handout card.
 *
 * @param {object} input
 * @param {string} [input.absolutePath] path on disk
 * @param {Buffer} [input.buffer] file contents, if already in memory
 * @param {string} input.originalName used to pick the parser
 * @param {boolean} [input.allowOcr=false] when a PDF has no text layer, transcribe
 *        its pages with the OpenAI vision model. Off by default: it costs money
 *        and takes ~3.6s per page, so it is an explicit admin action.
 * @returns {Promise<{text: string, chars: number, pages: number|null, method: string, usable: boolean, truncated: boolean, warning: string|null, error: string|null}>}
 */
async function extractHandoutText(input = {}) {
  const { absolutePath, buffer, originalName, allowOcr = false } = input;
  const base = {
    text: '', chars: 0, pages: null, method: 'text', usable: false, truncated: false, warning: null, error: null
  };

  const ext = path.extname(String(originalName || absolutePath || '')).toLowerCase();

  if (NOT_EXTRACTABLE[ext]) {
    return { ...base, error: NOT_EXTRACTABLE[ext] };
  }
  if (!EXTRACTABLE.includes(ext)) {
    return { ...base, error: `Cannot read "${ext || 'unknown'}" files for assessment generation.` };
  }

  let data = buffer;
  if (!data) {
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      return { ...base, error: 'File could not be found on the server.' };
    }
    try {
      data = await fs.promises.readFile(absolutePath);
    } catch (error) {
      return { ...base, error: `Could not read the file: ${error.message}` };
    }
  }

  let raw = '';
  let pages = null;
  try {
    if (ext === '.pdf') ({ text: raw, pages } = await extractPdf(data));
    else if (ext === '.docx') ({ text: raw, pages } = await extractDocx(data));
    else if (ext === '.pptx') ({ text: raw, pages } = await extractPptx(data));
    else raw = data.toString('utf8');
  } catch (error) {
    return { ...base, pages, error: `Could not read the ${ext.replace('.', '').toUpperCase()}: ${error.message}` };
  }

  let cleaned = cleanText(raw);
  let method = 'text';
  let ocrNote = null;

  // A PDF with no text layer is a scan. Fall back to OCR when the caller allows
  // it — that path costs money and takes a few seconds per page, so it is
  // opt-in rather than automatic on every upload.
  if (cleaned.length < MIN_USABLE_CHARS && ext === '.pdf' && allowOcr) {
    const ocr = await ocrPdf(data);
    const ocrText = cleanText(ocr.text);
    if (ocrText.length >= MIN_USABLE_CHARS) {
      cleaned = ocrText;
      method = 'ocr';
      pages = ocr.pages || pages;
      ocrNote = `Read with AI from ${ocr.ocrPages} scanned page${ocr.ocrPages === 1 ? '' : 's'}.`
        + (ocr.truncatedPages ? ` The remaining ${ocr.truncatedPages} page(s) were skipped — ${MAX_OCR_PAGES} pages is the limit.` : '');
    } else {
      return {
        ...base,
        chars: 0,
        pages,
        method: 'ocr',
        usable: false,
        error: ocr.error || null,
        warning: ocr.error
          ? null
          : 'Even reading the scan with AI found no words. Students can still open this file, but it cannot generate questions.'
      };
    }
  }

  if (cleaned.length < MIN_USABLE_CHARS) {
    return {
      ...base,
      text: cleaned,
      chars: cleaned.length,
      pages,
      method,
      usable: false,
      warning: ext === '.pdf'
        ? 'No readable text found — this looks like a scanned PDF. Use “Read with AI” to transcribe it, or re-upload a PDF exported from a document.'
        : 'No readable text found in this file, so it cannot be used to generate assessment questions.'
    };
  }

  const truncated = cleaned.length > MAX_CHARS_PER_HANDOUT;
  const notes = [];
  if (ocrNote) notes.push(ocrNote);
  if (truncated) {
    notes.push(`Only the first ${MAX_CHARS_PER_HANDOUT.toLocaleString()} of ${cleaned.length.toLocaleString()} characters are used for question generation.`);
  }

  return {
    ...base,
    text: truncated ? cleaned.slice(0, MAX_CHARS_PER_HANDOUT) : cleaned,
    chars: cleaned.length,
    pages,
    method,
    usable: true,
    truncated,
    warning: notes.length ? notes.join(' ') : null
  };
}

module.exports = {
  extractHandoutText,
  EXTRACTABLE,
  NOT_EXTRACTABLE,
  MIN_USABLE_CHARS,
  MAX_CHARS_PER_HANDOUT,
  MAX_OCR_PAGES
};
