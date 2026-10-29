"""Search LPA websites for local plan commencement notices.

For each current LPA, fetch the website home page, follow links that look
like local plan pages, and report pages mentioning a commencement notice.

Usage: python bin/commencement.py [--limit N] [--output FILE]
"""

import argparse
import csv
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlparse

import urllib.request

ORGANISATION = Path("cache/organisation.csv")
USER_AGENT = "Mozilla/5.0 (compatible; topic-page commencement search)"
TIMEOUT = 15

LINK_TEXT = re.compile(r"local plan|plan.?making|planning policy|new plan", re.I)
NOTICE = re.compile(
    r"notices?\s+of\s+(the\s+)?(intention|intent|commencement)"
    r"|intention\s+to\s+(commence|prepare|start|begin)"
    r"|commencement\s+(notice|of\s+(the\s+)?(local\s+)?plan)",
    re.I,
)
SLUG = re.compile(r"intention|intent-to|commenc", re.I)
SITEMAP = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)
MAX_SITEMAPS = 50
LINK = re.compile(r'<a\s[^>]*href="([^"#]+)"[^>]*>(.*?)</a>', re.I | re.S)
TAGS = re.compile(r"<[^>]+>")


def current_lpas():
    with ORGANISATION.open(newline="") as f:
        for row in csv.DictReader(f):
            if row["local-planning-authority"] and not row["end-date"]:
                if row["website"]:
                    yield row


def get(url, html_only=True):
    try:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=TIMEOUT) as r:
            if not html_only or "html" in r.headers.get("content-type", ""):
                return r.url, r.read().decode("utf-8", "replace")
    except (OSError, ValueError):
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
    return found[:10]


def search(row):
    base, html = get(row["website"])
    hits = []
    for url in sitemap_urls(base):
        url, page = get(url)
        m = NOTICE.search(TAGS.sub(" ", page))
        if m:
            hits.append((url, m.group(0)))
    for url in candidate_links(base, html):
        url, page = get(url)
        m = NOTICE.search(TAGS.sub(" ", page))
        if m:
            hits.append((url, m.group(0)))
        else:
            # one level deeper for local plan landing pages
            for sub in candidate_links(url, page, limit=5):
                sub, subpage = get(sub)
                m = NOTICE.search(TAGS.sub(" ", subpage))
                if m:
                    hits.append((sub, m.group(0)))
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
        writer.writerow(["lpa", "organisation", "url", "match"])
        for row, hits in pool.map(search, lpas):
            print(f"{row['name']}: {len(hits)} page(s)", file=sys.stderr)
            for url, match in hits:
                writer.writerow(
                    [row["local-planning-authority"], row["name"], url, match]
                )


if __name__ == "__main__":
    main()
