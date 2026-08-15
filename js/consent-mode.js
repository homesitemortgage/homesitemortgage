/* Homesite Mortgage — Google Consent Mode v2.

   MUST LOAD BEFORE js/ga4.js AND js/google-ads.js. It sets the default consent
   state before any Google tag initialises; if it runs after, the defaults are
   ignored and the tags behave as if consent were granted.

   WHY THIS EXISTS. The first real ad-driven lead (Aug 2026) arrived with a
   gclid in the Worker email, proving it came from a Google Ad — but Google Ads
   reported ZERO conversions for it. The visitor declined the CookieYes banner,
   so the old loaders never injected gtag at all and Google never learned the
   click converted. Smart Bidding optimises off Google's number, so it was
   learning that nothing works.

   Consent Mode v2 fixes that without weakening privacy. Consent defaults to
   DENIED. While denied, the Google tag sends cookieless pings: no cookies are
   written, no advertising identifiers are sent, and nothing is joined to a
   profile. Google uses those pings to MODEL the conversions it cannot observe.
   When the visitor accepts, we upgrade the state and normal measurement begins.

   Florida-only traffic means GDPR does not apply here, but this keeps the same
   opt-in posture the site has always had — a visitor who declines is still
   never cookied.

   Enhanced Conversions stays OFF regardless of consent state. It would upload
   hashed borrower email/phone, which is NPI under GLBA and belongs only on the
   Worker -> Resend -> HubSpot path. */
(function () {
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function () { window.dataLayer.push(arguments); };
  }

  // Default: deny everything. Runs before any tag, so nothing can slip through.
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'denied',
    personalization_storage: 'denied',
    security_storage: 'granted', // never gated; needed for anti-fraud
    wait_for_update: 500         // ms to wait for CookieYes before the first ping
  });

  // Google needs these flags to send the cookieless pings that power modelling.
  window.gtag('set', 'url_passthrough', true);
  window.gtag('set', 'ads_data_redaction', true);

  function applyConsent(c) {
    if (!c) return;
    var ad = c.advertisement === 'yes' ? 'granted' : 'denied';
    var an = c.analytics === 'yes' ? 'granted' : 'denied';
    var fn = c.functional === 'yes' ? 'granted' : 'denied';
    window.gtag('consent', 'update', {
      ad_storage: ad,
      ad_user_data: ad,
      ad_personalization: ad,
      analytics_storage: an,
      functionality_storage: fn,
      personalization_storage: fn
    });
  }

  // Whatever CookieYes already decided on a previous visit.
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof CookieYes !== 'undefined' && CookieYes.getConsent) {
      applyConsent(CookieYes.getConsent());
    }
  });

  // ...and the moment the visitor changes it.
  document.addEventListener('cookieyes_consent_update', function (e) {
    var d = e.detail;
    if (!d) return;
    var accepted = d.accepted || [];
    applyConsent({
      advertisement: accepted.indexOf('advertisement') > -1 ? 'yes' : 'no',
      analytics: accepted.indexOf('analytics') > -1 ? 'yes' : 'no',
      functional: accepted.indexOf('functional') > -1 ? 'yes' : 'no'
    });
  });
})();
