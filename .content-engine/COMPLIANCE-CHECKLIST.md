# Content Engine — Compliance Checklist

Homesite Mortgage is a Florida-licensed, NMLS-regulated mortgage brokerage.
**Every generated page must pass every BLOCKER check before a PR is opened.**
If any blocker cannot be cleared, do not open a normal PR — open it labeled
`needs-human` with the unresolved item described in the PR body.

This checklist mirrors `CLAUDE.md` and the 3-lens review that vetted the first page.

## BLOCKERS — never ship without these

### Never invent specifics
- [ ] **No rates, APRs, fees, points, monthly payments, loan terms, or down-payment amounts/percentages.** None — a stated payment, term, or down-payment figure is a Reg Z §1026.24(d) "triggering term" that legally forces a full APR + repayment disclosure block these pages do not carry. Not even "as low as" examples.
- [ ] **No invented program names, dollar amounts, deadlines, or statistics.** The only assistance program that may be named is the real **Florida Housing Finance Corporation**; keep all assistance talk general ("programs may be available; we'll check what's current").
- [ ] **No customer testimonials, reviews, names, or invented social proof.**

### No promises / outcomes
- [ ] **Never guarantee approval, qualification, or any outcome.** Use "may," "often," "depends on your situation," "we'll review."
- [ ] **Do NOT state specific down-payment figures** — not "3.5% down," not "$0 down," not "no down payment required." A stated down-payment amount or percentage is a Reg Z §1026.24(d) **triggering term** (it forces a full APR/repayment disclosure block these pages don't carry), and hedging it ("program minimum") does **not** cure that. Describe programs **generally** instead: "low-down-payment options," "designed for buyers without a large down payment saved," "VA financing offers favorable terms for eligible veterans." Let the loan officer cover specific numbers.
- [ ] **No quantified service promises** (e.g., "within 1 business hour"). Use "promptly" / "the same business day." (Existing pages use the 1-hour line; do not copy it into new pages.)

### Required compliance furniture (copy verbatim from an existing page's footer)
- [ ] Brokerage **NMLS #353790** + Tom Culpepper **#353539**, Tracy Cody **#886861**, Brandon Culpepper **#1577726**.
- [ ] **Equal Housing Opportunity** logo (the inline SVG) and text.
- [ ] Disclaimers: "This is not a commitment to lend," "All loans subject to credit approval," "originates loans in Florida only."
- [ ] **Years-in-business uses the `.years-in-business` span auto-calc pattern** (JS computes `currentYear - 1999`). Never hardcode the number in prose outside that span.

### Geography & facts
- [ ] Every city named is **verified** to be in the stated county / metro (use web search to confirm before writing).
- [ ] The "first-time buyer = no primary residence in the past 3 years" definition is framed as "many programs define…," never as universal law.

### Technical / SEO correctness
- [ ] **FAQPage JSON-LD text matches the visible FAQ text character-for-character** (Google policy — mismatched markup loses rich results).
- [ ] Valid JSON-LD `@graph`: BreadcrumbList + Article + FAQPage. Author/publisher reference `@id` `https://homesitemortgage.online/#business`.
- [ ] `canonical`, `og:url`, `og:title`, `twitter:title`, and `<title>` are self-consistent and match the real filename.
- [ ] Exactly one `<h1>`; section headings are `<h2>`; card headings `<h3>`. No skipped levels.
- [ ] Every internal link points to a file that exists. Link to the relevant loan pages and to `prequal.html?type=purchase`.
- [ ] Accessibility: skip link, `role`/`aria-label` on nav, `aria-controls`/`aria-expanded` on toggle, alt text on images, `role="img"` + label on the EHO SVG.

## DO NOT TOUCH (out of scope for the engine — never modify these)
- `prequal.html`, the contact form, `worker/`, `js/`, reCAPTCHA, FormSubmit/backend wiring.
- Any tracking/consent code (CookieYes, GA4, HubSpot) or the Facebook Pixel work.
- Existing pages' compliance language, NMLS/EHO blocks, or disclaimers.
- `sitemap.xml` — **append** the new page's `<url>` entry only; never edit existing entries.
