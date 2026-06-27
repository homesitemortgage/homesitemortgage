# Social drafts — Homesite Mortgage (Facebook)

The social-drafting engine (`.social-engine/run.py`) drafts Facebook posts on a schedule and opens a **draft PR** with a dated file in this folder.

**How it works:**
1. **Mondays & Thursdays**, the engine drafts 3 posts (rotating angles: tips, broker-vs-bank, loan spotlights, real review highlights, area spotlights, family-owned). Each is compliance-scanned and labeled ✅ clean or ⚠️ review.
2. A **human reviews** each post, fixes anything flagged, and approves.
3. Post the approved ones to Facebook **manually** (or schedule in Meta Business Suite).
4. The dated file stays here as the **archive copy** — this satisfies Florida's 2-year mortgage-ad recordkeeping rule (Fla. Stat. 494.00165). Don't delete old drafts.

**Nothing auto-posts. Nothing auto-merges. A person approves everything** — because a Facebook post promoting a mortgage is an "advertisement" under Florida and federal law (see `.social-engine/COMPLIANCE-NOTES.md`).

To run a batch on demand: GitHub → Actions → "Social Drafting Engine" → Run workflow.
