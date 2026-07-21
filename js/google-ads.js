/* Homesite Mortgage — Google Ads conversion tracking.

   Gated behind CookieYes "Advertisement" consent, mirroring the Facebook Pixel
   loader in thank-you.html so nothing fires before the visitor opts in. Shares
   the gtag/dataLayer instance with js/ga4.js when analytics consent is also
   granted; works standalone when it isn't.

   TO ACTIVATE: replace AW_ID and the labels below with the real values from
   Google Ads (Goals → Conversions → open the action → "Tag setup" → the
   send_to value looks like AW-1234567890/AbC-D_efGh12_34-567). While the
   placeholders are here the loader is inert — no network requests, no cookies.

   DELIBERATELY NOT ENABLED — Enhanced Conversions. It uploads hashed borrower
   email/phone to Google. Borrower contact details are NPI under GLBA and stay
   on the Worker → Resend → HubSpot path only. Do not turn this on in the
   Google Ads UI either; the setting lives there, not here.

   NOT USED — Google's call-forwarding numbers. A forwarding number would break
   NAP consistency for local SEO and bypass the Quo line / Free Caller Registry
   setup. Click-to-call is tracked below instead, from our own number. */
(function () {
  var AW_ID      = 'AW-XXXXXXXXXX';       // Google Ads conversion ID
  var LEAD_LABEL = 'XXXXXXXXXXXXXXXXXXX'; // "Prequal Lead" — primary conversion
  var CALL_LABEL = 'XXXXXXXXXXXXXXXXXXX'; // "Click to Call" — secondary/observation

  function isSet(v) { return v && v.indexOf('XXXX') === -1; }

  function loadAds() {
    if (window.googleAdsLoaded) return;
    if (!isSet(AW_ID)) return; // inert until a real conversion ID is set
    window.googleAdsLoaded = true;

    window.dataLayer = window.dataLayer || [];
    if (!window.gtag) {
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
    }

    // ga4.js may already have injected gtag.js; one library serves both IDs.
    if (!window.ga4Loaded) {
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + AW_ID;
      document.head.appendChild(s);
    }
    window.gtag('config', AW_ID);

    // Lead conversion — the Worker 303-redirects here after a successful submit,
    // so this page load is the confirmed lead. Matches GA4's generate_lead.
    if (location.pathname.indexOf('thank-you') !== -1 && isSet(LEAD_LABEL)) {
      window.gtag('event', 'conversion', { send_to: AW_ID + '/' + LEAD_LABEL });
    }
  }

  // Load now if advertisement consent is already granted...
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof CookieYes !== 'undefined') {
      var consent = CookieYes.getConsent();
      if (consent && consent.advertisement === 'yes') loadAds();
    }
  });

  // ...or the moment the visitor grants it.
  document.addEventListener('cookieyes_consent_update', function (e) {
    var data = e.detail;
    if (data && data.accepted && data.accepted.indexOf('advertisement') > -1) loadAds();
  });

  // Click-to-call — a tapped phone number is a real lead signal for this business,
  // where most borrowers call rather than fill in a form. Keep this one SECONDARY
  // in Google Ads so it never outvotes actual prequal submissions in bidding.
  document.addEventListener('click', function (e) {
    if (!window.gtag || !window.googleAdsLoaded || !isSet(CALL_LABEL)) return;
    if (!e.target.closest) return;
    var a = e.target.closest('a[href^="tel:"]');
    if (!a) return;
    window.gtag('event', 'conversion', {
      send_to: AW_ID + '/' + CALL_LABEL,
      event_callback: function () {}
    });
  });
})();
