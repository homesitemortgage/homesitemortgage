/**
 * Homesite Mortgage — Unified Form Handler (P1.6.2)
 *
 * Replaces the previous direct Web3Forms POST. Both contact.html and
 * prequal.html POST to this Worker. On each POST it:
 *
 *   1. Validates: POST-only, Origin/Referer same-origin, honeypot empty,
 *      required fields present, Turnstile token verified (if configured).
 *   2. Sends an email to Tom (BCC Brandon) via Resend with the full
 *      submission body — including TCPA consent status and UTM/ref
 *      attribution.
 *   3. Upserts a HubSpot contact (dedupe by email) with standard
 *      properties (email, firstname, lastname, phone) and a `message`
 *      property containing the full submission summary.
 *   4. Redirects the browser to /thank-you.html (303) on success.
 *
 * Failure semantics:
 *   - HubSpot fail: logged, swallowed. Email still sends, user still
 *     redirected. We never lose a lead because of CRM trouble.
 *   - Resend fail: return 502 with a plain-text user-facing message that
 *     includes the 321-751-4403 phone fallback. The lead is surfaced to
 *     the user immediately rather than silently disappearing.
 *   - Turnstile token missing/invalid: return 400 with the same phone-fallback
 *     message so the user has a path forward. Skipped entirely when the
 *     TURNSTILE_SECRET binding is not set (graceful pre-rollout).
 *
 * Secrets (set via `wrangler secret put`):
 *   - RESEND_API_KEY (required)
 *   - HUBSPOT_TOKEN  (required for CRM upsert; lead still emailed if missing)
 *   - TURNSTILE_SECRET (optional; Turnstile check is skipped when unset)
 *
 * Privacy / compliance:
 *   - No persistent storage. No KV. No D1. No R2.
 *   - NPI fields (income, credit, debt, employment) flow through to email
 *     + HubSpot only. They are never written to disk on the Worker.
 *   - Same-origin enforcement keeps the endpoint unusable from third-party
 *     pages without explicit re-allowlisting here.
 *
 * Field-name conventions (preserved from the existing forms):
 *   - contact.html: lowercase (name, email, phone, message)
 *   - prequal.html: Title Case ("Full Name", "Email Address",
 *     "Phone Number", "Loan Type", "Loan Program", etc.)
 *   Both shapes are read by pickEmail / pickName / pickPhone below.
 */

const ALLOWED_ORIGINS = [
  'https://homesitemortgage.online',
  'https://www.homesitemortgage.online',
];

const TOM_EMAIL = 'tcloans1@gmail.com';
const BRANDON_EMAIL = 'brandonjculpepper@gmail.com';
const FROM_EMAIL = 'Homesite Mortgage <leads@homesitemortgage.online>';
const THANK_YOU_URL = 'https://homesitemortgage.online/thank-you.html';
const PHONE_FALLBACK = '321-751-4403';

export default {
  async fetch(request, env, ctx) {
    const reqOrigin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Geo endpoint — lets the static site enforce the Florida-only Pixel rule.
    // Returns the visitor's Cloudflare edge region; the page fails closed.
    if (request.method === 'GET') {
      const url = new URL(request.url);
      if (url.pathname === '/geo') {
        const cf = request.cf || {};
        return new Response(
          JSON.stringify({
            country: cf.country || null,
            regionCode: cf.regionCode || null,
            region: cf.region || null,
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': corsOrigin,
              'Cache-Control': 'no-store',
            },
          }
        );
      }
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // ----- Origin / Referer gate -----
    const origin = request.headers.get('Origin') || '';
    const referer = request.headers.get('Referer') || '';
    const sameOrigin = (val) =>
      val && ALLOWED_ORIGINS.some((o) => val === o || val.startsWith(o + '/'));
    if (!sameOrigin(origin) && !sameOrigin(referer)) {
      return new Response('Forbidden', { status: 403 });
    }

    // ----- Parse body -----
    let form;
    try {
      const ct = request.headers.get('Content-Type') || '';
      if (
        ct.includes('application/x-www-form-urlencoded') ||
        ct.includes('multipart/form-data')
      ) {
        form = await request.formData();
      } else if (ct.includes('application/json')) {
        const json = await request.json();
        form = new FormData();
        for (const [k, v] of Object.entries(json)) form.append(k, v);
      } else {
        return new Response('Unsupported Content-Type', { status: 415 });
      }
    } catch (err) {
      return new Response('Malformed body', { status: 400 });
    }

    // ----- Honeypot — silently accept and redirect bots -----
    const honeypot = String(form.get('website') || '').trim();
    if (honeypot) {
      return Response.redirect(THANK_YOU_URL, 303);
    }

    // ----- Extract fields (drop Web3Forms legacy + honeypot) -----
    const fields = {};
    for (const [k, v] of form.entries()) {
      if (k === 'access_key' || k === 'subject' || k === 'redirect') continue;
      if (k.startsWith('_')) continue; // _next, _cc, _captcha, etc.
      if (k === 'website') continue; // honeypot
      if (k === 'g-recaptcha-response') continue; // legacy verification token, not lead data
      if (k === 'cf-turnstile-response') continue; // Turnstile token, not lead data
      fields[k] = String(v || '');
    }

    const email = pickEmail(fields);
    const name = pickName(fields);
    const phone = pickPhone(fields);

    if (!email || !name) {
      return new Response('Missing required fields (name and email).', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // ----- Turnstile verification (skipped if TURNSTILE_SECRET is unset) -----
    // Graceful degradation: if the Wrangler secret hasn't been configured
    // yet, log a warning and let the submission through. Once the secret is
    // set, missing token -> 400, failed verification -> 400.
    if (env.TURNSTILE_SECRET) {
      const turnstileToken = String(form.get('cf-turnstile-response') || '').trim();
      if (!turnstileToken) {
        return new Response(
          `We couldn't verify your submission. Please reload the page and try again — or call us at ${PHONE_FALLBACK}.`,
          { status: 400, headers: { 'Content-Type': 'text/plain' } }
        );
      }
      try {
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET,
            response: turnstileToken,
            remoteip: request.headers.get('CF-Connecting-IP') || '',
          }),
        });
        const verifyData = await verifyRes.json();
        if (!verifyData.success) {
          console.error('Turnstile rejected:', {
            errorCodes: verifyData['error-codes'],
            action: verifyData.action,
            hostname: verifyData.hostname,
          });
          return new Response(
            `We couldn't verify your submission. Please reload the page and try again — or call us at ${PHONE_FALLBACK}.`,
            { status: 400, headers: { 'Content-Type': 'text/plain' } }
          );
        }
      } catch (err) {
        // Network / parse error talking to siteverify. Conservative choice:
        // log and continue, so a transient outage doesn't block legitimate
        // leads. Bot pressure from this exact failure mode is low because
        // the secret is still required to spoof a token in the first place.
        console.error('Turnstile verify exception (continuing):', err && err.message);
      }
    } else {
      console.warn('TURNSTILE_SECRET not set; skipping Turnstile check.');
    }

    const formSource =
      fields.lead_source_page ||
      (referer.includes('/prequal') ? 'prequal' : 'contact');
    const tcpaRaw = String(fields.tcpa_consent || '').toLowerCase();
    const tcpaStatus =
      tcpaRaw === 'on' || tcpaRaw === 'yes' || tcpaRaw === '1' || tcpaRaw === 'true'
        ? 'YES'
        : 'NO';

    // ----- Lead scoring (HOT / WARM / NURTURE) -----
    const lead_score = scoreLead(fields, tcpaStatus);

    // ----- Email via Resend (primary path) -----
    const subject = `[${lead_score.band}] New ${formSource === 'prequal' ? 'Prequalification' : 'Contact'} Lead — ${name}`;
    let resendOk = false;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [TOM_EMAIL],
          bcc: [BRANDON_EMAIL],
          reply_to: email,
          subject,
          html: buildEmailHtml(fields, formSource, tcpaStatus, { name, email, phone, band: lead_score.band, score: lead_score.score }),
          text: buildEmailText(fields, formSource, tcpaStatus, { name, email, phone, band: lead_score.band, score: lead_score.score }),
        }),
      });
      resendOk = r.ok;
      if (!r.ok) {
        const errBody = await r.text();
        console.error('Resend failed:', r.status, errBody);
      }
    } catch (err) {
      console.error('Resend exception:', err && err.message);
    }

    // ----- SMS alert to Tom (best-effort; email alone gets missed) -----
    // Fire-and-forget so it never delays the redirect. Inert until the
    // TWILIO_* + TOM_SMS_TO vars are set.
    ctx.waitUntil(sendLeadSMS(env, { name, phone, formSource, band: lead_score.band }));

    // ----- HubSpot upsert (best-effort, never blocks user response) -----
    try {
      await upsertHubspot(env.HUBSPOT_TOKEN, {
        email,
        name,
        phone,
        fields,
        formSource,
        tcpaStatus,
      });
    } catch (err) {
      console.error('HubSpot exception (swallowed):', err && err.message);
    }

    // ----- Response semantics -----
    if (!resendOk) {
      // Surface the failure to the user with a phone fallback so the lead
      // is never silently lost.
      return new Response(
        `We could not deliver your message right now. Please call us directly at ${PHONE_FALLBACK} — Tom will pick up.`,
        { status: 502, headers: { 'Content-Type': 'text/plain' } }
      );
    }

    return Response.redirect(THANK_YOU_URL, 303);
  },
};

// ---------- Field helpers ----------
function pickEmail(f) {
  return (f['Email Address'] || f.email || f.Email || '').trim();
}
function pickName(f) {
  return (f['Full Name'] || f.name || f.Name || '').trim();
}
function pickPhone(f) {
  return (f['Phone Number'] || f.phone || f.Phone || '').trim();
}

// ---------- Email body builders ----------
const SUMMARY_SKIP_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'ref',
  'lead_source_page',
  'tcpa_consent',
]);

function scoreLead(fields, tcpaStatus) {
  const state = String(fields['Property State'] || '').trim();
  // Florida-only: out-of-state leads are referrals, not hot prospects.
  if (state && state !== 'Florida') return { band: 'REFERRAL', score: 0 };
  const TIMELINE = { 'ASAP': 40, '1–3 Months': 30, '3–6 Months': 15, 'Just Exploring': 0 };
  const CREDIT = { 'Excellent (740+)': 20, 'Good (700–739)': 15, 'Fair (660–699)': 8, 'Needs Work (below 660)': 0 };
  const AMOUNT = { 'Under $150K': 5, '$150K – $300K': 8, '$300K – $500K': 12, '$500K+': 15 };
  const INTENT = { 'Buy a Home': 10, 'Refinance': 8, 'Investment Property': 8 };
  let s = 0;
  s += TIMELINE[fields['Timeline']] || 0;
  s += CREDIT[fields['Estimated Credit Score']] || 0;
  s += AMOUNT[fields['Target Loan Amount']] || 0;
  s += INTENT[fields['Intent']] || 0;
  if (state === 'Florida') s += 10;
  if (tcpaStatus === 'YES') s += 5;
  if (String(fields['Property of Interest'] || '').trim()) s += 10; // named property = active buyer
  const band = s >= 70 ? 'HOT' : s >= 40 ? 'WARM' : 'NURTURE';
  return { band, score: s };
}

function buildEmailText(fields, source, tcpa, lead) {
  const lines = [];
  const name = (lead && lead.name) || '';
  const email = (lead && lead.email) || '';
  const phone = (lead && lead.phone) || '';
  lines.push(`NEW ${source === 'prequal' ? 'PREQUALIFICATION' : 'CONTACT'} LEAD`);
  if (lead && lead.band) lines.push(`Priority: ${lead.band}${lead.score != null ? ' (score ' + lead.score + ')' : ''}`);
  lines.push('');
  if (name) lines.push(`Name:  ${name}`);
  if (phone) lines.push(`Phone: ${phone}`);
  if (email) lines.push(`Email: ${email}`);
  lines.push('');
  lines.push(`Submission source: ${source}`);
  lines.push(`TCPA consent: ${tcpa}`);
  const utmRows = utmEntries(fields);
  lines.push('');
  if (utmRows.length) {
    lines.push('Attribution:');
    for (const [k, v] of utmRows) lines.push(`  ${k}: ${v}`);
  } else {
    lines.push('Attribution: (none)');
  }
  lines.push('');
  lines.push('--- Fields ---');
  for (const [k, v] of Object.entries(fields)) {
    if (SUMMARY_SKIP_KEYS.has(k)) continue;
    if (!v) continue;
    lines.push(`${k}: ${v}`);
  }
  return lines.join('\n');
}

function buildEmailHtml(fields, source, tcpa, lead) {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  const name = (lead && lead.name) || '';
  const email = (lead && lead.email) || '';
  const phone = (lead && lead.phone) || '';
  const telDigits = phone.replace(/[^\d]/g, '');
  const firstName = (name.split(/\s+/)[0] || 'them');
  const label = source === 'prequal' ? 'Prequalification' : 'Contact';
  const band = (lead && lead.band) || 'NURTURE';
  const BAND_STYLE = {
    HOT: { bg: '#0a7d2c', text: '&#128293; HOT LEAD &mdash; call ASAP' },
    WARM: { bg: '#c5a059', text: '&#9728;&#65039; WARM LEAD' },
    NURTURE: { bg: '#6b7280', text: 'NURTURE &mdash; follow up' },
    REFERRAL: { bg: '#1f5e8c', text: '&#8618; OUT-OF-STATE &mdash; referral' },
  };
  const bs = BAND_STYLE[band] || BAND_STYLE.NURTURE;
  const bandBar = `<div style="background:${bs.bg};color:#ffffff;font-weight:bold;font-size:15px;letter-spacing:0.5px;padding:11px 16px;border-radius:6px;margin-bottom:16px;text-align:center;">${bs.text}</div>`;

  // Keys already surfaced at the top — don't repeat them in the detail table.
  const TOP_KEYS = new Set([
    'Full Name', 'name', 'Name', 'Email Address', 'email', 'Email',
    'Phone Number', 'phone', 'Phone',
  ]);
  // Fields worth surfacing high (when present).
  const PRIORITY_KEYS = [
    'Property of Interest', 'Intent', 'Property State', 'property_state',
    'Target Loan Amount', 'Estimated Credit Score', 'Timeline', 'timeline',
    'Property Type', 'Loan Purpose', 'loan_purpose', 'Loan Type', 'loan_type',
  ];
  const priority = [];
  for (const k of PRIORITY_KEYS) {
    if (fields[k]) priority.push([k, fields[k]]);
  }
  // Don't repeat the top fields in the detail table below.
  const shownKeys = new Set(priority.map(([k]) => k));

  const rows = [];
  rows.push(`<tr><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;"><strong>Source</strong></td><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;">${esc(source)}</td></tr>`);
  rows.push(`<tr><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;"><strong>TCPA consent</strong></td><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;">${esc(tcpa)}</td></tr>`);
  const utmRows = utmEntries(fields);
  for (const [k, v] of utmRows) {
    rows.push(`<tr><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;"><strong>${esc(k)}</strong></td><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;">${esc(v)}</td></tr>`);
  }
  for (const [k, v] of Object.entries(fields)) {
    if (SUMMARY_SKIP_KEYS.has(k) || TOP_KEYS.has(k) || shownKeys.has(k)) continue;
    if (!v) continue;
    rows.push(`<tr><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;"><strong>${esc(k)}</strong></td><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;">${esc(v)}</td></tr>`);
  }

  const callBtn = telDigits
    ? `<a href="tel:${telDigits}" style="display:inline-block;background:#0a7d2c;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:13px 22px;border-radius:6px;margin:0 10px 10px 0;">&#128222; Call ${esc(firstName)}</a>`
    : '';
  const emailBtn = email
    ? `<a href="mailto:${esc(email)}" style="display:inline-block;background:#0a1f3c;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:13px 22px;border-radius:6px;margin:0 10px 10px 0;">&#9993; Email</a>`
    : '';
  const priorityHtml = priority.length
    ? '<div style="font-size:12px;color:#8a6d2f;text-transform:uppercase;letter-spacing:1px;font-weight:bold;margin:8px 0 8px;">What they&#39;re looking for</div>' +
      '<table cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px;font-size:15px;">' +
      priority
        .map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#555555;">${esc(k)}</td><td style="padding:3px 0;font-weight:bold;color:#1f2937;">${esc(v)}</td></tr>`)
        .join('') +
      '</table>'
    : '';

  return (
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">' +
    '<div style="max-width:560px;margin:0 auto;padding:24px;">' +
    bandBar +
    `<div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#8a6d2f;font-weight:bold;margin-bottom:6px;">New ${esc(label)} Lead</div>` +
    `<h1 style="margin:0 0 6px;font-size:26px;color:#0a1f3c;">${esc(name || '(no name provided)')}</h1>` +
    (phone ? `<div style="font-size:17px;color:#374151;margin-bottom:2px;">${esc(phone)}</div>` : '') +
    (email ? `<div style="font-size:15px;color:#374151;margin-bottom:18px;">${esc(email)}</div>` : '<div style="margin-bottom:18px;"></div>') +
    `<div style="margin:6px 0 22px;">${callBtn}${emailBtn}</div>` +
    priorityHtml +
    '<div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin:8px 0 6px;">Submission details</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:6px;">' +
    rows.join('') +
    '</table>' +
    '<div style="font-size:12px;color:#9ca3af;margin-top:18px;">Homesite Mortgage lead alert &middot; just hit Reply to email this lead back directly.</div>' +
    '</div></body></html>'
  );
}

// Attribution shown at the top of every lead email.
//
// gclid / gbraid / wbraid matter more than they look: js/google-ads.js only fires
// when the visitor accepts CookieYes "advertisement" consent, so a lead who declines
// cookies converts INVISIBLY in Google Ads. On a ~40-click test that can read as
// "the ads produced nothing" when they actually produced leads. These IDs always
// reach us on the form POST regardless of consent, so the lead email is the
// source of truth: paste a gclid into Google Ads to find the exact click/keyword
// that produced the lead, and reconcile against reported conversions.
//
// gbraid/wbraid replace gclid on iOS and wherever tracking protection suppresses it.
function utmEntries(fields) {
  return [
    ['gclid', fields.gclid],
    ['gbraid', fields.gbraid],
    ['wbraid', fields.wbraid],
    ['utm_source', fields.utm_source],
    ['utm_medium', fields.utm_medium],
    ['utm_campaign', fields.utm_campaign],
    ['utm_term', fields.utm_term],
    ['utm_content', fields.utm_content],
    ['ref', fields.ref],
  ].filter(([, v]) => v);
}

// ---------- HubSpot upsert ----------
async function upsertHubspot(token, { email, name, phone, fields, formSource, tcpaStatus }) {
  if (!token) {
    console.error('HubSpot skipped: no token');
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Best-effort first/last split.
  const parts = name.trim().split(/\s+/);
  const firstname = parts[0] || '';
  const lastname = parts.length > 1 ? parts.slice(1).join(' ') : '';

  // Pack everything not mapped to standard HubSpot properties into
  // the standard `message` field so all submission data is searchable
  // in HubSpot without requiring custom properties to exist in the portal.
  const skip = new Set([
    'Full Name',
    'name',
    'Name',
    'Email Address',
    'email',
    'Email',
    'Phone Number',
    'phone',
    'Phone',
    'tcpa_consent',
    'lead_source_page',
  ]);
  const summary = [];
  summary.push(`Source: ${formSource}`);
  summary.push(`TCPA: ${tcpaStatus}`);
  const utmRows = utmEntries(fields);
  if (utmRows.length) {
    summary.push('--- Attribution ---');
    for (const [k, v] of utmRows) summary.push(`${k}: ${v}`);
  }
  summary.push('--- Submission ---');
  for (const [k, v] of Object.entries(fields)) {
    if (skip.has(k)) continue;
    if (['utm_source', 'utm_medium', 'utm_campaign', 'ref'].includes(k)) continue;
    if (!v) continue;
    summary.push(`${k}: ${v}`);
  }

  const properties = {
    email,
    firstname,
    lastname,
    phone,
    message: summary.join('\n').slice(0, 65000),
  };

  // Structured TCPA consent so HubSpot can segment marketable (consented)
  // contacts from inquiry-only ones. Best-effort: if the property can't be
  // ensured (e.g. the token lacks schema scope) we omit it rather than risk
  // the whole upsert — consent is still captured in `message` regardless.
  if (await ensureConsentProperty(headers)) {
    properties.tcpa_consent = tcpaStatus === 'YES' ? 'true' : 'false';
  }

  // Search by email (dedupe).
  const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email'],
      limit: 1,
    }),
  });
  if (!searchRes.ok) {
    console.error('HubSpot search failed:', searchRes.status, await searchRes.text());
    return;
  }
  const search = await searchRes.json();
  if (search.results && search.results.length > 0) {
    const id = search.results[0].id;
    const patchRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ properties }),
    });
    if (!patchRes.ok) {
      console.error('HubSpot update failed:', patchRes.status, await patchRes.text());
    }
  } else {
    const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ properties }),
    });
    if (!createRes.ok) {
      console.error('HubSpot create failed:', createRes.status, await createRes.text());
    }
  }
}

// Idempotently ensure the custom `tcpa_consent` contact property exists so
// consented leads can be segmented for compliant marketing (e.g. a HubSpot
// active list of "TCPA Consent is Yes"). Returns true when the property is
// present (created or already there), false if it can't be ensured — e.g. the
// token lacks `crm.schemas.contacts.write`. Never throws; cached per isolate.
let consentPropReady = false;
async function ensureConsentProperty(headers) {
  if (consentPropReady) return true;
  try {
    const res = await fetch('https://api.hubapi.com/crm/v3/properties/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'tcpa_consent',
        label: 'TCPA Consent',
        type: 'enumeration',
        fieldType: 'radio',
        groupName: 'contactinformation',
        description: 'Express written consent to automated calls/texts (TCPA).',
        options: [
          { label: 'Yes - consented to calls/texts', value: 'true', displayOrder: 0 },
          { label: 'No - inquiry only', value: 'false', displayOrder: 1 },
        ],
      }),
    });
    if (res.ok || res.status === 409) {
      consentPropReady = true; // created, or already exists
      return true;
    }
    console.error('ensureConsentProperty failed:', res.status, await res.text());
    return false;
  } catch (err) {
    console.error('ensureConsentProperty exception:', err && err.message);
    return false;
  }
}

// ---------- SMS lead alert (Twilio — inert / disabled) ----------
// The team relies on the INSTANT Gmail notification on Tom's phone for new
// leads. The free carrier email-to-SMS path was removed because T-Mobile's
// gateway delayed texts 10-15 min — too slow to be useful. This stays fully
// inert (no text is sent) unless TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_FROM, and TOM_SMS_TO are all configured for a reliable paid text later.
// Sends only name + phone + band (never income/credit/NPI). Never throws.
async function sendLeadSMS(env, { name, phone, formSource, band }) {
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN,
        from = env.TWILIO_FROM, to = env.TOM_SMS_TO;
  if (!sid || !token || !from || !to) return; // not configured — no text sent
  const body =
    `New Homesite ${formSource === 'prequal' ? 'prequal' : 'contact'} lead` +
    `${band ? ' [' + band + ']' : ''}: ${name}${phone ? ' · ' + phone : ''}. ` +
    `Check email to follow up fast.`;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(`${sid}:${token}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
      }
    );
    if (!res.ok) console.error('Twilio SMS failed:', res.status, await res.text());
  } catch (err) {
    console.error('Twilio SMS exception:', err && err.message);
  }
}
