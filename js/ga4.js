/* Homesite Mortgage — Google Analytics 4 loader.
   Gated behind CookieYes "Analytics" consent, mirroring the HubSpot loader in
   index.html so analytics only runs after the visitor opts in.

   TO ACTIVATE: replace GA4_ID below with the real Measurement ID
   (G-XXXXXXXXXX) from the GA4 web data stream. While the placeholder is in
   place the loader is inert — no network requests, no cookies. */
(function () {
  var GA4_ID = 'G-4PN6EVV4DM'; // Homesite Mortgage — GA4 web data stream

  function loadGA4() {
    if (window.ga4Loaded) return;
    if (!GA4_ID || GA4_ID.indexOf('XXXX') !== -1) return; // inert until a real ID is set
    window.ga4Loaded = true;

    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
    document.head.appendChild(s);

    // Do NOT reassign window.gtag — consent-mode.js already defined it and
    // queued the consent defaults. Replacing it here would orphan those.
    window.dataLayer = window.dataLayer || [];
    if (!window.gtag) {
      window.gtag = function () { window.dataLayer.push(arguments); };
    }
    window.gtag('js', new Date());
    window.gtag('config', GA4_ID);

    // Lead conversion — fires once on the thank-you page after a form submit.
    if (location.pathname.indexOf('thank-you') !== -1) {
      window.gtag('event', 'generate_lead', {
        event_category: 'lead',
        event_label: 'form_submission'
      });
    }

    // Which assistant sent this visit, if any. js/attribution.js classifies the
    // referrer and stores it first-touch; this reports it so AI traffic can be
    // segmented in GA4 rather than sitting in the generic Referral bucket where
    // "chatgpt.com" is indistinguishable from any other site.
    //
    // Reported for every visit, not only ones that convert — the interesting
    // number is how many people an assistant sends versus how many of them
    // become leads, and the second is useless without the first.
    try {
      var src = sessionStorage.getItem('referrer_source');
      if (src) {
        window.gtag('event', 'referral_source_seen', {
          event_category: 'acquisition',
          event_label: src,
          page_path: location.pathname
        });
      }
    } catch (e) { /* storage blocked — never break the page for analytics */ }
  }

  // Always load. Consent Mode (js/consent-mode.js) gates whether this writes
  // cookies or only sends cookieless pings, so the loader itself no longer waits.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadGA4);
  } else {
    loadGA4();
  }

  // Funnel instrumentation — measure which entry points drive prequal/calculator
  // clicks so ad spend can be optimized by cost-per-lead. No-ops until analytics
  // consent has loaded gtag (guarded), so it never fires without consent.
  document.addEventListener('click', function (e) {
    if (!window.gtag || !e.target.closest) return;
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var label = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (/prequal\.html/.test(href)) {
      window.gtag('event', 'prequal_cta_click', { event_category: 'lead', event_label: label, page_path: location.pathname });
    } else if (/mortgage-calculator\.html/.test(href)) {
      window.gtag('event', 'calculator_cta_click', { event_category: 'engagement', event_label: label, page_path: location.pathname });
    } else if (/^tel:/.test(href)) {
      // Most borrowers here call rather than fill in a form — three calls
      // arrived on 2026-08-20 with no attribution at all. There are 175 tel:
      // links across the site and none of them were reporting anything.
      //
      // This counts the TAP, which is not the same as a connected call: it
      // misses anyone who reads the number and dials it by hand, and it counts
      // taps that never connect. It is a floor on call volume and a channel
      // comparison, not a call log. Say that plainly before anyone treats it
      // as one.
      window.gtag('event', 'click_to_call', {
        event_category: 'lead',
        event_label: label || 'phone',
        page_path: location.pathname
      });
    } else if (/^mailto:/.test(href)) {
      window.gtag('event', 'click_to_email', {
        event_category: 'lead',
        event_label: label || 'email',
        page_path: location.pathname
      });
    }
  });
})();
