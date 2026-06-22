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
  3. <main> — hero (local H1 + lede), intro, the buyer process, a loan-programs card grid
     linking to fha.html / va.html / conventional.html, a general down-payment-assistance
     section, a "why local / why Homesite" section, a visible FAQ of 4 Q&As, and a final
     CTA linking to prequal.html?type=purchase. Mirror the structure of the example.

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

# --- 5. sanity checks (page still opens as a draft PR; flagged for humans) -----
issues = []
if resp.get("stop_reason") == "max_tokens":
    issues.append("output hit max_tokens (possibly truncated)")
if not html.startswith("<!DOCTYPE html>"):
    issues.append("missing doctype")
for needle in ["NMLS #353790", "Equal Housing", "</html>", "prequal.html",
               "cookieyes", "ga4.js"]:
    if needle not in html:
        issues.append(f"missing '{needle}'")
needs_human = bool(issues)

write(os.path.join(ROOT, slug), html.rstrip("\n") + "\n")

# --- 6. sitemap + backlog -----------------------------------------------------
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

lines[topic["idx"]] = lines[topic["idx"]].replace("- [ ]", "- [x]", 1)
write(backlog_path, "\n".join(lines) + ("\n" if backlog.endswith("\n") else ""))

# --- 7. branch, commit, push, open DRAFT PR (never merge) ---------------------
sh("git", "config", "user.name", "OptimizedLife")
sh("git", "config", "user.email", "moondreamandsun@gmail.com")
sh("git", "checkout", "-b", branch)
sh("git", "add", slug, "sitemap.xml", ".content-engine/BACKLOG.md")

title = f"content: {topic['title']} — first-time buyer guide"
if needs_human:
    title += " [needs-human]"
commit_msg = (
    title + "\n\n"
    "Generated by the nightly content engine. Draft only — human review required.\n\n"
    "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
)
sh("git", "commit", "-m", commit_msg)
sh("git", "push", "-u", "origin", branch)

self_check = ("⚠️ needs human — " + "; ".join(issues)) if needs_human else "✅ passed basic checks"
pr_body = (
    f"Automated draft for **{topic['title']}** (`{slug}`).\n\n"
    f"Self-check: {self_check}\n\n"
    "Please review against `.content-engine/COMPLIANCE-CHECKLIST.md` before merging. "
    "One page, one PR — this never auto-merges."
)
sh("gh", "pr", "create", "--draft", "--base", "main", "--head", branch,
   "--title", title, "--body", pr_body)
print(f"Opened draft PR for {slug} (needs_human={needs_human})")
