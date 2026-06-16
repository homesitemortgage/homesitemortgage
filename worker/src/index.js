/**
 * Homesite Mortgage — Unified Form Handler (P1.6.2)
 *
 * Replaces the previous direct Web3Forms POST. Both contact.html and
 * prequal.html POST to this Worker. On each POST it:
 *
 *   1. Validates: POST-only, Origin/Referer same-origin, honeypot empty,
 *      required fields present, reCAPTCHA v3 score >= 0.5 (if configured).
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
 *   - reCAPTCHA missing/low-score: return 400 with the same phone-fallback
 *     message so the user has a path forward. Skipped entirely when the
 *     RECAPTCHA_SECRET binding is not set (graceful pre-rollout).
 *
 * Secrets (set via `wrangler secret put`):
 *   - RESEND_API_KEY (required)
 *   - HUBSPOT_TOKEN  (required for CRM upsert; lead still emailed if missing)
 *   - RECAPTCHA_SECRET (optional; reCAPTCHA check is skipped when unset)
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
    if (request.method === 'OPTIONS') {
      // Light CORS allowance for future fetch()-based clients. Plain
      // <form> POSTs don't need this; included so curl/diagnostic tools
      // and any future AJAX usage work without surprise.
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
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
      if (k === 'g-recaptcha-response') continue; // verification token, not lead data
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

    // ----- reCAPTCHA v3 verification (skipped if RECAPTCHA_SECRET is unset) -----
    // Graceful degradation per task brief: if the Wrangler secret hasn't been
    // configured yet, log a warning and let the submission through. Once the
    // secret is set, missing token -> 400, score < 0.5 -> 400.
    if (env.RECAPTCHA_SECRET) {
      const recaptchaToken = String(form.get('g-recaptcha-response') || '').trim();
      if (!recaptchaToken) {
        return new Response(
          `We couldn't verify your submission. Please reload the page and try again — or call us at ${PHONE_FALLBACK}.`,
          { status: 400, headers: { 'Content-Type': 'text/plain' } }
        );
      }
      try {
        const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            secret: env.RECAPTCHA_SECRET,
            response: recaptchaToken,
          }),
        });
        const verifyData = await verifyRes.json();
        const score = typeof verifyData.score === 'number' ? verifyData.score : null;
        if (!verifyData.success || (score !== null && score < 0.5)) {
          console.error('reCAPTCHA rejected:', {
            success: verifyData.success,
            score: score,
            errorCodes: verifyData['error-codes'],
            action: verifyData.action,
          });
          return new Response(
            `We couldn't verify your submission. Please reload the page and try again — or call us at ${PHONE_FALLBACK}.`,
            { status: 400, headers: { 'Content-Type': 'text/plain' } }
          );
        }
      } catch (err) {
        // Network / parse error talking to Google. Conservative choice: log
        // and continue, so a Google API outage doesn't block legitimate
        // leads. Bot pressure from this exact failure mode is low because
        // the secret is still required to spoof a token in the first place.
        console.error('reCAPTCHA verify exception (continuing):', err && err.message);
      }
    } else {
      console.warn('RECAPTCHA_SECRET not set; skipping reCAPTCHA check.');
    }

    const formSource =
      fields.lead_source_page ||
      (referer.includes('/prequal') ? 'prequal' : 'contact');
    const tcpaRaw = String(fields.tcpa_consent || '').toLowerCase();
    const tcpaStatus =
      tcpaRaw === 'on' || tcpaRaw === 'yes' || tcpaRaw === '1' || tcpaRaw === 'true'
        ? 'YES'
        : 'NO';

    // ----- Email via Resend (primary path) -----
    const subject = `New ${formSource === 'prequal' ? 'Prequalification' : 'Contact'} Lead — ${name}`;
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
          html: buildEmailHtml(fields, formSource, tcpaStatus),
          text: buildEmailText(fields, formSource, tcpaStatus),
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
    ctx.waitUntil(sendLeadSMS(env, { name, phone, formSource }));

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

function buildEmailText(fields, source, tcpa) {
  const lines = [];
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

function buildEmailHtml(fields, source, tcpa) {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  const rows = [];
  rows.push(`<tr><td><strong>Source</strong></td><td>${esc(source)}</td></tr>`);
  rows.push(`<tr><td><strong>TCPA consent</strong></td><td>${esc(tcpa)}</td></tr>`);
  const utmRows = utmEntries(fields);
  if (utmRows.length) {
    for (const [k, v] of utmRows) {
      rows.push(`<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`);
    }
  } else {
    rows.push(`<tr><td><strong>Attribution</strong></td><td>(none)</td></tr>`);
  }
  for (const [k, v] of Object.entries(fields)) {
    if (SUMMARY_SKIP_KEYS.has(k)) continue;
    if (!v) continue;
    rows.push(`<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`);
  }
  return (
    '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#222;">' +
    `<h2 style="color:#0a1f3c;margin:0 0 16px;">New ${esc(source === 'prequal' ? 'Prequalification' : 'Contact')} Lead</h2>` +
    '<table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px;">' +
    rows.join('') +
    '</table>' +
    '</body></html>'
  );
}

function utmEntries(fields) {
  return [
    ['utm_source', fields.utm_source],
    ['utm_medium', fields.utm_medium],
    ['utm_campaign', fields.utm_campaign],
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

// ---------- SMS lead alert (Twilio) ----------
// Texts Tom the instant a lead arrives, because email gets missed. Sends only
// name + phone + source (no income/credit/NPI in the SMS). Best-effort and
// fully inert unless TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, and
// TOM_SMS_TO are all configured. Never throws.
async function sendLeadSMS(env, { name, phone, formSource }) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  const to = env.TOM_SMS_TO;
  if (!sid || !token || !from || !to) return; // not configured yet
  try {
    const body =
      `New Homesite ${formSource === 'prequal' ? 'prequal' : 'contact'} lead: ` +
      `${name}${phone ? ' · ' + phone : ''}. Check email/HubSpot to follow up fast.`;
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
