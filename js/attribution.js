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

   The adkeyword/matchtype/adnetwork/addevice keys are Google Ads ValueTrack
   parameters, populated by the campaign's Final URL suffix. They answer the one
   question the $500 test exists to answer: WHICH KEYWORD produced this lead.
   Google Ads will not tell you which search term a given gclid came from, but
   ValueTrack stamps the matched keyword straight into the landing page URL, so
   it rides through to the lead email with no lookup and no stored database.

   No PII is stored here: campaign identifiers only. */
(function () {
  var KEYS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium',
              'utm_campaign', 'utm_term', 'utm_content', 'ref',
              // Google Ads ValueTrack — see Final URL suffix on the campaign
              'adkeyword', 'matchtype', 'adnetwork', 'addevice',
              'campaignid', 'adgroupid', 'creativeid',
              // Where the visit came from when it was not a paid click.
              // Set from document.referrer below, not from the URL.
              'referrer_source'];

  // AI assistants that send real traffic. The 2026-08-20 prequal lead arrived
  // with utm_source=chatgpt.com and no gclid — an assistant recommended us and
  // it cost nothing. That was noticed by luck; this makes it countable.
  //
  // Some assistants append utm_source, some send only a Referer header, and
  // some send neither. Capturing both paths catches more of them than either
  // alone, and neither path is reliable on its own.
  var AI_HOSTS = [
    [/(^|\.)chatgpt\.com$/i,            'ChatGPT'],
    [/(^|\.)openai\.com$/i,             'ChatGPT'],
    [/(^|\.)perplexity\.ai$/i,          'Perplexity'],
    [/(^|\.)claude\.ai$/i,              'Claude'],
    [/(^|\.)anthropic\.com$/i,          'Claude'],
    [/(^|\.)gemini\.google\.com$/i,     'Gemini'],
    [/(^|\.)copilot\.microsoft\.com$/i, 'Copilot'],
    [/(^|\.)grok\.com$/i,               'Grok'],
    [/(^|\.)x\.ai$/i,                   'Grok'],
    [/(^|\.)you\.com$/i,                'You.com'],
    [/(^|\.)phind\.com$/i,              'Phind']
  ];

  function label(host) {
    for (var i = 0; i < AI_HOSTS.length; i++) {
      if (AI_HOSTS[i][0].test(host)) return AI_HOSTS[i][1];
    }
    return null;
  }

  // HOSTNAME ONLY, never the full referrer URL. A referring search page can
  // carry the visitor's query — and sometimes their own details — in its query
  // string, and that is nonpublic personal information the moment it concerns a
  // borrower. The host answers "which channel sent them" without any of that.
  function referrerSource() {
    try {
      if (!document.referrer) return null;
      var host = new URL(document.referrer).hostname;
      if (!host || host === window.location.hostname) return null; // internal nav
      return label(host) || host;
    } catch (e) { return null; }
  }

  try {
    var url = new URLSearchParams(window.location.search);
    KEYS.forEach(function (k) {
      var v = url.get(k);
      // first touch wins: never overwrite a value already captured this session
      if (v && !sessionStorage.getItem(k)) sessionStorage.setItem(k, v);
    });

    if (!sessionStorage.getItem('referrer_source')) {
      // An assistant that stamps utm_source=chatgpt.com is more reliable than a
      // Referer header, so prefer it and normalise it to the same label.
      var fromUtm = url.get('utm_source');
      var src = (fromUtm && label(fromUtm)) || referrerSource();
      if (src) sessionStorage.setItem('referrer_source', src);
    }
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
