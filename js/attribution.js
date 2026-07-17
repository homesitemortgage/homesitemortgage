/* Homesite Mortgage — ad/campaign attribution capture.

   Runs on EVERY page (loaded synchronously in <head> so it stores values before
   any inline form-fill script reads them).

   Why this exists: prequal.html and contact.html already read utm_* from their
   OWN url, but an ad click usually lands somewhere else first (the calculator,
   a loan page, a county guide). By the time the visitor reaches the form the
   parameters are long gone, so every paid lead looked organic. This captures
   them at the landing page and holds them for the session.

   First touch wins — the campaign that earned the visit gets the credit, not a
   later internal click.

   No PII is stored here: campaign identifiers only. */
(function () {
  var KEYS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium',
              'utm_campaign', 'utm_term', 'utm_content', 'ref'];
  try {
    var url = new URLSearchParams(window.location.search);
    KEYS.forEach(function (k) {
      var v = url.get(k);
      // first touch wins: never overwrite a value already captured this session
      if (v && !sessionStorage.getItem(k)) sessionStorage.setItem(k, v);
    });
  } catch (e) { /* storage blocked — best effort, never break the page */ }

  // Let form pages pull whatever was captured, wherever it was captured.
  window.hmAttribution = function () {
    var out = {};
    try {
      KEYS.forEach(function (k) {
        var v = sessionStorage.getItem(k);
        if (v) out[k] = v;
      });
    } catch (e) { /* noop */ }
    return out;
  };
})();
