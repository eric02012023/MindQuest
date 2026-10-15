/**
 * File: public/js/mq-tables.js
 * Purpose: Every table in the dashboards shows TEN rows and then scrolls.
 *
 * WHY ONE SCRIPT FOR EVERY TABLE
 * The office asked for "ten rows, then it scrolls" on every list. Writing that
 * into forty templates would give forty slightly different versions; this file
 * gives every table the same one, including tables added later.
 *
 * It works on both kinds of table the app has:
 *   .mq-table            the grid lists (a .mq-head, then .mq-row children)
 *   .table-wrap > table  plain tables (thead th, tbody tr)
 *
 * WHAT IT DOES
 * A table with more than ten rows is given a max-height that fits exactly its
 * heading and its first ten rows, and scrolls inside that. The heading stays put
 * while the rows scroll (sticky, css/mq-data.css).
 *
 * There is NO search here. The small magnifier that used to sit in a table's
 * heading is gone: every list that needs to be searched has a proper search and
 * filter bar above it (a GET form the server answers), and the icon only doubled it.
 *
 * OPTING OUT
 *   data-no-table-cap   on the .mq-table / .table-wrap: no ten-row limit
 *
 * Tables that appear later (a dialog fetched on demand, a tab shown) are
 * enhanced by calling window.mqEnhanceTables(root); a table that was hidden
 * when the page loaded is measured once it becomes visible.
 */
(function () {
  'use strict';

  var VISIBLE_ROWS = 10;
  var states = [];

  function childrenMatching(parent, selector) {
    return Array.prototype.filter.call(parent.children, function (child) { return child.matches(selector); });
  }

  // ---------------------------------------------------------------- describe
  function describe(frame) {
    if (frame.classList.contains('mq-table')) {
      var head = childrenMatching(frame, '.mq-head')[0] || null;
      return {
        frame: frame,
        head: head,
        rows: function () { return childrenMatching(frame, '.mq-row'); }
      };
    }
    var table = frame.querySelector('table');
    if (!table) return null;
    var thead = table.tHead;
    var bodies = Array.prototype.slice.call(table.tBodies);
    var isEmptyRow = function (tr) {
      return tr.cells.length === 1 && Number(tr.cells[0].colSpan || 1) > 1;
    };
    return {
      frame: frame,
      head: thead,
      rows: function () {
        var all = [];
        bodies.forEach(function (body) {
          Array.prototype.forEach.call(body.rows, function (tr) {
            if (!isEmptyRow(tr)) all.push(tr);
          });
        });
        return all;
      }
    };
  }

  // --------------------------------------------------------------- the cap
  function isShown(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  /**
   * Fit the frame to its heading and first ten visible rows.
   *
   * Heights are read with getBoundingClientRect, which keeps the fraction —
   * offsetHeight rounds, and a row that is really 52.48px read as 52 left the
   * tenth row a few pixels short and clipped. getBoundingClientRect is in
   * screen pixels, which the dashboard's 90% zoom (css/mq-brand.css) scales,
   * while max-height is written in the element's own CSS pixels; the ratio of
   * the frame's two heights converts between them, whatever the browser's
   * zoom model.
   */
  function refit(state) {
    var frame = state.frame;
    if (frame.hasAttribute('data-no-table-cap')) return;
    if (!isShown(frame)) return;
    var rows = state.rows().filter(isShown);
    if (rows.length <= VISIBLE_ROWS) {
      if (frame.classList.contains('mq-capped')) {
        frame.classList.remove('mq-capped');
        frame.style.maxHeight = '';
      }
      return;
    }
    var scale = frame.offsetHeight ? frame.getBoundingClientRect().height / frame.offsetHeight : 1;
    if (!scale || !isFinite(scale)) scale = 1;
    var cssHeight = function (el) { return el.getBoundingClientRect().height / scale; };
    var height = state.head && isShown(state.head) ? cssHeight(state.head) : 0;
    for (var i = 0; i < VISIBLE_ROWS; i++) height += cssHeight(rows[i]);
    // Borders, and a horizontal scrollbar if the table is wider than its frame.
    var chrome = Math.max(0, frame.offsetHeight - frame.clientHeight);
    var next = Math.ceil(height + chrome + 1) + 'px';
    if (frame.style.maxHeight !== next) frame.style.maxHeight = next;
    frame.classList.add('mq-capped');
  }

  var pending = null;
  function refitAll() {
    if (pending) return;
    pending = window.requestAnimationFrame(function () {
      pending = null;
      states.forEach(refit);
    });
  }

  // ---------------------------------------------------------------- enhance
  function enhance(frame) {
    if (frame.__mqTable) return;
    if (frame.classList.contains('table-wrap') && frame.querySelector('.mq-table')) return;
    var state = describe(frame);
    if (!state) return;
    frame.__mqTable = state;
    states.push(state);

    if ('ResizeObserver' in window) {
      // A table in a closed tab or dialog measures 0 until it is shown.
      var observer = new ResizeObserver(function () { refit(state); });
      observer.observe(frame);
    }
    refit(state);
  }

  function enhanceTables(root) {
    (root || document).querySelectorAll('.mq-table, .table-wrap').forEach(enhance);
  }

  window.mqEnhanceTables = enhanceTables;
  window.addEventListener('resize', refitAll);
  window.addEventListener('load', refitAll);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refitAll);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { enhanceTables(document); });
  } else {
    enhanceTables(document);
  }
})();
