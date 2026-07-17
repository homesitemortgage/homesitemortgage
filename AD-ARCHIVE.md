# Advertising Archive — Florida 2-Year Recordkeeping

Florida Statute **494.00165** requires a licensed mortgage broker to keep a **sample of each advertisement for two (2) years** after it runs, available for OFR examination. The FTC MAP Rule (Reg N) imposes a parallel **24-month** recordkeeping duty. This file records how Homesite Mortgage satisfies both.

## What counts as an advertisement
Anything that promotes Homesite Mortgage to consumers: the website's marketing pages, Facebook/Instagram posts, and paid ads (Google Search, Meta).

## Already archived automatically ✅

| Advertising | How it's archived | Where |
|---|---|---|
| **Website marketing pages** | Every version of every page is committed with an author, message, and timestamp. Any past state is retrievable (`git log`, `git show <sha>:<file>`). This is a dated, tamper-evident archive. | This git repository |
| **Facebook / Instagram posts** | The social engine writes a **dated file per batch** and never deletes them. Each file holds the exact post text as drafted and approved. | `/social-drafts/YYYY-MM-DD-facebook.md` |
| **County / area guide pages** | Auto-generated pages are committed like any other page — same git history. | This git repository |

**Do not delete files in `/social-drafts`.** They are the archive copy.

## Requires a manual step ⚠️

| Advertising | What to do | When |
|---|---|---|
| **Google Search ads** | Screenshot each ad (headline + description variants as shown) **and** the landing page it points to. Save as `YYYY-MM-DD — <campaign> — <ad group>.png`. | **On launch day**, and again whenever an ad or landing page changes |
| **Meta / Instagram paid ads** | Same — screenshot the creative + landing page. | On launch and on every change |

Save to the Drive folder: **"Ad Archive — FL 2-Year Compliance"** (under the Homesite Mortgage folder).

**You cannot screenshot an ad retroactively.** If a creative is paused or edited before it's captured, the record is gone. Capture on the day it goes live.

## Retention
Keep everything **at least 2 years** from the last date the ad ran. Git history and `/social-drafts` are permanent, so only the Drive folder needs attention.

## Related compliance already enforced on every ad
- **Reg Z (12 CFR 1026.24)** — no interest rate, APR, payment amount, down-payment amount/percent, number/period of payments, or "zero down / no closing costs" without full TILA disclosures.
- **NMLS #353790** on every ad and landing page.
- **Equal Housing Opportunity** on landing pages.
- **TCPA** — the consent checkbox stays optional, never required.
- **Reviews** — only real, un-incentivized Google reviews (RESPA Section 8).
