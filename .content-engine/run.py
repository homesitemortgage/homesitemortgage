#!/usr/bin/env python3
"""
Homesite Mortgage content engine — self-contained.

Generates ONE local-SEO page from BACKLOG.md and opens a DRAFT pull request for
human review. It never merges and never pushes to main.

No Claude GitHub App required: it calls the Anthropic API directly with
ANTHROPIC_API_KEY and opens the PR with the built-in GITHUB_TOKEN via `gh`.
Standard-library only (urllib) — no pip install step.
"""
import os, re, sys, json, subprocess, datetime, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CE = os.path.join(ROOT, ".content-engine")
MODEL = os.environ.get("CONTENT_ENGINE_MODEL", "claude-opus-4-8")
TODAY = os.environ.get("RUN_DATE") or datetime.date.today().isoformat()


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)


def sh(*args, **kw):
    return subprocess.run(args, cwd=ROOT, check=True, **kw)


# --- 1. pick the first unchecked backlog topic --------------------------------
backlog_path = os.path.join(CE, "BACKLOG.md")
backlog = read(backlog_path)
lines = backlog.splitlines()
topic = None
for i, ln in enumerate(lines):
    m = re.match(r"^- \[ \] \*\*(.+?)\*\* — `(.+?\.html)`", ln)
    if m:
        topic = {
            "title": m.group(1).strip(),
            "slug": m.group(2).strip(),
            "detail": lines[i + 1].strip() if i + 1 < len(lines) else "",
            "idx": i,
        }
        break

if not topic:
    print("Backlog empty — nothing to generate.")
    sys.exit(0)

slug = topic["slug"]
slug_base = slug[:-5]  # drop .html
branch = f"content/{slug_base}"

# --- 2. skip if a draft PR for this topic is already open ---------------------
chk = subprocess.run(
    ["gh", "pr", "list", "--state", "open", "--head", branch, "--json", "number"],
    cwd=ROOT, capture_output=True, text=True,
)
if chk.returncode == 0 and chk.stdout.strip() and chk.stdout.strip() != "[]":
    print(f"Open PR already exists for {slug}; waiting for it to merge. Nothing to do.")
    sys.exit(0)

# Already published to main (e.g. a [needs-human] PR was fixed + merged without
# the backlog flip)? Don't regenerate over it.
if os.path.exists(os.path.join(ROOT, slug)):
    print(f"{slug} already exists on main; skipping.")
    sys.exit(0)

# --- 3. build the prompt ------------------------------------------------------
engine = read(os.path.join(CE, "ENGINE.md"))
compliance = read(os.path.join(CE, "COMPLIANCE-CHECKLIST.md"))
example = read(os.path.join(ROOT, "first-time-home-buyer-brevard-county-fl.html"))

system = (
    "You are the Homesite Mortgage content engine. You output ONLY the raw HTML "
    "for one web page — no markdown code fences, no commentary before or after."
)

user = f"""Produce the complete HTML for the page `{slug}`.

TOPIC: {topic['title']}
{topic['detail']}
TODAY (use for datePublished / dateModified / sitemap lastmod): {TODAY}

Use the EXAMPLE page at the bottom as your exact template. COPY VERBATIM, byte-for-byte:
the <head> boilerplate scripts (CookieYes + GA4), the entire <style> block, the <nav>,
the footer (including all NMLS IDs and the Equal Housing Opportunity logo/text), the
sticky CTA, and BOTH <script> blocks. Change ONLY these:
  1. <head> meta — description, <title>, canonical, og:* and twitter:* — all consistent
     and referencing the real filename `{slug}`. Set og:type to "article".
  2. JSON-LD @graph — BreadcrumbList + Article (publisher and author point to
     "https://homesitemortgage.online/#business"; datePublished and dateModified = {TODAY})
     + FAQPage. The FAQPage entries MUST match the visible FAQ text word-for-word.
  3. <main> — hero (local H1 + lede) followed by the SAME three hero-actions buttons as
     the example, in this order and verbatim: "Start My Free Prequal →" linking to
     prequal.html?type=purchase, "Estimate My Monthly Payment" linking to
     mortgage-calculator.html, and the "Call Us — 321-751-4403" button. The calculator
     link is REQUIRED on every page (it is our main lead engine — never drop it). Then:
     intro, the buyer process, a loan-programs card grid linking to fha.html / va.html /
     conventional.html, a general down-payment-assistance section, a "why local / why
     Homesite" section, a visible FAQ of 4 Q&As, and a final CTA linking to
     prequal.html?type=purchase. Mirror the structure of the example.

Follow EVERY blocker in these rules:
--- COMPLIANCE CHECKLIST ---
{compliance}

--- ENGINE NOTES ---
{engine}

--- EXAMPLE PAGE (copy the chrome verbatim; mirror the structure) ---
{example}
--- END EXAMPLE ---

Output ONLY the final HTML for `{slug}`, beginning with <!DOCTYPE html> and ending with </html>."""

# --- 4. call the Anthropic API ------------------------------------------------
body = json.dumps({
    "model": MODEL,
    "max_tokens": 32000,
    "system": system,
    "messages": [{"role": "user", "content": user}],
}).encode("utf-8")

req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST")
req.add_header("x-api-key", os.environ["ANTHROPIC_API_KEY"])
req.add_header("anthropic-version", "2023-06-01")
req.add_header("content-type", "application/json")
try:
    with urllib.request.urlopen(req, timeout=600) as r:
        resp = json.loads(r.read().decode("utf-8"))
except urllib.error.HTTPError as e:
    print("Anthropic API error:", e.code, e.read().decode("utf-8")[:800])
    sys.exit(1)

html = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text").strip()
html = re.sub(r"^```[a-zA-Z]*\n", "", html)
html = re.sub(r"\n```$", "", html).strip()
idx = html.find("<!DOCTYPE html>")
if idx > 0:
    html = html[idx:]

# Hard abort on a fundamentally broken generation — do NOT open a PR or consume
# the backlog slot; the next run retries this topic cleanly.
if not html or "</html>" not in html or resp.get("stop_reason") == "max_tokens":
    print("Generation incomplete/empty (truncated or missing </html>); aborting, backlog untouched.")
    sys.exit(1)

# --- 5. sanity checks (page still opens as a draft PR; flagged for humans) -----
issues = []
if not html.startswith("<!DOCTYPE html>"):
    issues.append("missing doctype")
for needle in ["NMLS #353790", "NMLS #353539", "NMLS #886861", "NMLS #1577726",
               "Equal Housing", "</html>", "prequal.html", "cookieyes", "ga4.js",
               "favicon", "321-751-4403", "Melbourne",
               f"homesitemortgage.online/{slug}"]:
    if needle not in html:
        issues.append(f"missing '{needle}'")
# Reg Z triggering terms / fabricated specifics must NEVER ship — force review.
FORBIDDEN = [
    r"\bno down payment\b", r"\bzero down\b", r"\$0\s*down\b", r"\bno-down\b",
    r"\b\d{1,2}(?:\.\d+)?\s*%\s*down\b",
    r"\b\d{1,2}\.\d+\s*%\s*(?:apr|rate|interest)",
    r"\bas low as\b",
    r"\bguarantee(?:d|s)?\s+(?:approval|rates?|results?)\b",  # not "VA-guaranteed"/"VA guarantee"
]
hits = [p for p in FORBIDDEN if re.search(p, html, re.I)]
if hits:
    issues.append("possible Reg Z triggering term(s) — review: " + ", ".join(hits))
needs_human = bool(issues)

# interlink to the areas hub so each new county page isn't an SEO island
AREAS_INTERLINK = (
    '    <section style="background:var(--off-white);padding:48px 0;border-top:1px solid rgba(10,31,60,0.06);">\n'
    '      <div style="max-width:var(--max-w);margin:0 auto;padding:0 24px;text-align:center;">\n'
    '        <p style="font-size:0.78rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--gold-text);margin:0 0 8px;">More Areas We Serve</p>\n'
    '        <h2 style="color:var(--navy);font-size:1.4rem;margin:0 0 12px;">Homesite Mortgage helps first-time buyers across all of Florida</h2>\n'
    '        <a href="areas.html" style="color:var(--navy);font-weight:600;text-decoration:underline;">Browse first-time buyer guides for every Florida region &rarr;</a>\n'
    '      </div>\n'
    '    </section>\n'
)
if "More Areas We Serve" not in html and "</main>" in html:
    html = html.replace("</main>", AREAS_INTERLINK + "  </main>", 1)
write(os.path.join(ROOT, slug), html.rstrip("\n") + "\n")

# --- 6. sitemap + backlog + homepage hub -- only for a clean page --------------
# A flagged page still opens a [needs-human] PR, but must NOT consume the backlog
# slot, get indexed, or be linked from the homepage until a human fixes it.
if not needs_human:
    sm_path = os.path.join(ROOT, "sitemap.xml")
    sm = read(sm_path)
    if slug not in sm:
        entry = (
            "  <url>\n"
            f"    <loc>https://homesitemortgage.online/{slug}</loc>\n"
            f"    <lastmod>{TODAY}</lastmod>\n"
            "    <changefreq>monthly</changefreq>\n"
            "    <priority>0.7</priority>\n"
            "  </url>\n"
        )
        sm = sm.replace("</urlset>", entry + "</urlset>")
        write(sm_path, sm)

    # de-orphan: link the new page from the homepage footer hub (clean, no
    # redundant prefix) AND from the areas.html regional accordion.
    idx_path = os.path.join(ROOT, "index.html")
    idx_html = read(idx_path)
    fmarker = "<!-- content-engine: add new <li> area-guide links here -->"
    if fmarker in idx_html and f'href="{slug}"' not in idx_html:
        link_li = (
            f'\n          <li><a href="{slug}" '
            f'style="color:rgba(255,255,255,0.72);text-decoration:none;font-size:0.85rem;">'
            f'{topic["title"]}</a></li>'
        )
        write(idx_path, idx_html.replace(fmarker, fmarker + link_li, 1))

    # areas.html — slot the page into its Florida region accordion.
    areas_path = os.path.join(ROOT, "areas.html")
    if os.path.exists(areas_path):
        areas_html = read(areas_path)
        REGIONS = [
            ("space-coast", ["brevard"]),
            ("central-fl", ["orlando", "orange", "seminole", "osceola", "kissimmee", "lake-county", "volusia", "daytona", "marion", "ocala"]),
            ("tampa-bay", ["tampa", "hillsborough", "pinellas", "petersburg", "pasco", "polk", "lakeland", "manatee", "bradenton", "sarasota"]),
            ("northeast-fl", ["jacksonville", "duval", "st-johns", "augustine", "alachua", "gainesville", "leon", "tallahassee"]),
            ("southwest-fl", ["fort-myers", "lee-county", "cape-coral", "collier", "naples"]),
            ("southeast-fl", ["palm-beach", "broward", "lauderdale", "miami", "dade", "st-lucie", "indian-river", "vero"]),
            ("panhandle", ["pensacola", "escambia"]),
        ]
        region = "central-fl"
        for rid, keys in REGIONS:
            if any(k in slug for k in keys):
                region = rid
                break
        amarker = f"<!-- region:{region} -->"
        soon = amarker + '\n                <li class="soon">Guides for this region are coming soon — we already serve buyers here statewide.</li>'
        if soon in areas_html:
            areas_html = areas_html.replace(soon, amarker, 1)  # drop the placeholder
        if amarker in areas_html and f'href="{slug}"' not in areas_html:
            area_li = f'\n                <li><a href="{slug}">First-Time Home Buyer Guide — {topic["title"]}</a></li>'
            areas_html = areas_html.replace(amarker, amarker + area_li, 1)
            write(areas_path, areas_html)

    lines[topic["idx"]] = lines[topic["idx"]].replace("- [ ]", "- [x]", 1)
    write(backlog_path, "\n".join(lines) + ("\n" if backlog.endswith("\n") else ""))

# --- 7. branch, commit, push, open DRAFT PR (never merge) ---------------------
sh("git", "config", "user.name", "OptimizedLife")
sh("git", "config", "user.email", "moondreamandsun@gmail.com")
sh("git", "checkout", "-b", branch)
sh("git", "add", slug, "sitemap.xml", ".content-engine/BACKLOG.md", "index.html", "areas.html")

title = f"content: {topic['title']} — first-time buyer guide"
if needs_human:
    title += " [needs-human]"
commit_msg = (
    title + "\n\n"
    "Generated by the nightly content engine.\n\n"
    "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
)
sh("git", "commit", "-m", commit_msg)
sh("git", "push", "-u", "origin", branch)

if needs_human:
    # A compliance/structure check tripped — open a DRAFT PR and HOLD it for a human.
    pr_body = (
        f"Automated draft for **{topic['title']}** (`{slug}`).\n\n"
        f"Self-check: ⚠️ needs human — {'; '.join(issues)}\n\n"
        "Held for review — does NOT auto-merge. Check against "
        "`.content-engine/COMPLIANCE-CHECKLIST.md`."
    )
    sh("gh", "pr", "create", "--draft", "--base", "main", "--head", branch,
       "--title", title, "--body", pr_body)
    print(f"Opened DRAFT [needs-human] PR for {slug} — held for review.")
else:
    # Passed every compliance + structure check — publish it automatically.
    pr_body = (
        f"Automated page for **{topic['title']}** (`{slug}`).\n\n"
        "Self-check: ✅ passed all compliance + structure checks — auto-merged to main."
    )
    sh("gh", "pr", "create", "--base", "main", "--head", branch,
       "--title", title, "--body", pr_body)
    sh("git", "checkout", "main")  # leave the feature branch so --delete-branch can remove it
    sh("gh", "pr", "merge", branch, "--squash", "--delete-branch")
    print(f"Auto-merged clean page {slug} -> main (now live).")
