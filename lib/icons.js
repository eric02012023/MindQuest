/**
 * File: lib/icons.js
 * Purpose: The row-action icon set, as one function every view can call.
 *
 * Row actions are icon buttons aligned to the right of each row. Pasting the
 * same <svg> into a dozen templates is how "edit" ends up drawn three different
 * ways, so the markup lives here and views ask for it by name.
 *
 * Registered on app.locals in server.js, so a template calls `icon('edit')`.
 * Output is trusted markup and must be printed with <%- %>, never <%= %>.
 */

/** 16px, 1.8 stroke, currentColor — so an icon takes the colour of its button. */
const PATHS = {
  view: '<circle cx="12" cy="12" r="3"/><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  add: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  remove: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/>',
  money: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M9.5 9.5h5"/><path d="M9.5 12.5h5"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6"/><path d="M9 12h6"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="7" rx="1"/><path d="M6 16h12v5H6z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  close: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  flag: '<path d="M4 22V4"/><path d="M4 5h13l-2 4 2 4H4"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 21h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  warning: '<path d="M12 3l9 16H3z"/><path d="M12 9v5"/><path d="M12 17.5v.5"/>'
};

/**
 * @param {string} name  a key of PATHS
 * @param {number} [size=16]
 * @returns {string} inline SVG markup, or '' for an unknown name
 */
function icon(name, size = 16) {
  const body = PATHS[name];
  if (!body) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" '
    + `aria-hidden="true" focusable="false">${body}</svg>`;
}

module.exports = { icon, ICON_NAMES: Object.keys(PATHS) };
