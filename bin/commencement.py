"""Search LPA websites for signs of work on a new local plan.

For each current LPA, look through the sitemaps and the local plan pages linked
from the home page, and report pages carrying a signal: a commencement notice,
a gateway assessment, a plan-making timetable, a call for sites or similar.

Usage: python bin/commencement.py [--limit N] [--output FILE]
"""

import argparse
import csv
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

import urllib.request

ORGANISATION = Path("cache/organisation.csv")
USER_AGENT = "Mozilla/5.0 (compatible; topic-page commencement search)"
TIMEOUT = 15

LINK_TEXT = re.compile(r"local plan|plan.?making|planning policy|new plan", re.I)
SIGNALS = {
    "notice": re.compile(
        r"notices?\s+of\s+(the\s+)?(intention|intent|commencement)"
        r"|intention\s+to\s+(commence|prepare|start|begin)"
        r"|commencement\s+(notice|of\s+(the\s+)?(local\s+)?plan)",
        re.I,
    ),
    "gateway": re.compile(r"gateway\s*[123]\b|gateway\s+assessment", re.I),
    "timetable": re.compile(
        r"(local\s+plan|plan.?making)\s+(timetable|project\s+plan)"
        r"|timetable\s+for\s+(the\s+|our\s+)?(new\s+)?local\s+plan",
        re.I,
    ),
    "engagement": re.compile(
        r"call\s+for\s+sites|issues\s+and\s+options|regulation\s+18"
        r"|(early|initial)\s+(engagement|consultation)\s+on\s+(the\s+)?(new\s+)?local\s+plan",
        re.I,
    ),
    "new-plan": re.compile(
        r"(preparing|prepare|preparation\s+of|developing)\s+(a|the|our)\s+new\s+local\s+plan"
        r"|new\s+local\s+plan\s+(is|will\s+be)\s+(being\s+)?(prepared|developed)"
        r"|local\s+plan\s+review",
        re.I,
    ),
}
SLUG = re.compile(
    r"intention|intent-to|commenc|new-local-plan|local-plan-(review|20\d\d)"
    r"|plan-making|gateway|call-for-sites|issues-and-options|project-plan"
    r"|local-plan-timetable|regulation-18",
    re.I,
)
SITEMAP = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)
MAX_PAGES = 20
MAX_SITEMAPS = 50
LINK = re.compile(r'<a\s[^>]*href="([^"#]+)"[^>]*>(.*?)</a>', re.I | re.S)
TAGS = re.compile(r"<[^>]+>")
SCRIPTS = re.compile(r"<(script|style)\b.*?</\1>", re.I | re.S)


def current_lpas():
    with ORGANISATION.open(newline="") as f:
        for row in csv.DictReader(f):
            if row["local-planning-authority"] and not row["end-date"]:
                if row["website"]:
                    yield row


def get(url, html_only=True):
    try:
        request = urllib.request.Request(
            quote(url, safe=":/?&=%#+@~,;"), headers={"User-Agent": USER_AGENT}
        )
        with urllib.request.urlopen(request, timeout=TIMEOUT) as r:
            if not html_only or "html" in r.headers.get("content-type", ""):
                return r.url, r.read().decode("utf-8", "replace")
    except Exception:
        pass
    return url, ""


def candidate_links(base, html, limit=8):
    host = urlparse(base).netloc.removeprefix("www.")
    seen = []
    for href, text in LINK.findall(html):
        text = TAGS.sub("", text).strip()
        url = urljoin(base, href).split("#")[0]
        if urlparse(url).netloc.removeprefix("www.") != host:
            continue
        if (LINK_TEXT.search(text) or LINK_TEXT.search(href)) and url not in seen:
            seen.append(url)
    return seen[:limit]


def sitemap_urls(base):
    """URLs from the site's sitemaps whose address suggests a commencement notice."""
    root = "{0.scheme}://{0.netloc}".format(urlparse(base))
    queue = [urljoin(root, "/sitemap.xml")]
    _, robots = get(urljoin(root, "/robots.txt"), html_only=False)
    queue += re.findall(r"(?im)^sitemap:\s*(\S+)", robots)
    seen, found = set(), []
    while queue and len(seen) < MAX_SITEMAPS:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        _, xml = get(url, html_only=False)
        for loc in SITEMAP.findall(xml):
            if loc.endswith(".xml") or "sitemap" in loc.lower():
                queue.append(loc)
            elif SLUG.search(loc) and re.search(r"plan", loc, re.I):
                found.append(loc)
    # notices first, then the rest, shortest (nearest the landing page) first
    return sorted(
        set(found), key=lambda u: (not re.search("intention|commenc", u), len(u))
    )[:MAX_PAGES]


PLAN_NEAR = re.compile(r"local\s+plan|plan.?making|new\s+plan", re.I)
NOT_PLAN = re.compile(
    r"demolish|wedding|rights-of-way|make-an-order|minerals|waste", re.I
)
# weak signals only count on pages about a new or emerging local plan
NEW_PLAN_URL = re.compile(r"new|review|emerging|next|20[2-4]\d", re.I)


def signals(url, page):
    if NOT_PLAN.search(url):
        return
    text = TAGS.sub(" ", SCRIPTS.sub(" ", page))
    for signal, pattern in SIGNALS.items():
        for m in pattern.finditer(text):
            near = text[max(m.start() - 300, 0) : m.end() + 300]
            if signal == "notice" and not PLAN_NEAR.search(near):
                continue
            if signal in ("engagement", "new-plan") and not NEW_PLAN_URL.search(url):
                continue
            yield url, signal, m.group(0)
            break


def search(row):
    base, html = get(row["website"])
    hits, seen = [], set()

    def check(url):
        if url in seen:
            return
        seen.add(url)
        url, page = get(url)
        hits.extend(signals(url, page))
        return page

    for url in sitemap_urls(base):
        check(url)
    for url in candidate_links(base, html):
        page = check(url)
        # one level deeper for local plan landing pages
        for sub in candidate_links(url, page or "", limit=5):
            check(sub)
    return row, hits


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, help="only search the first N LPAs")
    parser.add_argument("--output", default="data/commencement-notices.csv")
    args = parser.parse_args()

    lpas = list(current_lpas())[: args.limit]
    with ThreadPoolExecutor(max_workers=8) as pool, open(
        args.output, "w", newline=""
    ) as out:
        writer = csv.writer(out)
        writer.writerow(["lpa", "organisation", "url", "signal", "match"])
        for row, hits in pool.map(search, lpas):
            print(f"{row['name']}: {len(hits)} page(s)", file=sys.stderr)
            for url, signal, match in hits:
                writer.writerow(
                    [row["local-planning-authority"], row["name"], url, signal, match]
                )


if __name__ == "__main__":
    main()
