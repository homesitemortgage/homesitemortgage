# -*- coding: utf-8 -*-
"""
IndexNow submitter.

Google does not participate in IndexNow, so this does nothing for Google. It is
here for BING - which is what Microsoft Copilot reads, and which several
assistant retrieval stacks lean on. A sitemap ping asks a crawler to come back
eventually; IndexNow tells it a specific set of URLs changed right now.

The key file at the site root is the ownership proof, so it is deliberately
public and committed. Rotating it means generating a new key, committing the new
<key>.txt, and updating KEY below.

Usage:
    python tools/indexnow.py            # submit every indexable URL in sitemap.xml
    python tools/indexnow.py <url> ...  # submit specific URLs
"""
import io, sys, json, re, os
from urllib import request, error

HOST = "homesitemortgage.online"
KEY = "619fcc04cf2b19469261b694f9ad8a61"
KEY_LOCATION = "https://%s/%s.txt" % (HOST, KEY)
ENDPOINT = "https://api.indexnow.org/indexnow"   # shared endpoint: fans out to all participants

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sitemap_urls():
    s = io.open(os.path.join(ROOT, "sitemap.xml"), encoding="utf-8").read()
    return re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", s)


def submit(urls):
    urls = [u for u in urls if u.startswith("https://%s" % HOST)]
    if not urls:
        print("nothing to submit")
        return 0
    body = json.dumps({
        "host": HOST,
        "key": KEY,
        "keyLocation": KEY_LOCATION,
        "urlList": urls,
    }).encode("utf-8")
    req = request.Request(ENDPOINT, data=body, method="POST",
                          headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with request.urlopen(req, timeout=30) as r:
            code, note = r.status, r.read().decode("utf-8", "replace")[:200]
    except error.HTTPError as e:
        code, note = e.code, e.read().decode("utf-8", "replace")[:200]
    meaning = {
        200: "OK - accepted",
        202: "Accepted - key validation pending",
        400: "Bad request - malformed",
        403: "Forbidden - key not valid for this host",
        422: "Unprocessable - URL/host or key mismatch",
        429: "Rate limited - too many requests",
    }.get(code, "unexpected")
    print("submitted %d URLs -> HTTP %s (%s) %s" % (len(urls), code, meaning, note))
    return 0 if code in (200, 202) else 1


if __name__ == "__main__":
    urls = sys.argv[1:] or sitemap_urls()
    sys.exit(submit(urls))
