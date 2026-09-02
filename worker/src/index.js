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
// Lizzie answers the phones, so she needs the lead the moment it lands, not
// after someone forwards it. Speed to first contact is the whole game here —
// the first lead sat 1.5 hours before anyone noticed.
const LIZZIE_EMAIL = 'le.elizabeth0206@gmail.com';
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
    // Checks BOTH names: the field was renamed from `website` to `hp_field`
    // because `website` is a common browser-autofill target, and a false
    // positive here destroys a real lead while showing that person a success
    // page. The old name stays wired up so bots that learned it are still
    // caught and there is no gap across the deploy.
    //
    // This is logged deliberately. A silently discarded submission is otherwise
    // indistinguishable from a successful one, so if this ever fires on a real
    // person there has to be something to find. Field NAMES only, never values.
    const honeypot = String(form.get('hp_field') || form.get('website') || '').trim();
    if (honeypot) {
      console.error('Honeypot tripped — submission dropped:', {
        field: form.get('hp_field') ? 'hp_field' : 'website',
        formSource: String(form.get('lead_source_page') || 'unknown'),
        hasEmail: Boolean(form.get('Email Address') || form.get('email')),
        hasTurnstile: Boolean(form.get('cf-turnstile-response')),
      });
      return Response.redirect(THANK_YOU_URL, 303);
    }

    // ----- Extract fields (drop Web3Forms legacy + honeypot) -----
    const fields = {};
    for (const [k, v] of form.entries()) {
      if (k === 'access_key' || k === 'subject' || k === 'redirect') continue;
      if (k.startsWith('_')) continue; // _next, _cc, _captcha, etc.
      if (k === 'website' || k === 'hp_field') continue; // honeypot (both names)
      if (k === 'g-recaptcha-response') continue; // legacy verification token, not lead data
      if (k === 'cf-turnstile-response') continue; // Turnstile token, not lead data
      fields[k] = String(v || '');
    }

    const email = pickEmail(fields);
    const name = pickName(fields);
    const phone = pickPhone(fields);

    if (!email || !name) {
      return errorPage(
        'Your submission is missing a name or an email address, so we could not send it. ' +
        'Please go back and add them &mdash; or call and we will take everything over the phone.',
        400
      );
    }

    // ----- Turnstile verification (skipped if TURNSTILE_SECRET is unset) -----
    // Graceful degradation: if the Wrangler secret hasn't been configured
    // yet, log a warning and let the submission through. Once the secret is
    // set, missing token -> 400, failed verification -> 400.
    if (env.TURNSTILE_SECRET) {
      const turnstileToken = String(form.get('cf-turnstile-response') || '').trim();
      if (!turnstileToken) {
        return errorPage(
          'We could not finish the security check, so your information has not been sent. ' +
          'Please go back, reload the page and try once more &mdash; or call and we will take it over the phone.',
          400
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
          return errorPage(
            'We could not finish the security check, so your information has not been sent. ' +
            'Please go back, reload the page and try once more &mdash; or call and we will take it over the phone.',
            400
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
    // Source rides in the subject line so it is visible in the inbox list
    // without opening anything, and so a single Gmail filter can count a
    // month of AI-sourced leads. Cheaper and more reliable than a dashboard.
    const sourceTag = fields.heard_about_us || fields.referrer_source || '';
    const subject = `[${lead_score.band}] New ${formSource === 'prequal' ? 'Prequalification' : 'Contact'} Lead — ${name}${sourceTag ? ` · via ${sourceTag}` : ''}`;
    // One Resend call was the entire lead pipeline. Resend rate-limits at a couple
    // of requests per second, so two visitors landing together — exactly what an ad
    // burst produces — is enough for a 429, and any transient 5xx costs the same:
    // the visitor gets a 502 and Tom gets nothing. Retry once on the failures a
    // retry can actually fix. The idempotency key means a retry sent after a reply
    // we never saw cannot deliver the same lead twice.
    const resendPayload = {
      from: FROM_EMAIL,
      to: [TOM_EMAIL],
      bcc: [BRANDON_EMAIL, LIZZIE_EMAIL],
      reply_to: email,
      subject,
      html: buildEmailHtml(fields, formSource, tcpaStatus, { name, email, phone, band: lead_score.band, score: lead_score.score }),
      text: buildEmailText(fields, formSource, tcpaStatus, { name, email, phone, band: lead_score.band, score: lead_score.score }),
    };
    const idempotencyKey = crypto.randomUUID();
    let resendOk = false;
    for (let attempt = 1; attempt <= 2 && !resendOk; attempt++) {
      if (attempt > 1) await new Promise((done) => setTimeout(done, 1200));
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(resendPayload),
        });
        resendOk = r.ok;
        if (!r.ok) {
          const errBody = await r.text();
          console.error('Resend failed:', r.status, errBody, 'attempt', attempt);
          // A 4xx that is not a rate limit (bad key, rejected address) fails the
          // same way twice. Do not spend a second call or the visitor's wait on it.
          if (r.status !== 429 && r.status < 500) break;
        }
      } catch (err) {
        console.error('Resend exception:', err && err.message, 'attempt', attempt);
      }
    }

    // ----- SMS alert to Tom (best-effort; email alone gets missed) -----
    // Fire-and-forget so it never delays the redirect. Inert until the
    // TWILIO_* + TOM_SMS_TO vars are set.
    ctx.waitUntil(sendLeadSMS(env, { name, phone, formSource, band: lead_score.band }));

    // ----- HubSpot upsert (best-effort, never blocks user response) -----
    // This was awaited despite the comment, holding the 303 redirect for the
    // full round-trip to HubSpot while the visitor sat on an unchanged page.
    // The CRM write has no bearing on what they see and its failure is already
    // swallowed, so run it after the response like the SMS alert above.
    ctx.waitUntil(
      upsertHubspot(env.HUBSPOT_TOKEN, {
        email,
        name,
        phone,
        fields,
        formSource,
        tcpaStatus,
      }).catch((err) => {
        console.error('HubSpot exception (swallowed):', err && err.message);
      })
    );

    // ----- Response semantics -----
    if (!resendOk) {
      // Both send attempts failed. Calling is the only path left, so make it one tap.
      return errorPage(
        'We could not get your message to our inbox just now. ' +
        'Please call us directly so this does not sit &mdash; Tom will pick up.',
        502
      );
    }

    return Response.redirect(THANK_YOU_URL, 303);
  },
};

// ---------- Visitor-facing failure page ----------
// These responses used to be bare text/plain. Everyone who reaches one is a lead
// about to walk, so the fallback number has to be one tap away rather than digits
// to retype. Carries the NMLS IDs and the Equal Housing line like any other page.
// Copy only — never interpolate anything the visitor submitted into `message`.
function errorPage(message, status) {
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>We could not send that &mdash; Homesite Mortgage</title></head>' +
    '<body style="margin:0;padding:32px 20px;background:#f9f9fb;color:#333;line-height:1.6;font-family:Lato,Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;padding:28px;border-radius:16px;">' +
    `<p style="margin:0 0 22px;font-size:1.05rem;">${message}</p>` +
    `<a href="tel:3217514403" style="display:inline-block;background:#c5a059;color:#0a2540;text-decoration:none;font-weight:700;padding:15px 26px;border-radius:50px;">&#128222; Call ${PHONE_FALLBACK}</a>` +
    '<p style="margin:26px 0 0;font-size:0.72rem;color:#777777;">Homesite Mortgage NMLS #353790 &middot; Tom Culpepper NMLS #353539 &middot; Tracy Cody NMLS #886861 &middot; Brandon Culpepper NMLS #1577726 &middot; Equal Housing Opportunity.</p>' +
    '</div></body></html>';
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

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
// Anything rendered by utmEntries() must be listed here, or it renders twice —
// once in the attribution rows and again in the generic field loop below. That
// is why gclid appeared twice in the first real lead email.
const SUMMARY_SKIP_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'gclid',
  'gbraid',
  'wbraid',
  'adkeyword',
  'matchtype',
  'adnetwork',
  'addevice',
  'campaignid',
  'adgroupid',
  'creativeid',
  'referrer_source',
  'heard_about_us',
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
  // 'Loan Program' is the name prequal.html actually posts (hidden input, set from
  // ?type=). It was missing here while four names no form posts were listed, so the
  // one thing the visitor pre-selected landed in the bottom table instead of up top.
  const PRIORITY_KEYS = [
    'Property of Interest', 'Intent', 'Property State', 'property_state',
    'Target Loan Amount', 'Estimated Credit Score', 'Timeline', 'timeline',
    'Property Type', 'Loan Program',
    'Loan Purpose', 'loan_purpose', 'Loan Type', 'loan_type',
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
    // The contact form's `message` is a textarea. esc() leaves its newlines as-is,
    // which HTML collapses, so a message typed in paragraphs arrived as one
    // run-on line. Escape first, then turn the newlines into breaks.
    const cellHtml = esc(v).replace(/\r?\n/g, '<br>');
    rows.push(`<tr><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;"><strong>${esc(k)}</strong></td><td style="padding:5px 10px;border-bottom:1px solid #eef0f3;">${cellHtml}</td></tr>`);
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
        .map(([k, v]) => {
          // The property address is the one value Tom acts on away from his desk —
          // make it open in Maps instead of forcing a copy-paste.
          const cell = k === 'Property of Interest'
            ? `<a href="https://maps.google.com/?q=${encodeURIComponent(String(v))}" style="color:#0a1f3c;">${esc(v)}</a>`
            : esc(v);
          return `<tr><td style="padding:3px 14px 3px 0;color:#555555;">${esc(k)}</td><td style="padding:3px 0;font-weight:bold;color:#1f2937;">${cell}</td></tr>`;
        })
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
// Match types arrive as single letters; spell them out so the email is readable
// without a lookup table.
const MATCH_TYPES = { e: 'Exact', p: 'Phrase', b: 'Broad' };
const AD_NETWORKS = { g: 'Google Search', s: 'Search partner', d: 'Display', ytv: 'YouTube', vp: 'Video partner' };
const AD_DEVICES = { m: 'Mobile', t: 'Tablet', c: 'Desktop' };

function utmEntries(fields) {
  const kw = fields.adkeyword;
  const mt = fields.matchtype;
  return [
    // Where the visit came from when it was NOT a paid click. This goes at the
    // very top because the 2026-08-20 lead came from ChatGPT with no gclid, and
    // nobody knew until someone happened to read the raw utm_source. A free
    // channel that produces $500K buyers deserves a line of its own.
    // What the visitor SAID, which is the only signal that survives a stripped
    // referrer — and most assistant traffic arrives with no referrer at all.
    ['Told us they found us via', fields.heard_about_us],
    ['Detected referrer', fields.referrer_source],
    // The keyword goes FIRST among the paid fields — it is the direct answer to
    // "which keyword produced this lead", which no Google Ads report will tell
    // you from a gclid alone.
    ['Ad keyword', kw ? (mt ? `${kw}  (${MATCH_TYPES[mt] || mt} match)` : kw) : ''],
    ['Ad network', AD_NETWORKS[fields.adnetwork] || fields.adnetwork],
    ['Device', AD_DEVICES[fields.addevice] || fields.addevice],
    ['gclid', fields.gclid],
    ['gbraid', fields.gbraid],
    ['wbraid', fields.wbraid],
    ['campaignid', fields.campaignid],
    ['adgroupid', fields.adgroupid],
    ['creativeid', fields.creativeid],
    ['utm_source', fields.utm_source],
    ['utm_medium', fields.utm_medium],
    ['utm_campaign', fields.utm_campaign],
    ['utm_term', fields.utm_term],
    ['utm_content', fields.utm_content],
    ['ref', fields.ref],
  ].filter(([, v]) => v);
}

// ---------- HubSpot upsert ----------
/**
 * HubSpot echoes rejected property values back inside `message` - on
 * INVALID_EMAIL that is the borrower's own email address. Never log the body;
 * correlationId is what HubSpot support asks for and carries no borrower data.
 */
async function hsErr(res) {
  const b = await res.json().catch(() => null);
  if (!b) return '(unparseable error body withheld)';
  return { correlationId: b.correlationId, category: b.category, status: b.status };
}

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
    console.error('HubSpot search failed:', searchRes.status, await hsErr(searchRes));
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
      console.error('HubSpot update failed:', patchRes.status, await hsErr(patchRes));
    }
  } else {
    const createRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ properties }),
    });
    if (!createRes.ok) {
      console.error('HubSpot create failed:', createRes.status, await hsErr(createRes));
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
    console.error('ensureConsentProperty failed:', res.status, await hsErr(res));
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
