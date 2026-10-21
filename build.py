"""Fetch topic datasets and write compact JSON for the prototype topic page."""

import csv
import io
import json
import sys
import urllib.request
from pathlib import Path

from shapely import wkt
from shapely.geometry import mapping

FILES = "https://files.planning.data.gov.uk/dataset/"
CACHE = Path("cache")
DATA = Path("data")
csv.field_size_limit(10**9)

PLAN_FIELDS = [
    "entity",
    "reference",
    "name",
    "start-date",
    "end-date",
    "entry-date",
    "adopted-date",
    "period-start-date",
    "period-end-date",
    "local-plan-process",
    "organisation",
    "document-url",
    "documentation-url",
    "required-housing",
]


def fetch(dataset):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{dataset}.csv"
    if not path.exists():
        print("fetching", dataset, file=sys.stderr)
        urllib.request.urlretrieve(f"{FILES}{dataset}.csv", path)
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def simplify(geometry):
    geom = wkt.loads(geometry).simplify(0.003, preserve_topology=True)
    out = mapping(geom)
    out["coordinates"] = json.loads(
        json.dumps(out["coordinates"], separators=(",", ":")),
        parse_float=lambda s: round(float(s), 4),
    )
    return out


def build(slug, topic):
    plans = fetch(topic["dataset"])
    boundaries = fetch(topic["boundary"])
    names = {}
    features = []
    for b in boundaries:
        names[b["reference"]] = b["name"]
        if b["geometry"]:
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "reference": b["reference"],
                        "name": b["name"],
                        "entity": b["entity"],
                    },
                    "geometry": simplify(b["geometry"]),
                }
            )
    fields = PLAN_FIELDS + [topic["boundaryField"], topic["authorityField"]]
    rows = []
    for p in plans:
        row = {k: p.get(k, "") for k in fields}
        row["boundary"] = row.pop(topic["boundaryField"])
        row["authorities"] = row.pop(topic["authorityField"])
        row["authority-name"] = names.get(row["boundary"], "")
        rows.append(row)
    events = []
    if topic["timetable"]:
        for t in fetch(topic["timetable"]):
            events.append(
                {
                    "plan": t[topic["dataset"]],
                    "event": t[f"{topic['dataset']}-event"],
                    "date": t["event-date"] or t["start-date"],
                    "earliest": t["predicted-earliest-date"],
                    "latest": t["predicted-latest-date"],
                }
            )
    out = {
        "plans": rows,
        "boundaries": {"type": "FeatureCollection", "features": features},
        "events": events,
        "counts": {
            "plans": len(rows),
            "boundaries": len(boundaries),
            "events": len(events),
        },
    }
    DATA.mkdir(exist_ok=True)
    (DATA / f"{slug}.json").write_text(json.dumps(out, separators=(",", ":")))
    print(slug, out["counts"])


if __name__ == "__main__":
    topics = json.load(open("topics.json"))
    for slug in sys.argv[1:] or topics:
        build(slug, topics[slug])
