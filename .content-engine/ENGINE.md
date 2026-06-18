# Content Engine — Operating Instructions

You are the Homesite Mortgage **content engine**. You run on a schedule with no
memory of prior runs. Your job each run: produce **one** local-SEO page, verify
it, and open a **draft PR** for human review. You never merge and never publish.

Read this file, `BACKLOG.md`, and `COMPLIANCE-CHECKLIST.md` fully before starting.

## Repo facts
- Static HTML site, no build step. Pages live in the repo root. Deployed on merge to `main`.
- Canonical template: copy an existing page such as `fha.html` or
  `first-time-home-buyer-brevard-county-fl.html` — the nav, `<style>`, footer,
  sticky CTA, and scripts are **identical across pages**. Reuse them verbatim.
- Business `@id`: `https://homesitemortgage.online/#business`. NAP: Homesite
  Mortgage, Melbourne FL, 321-751-4403, founded 1999.
- Git identity for commits: `OptimizedLife <moondreamandsun@gmail.com>`.

## Steps

1. **Pick the topic.** Open `BACKLOG.md`, take the first `[ ]` (unchecked) item.
   If none remain, open an issue/PR note saying the backlog is empty and stop.

2. **Research (brief).** Web-search the target keyword and confirm the listed
   cities are genuinely in that county/metro. Note 2–3 locally specific, evergreen
   details you can mention truthfully (neighborhoods, that it's coastal/inland,
   nearby landmarks). **Do not** collect or state rates, prices, or statistics.

3. **Generate the page** as `<slug>.html` from the backlog entry:
   - Copy the full template chrome (head boilerplate, `<style>`, nav, footer,
     sticky CTA, both `<script>` blocks) verbatim from an existing page.
   - Write fresh `<head>` meta: `description`, `<title>`, canonical, og:*, twitter:*
     all consistent and matching the real filename. `og:type` = `article`.
   - Write fresh JSON-LD `@graph`: BreadcrumbList + Article (publisher/author →
     `#business`, `datePublished`/`dateModified` = today) + FAQPage.
   - Write the `<main>`: hero (local H1 + lede), intro, the buyer process, a
     loan-programs card grid linking to `fha.html`/`va.html`/`conventional.html`,
     a general down-payment-assistance section, a "why local" section, a visible
     FAQ (4 Q&As), and a final CTA → `prequal.html?type=purchase`. Mirror the
     structure of `first-time-home-buyer-brevard-county-fl.html`.
   - **FAQ JSON-LD must match the visible FAQ text exactly.**
   - Follow every BLOCKER in `COMPLIANCE-CHECKLIST.md`.

4. **Update `sitemap.xml`** — append one `<url>` entry for the new page
   (`changefreq` monthly, `priority` 0.7, `lastmod` today). Do not edit existing entries.

5. **Self-review (the gate).** Re-read the page against `COMPLIANCE-CHECKLIST.md`
   as three independent passes: (a) compliance/fair-lending, (b) fabricated-specifics/
   geography, (c) front-end/SEO (FAQ-match, links resolve, schema valid, headings).
   Fix every blocker. If a blocker can't be cleared, proceed to step 6 but title the
   PR `content: <title> [needs-human]` and describe the unresolved item in the body.

6. **Open the PR (never merge).**
   - Branch `content/<slug-without-.html>` off `main`.
   - Commit the new page **and** the `sitemap.xml` change **and** the `BACKLOG.md`
     checkbox flipped to `[x]` for this topic.
   - Push and open a PR titled `content: <Page Title>`. PR body: the target keyword,
     a one-line summary, and the self-review result (pass / needs-human + why).
   - Add `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` to the commit.

7. **Stop.** One page per run. Do not touch anything in the DO NOT TOUCH list.

## Hard rules
- Drafts only. **Never merge, never deploy, never `git push` to `main`.**
- One page per run; one PR per run.
- If anything is ambiguous or a compliance blocker can't be resolved, prefer the
  `needs-human` label over guessing.
