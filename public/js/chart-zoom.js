/**
 * File: public/js/chart-zoom.js
 * Purpose: Keep chart tooltips on the point under the pointer at 90% zoom.
 *
 * Dashboards are shown at 90% on a computer screen (css/mq-brand.css). Chart.js
 * 4.4 reads where the pointer is in screen pixels, which that zoom makes a
 * tenth smaller than the chart's own, so hovering a bar near the right edge
 * named one further left. This scales the pointer back into the chart's pixels
 * before Chart.js looks for the point under it. Without any zoom it does
 * nothing. Load it right after /js/vendor/chart.umd.min.js.
 */
(function () {
  if (typeof Chart === 'undefined') return;
  Chart.register({
    id: 'mqZoomPointer',
    beforeEvent: function (chart, args) {
      var zoom = chart.canvas.currentCSSZoom || 1;
      var event = args.event;
      if (zoom === 1 || !event || event.x === null || event.y === null) return;
      event.x /= zoom;
      event.y /= zoom;
      args.inChartArea = chart.isPointInArea(event);
    }
  });
})();
