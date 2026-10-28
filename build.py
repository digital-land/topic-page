"""Fetch topic datasets and write compact JSON for the prototype topic page."""

import csv
import io
import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

from shapely import wkt
from shapely.geometry import mapping

FILES = "https://files.planning.data.gov.uk/dataset/"
ORGANISATIONS = "https://files.planning.data.gov.uk/organisation-collection/dataset/organisation.csv"
CACHE = Path("cache")
DATA = Path("data")
csv.field_size_limit(10**9)

# journey stage reached by each timetable event
EVENT_STAGE = {
    "commenced": 0,
    "scoping-consultation-start": 0,
    "content-consultation-start": 0,
    "reg-18-draft-local-plan-published": 0,
    "reg-18-consultation-start": 0,
    "reg-18-public-consultation-start": 0,
    "reg-19-publication-local-plan-published": 1,
    "reg-19-public-consultation-start": 1,
    "proposed-plan-consultation-start": 1,
    "submit-plan-for-examination": 2,
    "examination-submitted": 2,
    "planning-inspectorate-examination-start": 2,
    "planning-inspectorate-found-sound": 3,
    "examination-recommendations-published": 3,
    "inspector-report-published": 3,
    "planning-inspectorate-examination-end": 3,
    "plan-adopted": 4,
    "adopted": 4,
}
# repeated events further apart than this are taken to be a new plan cycle
CYCLE_GAP_DAYS = 31

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


def current_lpas():
    """References of current LPAs: organisations with an LPA area and no end-date."""
    path = CACHE / "organisation.csv"
    if not path.exists():
        print("fetching organisation", file=sys.stderr)
        urllib.request.urlretrieve(ORGANISATIONS, path)
    with open(path, newline="", encoding="utf-8") as f:
        return sorted(
            o["local-planning-authority"]
            for o in csv.DictReader(f)
            if o["local-planning-authority"] and not o["end-date"]
        )


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


def days_between(a, b):
    return abs((date.fromisoformat(b) - date.fromisoformat(a)).days)


def flag_reused_references(events):
    """Mark events from earlier cycles of a reused plan reference as suspect.

    Where a reference has been reused for a later plan cycle, the same event
    appears with dates years apart, or stages run backwards in time. Keep the
    latest repeat of each event, then the largest set of stages that are in
    date order (preferring the most recent), and flag the rest.
    Returns a list of issues, one per affected plan.
    """
    by_plan = {}
    for e in events:
        by_plan.setdefault(e["plan"], []).append(e)
    issues = []
    for plan, es in by_plan.items():
        reasons = []
        dated = [e for e in es if e["date"] and e["event"] in EVENT_STAGE]
        for name in {e["event"] for e in dated}:
            same = sorted(
                (e for e in dated if e["event"] == name), key=lambda e: e["date"]
            )
            if days_between(same[0]["date"], same[-1]["date"]) > CYCLE_GAP_DAYS:
                for e in same[:-1]:
                    e["suspect"] = True
                reasons.append(f"{name} recorded on {len(same)} dates")
        first = {}
        for e in dated:
            if not e.get("suspect"):
                stage = EVENT_STAGE[e["event"]]
                first[stage] = min(first.get(stage, e["date"]), e["date"])
        best = ()
        for mask in range(1, 1 << 5):
            keep = [s for s in range(5) if mask >> s & 1 and s in first]
            if all(first[a] <= first[b] for a, b in zip(keep, keep[1:])):
                if len(keep) > len(best) or (
                    len(keep) == len(best)
                    and keep
                    and max(first[s] for s in keep) > max(first[s] for s in best)
                ):
                    best = keep
        for e in dated:
            if EVENT_STAGE[e["event"]] not in best and not e.get("suspect"):
                e["suspect"] = True
                reasons.append(f"{e['event']} out of date order")
        if any(e.get("suspect") for e in es):
            issues.append(
                {
                    "plan": plan,
                    "reasons": sorted(set(reasons)),
                    "events": sum(1 for e in es if e.get("suspect")),
                }
            )
    return sorted(issues, key=lambda i: i["plan"])


def build(slug, topic):
    plans = fetch(topic["dataset"])
    boundaries = fetch(topic["boundary"])
    # abolished authorities (e.g. districts merged into a unitary) have an end-date
    ended = {a["reference"]: a["end-date"] for a in fetch("local-planning-authority")}
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
                        "end-date": b.get("end-date") or ended.get(b["reference"], ""),
                        # single LPA areas, as opposed to joint planning groups
                        "lpa": b["reference"] in ended,
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
        # local-plan-timetable links on local-plan; the shared plan-timetable on plan
        key = "plan" if topic["timetable"] == "plan-timetable" else topic["dataset"]
        refs = {p["reference"] for p in plans}
        for t in fetch(topic["timetable"]):
            event = {
                "plan": t[key],
                "event": t[f"{key}-event"],
                "date": t["event-date"] or t.get("actual-date") or t["start-date"],
                "earliest": t.get("predicted-earliest-date")
                or t.get("predicted-date", ""),
                "latest": t.get("predicted-latest-date", ""),
            }
            event["stage"] = EVENT_STAGE.get(event["event"])
            # skip milestones with no date at all (unfilled timetable templates)
            if event["plan"] in refs and (event["date"] or event["earliest"]):
                events.append(event)
    issues = flag_reused_references(events)
    out = {
        "plans": rows,
        "issues": issues,
        "boundaries": {"type": "FeatureCollection", "features": features},
        "events": events,
        "current-lpas": current_lpas() if topic.get("currentLpas") else [],
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
