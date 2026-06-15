/* Homesite Mortgage — Google Analytics 4 loader.
   Gated behind CookieYes "Analytics" consent, mirroring the HubSpot loader in
   index.html so analytics only runs after the visitor opts in.

   TO ACTIVATE: replace GA4_ID below with the real Measurement ID
   (G-XXXXXXXXXX) from the GA4 web data stream. While the placeholder is in
   place the loader is inert — no network requests, no cookies. */
(function () {
  var GA4_ID = 'G-XXXXXXXXXX'; // <-- replace with the real Measurement ID

  function loadGA4() {
    if (window.ga4Loaded) return;
    if (!GA4_ID || GA4_ID.indexOf('XXXX') !== -1) return; // inert until a real ID is set
    window.ga4Loaded = true;

    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA4_ID);

    // Lead conversion — fires once on the thank-you page after a form submit.
    if (location.pathname.indexOf('thank-you') !== -1) {
      window.gtag('event', 'generate_lead', {
        event_category: 'lead',
        event_label: 'form_submission'
      });
    }
  }

  // Load now if analytics consent is already granted...
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof CookieYes !== 'undefined') {
      var consent = CookieYes.getConsent();
      if (consent && consent.analytics === 'yes') loadGA4();
    }
  });

  // ...or the moment the visitor grants it.
  document.addEventListener('cookieyes_consent_update', function (e) {
    var data = e.detail;
    if (data && data.accepted && data.accepted.indexOf('analytics') > -1) loadGA4();
  });
})();
