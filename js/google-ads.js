/* Homesite Mortgage — Google Ads conversion tracking.

   CONSENT IS HANDLED BY js/consent-mode.js, WHICH MUST LOAD FIRST. This file
   no longer gates the tag behind CookieYes. It used to, and that silently lost
   real conversions: the first ad-driven lead declined the banner, so gtag never
   loaded and Google Ads recorded zero conversions even though the Worker had
   the gclid. Under Consent Mode v2 the tag always loads but starts in a denied
   state — cookieless pings only, no cookies, no identifiers — which lets Google
   model the conversions it cannot directly observe.

   The "Submit lead form" conversion is URL-BASED, not snippet-based: the action
   in Google Ads is defined as "page load: homesitemortgage.online/thank-you.html".
   The Google tag alone detects that page load and records the conversion, so
   there is no event snippet and no send_to label for the lead. Do not add one —
   a second signal on the same page would double-count.

   CALL_LABEL is still a placeholder because no click-to-call conversion action
   exists in Google Ads yet. While it holds XXXX the click handler is inert.

   DELIBERATELY NOT ENABLED — Enhanced Conversions. It uploads hashed borrower
   email/phone to Google. Borrower contact details are NPI under GLBA and stay
   on the Worker → Resend → HubSpot path only. Do not turn this on in the
   Google Ads UI either; the setting lives there, not here.

   NOT USED — Google's call-forwarding numbers. A forwarding number would break
   NAP consistency for local SEO and bypass the Quo line / Free Caller Registry
   setup. Click-to-call is tracked below instead, from our own number. */
(function () {
  var AW_ID      = 'AW-18333281422';      // Google Ads conversion ID
  // Paste ONLY the label here, e.g. 'AbC-D_efGhIjKlMnOp'. Google's UI shows it as
  // send_to: 'AW-18333281422/AbC-D_efGhIjKlMnOp' and the whole string usually gets
  // copied, so normaliseLabel below strips a pasted AW-.../ prefix rather than
  // building AW-18333281422/AW-18333281422/AbC... and failing silently.
  var CALL_LABEL = 'XXXXXXXXXXXXXXXXXXX'; // "Click to Call" — secondary/observation

  function isSet(v) { return v && v.indexOf('XXXX') === -1; }

  // A wrong paste must be loud. The previous campaign spent $540 with calls
  // uncounted; the failure mode to avoid is a label that looks set but is
  // malformed, because that reports nothing and looks like it is working.
  function normaliseLabel(v) {
    if (!isSet(v)) return null;
    var label = String(v).trim();
    var slash = label.lastIndexOf('/');
    if (slash !== -1) label = label.slice(slash + 1);   // 'AW-123.../AbC' -> 'AbC'
    if (!/^[A-Za-z0-9_-]{8,}$/.test(label)) {
      if (window.console && console.warn) {
        console.warn('[google-ads] CALL_LABEL does not look like a Google Ads ' +
                     'conversion label; click-to-call conversions are NOT being ' +
                     'reported. Paste just the label, e.g. AbC-D_efGhIjKlMnOp.');
      }
      return null;
    }
    return label;
  }

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
    // No lead snippet here on purpose — see the URL-based note at the top of
    // this file. The Worker 303-redirects to thank-you.html after a successful
    // submit, and the Google tag matches that URL on its own.
  }

  // Always load. Consent Mode (js/consent-mode.js) decides whether this tag may
  // write cookies or only send cookieless pings — so loading it while consent is
  // denied is the intended behaviour, and it is what makes modelling possible.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAds);
  } else {
    loadAds();
  }

  // Click-to-call — a tapped phone number is a real lead signal for this business,
  // where most borrowers call rather than fill in a form. Keep this one SECONDARY
  // in Google Ads so it never outvotes actual prequal submissions in bidding.
  document.addEventListener('click', function (e) {
    if (!window.gtag || !window.googleAdsLoaded) return;
    var label = normaliseLabel(CALL_LABEL);
    if (!label) return;
    if (!e.target.closest) return;
    var a = e.target.closest('a[href^="tel:"]');
    if (!a) return;
    window.gtag('event', 'conversion', {
      send_to: AW_ID + '/' + label,
      event_callback: function () {}
    });
  });
})();
