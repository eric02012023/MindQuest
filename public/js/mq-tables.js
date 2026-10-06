/**
 * File: public/js/mq-tables.js
 * Purpose: Every table in the dashboards shows TEN rows and scrolls, and has a
 *          small search icon in its heading that finds any row by anything
 *          written in it.
 *
 * WHY ONE SCRIPT FOR EVERY TABLE
 * The office asked for the same two things on every list — "ten rows, then it
 * scrolls" and "a search icon inside the table" (like the Name column of a
 * course list, where the magnifier sits beside the heading). Writing that into
 * forty templates would give forty slightly different versions; this file
 * gives every table the same one, including tables added later.
 *
 * It works on both kinds of table the app has:
 *   .mq-table            the grid lists (a .mq-head, then .mq-row children)
 *   .table-wrap > table  plain tables (thead th, tbody tr)
 *
 * WHAT IT DOES
 *   - A table with more than ten rows is given a max-height that fits exactly
 *     its heading and its first ten rows, and scrolls inside that. The heading
 *     stays put while the rows scroll (sticky, css/mq-data.css).
 *   - A magnifier is placed in the heading cell of the name column (or the
 *     cell marked data-search-col). Pressing it opens a search box above the
 *     table; typing hides the rows that do not contain every word typed — the
 *     name, the ID, the status, a date, whatever the row shows. "3 of 120"
 *     says how many match. Escape, or the ×, clears it.
 *   - Nothing is sent to the server: the rows are all on the page already.
 *
 * OPTING OUT / IN
 *   data-no-table-search   on the .mq-table / .table-wrap: no search icon
 *   data-no-table-cap      no ten-row limit
 *   data-search-anchor="external" + a button with data-table-search-for="<id>"
 *                          put the icon somewhere else (User Management puts it
 *                          beside the "All users" heading)
 *
 * Tables that appear later (a dialog fetched on demand, a tab shown) are
 * enhanced by calling window.mqEnhanceTables(root); a table that was hidden
 * when the page loaded is measured once it becomes visible.
 */
(function () {
  'use strict';

  var VISIBLE_ROWS = 10;
  var NAME_HEADING = /^(name|student|learner|tutor|user|assistant|who|title|assessment|topic|subject|slip|module|alert|what happened)/i;
  var ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">'
    + '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.2"/>'
    + '<path d="M20 20l-3.6-3.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  // Text inside these is not what the row "says": buttons, hidden dialogs,
  // drop-downs. Searching "archive" should not match every row's Archive button.
  var SKIP = 'script, style, template, select, option, button, .btn, .mq-btn, .mq-icon, .global-modal, '
    + '.mq-cell-actions form, [data-search-skip], input, textarea';

  var states = [];

  function normalise(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function childrenMatching(parent, selector) {
    return Array.prototype.filter.call(parent.children, function (child) { return child.matches(selector); });
  }

  /** Everything a person could read in a row, lower-cased, computed once. */
  function rowText(row) {
    if (row.__mqText !== undefined) return row.__mqText;
    var parts = [];
    var walker = document.createTreeWalker(row, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (node.nodeType === 1) return node.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) parts.push(node.nodeValue);
    if (row.getAttribute('data-search-text')) parts.push(row.getAttribute('data-search-text'));
    row.__mqText = normalise(parts.join(' '));
    return row.__mqText;
  }

  // ---------------------------------------------------------------- describe
  function describe(frame) {
    if (frame.classList.contains('mq-table')) {
      var head = childrenMatching(frame, '.mq-head')[0] || null;
      return {
        kind: 'grid',
        frame: frame,
        head: head,
        headCells: head ? Array.prototype.slice.call(head.children) : [],
        columns: head ? head.children.length : 1,
        rows: function () { return childrenMatching(frame, '.mq-row'); },
        empties: function () { return childrenMatching(frame, '.mq-empty:not(.mq-search-empty)'); },
        rowParent: frame
      };
    }
    var table = frame.querySelector('table');
    if (!table) return null;
    var thead = table.tHead;
    var headRow = thead ? thead.rows[0] : null;
    var cells = headRow ? Array.prototype.slice.call(headRow.cells) : [];
    var bodies = Array.prototype.slice.call(table.tBodies);
    var isEmptyRow = function (tr) {
      return tr.cells.length === 1 && Number(tr.cells[0].colSpan || 1) > 1;
    };
    return {
      kind: 'table',
      frame: frame,
      table: table,
      head: thead,
      headCells: cells,
      columns: Math.max(1, cells.reduce(function (sum, th) { return sum + Number(th.colSpan || 1); }, 0)),
      rows: function () {
        var all = [];
        bodies.forEach(function (body) {
          Array.prototype.forEach.call(body.rows, function (tr) {
            if (!isEmptyRow(tr) && !tr.classList.contains('mq-search-empty')) all.push(tr);
          });
        });
        return all;
      },
      empties: function () {
        var all = [];
        bodies.forEach(function (body) {
          Array.prototype.forEach.call(body.rows, function (tr) {
            if (isEmptyRow(tr) && !tr.classList.contains('mq-search-empty')) all.push(tr);
          });
        });
        return all;
      },
      rowParent: bodies[bodies.length - 1] || table
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
    var rows = state.rows().filter(function (row) {
      return !row.classList.contains('mq-search-miss') && isShown(row);
    });
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

  // ---------------------------------------------------------------- search
  function anchorCell(state) {
    var cells = state.headCells.filter(function (cell) { return normalise(cell.textContent); });
    var marked = state.headCells.filter(function (cell) { return cell.hasAttribute('data-search-col'); })[0];
    if (marked) return marked;
    var named = cells.filter(function (cell) { return NAME_HEADING.test(normalise(cell.textContent)); })[0];
    return named || cells[0] || state.headCells[0] || null;
  }

  function buildBar(state) {
    var bar = document.createElement('div');
    bar.className = 'mq-table-search';
    bar.innerHTML = '<span class="mq-table-search-icon">' + ICON + '</span>'
      + '<input type="search" autocomplete="off" spellcheck="false" placeholder="Search this table — name, ID, anything in a row" aria-label="Search this table" />'
      + '<span class="mq-table-search-count" aria-live="polite"></span>'
      + '<button type="button" class="mq-table-search-close" aria-label="Close search" title="Close search">&times;</button>';
    state.frame.parentNode.insertBefore(bar, state.frame);
    state.bar = bar;
    state.input = bar.querySelector('input');
    state.count = bar.querySelector('.mq-table-search-count');

    var timer = null;
    state.input.addEventListener('input', function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { apply(state); }, 60);
    });
    state.input.addEventListener('keydown', function (event) {
      // The table may sit inside a form (Attendance): Enter must not submit it.
      if (event.key === 'Enter') event.preventDefault();
      if (event.key === 'Escape') { event.preventDefault(); close(state); }
    });
    bar.querySelector('.mq-table-search-close').addEventListener('click', function () { close(state); });
  }

  function open(state) {
    if (!state.bar) buildBar(state);
    state.bar.classList.add('is-open');
    (state.toggles || []).forEach(function (toggle) { toggle.setAttribute('aria-expanded', 'true'); toggle.classList.add('is-active'); });
    state.input.focus();
  }

  function close(state) {
    if (!state.bar) return;
    state.input.value = '';
    apply(state);
    state.bar.classList.remove('is-open');
    (state.toggles || []).forEach(function (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.classList.remove('is-active'); });
  }

  function toggle(state) {
    if (state.bar && state.bar.classList.contains('is-open')) close(state);
    else open(state);
  }

  function noMatchRow(state) {
    if (state.noMatch) return state.noMatch;
    var el;
    if (state.kind === 'grid') {
      el = document.createElement('div');
      el.className = 'mq-empty mq-search-empty';
    } else {
      el = document.createElement('tr');
      el.className = 'mq-search-empty';
      var td = document.createElement('td');
      td.colSpan = state.columns;
      el.appendChild(td);
    }
    state.noMatch = el;
    return el;
  }

  function apply(state) {
    var terms = normalise(state.input ? state.input.value : '').split(' ').filter(Boolean);
    var rows = state.rows();
    var shown = 0;
    rows.forEach(function (row) {
      var text = rowText(row);
      var match = terms.every(function (term) { return text.indexOf(term) !== -1; });
      row.classList.toggle('mq-search-miss', !match);
      if (match) shown++;
    });

    // The table's own "nothing here yet" line stays as it was when there are no
    // rows at all; a search with no hits gets its own line.
    var empty = noMatchRow(state);
    if (terms.length && rows.length && !shown) {
      var label = 'No match for “' + terms.join(' ') + '”.';
      if (state.kind === 'grid') empty.textContent = label;
      else empty.firstChild.textContent = label;
      if (!empty.parentNode) state.rowParent.appendChild(empty);
    } else if (empty.parentNode) {
      empty.parentNode.removeChild(empty);
    }

    if (state.count) state.count.textContent = terms.length ? shown + ' of ' + rows.length : '';
    // Back to the top, so the first match is in view rather than scrolled past.
    state.frame.scrollTop = 0;
    refit(state);
  }

  // ---------------------------------------------------------------- enhance
  function enhance(frame) {
    if (frame.__mqTable) return;
    if (frame.classList.contains('table-wrap') && frame.querySelector('.mq-table')) return;
    var state = describe(frame);
    if (!state) return;
    frame.__mqTable = state;
    states.push(state);
    state.toggles = [];

    if (!frame.hasAttribute('data-no-table-search')) {
      if (frame.getAttribute('data-search-anchor') === 'external' && frame.id) {
        document.querySelectorAll('[data-table-search-for="' + frame.id + '"]').forEach(function (button) {
          button.setAttribute('aria-expanded', 'false');
          button.addEventListener('click', function () { toggle(state); });
          state.toggles.push(button);
        });
      } else {
        var cell = anchorCell(state);
        if (cell) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'mq-th-search';
          button.title = 'Search this table';
          button.setAttribute('aria-label', 'Search this table');
          button.setAttribute('aria-expanded', 'false');
          button.innerHTML = ICON;
          button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            toggle(state);
          });
          cell.appendChild(button);
          state.toggles.push(button);
        }
      }
      // A phone hides the heading row, and the icon with it; the search box is
      // shown there instead (css/mq-data.css).
      buildBar(state);
    }

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
