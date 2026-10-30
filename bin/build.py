"""Fetch topic datasets and write compact JSON for the prototype topic page."""

import csv
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

from shapely import wkt
from shapely.geometry import mapping

FILES = "https://files.planning.data.gov.uk/dataset/"
ORGANISATIONS = "https://files.planning.data.gov.uk/organisation-collection/dataset/organisation.csv"
DATASETTE = "https://datasette.planning.data.gov.uk/digital-land.json"
PERFORMANCE = "https://datasette.planning.data.gov.uk/performance.json"
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
# current LPAs whose organisation record has no LPA area reference
NO_AREA_LPAS = {"development-corporation:Q72456968"}
# stages reached by estimated events, kept apart from EVENT_STAGE so they aren't
# checked against actual dates
ESTIMATED_STAGE = {
    "estimated-reg-18-draft-local-plan-published": 0,
    "estimated-reg-18-public-consultation-start": 0,
    "estimated-reg-18-public-consultation-end": 0,
    "estimated-reg-19-publication-local-plan-published": 1,
    "estimated-reg-19-public-consultation-start": 1,
    "estimated-reg-19-public-consultation-end": 1,
    "estimated-submit-plan-for-examination": 2,
    "estimated-plan-adoption-date": 4,
}
# notice of intention to commence a new local plan, which LPAs spell several ways
NOTICE_EVENT = "publish-notice-intention-commence"
# gateway milestones and the notice of intention to commence, which only exist in the
# new plan-making system, predicted or actual
NEW_SYSTEM_EVENTS = {
    "gateway-1-self-assessment",
    "gateway-1:-self-assessment-of-readiness",
    "gateway-2-advice-sought",
    "gateway-2-advice-published",
    "gateway-3-advice-sought",
    "gateway-3-advice-published",
    "gateway-3-further-advice-sought",
    "gateway-3-repeat-advice-published",
    NOTICE_EVENT,
}
# minerals and waste plans and areas recorded in the local plan datasets
MINERALS_AND_WASTE = re.compile(r"mineral|waste", re.I)
# notices for plans that aren't new local plans, when their plan isn't in the dataset
NOT_LOCAL_PLAN = re.compile(r"mineral|waste|supplementary|\bm(?:w)?lp\b", re.I)
# name of the template record LPAs copy for a new local plan, before filling it in
TEMPLATE_NAME = "emerging new local plan"
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
    """Current LPAs: organisations with an LPA role and no end-date.

    The organisation dataset holds the LPA area reference in
    local-planning-authority, which is blank for South Tees Development
    Corporation, still a current LPA. Each is flagged with whether it, or a
    planning group it belongs to, has a plan-timetable endpoint.
    """
    path = CACHE / "organisation.csv"
    if not path.exists():
        print("fetching organisation", file=sys.stderr)
        urllib.request.urlretrieve(ORGANISATIONS, path)
    with open(path, newline="", encoding="utf-8") as f:
        organisations = {o["organisation"]: o for o in csv.DictReader(f)}
    providers, endpoints = timetable_providers(organisations)
    signals = plan_signals()
    lpas = [
        {
            "organisation": o["organisation"],
            "name": o["name"],
            "entity": o["entity"],
            "reference": o["local-planning-authority"],
            "timetable-endpoint": o["organisation"] in providers,
            "signals": signals.get(o["local-planning-authority"], {}),
        }
        for o in organisations.values()
        if not o["end-date"]
        and (o["local-planning-authority"] or o["organisation"] in NO_AREA_LPAS)
    ]
    return lpas, endpoints, organisations, providers


def plan_signals():
    """First page found on each LPA website for each sign of work on a new plan.

    Searched for by bin/commencement.py. Minerals and waste pages are left out,
    as the signals are about local plans.
    """
    path = DATA / "commencement-notices.csv"
    if not path.exists():
        return {}
    signals = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if not re.search(r"minerals|waste", row["url"], re.I):
                signals.setdefault(row["lpa"], {}).setdefault(row["signal"], row["url"])
    return signals


def is_local_plan_maker(organisation, organisations):
    """A current LPA, or a local planning group that isn't for minerals and waste."""
    o = organisations.get(organisation, {})
    if organisation.startswith("local-planning-group:"):
        return not MINERALS_AND_WASTE.search(o.get("name", ""))
    return not o.get("end-date") and bool(
        o.get("local-planning-authority") or organisation in NO_AREA_LPAS
    )


def timetable_providers(organisations):
    """Organisations (and planning group members) with an active plan-timetable endpoint.

    Uses the provision summary in the performance database, which only counts
    endpoints that haven't ended. plan-timetable is shared by every kind of plan, so
    only current LPAs and local planning groups count: government organisations,
    county councils and minerals and waste planning groups are left out.
    Returns the organisations and the endpoint count.
    """
    path = CACHE / "plan-timetable-provision.json"
    if not path.exists():
        print("fetching plan-timetable provision", file=sys.stderr)
        query = urllib.parse.urlencode(
            {
                "sql": "select organisation, active_endpoint_count from provision_summary "
                "where dataset = :p0 and active_endpoint_count > 0 "
                'and organisation not like "government-organisation%"',
                "p0": "plan-timetable",
                "_size": "max",
                "_shape": "array",
            }
        )
        urllib.request.urlretrieve(f"{PERFORMANCE}?{query}", path)
    provision = [
        p
        for p in json.loads(path.read_text())
        if is_local_plan_maker(p["organisation"], organisations)
    ]
    providers = set()
    for p in provision:
        providers.add(p["organisation"])
        members = organisations.get(p["organisation"], {}).get("organisations", "")
        providers.update(m for m in members.split(";") if m)
    return providers, sum(p["active_endpoint_count"] for p in provision)


def lpa_submissions(pipelines, lpas, organisations):
    """When each current LPA added an endpoint for each pipeline, and when it updated it.

    A new resource (a new hash of the endpoint's data) means the LPA changed
    the data. Endpoints of planning groups count for each member LPA.
    """
    path = CACHE / "lpa-submissions.json"
    if not path.exists():
        print("fetching LPA submissions", file=sys.stderr)
        names = ",".join(f"'{p}'" for p in pipelines)
        query = urllib.parse.urlencode(
            {
                "sql": "select source.organisation, sp.pipeline, endpoint.endpoint, "
                "endpoint.start_date as endpoint_start, resource.start_date as resource_start "
                "from source_pipeline sp join source on sp.source = source.source "
                "join endpoint on source.endpoint = endpoint.endpoint "
                "left join resource_endpoint re on re.endpoint = endpoint.endpoint "
                "left join resource on resource.resource = re.resource "
                f"where sp.pipeline in ({names}) "
                'and source.organisation not like "government-organisation%"',
                "_size": "max",
                "_shape": "array",
            }
        )
        urllib.request.urlretrieve(f"{DATASETTE}?{query}", path)
    rows = json.loads(path.read_text())
    current = {l["organisation"] for l in lpas}
    # endpoint -> pipeline -> dates
    by_org = {}
    for r in rows:
        owners = [r["organisation"]]
        members = organisations.get(r["organisation"], {}).get("organisations", "")
        owners += [m for m in members.split(";") if m]
        for o in owners:
            if o not in current:
                continue
            ep = (
                by_org.setdefault(o, {})
                .setdefault(r["pipeline"], {})
                .setdefault(
                    r["endpoint"], {"added": r["endpoint_start"], "resources": set()}
                )
            )
            if r["resource_start"]:
                ep["resources"].add(r["resource_start"])
    out = []
    for o, kinds in by_org.items():
        item = {"organisation": o}
        for pipeline, endpoints in kinds.items():
            added = min(e["added"] for e in endpoints.values() if e["added"])
            # the first resource of an endpoint is its first fetch, not an update
            updates = sorted(
                {d for e in endpoints.values() for d in sorted(e["resources"])[1:]}
            )
            item[pipeline] = {"added": added, "updates": updates}
        out.append(item)
    return sorted(out, key=lambda i: i["organisation"])


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


def is_notice(event):
    name = event.lower()
    return "intention" in name and "commence" in name


def owners(entity, organisations):
    """The organisation with this entity number, and its members if it's a group."""
    org = next((o for o in organisations.values() if o["entity"] == entity), None)
    if not org:
        return []
    return [org["organisation"]] + [
        m for m in org.get("organisations", "").split(";") if m
    ]


def lpa_notices(notices, lpas, organisations):
    """Current LPAs that have given notice of intention to commence a new local plan.

    A notice from a planning group counts for each member LPA. One entry per LPA
    and plan, with whether the plan is in the plan dataset.
    """
    current = {l["organisation"]: l for l in lpas}
    out = {}
    for entity, plan, when, linked in notices:
        for o in owners(entity, organisations):
            if o in current:
                item = out.setdefault(
                    (o, plan),
                    {
                        "organisation": o,
                        "reference": current[o]["reference"],
                        "plan": plan,
                        "date": when,
                        "linked": linked,
                    },
                )
                item["date"] = min(item["date"], when)
    return sorted(out.values(), key=lambda n: (n["organisation"], n["plan"]))


def build(slug, topic, quality=None):
    """Write the data for a topic to data/{slug}.json.

    With a quality, only plans and timetable rows of that quality are used, and the
    data is written to data/{slug}-{quality}.json. Authoritative leaves out the
    historic data we seeded, which has a quality of some. Boundaries are kept.
    """
    plans = fetch(topic["dataset"])
    boundaries = fetch(topic["boundary"])
    if quality:
        plans = [p for p in plans if p["quality"] == quality]
    # leave out minerals and waste plans and planning groups recorded as local plan data
    if topic["dataset"] == "local-plan":
        plans = [p for p in plans if not MINERALS_AND_WASTE.search(p["name"])]
        boundaries = [b for b in boundaries if not MINERALS_AND_WASTE.search(b["name"])]
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
    refs = {p["reference"] for p in plans}
    events = []
    event_orgs = []
    notices = []
    # organisations with dated timetable rows, including for plans not in the plan dataset
    publishers = set()
    # dated rows for plans not in the plan dataset, with who published them
    unlinked = []
    today = date.today().isoformat()
    if topic["timetable"]:
        # local-plan-timetable links on local-plan; the shared plan-timetable on plan
        key = "plan" if topic["timetable"] == "plan-timetable" else topic["dataset"]
        for t in fetch(topic["timetable"]):
            if quality and t["quality"] != quality:
                continue
            if is_notice(t[f"{key}-event"]):
                t[f"{key}-event"] = NOTICE_EVENT
            event = {
                "plan": t[key],
                "event": t[f"{key}-event"],
                "date": t["event-date"] or t.get("actual-date") or t["start-date"],
                "earliest": t.get("predicted-earliest-date")
                or t.get("predicted-date", ""),
                "latest": t.get("predicted-latest-date", ""),
            }
            event["stage"] = EVENT_STAGE.get(
                event["event"], ESTIMATED_STAGE.get(event["event"])
            )
            # skip milestones with no date at all (unfilled timetable templates)
            if event["plan"] in refs and (event["date"] or event["earliest"]):
                events.append(event)
                event_orgs.append(t["organisation-entity"])
            if (event["date"] or event["earliest"]) and (
                event["plan"] in refs or not NOT_LOCAL_PLAN.search(event["plan"])
            ):
                publishers.add(t["organisation-entity"])
                if event["plan"] not in refs:
                    unlinked.append((event, t["organisation-entity"]))
            # notices already given, including for new plans not yet in the plan dataset
            if (
                event["event"] == NOTICE_EVENT
                and event["date"]
                and event["date"] <= today
                and (event["plan"] in refs or not NOT_LOCAL_PLAN.search(event["plan"]))
            ):
                notices.append(
                    (
                        t["organisation-entity"],
                        event["plan"],
                        event["date"],
                        event["plan"] in refs,
                    )
                )
    new_system = {e["plan"] for e in events if e["event"] in NEW_SYSTEM_EVENTS}
    for row in rows:
        row["new-system"] = row["reference"] in new_system
    lpas, endpoints, organisations, providers = (
        current_lpas() if topic.get("currentLpas") else ([], 0, {}, set())
    )
    # the organisation behind each area, by LPA reference or else by name (planning groups)
    org_by_area = {}
    for o in organisations.values():
        if o["end-date"]:
            continue
        for key in (o["local-planning-authority"], o["name"]):
            if key:
                org_by_area.setdefault(key, o["entity"])
    for f in features:
        p = f["properties"]
        entity = (
            org_by_area.get(p["reference"])
            or org_by_area.get(p["name"])
            or org_by_area.get(f"{p['name']} Local Planning Group")
        )
        if entity:
            p["organisation-entity"] = entity
    # timetables for plans not in the plan dataset, credited to the current LPAs that
    # published them, so they count in the timeline charts but not as plans
    lpa_refs = {l["organisation"]: l["reference"] for l in lpas if l["reference"]}
    timetable_plans = {}
    for event, entity in unlinked:
        areas = {lpa_refs[o] for o in owners(entity, organisations) if o in lpa_refs}
        if areas:
            timetable_plans.setdefault(event["plan"], set()).update(areas)
            events.append(event)
            event_orgs.append(entity)
    # template records for a new local plan, left out of the plans until an LPA gives
    # them a status or a timetable; ones in use but still named as the template are flagged
    planned = {e["plan"] for e in events}
    templates = []
    for row in list(rows):
        row["template"] = row["name"].strip().lower() == TEMPLATE_NAME
        if (
            row["template"]
            and not row["local-plan-process"]
            and row["reference"] not in planned
        ):
            rows.remove(row)
            templates.append(
                {k: row[k] for k in ("reference", "entity", "boundary", "authorities")}
            )
    # only plans in the dataset are listed as having problems
    issues = [i for i in flag_reused_references(events) if i["plan"] in refs]
    # an LPA has timetable data if it, or a planning group it belongs to, published dated rows
    with_data = {o for e in publishers for o in owners(e, organisations)}
    for l in lpas:
        l["timetable-data"] = l["organisation"] in with_data
    # who published each event: any organisation but government, or one with its own endpoint
    by_entity = {o["entity"]: o["organisation"] for o in organisations.values()}
    event_counts = {
        "total": len(events),
        "lpa": sum(
            not by_entity.get(o, "government-organisation").startswith("government")
            for o in event_orgs
        ),
        "endpoint": sum(by_entity.get(o) in providers for o in event_orgs),
    }
    submissions = (
        lpa_submissions([topic["dataset"], topic["timetable"]], lpas, organisations)
        if lpas
        else []
    )
    out = {
        "plans": rows,
        "issues": issues,
        "boundaries": {"type": "FeatureCollection", "features": features},
        "events": events,
        "current-lpas": lpas,
        "timetable-endpoints": endpoints,
        "timetable-events": event_counts if lpas else {},
        "lpa-submissions": submissions,
        "notices": lpa_notices(notices, lpas, organisations) if lpas else [],
        "templates": templates,
        "timetable-plans": [
            {"reference": r, "authorities": ";".join(sorted(a))}
            for r, a in sorted(timetable_plans.items())
        ],
        "counts": {
            "plans": len(rows),
            "boundaries": len(boundaries),
            "events": len(events),
        },
    }
    DATA.mkdir(exist_ok=True)
    name = f"{slug}-{quality}" if quality else slug
    (DATA / f"{name}.json").write_text(json.dumps(out, separators=(",", ":")))
    print(name, out["counts"])


if __name__ == "__main__":
    topics = json.load(open("topics.json"))
    for slug in sys.argv[1:] or topics:
        build(slug, topics[slug])
        build(slug, topics[slug], "authoritative")
