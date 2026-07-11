#!/usr/bin/env python3
"""
Homesite Mortgage — Facebook social-drafting engine.

Drafts a small batch of compliance-checked Facebook posts and opens a DRAFT PR
for human review. It NEVER auto-posts and NEVER auto-merges — a person approves
each post and publishes it. Approved drafts live in /social-drafts: a dated,
version-controlled archive that also satisfies Florida's 2-year mortgage-ad
recordkeeping rule (Fla. Stat. 494.00165).

Run by GitHub Actions on a schedule. Needs ANTHROPIC_API_KEY + GH_TOKEN.
"""
import os, re, sys, json, subprocess, datetime, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.environ.get("SOCIAL_ENGINE_MODEL", "claude-sonnet-5")
TODAY = datetime.date.today().isoformat()
N_POSTS = int(os.environ.get("SOCIAL_ENGINE_POSTS", "3"))

def read(p):
    with open(p, encoding="utf-8") as f: return f.read()
def write(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f: f.write(s)
def sh(*a, **k): return subprocess.run(a, cwd=ROOT, check=True, **k)

# --- real reviews only (we never invent a testimonial) -----------------------
idx = read(os.path.join(ROOT, "index.html"))
reviews = re.findall(
    r'"author":\s*\{"@type":\s*"Person",\s*"name":\s*"([^"]+)"\},\s*"reviewBody":\s*"([^"]+)"', idx)
reviews_txt = "\n".join(f'- {n}: "{b}"' for n, b in reviews) or "(none available — skip the review angle)"

# --- rotating post angles (deterministic by date, no randomness) -------------
ANGLES = [
    ("First-time-buyer tip", "One practical, encouraging tip for a Florida first-time buyer (why prequalify first, what to gather, how it works). No numbers."),
    ("Why a broker vs a bank", "Friendly explanation of why a broker (shops many lenders) beats one bank — more options, on your side. No rate or savings claims."),
    ("Loan-program spotlight", "Introduce ONE program (FHA / VA / Conventional / DSCR / first-time) in plain language and who it tends to fit. No rates, terms, or down-payment numbers."),
    ("Review spotlight", "Build a warm post around ONE real Google review below — quote it accurately, credit the first name only, thank them. Real text only."),
    ("Local area spotlight", "A welcoming post about serving a Florida community (Brevard/Space Coast, Orlando, Tampa, Jacksonville, Lakeland, etc.). No numbers."),
    ("What to expect", "Reassure buyers what working with Homesite is like — a real person, personal guidance, no pressure, online and by phone."),
    ("Family-owned / slogan", "Warm post about being family-owned in Florida since 1999, people-first ('Where people are our foundation'). No fabricated facts."),
]
start = datetime.date.today().toordinal() % len(ANGLES)
chosen = [ANGLES[(start + i) % len(ANGLES)] for i in range(N_POSTS)]
angles_txt = "\n".join(f"{i+1}. {n} — {d}" for i, (n, d) in enumerate(chosen))

COMPLIANCE = read(os.path.join(ROOT, ".social-engine", "COMPLIANCE-NOTES.md"))

system = (
    "You are the social media copywriter for Homesite Mortgage, a family-owned Florida "
    "mortgage brokerage (NMLS #353790), licensed statewide since 1999. Brand voice: warm, "
    "personal, trustworthy, Florida-proud, plain-spoken — never salesy or hypey. Slogan: "
    "'Where people are our foundation.' You write Facebook posts that build trust and gently "
    "invite a free, no-pressure prequalification. You STRICTLY follow mortgage advertising law."
)
user = f"""Draft {N_POSTS} Facebook posts for Homesite Mortgage, one per angle.

ANGLES:
{angles_txt}

REAL GOOGLE REVIEWS (the ONLY testimonials you may quote — exact words, first name only):
{reviews_txt}

COMPLIANCE — every post MUST follow these; a violation must never ship:
{COMPLIANCE}

For each post give: a strong first-line hook, 2-4 short body sentences, a soft CTA
(start a free prequal at homesitemortgage.online or call 321-751-4403), 3-6 hashtags,
and a one-line image/visual idea. Tight and skimmable. Tasteful emojis ok.

Return ONLY valid JSON: a list of objects with keys angle, hook, body, cta,
hashtags (array of strings), image_idea. No prose outside the JSON."""

payload = json.dumps({"model": MODEL, "max_tokens": 4000, "system": system,
                      "messages": [{"role": "user", "content": user}]}).encode("utf-8")
req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=payload, method="POST")
req.add_header("x-api-key", os.environ["ANTHROPIC_API_KEY"])
req.add_header("anthropic-version", "2023-06-01")
req.add_header("content-type", "application/json")
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        resp = json.loads(r.read().decode("utf-8"))
except urllib.error.HTTPError as e:
    print("Anthropic API error:", e.code, e.read().decode("utf-8")[:600]); sys.exit(1)

raw = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text").strip()
raw = re.sub(r"^```[a-zA-Z]*\n", "", raw); raw = re.sub(r"\n```$", "", raw).strip()
m = re.search(r"\[.*\]", raw, re.S)
if not m:
    print("No JSON array in model output; aborting."); sys.exit(1)
posts = json.loads(m.group(0))

# --- compliance scan: any rate/term/number is a triggering-term risk on social
FORBIDDEN = [
    r"\bno down payment\b", r"\bzero down\b", r"\$0\s*down\b", r"\bno-down\b",
    r"\b\d{1,2}(?:\.\d+)?\s*%\s*down\b", r"\b\d{1,2}\.\d+\s*%\s*(?:apr|rate|interest)",
    r"\bas low as\b", r"\blowest rates?\b",
    r"\bguarantee(?:d|s)?\s+(?:approval|rates?|results?)\b",
    r"\b\d{1,2}(?:\.\d+)?\s*%", r"\$\s?\d",
]
def scan(t): return [p for p in FORBIDDEN if re.search(p, t, re.I)]

flagged = 0
out = [f"# Homesite Mortgage — Facebook drafts · {TODAY}", "",
       "> DRAFTS for review. Approve/tweak, then post to Facebook **manually** (compliance).",
       "> This dated file is the ad-archive copy (FL 2-year recordkeeping) — do not delete.", ""]
for i, p in enumerate(posts, 1):
    blob = " ".join([p.get("hook", ""), p.get("body", ""), p.get("cta", "")])
    hits = scan(blob)
    if hits: flagged += 1
    status = "✅ clean" if not hits else "⚠️ REVIEW BEFORE POSTING — " + ", ".join(hits)
    tags = " ".join(p.get("hashtags", []) if isinstance(p.get("hashtags"), list) else [])
    out += [f"## {i}. {p.get('angle','Post')}  ·  {status}", "",
            f"**{p.get('hook','')}**", "", p.get("body", ""), "",
            p.get("cta", ""), "", tags, "",
            f"*Image idea:* {p.get('image_idea','')}", "", "---", ""]
write(os.path.join(ROOT, "social-drafts", f"{TODAY}-facebook.md"), "\n".join(out))

# --- branch, commit, push, open DRAFT PR (never merge, never auto-post) -------
branch = f"social-drafts-{TODAY}"
sh("git", "config", "user.name", "OptimizedLife")
sh("git", "config", "user.email", "moondreamandsun@gmail.com")
sh("git", "checkout", "-b", branch)
sh("git", "add", f"social-drafts/{TODAY}-facebook.md")
sh("git", "commit", "-m",
   f"social: Facebook drafts {TODAY}\n\nDrafts for human review — NOT auto-posted.\n\n"
   "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>")
sh("git", "push", "-u", "origin", branch)
note = "all clean ✅" if not flagged else f"{flagged} flagged ⚠️ — fix before posting"
sh("gh", "pr", "create", "--draft", "--base", "main", "--head", branch,
   "--title", f"social: Facebook drafts {TODAY} ({len(posts)} posts, {note})",
   "--body", "Auto-drafted Facebook posts for review. Approve + post manually; this file is the "
             f"FL ad-archive copy. Status: {note}.")
print(f"Opened DRAFT social PR for {TODAY}: {len(posts)} posts, {flagged} flagged.")
