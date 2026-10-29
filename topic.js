// GOV.UK colours, one per meaning across the page
const COLOUR = {
  progress: "#1d70b8", // blue
  adopted: "#00703c", // green
  withdrawn: "#d4351c", // red
  submitted: "#f47738", // orange
  notStated: "#505a5f", // dark grey
  newPlan: "#d53880", // pink
  sound: "#4c2c92", // purple
};
const GROUPS = {
  preparing: { label: "Preparation and timetable", colour: "#5694ca" },
  draft: { label: "Draft and consultation", colour: COLOUR.progress },
  submitted: { label: "Submitted for examination", colour: COLOUR.submitted },
  sound: { label: "Found sound or inspector report", colour: COLOUR.sound },
  adopted: { label: "Adopted", colour: COLOUR.adopted },
  withdrawn: { label: "Withdrawn", colour: COLOUR.withdrawn },
};
const EVENT_GROUP = {
  "timetable-published": "preparing",
  "publish-notice-intention-commence": "preparing",
  "publish-notice-of-intention-to-commence-local-plan-preparation": "preparing",
  "Notice of Intention to Commence Plan": "preparing",
  "gateway-1-self-assessment": "preparing",
  "gateway-1:-self-assessment-of-readiness": "preparing",
  "call-for-sites-start": "preparing",
  "SEA-scoping-report-consultation-start": "preparing",
  "plan-content-evidence-consultation-start": "draft",
  "consultation:-proposed-local-plan-content-and-evidence-start": "draft",
  "consultation:-proposed-local-plan-start": "draft",
  "main-modification-consultation-start": "draft",
  "additional-consultation-start": "draft",
  "planning-inspectorate-examination-start": "submitted",
  "submission-to-examination": "submitted",
  "planning-inspectorate-examination-end": "sound",
  adoption: "adopted",
  "reg-18-draft-local-plan-published": "draft",
  "reg-18-consultation-start": "draft",
  "reg-18-public-consultation-start": "draft",
  "reg-19-publication-local-plan-published": "draft",
  "reg-19-public-consultation-start": "draft",
  "proposed-plan-consultation-start": "draft",
  "scoping-consultation-start": "draft",
  "content-consultation-start": "draft",
  "submit-plan-for-examination": "submitted",
  "examination-submitted": "submitted",
  "planning-inspectorate-found-sound": "sound",
  "examination-recommendations-published": "sound",
  "inspector-report-published": "sound",
  "plan-adopted": "adopted",
  adopted: "adopted",
  "plan-withdrawn": "withdrawn",
};
const STAGES = ["Early consultation", "Publication", "Submitted", "Examination concluded", "Adopted"];
const STATUS_LABEL = {
  adopted: "Adopted",
  "regulation-18": "Regulation 18 consultation",
  "regulation-19": "Regulation 19 consultation",
  examination: "Examination",
  draft: "Draft",
  "": "Not stated",
};
const PAGE_SIZE = 20;

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const fmt = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "";
// start-date records adoption; adopted-date is deprecated but still used by some publishers
const adoptedDate = (p) => p["start-date"] || p["adopted-date"];
const isAdopted = (p) => p["local-plan-process"] === "adopted" || Boolean(adoptedDate(p));
const statusOf = (p) => STATUS_LABEL[p["local-plan-process"]] ?? p["local-plan-process"];
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const slugFromPath = () => new URLSearchParams(location.search).get("topic");

let topic, data, quality, planByRef, noticeAreas, lpaRefs, timetableStage, state = { page: 1 };

async function init() {
  const slug = slugFromPath();
  // ask the server each time so a rebuilt data file shows straight away
  const topics = await (await fetch("topics.json", { cache: "no-cache" })).json();
  topic = topics[slug];
  if (!topic) {
    $("error").hidden = false;
    $("error-text").textContent = `Topic "${slug}" not found. Try ${Object.keys(topics).join(", ")}.`;
    return;
  }
  // authoritative data only, or all data including the historic data we seeded
  quality = new URLSearchParams(location.search).get("quality") === "authoritative" ? "authoritative" : null;
  $("authoritative").checked = Boolean(quality);
  $("authoritative").addEventListener("change", (e) => {
    const params = new URLSearchParams(location.search);
    if (e.target.checked) params.set("quality", "authoritative");
    else params.delete("quality");
    location.search = params;
  });
  data = await (await fetch(`data/${slug}${quality ? `-${quality}` : ""}.json`, { cache: "no-cache" })).json();
  data.plans.sort((a, b) => a.name.localeCompare(b.name));
  // only keep timetables linked to a plan in the dataset, or credited to an LPA by the build
  const refs = new Set([...data.plans, ...(data["timetable-plans"] ?? [])].map((p) => p.reference));
  data.events = data.events.filter((e) => refs.has(e.plan));
  // LPA areas that have given notice of a new local plan, even if the plan isn't in the dataset yet
  noticeAreas = new Set((data.notices ?? []).map((n) => n.reference));
  // LPA references, current and former, for telling them apart from other authority codes
  lpaRefs = new Set([...data.boundaries.features.filter((f) => f.properties.lpa).map((f) => f.properties.reference), ...(data["current-lpas"] ?? []).map((l) => l.reference)]);
  // the furthest stage each plan has actually reached in its timetable
  timetableStage = {};
  data.events.forEach((e) => {
    if (e.stage != null && e.date && e.date <= TODAY && !e.suspect) timetableStage[e.plan] = Math.max(timetableStage[e.plan] ?? 0, e.stage);
    else timetableStage[e.plan] ??= -1;
  });
  document.title = `${topic.name} - Planning Data`;
  $("crumb").textContent = topic.name;
  $("heading").textContent = topic.name;
  $("summary").textContent = topic.summary;
  renderStats();
  renderMap();
  renderCoverage();
  renderTimeline();
  renderLinks();
  renderDatasets();
  setupSearch();
}

// the LPAs a plan covers. Some plans list their authorities by another code, such as an ONS
// code, so those are left out and the boundary used instead, when either gives LPA references.
function lpasOf(p) {
  const split = (s) => (s || "").split(/[;-]/).filter(Boolean);
  for (const codes of [split(p.authorities), split(p.boundary)]) {
    const lpas = codes.filter((r) => lpaRefs.has(r));
    if (lpas.length) return lpas;
  }
  return split(p.authorities || p.boundary);
}

function renderStats() {
  const plans = data.plans;
  const adopted = plans.filter(isAdopted).length;
  const plural = `${topic.singular}s`;
  const features = data.boundaries.features;
  const onMap = plans.filter((p) => features.some((f) => f.properties.reference === p.boundary));
  const stats = [
    [plans.length, `${plural} on the platform`],
    [adopted, "adopted"],
    [onMap.length, `${plural} with a boundary, ${plans.length - onMap.length} without`],
  ];
  if (data["current-lpas"].length) {
    // a plan can cover several LPAs, either as a joint plan or through a joint planning group
    const lpas = data["current-lpas"];
    const withPlan = new Set();
    const withAdopted = new Set();
    plans.forEach((p) =>
      lpasOf(p).forEach((r) => {
        withPlan.add(r);
        if (isAdopted(p)) withAdopted.add(r);
      })
    );
    const share = (set) => {
      const n = lpas.filter((l) => set.has(l.reference)).length;
      return `${n} (${Math.round((n / lpas.length) * 100)}%)`;
    };
    stats.push(
      [lpas.length, "current local planning authorities (LPAs)"],
      [share(withPlan), `of current LPAs covered by a ${topic.singular}`],
      [share(withAdopted), `of current LPAs covered by an adopted ${topic.singular}`],
      [share(noticeAreas), `of current LPAs have given notice of intention to commence a new ${topic.singular}`]
    );
  } else {
    const current = features.filter((f) => !(f.properties["end-date"] && f.properties["end-date"] <= TODAY)).length;
    stats.push([current, "current authorities with a boundary"]);
  }
  if (topic.expected) stats.push([topic.expected, topic.expectedNote + " in England"]);
  $("stats").innerHTML = stats
    .map(([n, l]) => `<div class="stat"><strong>${typeof n === "number" ? n.toLocaleString("en-GB") : n}</strong><span>${esc(l)}</span></div>`)
    .join("");
}

// what a plan says about the authority, most significant first
const PLAN_STATES = ["new", "existing", "adopted", "noAdopted", "unknown"];
function planState(p) {
  const process = p["local-plan-process"];
  if (adoptedDate(p)) return "adopted";
  if (process === "withdrawn") return "noAdopted";
  // a timetable with gateway events or a notice of intention to commence, predicted or
  // actual, is under the new plan-making system
  if (p["new-system"]) return "new";
  if (isAdopted(p)) return "adopted";
  if (process) return "existing";
  // no status, so go by the timetable: adopted if it has reached adoption, otherwise in progress
  const stage = timetableStage[p.reference];
  if (stage === undefined) return "unknown";
  return stage === 4 ? "adopted" : "existing";
}

// the status of an area, in the order of the map key
function stateDefs() {
  return [
    ["new", COLOUR.newPlan, `New system ${topic.singular} being developed`],
    ["existing", COLOUR.progress, `Existing system ${topic.singular} being developed`],
    ["adopted", COLOUR.adopted, `There is an adopted ${topic.singular} in place`],
    ["noAdopted", COLOUR.withdrawn, `No adopted ${topic.singular} is in place`],
    // with authoritative data only, most areas are unknown because they have no plans at all
    ["unknown", null, quality ? "No authoritative plan data" : "Unknown status"],
  ];
}

// an LPA that has given notice of a new plan is under the new system, whether or not
// that plan is in the dataset
function boundaryState(plans, ref) {
  const states = new Set(plans.map(planState));
  if (noticeAreas.has(ref)) states.add("new");
  return PLAN_STATES.find((s) => states.has(s)) ?? "unknown";
}

function boundaryColour(plans, ref) {
  return { new: COLOUR.newPlan, existing: COLOUR.progress, adopted: COLOUR.adopted, noAdopted: COLOUR.withdrawn, unknown: COLOUR.notStated }[boundaryState(plans, ref)];
}

// a template record in use, still named as the template
const templateTag = (p) => (p.template ? ` <strong class="govuk-tag govuk-tag--grey">Template not updated</strong>` : "");

function planLine(p) {
  const hasEvents = data.events.some((e) => e.plan === p.reference);
  return `<li><a class="govuk-link" href="https://www.planning.data.gov.uk/entity/${esc(p.entity)}">${esc(p.name)}</a>${templateTag(p)} (${esc(statusOf(p))})${
    hasEvents ? ` <a class="govuk-link" href="#timeline-heading" data-timeline="${esc(p.reference)}">timeline</a>` : ""
  }</li>`;
}

const polygons = (g) => (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates]);
const ringArea = (r) => Math.abs(r.reduce((s, [x1, y1], i) => { const [x2, y2] = r[(i + 1) % r.length]; return s + x1 * y2 - x2 * y1; }, 0)) / 2;
const featureArea = (f) => polygons(f.geometry).reduce((s, [outer, ...holes]) => s + ringArea(outer) - holes.reduce((h, r) => h + ringArea(r), 0), 0);
// even-odd test over every ring, so holes are excluded
function featureContains(f, [x, y]) {
  let inside = false;
  for (const ring of polygons(f.geometry).flat())
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const [[x1, y1], [x2, y2]] = [ring[i], ring[k]];
      if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
    }
  return inside;
}

const bbox = (f) => {
  const pts = polygons(f.geometry).flat(2);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
};

// former authorities that now sit (almost) wholly inside a current boundary, such as the
// four districts that became Somerset Council, found by sampling points across each one
function predecessors(features) {
  const out = {};
  const current = features.filter((f) => !f.properties.former).map((f) => [f, bbox(f)]);
  for (const old of features.filter((f) => f.properties.former)) {
    const [x0, y0, x1, y1] = bbox(old);
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const samples = [];
    for (let i = 0.5; i < 20; i++)
      for (let k = 0.5; k < 20; k++) {
        const p = [x0 + ((x1 - x0) * i) / 20, y0 + ((y1 - y0) * k) / 20];
        if (featureContains(old, p)) samples.push(p);
      }
    for (const [f, [a, b, c, d]] of current) {
      if (f.properties.area <= old.properties.area || cx < a || cx > c || cy < b || cy > d) continue;
      if (samples.length && samples.filter((p) => featureContains(f, p)).length >= 0.9 * samples.length)
        (out[f.properties.reference] ??= []).push(old);
    }
  }
  Object.values(out).forEach((olds) => olds.sort((a, b) => a.properties.name.localeCompare(b.properties.name)));
  return out;
}

const boundaryName = (f) => f.properties.name + (f.properties.former ? " (former)" : "");

function renderMap() {
  // an LPA area takes every plan that covers it, including joint plans, as in the area
  // covered chart; other areas, such as joint planning groups, take plans with their boundary
  const byBoundary = {};
  const byLpa = {};
  data.plans.forEach((p) => {
    (byBoundary[p.boundary] ??= []).push(p);
    lpasOf(p).forEach((r) => (byLpa[r] ??= []).push(p));
  });
  planByRef = {};
  data.boundaries.features.forEach(({ properties: { reference, lpa } }) => (planByRef[reference] = (lpa ? byLpa : byBoundary)[reference] ?? []));
  // a fixed map: areas can be selected, but not panned or zoomed
  const map = L.map("map", {
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
  }).setView([52.9, -1.6], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);
  // boundaries overlap (joint plans, reorganised councils), so draw them opaque in one
  // see-through pane so overlaps don't darken: former authorities underneath, then
  // current ones with the largest (e.g. new unitary councils) on top
  map.createPane("boundaries").classList.add("boundaries-pane");
  const today = new Date().toISOString().slice(0, 10);
  const features = data.boundaries.features
    .map((f) => ({ ...f, properties: { ...f.properties, area: featureArea(f), former: Boolean(f.properties["end-date"]) && f.properties["end-date"] <= today } }))
    .sort((a, b) => b.properties.former - a.properties.former || a.properties.area - b.properties.area);
  const layer = L.geoJSON({ type: "FeatureCollection", features }, {
    pane: "boundaries",
    style: (f) => ({
      color: "#0b0c0c",
      weight: 1,
      // authorities with an unknown status are see-through, but still selectable
      fillOpacity: boundaryState(planByRef[f.properties.reference] ?? [], f.properties.reference) === "unknown" ? 0 : 1,
      fillColor: boundaryColour(planByRef[f.properties.reference] ?? [], f.properties.reference),
    }),
    onEachFeature: (f, l) => l.bindTooltip(esc(boundaryName(f))),
  }).addTo(map);
  const formerOf = predecessors(features);
  // outline the selected boundary along its edge, in the GOV.UK focus colours
  map.createPane("selected").classList.add("selected-pane");
  const selected = L.layerGroup().addTo(map);
  // list the plans for every boundary under the click, top of the map first, with each
  // current authority followed by all the former authorities it replaced
  layer.on("click", (e) => {
    const here = features.filter((f) => featureContains(f, [e.latlng.lng, e.latlng.lat])).reverse();
    const shown = new Set();
    const sections = here.flatMap((f) => {
      if (shown.has(f)) return [];
      const olds = (formerOf[f.properties.reference] ?? []).filter((o) => !shown.has(o));
      [f, ...olds].forEach((x) => shown.add(x));
      return [f, ...olds];
    });
    selected.clearLayers();
    if (here[0])
      [{ color: "#0b0c0c", weight: 6 }, { color: "#ffdd00", weight: 3 }].forEach((style) =>
        L.geoJSON(here[0], { pane: "selected", interactive: false, style: { ...style, fill: false } }).addTo(selected),
      );
    toggleMapPanel(true, false);
    $("map-selected").innerHTML = sections
      .map((f) => {
        const plans = planByRef[f.properties.reference] ?? [];
        return (
          `<h3 class="govuk-heading-s">${esc(boundaryName(f))}</h3>` +
          (plans.length
            ? `<ul class="govuk-list">${plans.map(planLine).join("")}</ul>`
            : `<p class="govuk-body">No ${topic.singular} covers this area.</p>`)
        );
      })
      .join("");
  });
  // keep boundaries clear of the key panel, unless the map is too narrow to fit both
  const keyWidth = $("map-panel").offsetWidth + 30;
  const padRight = map.getSize().x - keyWidth >= 300 ? keyWidth : 0;
  if (layer.getBounds().isValid()) map.fitBounds(layer.getBounds(), { paddingBottomRight: [padRight, 0] });
  const noBoundary = plansWithoutBoundary().length;
  // current areas by status; former authorities underneath are left out
  const counts = {};
  features
    .filter((f) => !f.properties.former)
    .forEach((f) => {
      const s = boundaryState(planByRef[f.properties.reference] ?? [], f.properties.reference);
      counts[s] = (counts[s] ?? 0) + 1;
    });
  $("legend").innerHTML =
    stateDefs()
      .map(([s, c, l]) => `<div class="legend-item"><span class="swatch"${c ? ` style="background:${c}"` : ""}></span>${l}: <strong>${counts[s] ?? 0}</strong></div>`)
      .join("") +
    `<p class="govuk-body-s">${data.events.length ? `<a class="govuk-link" href="#boundaries-heading" data-open="missing-boundaries">${noBoundary}</a>` : noBoundary} of ${data.plans.length} plans have no boundary on the map. Select an area to see its plans.</p>`;
  document.querySelector(".map-panel__close").addEventListener("click", () => toggleMapPanel(false));
  document.querySelector(".map-panel__open").addEventListener("click", () => toggleMapPanel(true));
}

function toggleMapPanel(open, moveFocus = true) {
  const [panel, openBtn] = [$("map-panel"), document.querySelector(".map-panel__open")];
  panel.hidden = !open;
  openBtn.hidden = open;
  openBtn.setAttribute("aria-expanded", open);
  if (moveFocus) (open ? panel : openBtn).focus();
}

// a single stacked bar, as wide as the page, with a key below
function stackedBar(title, intro, segments) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const [w, h] = [960, 56];
  let x = 0;
  let svg = `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;min-width:640px" role="img" aria-label="${esc(title)}">`;
  segments.forEach((s) => {
    const sw = total ? (s.value / total) * w : 0;
    if (sw > 0) {
      const fill = s.colour ?? "#f3f2f1";
      svg += `<rect x="${x}" y="0" width="${sw}" height="${h}" fill="${fill}" stroke="${s.colour ? "#fff" : "#b1b4b6"}"><title>${esc(s.label)}: ${esc(s.text)}</title></rect>`;
      if (sw > 40) svg += `<text x="${x + sw / 2}" y="${h / 2 + 5}" text-anchor="middle" font-size="16" font-weight="700" style="fill:${s.colour ? "#fff" : "#0b0c0c"}">${esc(s.short)}</text>`;
    }
    x += sw;
  });
  svg += `</svg>`;
  const key = segments
    .map((s) => `<div class="legend-item"><span class="swatch"${s.colour ? ` style="background:${s.colour}"` : ""}></span>${esc(s.label)}: <strong>${esc(s.text)}</strong></div>`)
    .join("");
  return `<h3 class="govuk-heading-m" id="${slugify(title)}">${esc(title)}</h3><p class="govuk-body">${intro}</p><div class="chart-wrap">${svg}</div><div class="chart-key">${key}</div>`;
}

// approximate area in square kilometres of a boundary drawn in degrees
function areaKm2(f) {
  const [, south, , north] = bbox(f);
  return featureArea(f) * Math.cos(((south + north) / 2) * (Math.PI / 180)) * 111.19 * 111.19;
}

function renderCoverage() {
  const defs = stateDefs();
  const pct = (v, total) => `${Math.round((v / total) * 100)}%`;
  const current = data.boundaries.features.filter((f) => !(f.properties["end-date"] && f.properties["end-date"] <= TODAY));

  // 1. areas on the map, as in the map key
  const areas = {};
  current.forEach((f) => {
    const s = boundaryState(planByRef[f.properties.reference] ?? [], f.properties.reference);
    areas[s] = (areas[s] ?? 0) + 1;
  });
  const lpaCount = current.filter((f) => f.properties.lpa).length;
  const groups = current.filter((f) => !f.properties.lpa && f.properties.reference.includes("-")).length;
  const others = current.filter((f) => !f.properties.lpa && !f.properties.reference.includes("-")).map((f) => f.properties.name);
  const lpas = data["current-lpas"] ?? [];
  const explanation = lpas.length
    ? ` These are ${lpaCount} LPA areas, ${groups} joint planning groups that cover several LPAs${others.length ? ` and ${others.length} other ${others.length === 1 ? "authority" : "authorities"}, ${others.join(", ")}` : ""}. The ${lpas.length} current LPAs are organisations, and ${lpas.length - lpaCount} of them have no area on the map.`
    : "";
  const chart1 = stackedBar(
    "Active areas",
    `${current.length} current areas on the map, by the status of their plans. These are the numbers in the map key.${explanation}`,
    defs.map(([s, colour, label]) => ({ label, colour, value: areas[s] ?? 0, short: `${areas[s] ?? 0}`, text: `${areas[s] ?? 0} (${pct(areas[s] ?? 0, current.length)})` }))
  );

  // 2. the same, weighted by the size of each LPA. Joint planning groups overlap their LPAs, so only LPAs are used.
  const lpaAreas = current.filter((f) => f.properties.lpa);
  const size = {};
  let totalSize = 0;
  lpaAreas.forEach((f) => {
    const ref = f.properties.reference;
    const s = boundaryState(data.plans.filter((p) => lpasOf(p).includes(ref)), ref);
    const km = areaKm2(f);
    size[s] = (size[s] ?? 0) + km;
    totalSize += km;
  });
  const km = (v) => `${Math.round(v).toLocaleString("en-GB")} km²`;
  const chart2 = stackedBar(
    "Area covered",
    `${lpaAreas.length} current LPAs, by the area they cover (about ${km(totalSize)}) and the status of the plans that cover them, including joint plans. Areas are approximate.`,
    defs.map(([s, colour, label]) => ({ label, colour, value: size[s] ?? 0, short: pct(size[s] ?? 0, totalSize), text: `${km(size[s] ?? 0)} (${pct(size[s] ?? 0, totalSize)})` }))
  );

  // 3. every plan on the platform
  const plans = {};
  data.plans.forEach((p) => (plans[planState(p)] = (plans[planState(p)] ?? 0) + 1));
  const planLabels = {
    new: `New system ${topic.singular}s being developed`,
    existing: `Existing system ${topic.singular}s being developed`,
    adopted: `Adopted ${topic.singular}s`,
    noAdopted: `Withdrawn ${topic.singular}s`,
    unknown: "Unknown status",
  };
  const chart3 = stackedBar(
    "Plans on the platform",
    `${data.plans.length} ${topic.singular}s, by status. A plan with gateway events or a notice of intention to commence in its timetable is under the new system.`,
    defs.map(([s, colour]) => ({ label: planLabels[s], colour, value: plans[s] ?? 0, short: `${plans[s] ?? 0}`, text: `${plans[s] ?? 0} (${pct(plans[s] ?? 0, data.plans.length)})` }))
  );
  $("coverage").innerHTML = chart1 + chart2 + chart3 + renderNotices() + renderTemplates();
}

// template records for a new local plan: unused ones, left out of the plans, and ones in use
// that still have the template name
function renderTemplates() {
  const unused = data.templates ?? [];
  const used = data.plans.filter((p) => p.template);
  if (!unused.length && !used.length) return "";
  const lpaNames = Object.fromEntries((data["current-lpas"] ?? []).map((l) => [l.reference, l.name]));
  const name = (t) => lpasOf(t).map((r) => lpaNames[r] ?? r).join(", ") || t.reference;
  const list = (title, items, item) =>
    items.length
      ? `<details class="govuk-details"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">${title}</span></summary><div class="govuk-details__text"><ul class="govuk-list govuk-list--bullet">${items
          .map((t) => ({ t, n: name(t) }))
          .sort((a, b) => a.n.localeCompare(b.n))
          .map(({ t, n }) => `<li>${item(t, n)}</li>`)
          .join("")}</ul></div></details>`
      : "";
  const link = (t, text) => `<a class="govuk-link" href="https://www.planning.data.gov.uk/entity/${esc(t.entity)}">${esc(text)}</a>`;
  return (
    `<h3 class="govuk-heading-m" id="templates-heading">Template records for a new ${topic.singular}</h3>` +
    `<p class="govuk-body">LPAs are given a template record, named "Emerging new ${topic.singular}", to fill in when they start a new ${topic.singular}. ${unused.length} have not been filled in yet: they have no status and no timetable, so they are left out of the ${topic.singular}s on this page. ${used.length} have a status or a timetable but still have the template name.</p>` +
    list(`List the ${unused.length} template records not filled in`, unused, (t, n) => link(t, n)) +
    list(`List the ${used.length} template records in use that still have the template name`, used, (t, n) => `${link(t, n)} (${esc(statusOf(t))})`)
  );
}

// current LPAs that have given notice of intention to commence a new plan
function renderNotices() {
  const notices = data.notices ?? [];
  if (!notices.length) return "";
  const lpas = Object.fromEntries(data["current-lpas"].map((l) => [l.organisation, l]));
  const plans = Object.fromEntries(data.plans.map((p) => [p.reference, p]));
  const count = new Set(notices.map((n) => n.organisation)).size;
  const unlinked = new Set(notices.filter((n) => !n.linked).map((n) => n.organisation)).size;
  const th = (t) => `<th scope="col" class="govuk-table__header">${t}</th>`;
  const rows = notices
    .map((n) => ({ ...n, name: lpas[n.organisation]?.name ?? n.organisation }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.plan.localeCompare(b.plan))
    .map((n) => {
      const p = plans[n.plan];
      const plan = p ? `<a class="govuk-link" href="https://www.planning.data.gov.uk/entity/${esc(p.entity)}">${esc(p.name)}</a>` : `${esc(n.plan)} <strong class="govuk-tag govuk-tag--yellow">Not in ${esc(topic.dataset)}</strong>`;
      return `<tr class="govuk-table__row"><td class="govuk-table__cell"><a class="govuk-link" href="https://provide.planning.data.gov.uk/organisations/${esc(n.organisation)}">${esc(n.name)}</a></td><td class="govuk-table__cell">${plan}</td><td class="govuk-table__cell">${fmt(n.date)}</td></tr>`;
    })
    .join("");
  return (
    `<h3 class="govuk-heading-m" id="notices-heading">Notice of intention to commence</h3>` +
    `<p class="govuk-body">${count} current LPAs have given notice of intention to commence a new ${topic.singular}, from the notice dates in their timetables. A notice from a planning group counts for each LPA in the group. For ${unlinked} of these LPAs, the timetable refers to a plan that isn't in the ${esc(topic.dataset)} dataset, so the plan can't be shown on its own. They are still shown as developing a new system ${topic.singular} on the map.</p>` +
    `<details class="govuk-details" id="notices"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">List the ${count} LPAs</span></summary><div class="govuk-details__text">` +
    `<table class="govuk-table"><thead class="govuk-table__head"><tr class="govuk-table__row">${th("LPA")}${th("Plan")}${th("Notice given")}</tr></thead><tbody class="govuk-table__body">${rows}</tbody></table></div></details>`
  );
}

function renderTimeline() {
  const el = $("timeline");
  if (!data.events.length) {
    $("timeline-heading").hidden = true;
    el.innerHTML = `<p class="govuk-body">No timetable data is available for ${esc(topic.name.toLowerCase())} yet.</p>`;
    $("timeline-heading").hidden = false;
    return;
  }
  const counts = {};
  data.events.forEach((e) => {
    const g = EVENT_GROUP[e.event];
    const y = (e.date || "").slice(0, 4);
    if (!g || !y || e.suspect) return;
    ((counts[y] ??= {})[g] ??= new Set()).add(e.plan);
  });
  const years = Object.keys(counts).map(Number).filter((y) => y >= 2004);
  const [y0, y1] = [Math.min(...years), Math.max(...years)];
  const groups = Object.keys(GROUPS);
  const totals = (y) => groups.reduce((s, g) => s + (counts[y]?.[g]?.size ?? 0), 0);
  const biggest = Math.max(...years.map(totals));
  // round the axis up to the next gridline so the tallest bar sits under a label
  const step = Math.ceil(biggest / 5 / 10) * 10;
  const max = Math.ceil(biggest / step) * step;
  const [w, h, ml, mb, mt] = [960, 320, 40, 30, 10];
  const bw = (w - ml) / (y1 - y0 + 1);
  const sy = (v) => h - mb - (v / max) * (h - mb - mt);
  let svg = `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;min-width:640px" role="img" aria-label="Stacked bar chart of plans reaching each milestone by year">`;
  for (let t = 0; t <= max; t += step) {
    svg += `<line class="grid" x1="${ml}" x2="${w}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${ml - 6}" y="${sy(t) + 4}" text-anchor="end">${t}</text>`;
  }
  for (let y = y0; y <= y1; y++) {
    let base = h - mb;
    const x = ml + (y - y0) * bw;
    groups.forEach((g) => {
      const n = counts[y]?.[g]?.size ?? 0;
      if (!n) return;
      const bh = (n / max) * (h - mb - mt);
      base -= bh;
      svg += `<rect x="${x + 3}" y="${base}" width="${bw - 6}" height="${bh}" fill="${GROUPS[g].colour}"><title>${y}: ${n} ${GROUPS[g].label.toLowerCase()}</title></rect>`;
    });
    if ((y - y0) % 2 === 0) svg += `<text x="${x + bw / 2}" y="${h - 10}" text-anchor="middle">${y}</text>`;
  }
  svg += `<line class="axis" x1="${ml}" x2="${w}" y1="${h - mb}" y2="${h - mb}"/></svg>`;
  const timetableOnly = data["timetable-plans"]?.length ?? 0;
  el.innerHTML =
    `<p class="govuk-body">Number of plans reaching each milestone, by year, from the timetable dataset. ${data.events.length.toLocaleString("en-GB")} events across ${new Set(data.events.map((e) => e.plan)).size} plans${
      timetableOnly ? `, including ${timetableOnly} timetables for plans that aren't in the ${esc(topic.dataset)} dataset` : ""
    }.</p>` +
    `<div class="chart-key">${groups.map((g) => `<span class="legend-item"><span class="swatch" style="background:${GROUPS[g].colour}"></span>${GROUPS[g].label}</span>`).join("")}</div>` +
    `<div class="chart-wrap">${svg}</div>` +
    renderJourney() +
    `<div id="plan-timeline" aria-live="polite"></div>` +
    `<p class="govuk-body-s">Select a plan on the map or in the search results to see its own timetable.</p>` +
    renderFlows() +
    renderTimetableProviders() +
    renderSubmissions() +
    renderIssues() +
    renderMissingBoundaries();
}

const TODAY = new Date().toISOString().slice(0, 10);
const isPredicted = (e) => Boolean(e.earliest) || e.event.startsWith("estimated-") || e.date > TODAY;

function renderJourney() {
  const byPlan = {};
  // one line per plan in the dataset, so each can show its own timetable
  const inDataset = new Set(data.plans.map((p) => p.reference));
  data.events.forEach((e) => {
    const stage = e.stage;
    if (stage == null || !e.date || e.suspect || !inDataset.has(e.plan)) return;
    const stages = (byPlan[e.plan] ??= {});
    if (!stages[stage] || e.date < stages[stage].date) stages[stage] = { date: e.date, predicted: isPredicted(e) };
  });
  const withdrawn = new Set(data.events.filter((e) => e.event === "plan-withdrawn").map((e) => e.plan));
  const names = Object.fromEntries(data.plans.map((p) => [p.reference, p.name]));
  const journeys = Object.entries(byPlan)
    .map(([ref, st]) => ({
      ref,
      points: Object.entries(st)
        .map(([stage, v]) => ({ stage: +stage, t: new Date(v.date).getTime(), date: v.date, predicted: v.predicted }))
        .filter((p) => p.t >= Date.UTC(2004, 0, 1))
        .sort((a, b) => a.stage - b.stage),
      outcome: withdrawn.has(ref) ? "withdrawn" : st[4] ? "adopted" : "progress",
    }))
    .filter((j) => j.points.length >= 2);
  if (!journeys.length) return "";
  const colour = { adopted: COLOUR.adopted, progress: COLOUR.progress, withdrawn: COLOUR.withdrawn };
  const label = { adopted: "Adopted", progress: "In progress", withdrawn: "Withdrawn" };
  const t0 = Date.UTC(2004, 0, 1);
  const t1 = Math.max(...journeys.flatMap((j) => j.points.map((p) => p.t)));
  const [y0, y1] = [2004, new Date(t1).getUTCFullYear() + 1];
  const [w, h, ml, mr, mt, mb] = [Math.max(760, (y1 - y0) * 40 + 200), 360, 170, 20, 10, 30];
  const sx = (t) => ml + ((t - t0) / (Date.UTC(y1, 0, 1) - t0)) * (w - ml - mr);
  const sy = (s) => h - mb - (s / (STAGES.length - 1)) * (h - mb - mt - 20) - 10;
  let svg = `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;min-width:640px" role="img" aria-label="Bump chart of each plan's progress through the stages over time">`;
  STAGES.forEach((l, i) => (svg += `<line class="grid" x1="${ml}" x2="${w - mr}" y1="${sy(i)}" y2="${sy(i)}"/><text x="${ml - 8}" y="${sy(i) + 4}" text-anchor="end">${l}</text>`));
  for (let y = y0; y <= y1; y += 2) svg += `<text x="${sx(Date.UTC(y, 0, 1))}" y="${h - 8}" text-anchor="middle">${y}</text>`;
  const days = (a, b) => (b - a) / 864e5;
  const order = { progress: 0, withdrawn: 1, adopted: 2 };
  journeys
    .sort((a, b) => order[a.outcome] - order[b.outcome])
    .forEach((j) => {
      const xy = (p) => `${sx(p.t).toFixed(1)},${sy(p.stage).toFixed(1)}`;
      const actual = j.points.filter((p) => !p.predicted);
      const pts = actual.map(xy).join(" ");
      // dashed segments lead to predicted (future) stages
      const future = j.points
        .map((p, i) => (p.predicted && i ? `${xy(j.points[i - 1])} ${xy(p)}` : ""))
        .filter(Boolean);
      const [a, b] = [j.points[0], j.points.at(-1)];
      const dur = ((days(a.t, b.t) / 365.25)).toFixed(1);
      svg += `<polyline class="journey" data-timeline="${esc(j.ref)}" points="${pts}" fill="none" stroke="${colour[j.outcome]}"><title>${esc(names[j.ref] ?? j.ref)}: ${esc(STAGES[a.stage])} to ${esc(STAGES[b.stage])} in ${dur} years (${label[j.outcome].toLowerCase()})</title></polyline>`;
      future.forEach((f) => (svg += `<polyline class="journey journey--predicted" data-timeline="${esc(j.ref)}" points="${f}" fill="none"><title>${esc(names[j.ref] ?? j.ref)}: predicted dates</title></polyline>`));
    });
  svg += `</svg>`;
  const durations = journeys
    .filter((j) => j.outcome === "adopted" && j.points[0].stage < 3)
    .map((j) => days(j.points[0].t, j.points.at(-1).t) / 365.25)
    .sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)].toFixed(1) : null;
  return (
    `<h3 class="govuk-heading-m" id="progress-heading">Progress through the stages</h3>` +
    `<p class="govuk-body">One line per plan, from the first date recorded at each stage. ${journeys.length} plans have dates for at least two stages.${
      median ? ` For the ${durations.length} adopted plans with early consultation or publication dates, the median time from first recorded stage to adoption is ${median} years.` : ""
    } Select a line to see the plan's timetable.</p>` +
    `<div class="chart-key">${Object.keys(colour).map((k) => `<span class="legend-item"><span class="swatch" style="background:${colour[k]}"></span>${label[k]}</span>`).join("")}<span class="legend-item"><span class="swatch swatch--predicted"></span>Predicted</span></div>` +
    `<div class="chart-wrap">${svg}</div>`
  );
}

// plans with no boundary reference, or one that isn't in the boundary data
function plansWithoutBoundary() {
  const refs = new Set(data.boundaries.features.map((f) => f.properties.reference));
  return data.plans.filter((p) => !refs.has(p.boundary));
}


const lpaProblem = (p) => ({ 0: "No LPA recorded", 1: "Unknown LPA" })[lpasOf(p).length] ?? "Unknown group";

// current LPAs with no area reference, or none in the boundary data
function lpasWithoutBoundary() {
  const refs = new Set(data.boundaries.features.map((f) => f.properties.reference));
  return (data["current-lpas"] ?? []).filter((l) => !refs.has(l.reference));
}

function renderMissingBoundaries() {
  const missing = plansWithoutBoundary();
  if (!missing.length) return "";
  const noLpa = lpasWithoutBoundary();
  const lpaTable = noLpa.length
    ? `<p class="govuk-body">${noLpa.length} of the ${data["current-lpas"].length} current LPAs have no boundary:</p><ul class="govuk-list govuk-list--bullet">${noLpa
        .map((l) => `<li><a class="govuk-link" href="https://provide.planning.data.gov.uk/organisations/${esc(l.organisation)}">${esc(l.name)}</a> (${l.reference ? `${esc(l.reference)} not in boundary data` : "no LPA area in the organisation data"})</li>`)
        .join("")}</ul>`
    : "";
  const rows = missing
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (p) =>
        `<tr class="govuk-table__row"><td class="govuk-table__cell"><a class="govuk-link" href="https://www.planning.data.gov.uk/entity/${esc(p.entity)}">${esc(p.name)}</a></td><td class="govuk-table__cell">${esc(lpasOf(p).join(", ") || "Not stated")}</td><td class="govuk-table__cell">${esc(statusOf(p) || "Not stated")}</td><td class="govuk-table__cell">${lpaProblem(p)}</td></tr>`
    )
    .join("");
  const th = (t) => `<th scope="col" class="govuk-table__header">${t}</th>`;
  return (
    `<h3 class="govuk-heading-m" id="boundaries-heading">Plans with missing boundaries</h3>` +
    `<p class="govuk-body">${missing.length} of ${data.plans.length} plans can't be shown on the map, because they have no boundary or the boundary isn't in the boundary data.</p>` +
    lpaTable +
    `<details class="govuk-details" id="missing-boundaries"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">List the ${missing.length} plans</span></summary><div class="govuk-details__text">` +
    `<table class="govuk-table"><thead class="govuk-table__head"><tr class="govuk-table__row">${th("Plan")}${th("LPAs")}${th("Status")}${th("Problem")}</tr></thead><tbody class="govuk-table__body">${rows}</tbody></table></div></details>`
  );
}

// stages for the flow charts, in order from preparation to adopted, then withdrawn
const FLOW_STAGES = [
  ["Preparation", "#5694ca"],
  ["Publication", COLOUR.progress],
  ["Submitted", COLOUR.submitted],
  ["Examination concluded", COLOUR.sound],
  ["Adopted", COLOUR.adopted],
  ["Withdrawn", COLOUR.withdrawn],
];
const FLOW_FROM = 2010;
const PREDICTED_COLOUR = "#6f777b";

// dated stage events of each plan, leaving out events flagged as suspect. Predicted ones,
// dated in the future, are kept apart.
function planStages() {
  const actual = {};
  const predicted = {};
  data.events.forEach((e) => {
    const date = e.date || e.earliest;
    if (!date || e.suspect) return;
    const stage = e.event === "plan-withdrawn" ? 5 : e.stage ?? (EVENT_GROUP[e.event] === "preparing" ? 0 : null);
    if (stage === null) return;
    if (date > TODAY) (predicted[e.plan] ??= []).push([date, stage]);
    else if (!isPredicted(e)) (actual[e.plan] ??= []).push([date, stage]);
  });
  return { actual, predicted };
}

// each LPA is at the stage of its most recently active plan on the given date
function lpaStage(plans, stages, date) {
  let best;
  plans.forEach((p) => {
    const events = (stages[p.reference] ?? []).filter(([d]) => d <= date);
    if (!events.length) return;
    const last = events.reduce((m, [d]) => (d > m ? d : m), "");
    const stage = events.some(([, s]) => s === 5) ? 5 : Math.max(...events.map(([, s]) => s));
    if (!best || last + stage > best.key) best = { key: last + stage, stage };
  });
  return best?.stage;
}

function flowChart(title, refs, planFilter, description, marks = [], showPredicted = true) {
  const { actual, predicted } = planStages();
  const byLpa = {};
  [...data.plans, ...(data["timetable-plans"] ?? [])].filter(planFilter).forEach((p) => lpasOf(p).filter((r) => refs.has(r)).forEach((r) => (byLpa[r] ??= []).push(p)));
  const lpas = Object.values(byLpa);
  if (!lpas.length) return "";
  const thisYear = new Date(TODAY).getUTCFullYear();
  // later years use predicted dates too, as far as the timetables go
  const lastPredicted = Math.max(thisYear, ...Object.values(predicted).flat().map(([d]) => +d.slice(0, 4)));
  const years = Array.from({ length: Math.min(showPredicted ? lastPredicted : thisYear, thisYear + 6) - FLOW_FROM + 1 }, (_, i) => FLOW_FROM + i);
  const isFuture = (i) => years[i] > thisYear;
  const withPredicted = Object.fromEntries([...new Set([...Object.keys(actual), ...Object.keys(predicted)])].map((r) => [r, [...(actual[r] ?? []), ...(predicted[r] ?? [])]]));
  const at = years.map((y) => lpas.map((plans) => (y > thisYear ? lpaStage(plans, withPredicted, `${y}-12-31`) : lpaStage(plans, actual, y < thisYear ? `${y}-12-31` : TODAY))));
  const n = FLOW_STAGES.length;
  const counts = at.map((col) => FLOW_STAGES.map((_, s) => col.filter((v) => v === s).length));
  const flows = years.slice(1).map((_, i) => {
    const m = FLOW_STAGES.map(() => FLOW_STAGES.map(() => 0));
    at[i].forEach((a, l) => {
      const b = at[i + 1][l];
      if (a !== undefined && b !== undefined) m[a][b]++;
    });
    return m;
  });

  // each stage has its own band, as tall as its biggest column
  const [w, ml, mr, mt, mb, gap, nodeW] = [960, 150, 20, marks.length ? 40 : 24, 30, 14, 10];
  const peak = FLOW_STAGES.map((_, s) => Math.max(1, ...counts.map((c) => c[s])));
  const k = 440 / peak.reduce((a, b) => a + b, 0);
  const band = [];
  let y = mt;
  peak.forEach((p, s) => {
    const hgt = Math.max(p * k, 16);
    band.push({ top: y, mid: y + hgt / 2 });
    y += hgt + gap;
  });
  const h = y - gap + mb;
  const colX = (i) => ml + (i * (w - ml - mr - nodeW)) / (years.length - 1);
  const nodeH = (i, s) => counts[i][s] * k;
  let svg = `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;min-width:760px" role="img" aria-label="${esc(title)}: flow of LPAs between plan stages each year">`;
  const firstFuture = years.findIndex((_, i) => isFuture(i));
  if (firstFuture > 0) {
    const x = (colX(firstFuture - 1) + nodeW + colX(firstFuture)) / 2;
    svg += `<rect x="${x}" y="${mt - 6}" width="${w - mr - x + 4}" height="${h - mb - mt + 6}" fill="#f3f2f1"/><text x="${(x + w - mr) / 2}" y="${mt - 10}" text-anchor="middle" font-size="12" fill="#505a5f">Predicted</text>`;
  }
  FLOW_STAGES.forEach(([label, colour], s) => {
    svg += `<line class="grid" x1="${ml}" x2="${w - mr}" y1="${band[s].mid}" y2="${band[s].mid}"/><text x="${ml - 12}" y="${band[s].mid + 4}" text-anchor="end">${label}</text>`;
  });
  years.forEach((yr, i) => (svg += `<text x="${colX(i) + nodeW / 2}" y="${h - 8}" text-anchor="middle">${yr}</text>`));
  marks.forEach(([yr, text], i) => {
    const x = colX(yr - FLOW_FROM) + nodeW / 2;
    svg += `<line x1="${x}" x2="${x}" y1="${mt - 6 - (i % 2) * 14}" y2="${h - mb}" stroke="#505a5f" stroke-dasharray="4 3"/><text x="${x}" y="${mt - 10 - (i % 2) * 14}" text-anchor="middle" font-size="12">${esc(text)}</text>`;
  });
  // ribbons first, so the nodes sit on top
  flows.forEach((m, i) => {
    const out = FLOW_STAGES.map((_, s) => band[s].mid - nodeH(i, s) / 2);
    const inn = FLOW_STAGES.map((_, s) => band[s].mid - nodeH(i + 1, s) / 2);
    FLOW_STAGES.forEach((_, a) => {
      for (let b = 0; b < n; b++) {
        const v = m[a][b];
        if (!v) continue;
        const [x0, x1, t, hh] = [colX(i) + nodeW, colX(i + 1), v * k, null];
        const [y0, y1] = [out[a], inn[b]];
        out[a] += t;
        inn[b] += t;
        const xm = (x0 + x1) / 2;
        svg += `<path d="M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1} L${x1},${y1 + t} C${xm},${y1 + t} ${xm},${y0 + t} ${x0},${y0 + t}Z" fill="${isFuture(i + 1) ? PREDICTED_COLOUR : FLOW_STAGES[a][1]}" fill-opacity="${a === b ? 0.3 : 0.55}"><title>${v} LPA${v === 1 ? "" : "s"}: ${FLOW_STAGES[a][0]} ${years[i]} to ${FLOW_STAGES[b][0]} ${years[i + 1]}</title></path>`;
      }
    });
  });
  counts.forEach((c, i) =>
    c.forEach((v, s) => {
      if (!v) return;
      svg += `<rect x="${colX(i)}" y="${band[s].mid - nodeH(i, s) / 2}" width="${nodeW}" height="${Math.max(nodeH(i, s), 1.5)}" fill="${isFuture(i) ? PREDICTED_COLOUR : FLOW_STAGES[s][1]}"><title>${years[i]}: ${v} LPA${v === 1 ? "" : "s"} at ${FLOW_STAGES[s][0].toLowerCase()}${isFuture(i) ? " (predicted)" : ""}</title></rect>`;
    })
  );
  svg += `</svg>`;
  return (
    `<h3 class="govuk-heading-m" id="${slugify(title)}">${esc(title)}</h3>` +
    `<p class="govuk-body">${lpas.length} LPAs. ${description}</p>` +
    `<div class="chart-wrap">${svg}</div>`
  );
}

function renderFlows() {
  const current = new Set((data["current-lpas"] ?? []).map((l) => l.reference).filter(Boolean));
  if (!current.size) return "";
  const former = data.boundaries.features.filter((f) => f.properties.lpa && f.properties["end-date"] && f.properties["end-date"] <= TODAY);
  const ended = {};
  former.forEach((f) => (ended[f.properties["end-date"].slice(0, 4)] = (ended[f.properties["end-date"].slice(0, 4)] ?? 0) + 1));
  return (
    `<h3 class="govuk-heading-m" id="flows-heading">How LPAs move between plan stages</h3>` +
    `<p class="govuk-body">At the end of each year, each LPA is placed at the stage of its most recently active plan, using actual dates from the timetable. Ribbons show LPAs moving between stages from one year to the next. An LPA that starts a new plan after adopting one moves back to preparation. Plans with no timetable events are left out. A timetable for a plan that isn't in the ${esc(topic.dataset)} dataset counts for the LPA that published it. The grey years to the right are predicted from timetable dates in the future.</p>` +
    flowChart("Plans covering one LPA", current, (p) => lpasOf(p).length === 1, "Current LPAs, by the plans that cover only that LPA.") +
    flowChart("Joint plans", current, (p) => lpasOf(p).length > 1, "Current LPAs, by the plans they share with other LPAs. Each LPA is counted once, however many LPAs share the plan.") +
    flowChart(
      "Reorganised LPAs",
      new Set(former.map((f) => f.properties.reference)),
      () => true,
      `Authorities that no longer exist, which were merged or replaced. Dashed lines mark the years they ended: ${Object.entries(ended).map(([y, c]) => `${c} in ${y}`).join(", ")}.`,
      Object.entries(ended).map(([y, c]) => [+y, `${c} ended`]),
      false
    )
  );
}

function renderTimetableProviders() {
  const lpas = data["current-lpas"];
  if (!lpas?.length) return "";
  const inDataset = new Set(data.plans.map((p) => p.reference));
  const planRefs = new Set(data.events.map((e) => e.plan).filter((r) => inDataset.has(r)));
  const covered = new Set();
  data.plans.filter((p) => planRefs.has(p.reference)).forEach((p) => lpasOf(p).forEach((r) => covered.add(r)));
  const pct = (n) => `${n} (${Math.round((n / lpas.length) * 100)}%)`;
  // events for one of its plans, or dated rows it published, such as for a plan not yet in the dataset
  const hasEvents = (l) => covered.has(l.reference) || l["timetable-data"];
  const own = lpas.filter((l) => l["timetable-endpoint"]);
  const withEvents = lpas.filter(hasEvents);
  const ownNoEvents = own.filter((l) => !hasEvents(l));
  const none = lpas.filter((l) => !hasEvents(l) && !l["timetable-endpoint"]);
  const hasPlan = new Set();
  data.plans.forEach((p) => lpasOf(p).forEach((r) => hasPlan.add(r)));
  const noticed = lpas.filter((l) => Object.keys(l.signals ?? {}).length);
  const noticeNoEvents = noticed.filter((l) => !hasEvents(l));
const events = data["timetable-events"] ?? {};
  const evPct = (n) => `${n.toLocaleString("en-GB")} (${Math.round((n / events.total) * 100)}%)`;
  const stat = (n, l) => `<div class="stat"><strong>${n}</strong><span>${l}</span></div>`;
  const list = (title, items) =>
    items.length
      ? `<details class="govuk-details"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">${title}</span></summary><div class="govuk-details__text"><ul class="govuk-list govuk-list--bullet">${items
          .map((l) => `<li><a class="govuk-link" href="https://provide.planning.data.gov.uk/organisations/${esc(l.organisation)}">${esc(l.name)}</a></li>`)
          .join("")}</ul></div></details>`
      : "";
  const SIGNAL = {
    notice: "commencement notice",
    gateway: "gateway assessment",
    timetable: "plan timetable",
    engagement: "engagement or call for sites",
    "new-plan": "new plan mentioned",
  };
  const noticeList = (items) => {
    if (!items.length) return "";
    const row = (l) => {
      const links = Object.entries(l.signals)
        .map(([k, u]) => `<a class="govuk-link" href="${esc(u)}">${SIGNAL[k] ?? esc(k)}</a>`)
        .join(", ");
      return `<li><a class="govuk-link" href="https://provide.planning.data.gov.uk/organisations/${esc(l.organisation)}">${esc(l.name)}</a>: ${links}</li>`;
    };
    const noPlan = items.filter((l) => !hasPlan.has(l.reference));
    const noEvents = items.filter((l) => hasPlan.has(l.reference));
    const group = (title, xs) => (xs.length ? `<h4 class="govuk-heading-s">${title} (${xs.length})</h4><ul class="govuk-list govuk-list--bullet">${xs.map(row).join("")}</ul>` : "");
    return `<details class="govuk-details"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">List the ${items.length} LPAs showing signs of a new local plan but with no timetable events</span></summary><div class="govuk-details__text"><p class="govuk-body">Found by searching LPA websites for commencement notices, gateway assessments, plan timetables, calls for sites and similar. The search is automatic, so some pages may not be about a new plan, and some LPAs may be missed.</p>${group("No plan on the platform", noPlan)}${group("Plan on the platform but no timetable events", noEvents)}</div></details>`;
  };
  const signalTable = () => {
    const cols = Object.keys(SIGNAL);
    // signs of a new plan, but no timetable events
    const missing = (l) => Object.keys(l.signals ?? {}).length > 0 && !hasEvents(l);
    const cell = (l, k) => (l.signals?.[k] ? `<a class="govuk-link" href="${esc(l.signals[k])}">Yes</a>` : "");
    const rows = [...lpas]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (l) =>
          `<tr class="govuk-table__row${missing(l) ? " row--missing" : ""}"><td class="govuk-table__cell"><a class="govuk-link" href="https://provide.planning.data.gov.uk/organisations/${esc(l.organisation)}">${esc(l.name)}</a></td><td class="govuk-table__cell">${hasPlan.has(l.reference) ? "Yes" : ""}</td><td class="govuk-table__cell">${hasEvents(l) ? "Yes" : ""}</td>${cols.map((k) => `<td class="govuk-table__cell">${cell(l, k)}</td>`).join("")}</tr>`,
      )
      .join("");
    return `<details class="govuk-details"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">Table of all ${lpas.length} current LPAs and the signals found</span></summary><div class="govuk-details__text"><p class="govuk-body"><span class="swatch-missing"></span> Highlighted rows have signals of a new plan but no timetable events, so we may be missing timetable or plan data (${lpas.filter(missing).length}).</p><table class="govuk-table"><thead class="govuk-table__head"><tr class="govuk-table__row"><th class="govuk-table__header">LPA</th><th class="govuk-table__header">Plan</th><th class="govuk-table__header">Timetable events</th>${cols.map((k) => `<th class="govuk-table__header">${SIGNAL[k]}</th>`).join("")}</tr></thead><tbody class="govuk-table__body">${rows}</tbody></table></div></details>`;
  };
  return (
    `<h3 class="govuk-heading-m" id="providers-heading">LPAs providing timetable data</h3>` +
    `<p class="govuk-body">Of ${lpas.length} current LPAs, ${pct(own.length)} publish their own plan timetable, through ${data["timetable-endpoints"]} endpoints on the platform. An LPA counts if it, or a planning group it belongs to, has an endpoint. ${pct(withEvents.length)} have dated timetable events, either for at least one of their plans or published by them for a plan that isn't in the ${esc(topic.dataset)} dataset or doesn't list them. This includes events that did not come from an endpoint of their own.</p>` +
    `<div class="stats">` +
    // timetables first, then LPA provision, then the events in them
    stat(`${planRefs.size} (${Math.round((planRefs.size / data.plans.length) * 100)}%)`, `of ${data.plans.length} ${topic.singular}s have a timetable`) +
    stat(pct(withEvents.length), "of current LPAs have a timetable") +
    stat(pct(own.length), "of current LPAs publish their own timetable") +
    stat(ownNoEvents.length, "publish a timetable but have no events here") +
    stat(none.length, "have no timetable data") +
    (noticed.length ? stat(`${noticeNoEvents.length} of ${noticed.length}`, "LPAs showing signs of a new local plan on their website have no timetable events") : "") +
    (events.total
      ? stat(events.total.toLocaleString("en-GB"), "timetable events") +
        stat(evPct(events.endpoint), "events from LPAs publishing their own timetable")
      : "") +
    `</div>` +
    list(`List the ${ownNoEvents.length} LPAs that publish a timetable but have no events here`, ownNoEvents) +
    list(`List the ${none.length} LPAs with no timetable data`, none) +
    noticeList(noticeNoEvents) +
    signalTable()
  );
}

function renderSubmissions() {
  const subs = data["lpa-submissions"];
  if (!subs?.length) return "";
  const kinds = [
    [topic.dataset, "Plan data", COLOUR.progress],
    [topic.timetable, "Timetable data", COLOUR.submitted],
  ];
  const lpas = Object.fromEntries(data["current-lpas"].map((l) => [l.organisation, l]));
  const day = (d) => new Date(d).getTime();
  const dates = subs.flatMap((s) => kinds.flatMap(([k]) => (s[k] ? [s[k].added, ...s[k].updates] : [])));
  const t0 = Math.min(...dates.map(day));
  const t1 = day(TODAY);
  const months = [];
  for (let d = new Date(t0), m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); m <= t1; d = new Date(m), m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) months.push(m);
  const monthLabel = (t) => new Date(t).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  const key = (k) => subs.filter((s) => s[k]);
  const updates = (k) => subs.reduce((n, s) => n + (s[k]?.updates.length ?? 0), 0);

  // cumulative number of LPAs that have added an endpoint
  const [w, h, ml, mr, mt, mb] = [960, 280, 40, 20, 10, 30];
  const max = Math.ceil(Math.max(...kinds.map(([k]) => key(k).length)) / 20) * 20;
  const sx = (t) => ml + ((t - t0) / (t1 - t0)) * (w - ml - mr);
  const sy = (v) => h - mb - (v / max) * (h - mb - mt);
  let svg = `<svg class="chart" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;min-width:640px" role="img" aria-label="Step chart of the number of LPAs that have provided plan data and timetable data over time">`;
  for (let v = 0; v <= max; v += 20) svg += `<line class="grid" x1="${ml}" x2="${w - mr}" y1="${sy(v)}" y2="${sy(v)}"/><text x="${ml - 6}" y="${sy(v) + 4}" text-anchor="end">${v}</text>`;
  months.forEach((m) => (svg += `<text x="${sx(m)}" y="${h - 10}" text-anchor="middle">${monthLabel(m)}</text>`));
  kinds.forEach(([k, label, colour]) => {
    const added = key(k).map((s) => day(s[k].added)).sort((a, b) => a - b);
    let pts = `${sx(t0)},${sy(0)}`;
    added.forEach((t, i) => (pts += ` ${sx(t)},${sy(i)} ${sx(t)},${sy(i + 1)}`));
    pts += ` ${sx(t1)},${sy(added.length)}`;
    svg += `<polyline points="${pts}" fill="none" stroke="${colour}" stroke-width="3"><title>${label}: ${added.length} LPAs</title></polyline>`;
  });
  svg += `<line class="axis" x1="${ml}" x2="${w - mr}" y1="${h - mb}" y2="${h - mb}"/></svg>`;

  // one row per LPA: a filled dot when the endpoint was added, a ring for each update
  const rows = subs
    .map((s) => ({ s, name: lpas[s.organisation]?.name ?? s.organisation, first: Math.min(...kinds.filter(([k]) => s[k]).map(([k]) => day(s[k].added))) }))
    .sort((a, b) => a.first - b.first || a.name.localeCompare(b.name));
  const [rw, rh, lw] = [960, 20, 250];
  const rx = (t) => lw + ((t - t0) / (t1 - t0)) * (rw - lw - 20);
  let lane = `<svg class="chart" viewBox="0 0 ${rw} ${rows.length * rh + 30}" style="width:100%;height:auto;min-width:640px" role="img" aria-label="Timeline of when each LPA provided and updated plan data and timetable data">`;
  months.forEach((m) => (lane += `<line class="grid" x1="${rx(m)}" x2="${rx(m)}" y1="0" y2="${rows.length * rh}"/><text x="${rx(m)}" y="${rows.length * rh + 18}" text-anchor="middle">${monthLabel(m)}</text>`));
  rows.forEach(({ s, name }, i) => {
    const y = i * rh + rh / 2;
    lane += `<a href="https://provide.planning.data.gov.uk/organisations/${esc(s.organisation)}"><text x="${lw - 10}" y="${y + 4}" text-anchor="end" class="lane-label">${esc(name)}</text></a>`;
    kinds.forEach(([k, label, colour], n) => {
      if (!s[k]) return;
      const cy = y + (n ? 4 : -4);
      lane += `<circle cx="${rx(day(s[k].added))}" cy="${cy}" r="3.5" fill="${colour}"><title>${esc(name)}: ${label.toLowerCase()} added ${fmt(s[k].added)}</title></circle>`;
      s[k].updates.forEach((u) => (lane += `<circle cx="${rx(day(u))}" cy="${cy}" r="3" fill="#fff" stroke="${colour}" stroke-width="1.5"><title>${esc(name)}: ${label.toLowerCase()} updated ${fmt(u)}</title></circle>`));
    });
  });
  lane += `</svg>`;
  const keyHtml =
    kinds.map(([, label, colour]) => `<span class="legend-item"><span class="swatch" style="background:${colour}"></span>${label}</span>`).join("") +
    `<span class="legend-item"><span class="swatch swatch--ring"></span>Updated</span>`;
  return (
    `<h3 class="govuk-heading-m" id="submissions-heading">When LPAs provided data</h3>` +
    `<p class="govuk-body">Number of current LPAs that have added an endpoint, from ${monthLabel(t0)}. ${key(topic.dataset).length} have provided plan data and ${key(topic.timetable).length} timetable data. A new copy of the data at an endpoint is counted as an update: ${updates(topic.dataset)} for plan data and ${updates(topic.timetable)} for timetable data.</p>` +
    `<div class="chart-key">${kinds.map(([, label, colour]) => `<span class="legend-item"><span class="swatch" style="background:${colour}"></span>${label}</span>`).join("")}</div>` +
    `<div class="chart-wrap">${svg}</div>` +
    `<details class="govuk-details"><summary class="govuk-details__summary"><span class="govuk-details__summary-text">Timeline for each of the ${rows.length} LPAs</span></summary><div class="govuk-details__text"><div class="chart-key">${keyHtml}</div><div class="chart-wrap">${lane}</div></div></details>`
  );
}

// a plan links to the provide service page of its first LPA
function planOrganisationLink(ref, name) {
  const p = data.plans.find((x) => x.reference === ref);
  const lpa = p && data["current-lpas"].find((l) => l.reference && lpasOf(p).includes(l.reference));
  return lpa ? `<a class="govuk-link" href="https://provide.planning.data.gov.uk/organisations/${esc(lpa.organisation)}">${esc(name)}</a>` : esc(name);
}

function renderIssues() {
  if (!data.issues?.length) return "";
  const names = Object.fromEntries(data.plans.map((p) => [p.reference, p.name]));
  return (
    `<h3 class="govuk-heading-m" id="issues-heading">Plans with timetable problems</h3>` +
    `<p class="govuk-body">${data.issues.length} plans reuse a reference for a later plan cycle, or have stages out of date order. The events listed are left out of the charts above.</p>` +
    `<table class="govuk-table"><thead class="govuk-table__head"><tr class="govuk-table__row"><th scope="col" class="govuk-table__header">Plan</th><th scope="col" class="govuk-table__header">Problem</th><th scope="col" class="govuk-table__header govuk-table__header--numeric">Events left out</th></tr></thead><tbody class="govuk-table__body">` +
    data.issues
      .map(
        (i) =>
          `<tr class="govuk-table__row"><td class="govuk-table__cell">${planOrganisationLink(i.plan, names[i.plan] ?? i.plan)} <a class="govuk-link" href="#timeline-heading" data-timeline="${esc(i.plan)}">timeline</a></td><td class="govuk-table__cell">${i.reasons.map(esc).join("; ")}</td><td class="govuk-table__cell govuk-table__cell--numeric">${i.events}</td></tr>`
      )
      .join("") +
    `</tbody></table>`
  );
}

function showPlanTimeline(ref) {
  const p = data.plans.find((x) => x.reference === ref);
  const events = data.events
    .filter((e) => e.plan === ref)
    .sort((a, b) => (a.date || a.earliest || "").localeCompare(b.date || b.earliest || ""));
  const caption = p["authority-name"] ? `<span class="govuk-caption-m">${esc(p["authority-name"])}</span>` : "";
  const link = `<p class="govuk-body"><a class="govuk-link" href="https://www.planning.data.gov.uk/entity/${esc(p.entity)}">View this plan on planning.data.gov.uk</a></p>`;
  $("plan-timeline").innerHTML =
    `<div class="plan-timeline">${caption}<h3 class="govuk-heading-m">${esc(p.name)}</h3>${link}<ol>` +
    events
      .map((e) => {
        const c = GROUPS[EVENT_GROUP[e.event]]?.colour ?? "#b1b4b6";
        const date = e.date ? fmt(e.date) : e.earliest ? `Predicted ${fmt(e.earliest)}${e.latest ? " to " + fmt(e.latest) : ""}` : "No date";
        const pred = isPredicted(e);
        return `<li${e.suspect ? ' class="suspect"' : pred ? ' class="predicted"' : ""}><span class="swatch${pred ? " swatch--predicted" : ""}" style="background:${c}"></span><strong>${esc(pred && e.date ? "Predicted " + date : date)}</strong> ${esc(e.event.replaceAll("-", " "))}${e.suspect ? " (left out of charts)" : ""}</li>`;
      })
      .join("") +
    `</ol></div>`;
}

document.addEventListener("click", (ev) => {
  const open = ev.target.closest("[data-open]");
  if (open) $(open.dataset.open).open = true;
  const a = ev.target.closest("[data-timeline]");
  if (!a) return;
  showPlanTimeline(a.dataset.timeline);
  // links elsewhere on the page jump to the plan's timetable; lines on the chart leave the page where it is
  if (a.getAttribute("href")) {
    ev.preventDefault();
    $("plan-timeline").scrollIntoView();
  }
});

function renderLinks() {
  $("links").innerHTML = [
    ["https://digital-land.github.io/specification/specification/plan/", "Plan specification"],
    [topic.guidance, `Guidance on publishing ${topic.singular} data`],
    [`https://www.planning.data.gov.uk/dataset/${topic.dataset}`, `${topic.name} dataset page`],
    [`https://www.planning.data.gov.uk/entity/?dataset=${topic.dataset}`, `Search all ${topic.dataset} entities on the platform`],
  ]
    .map(([u, t]) => `<li><a class="govuk-link" href="${esc(u)}">${esc(t)}</a></li>`)
    .join("");
}

function renderDatasets() {
  const all = [{ dataset: topic.dataset, description: `${topic.name} - the main dataset for this topic.` }, ...topic.related];
  $("datasets").innerHTML = `<ul class="dataset-list">${all
    .map((d) => `<li><a class="govuk-link govuk-!-font-weight-bold" href="https://www.planning.data.gov.uk/dataset/${esc(d.dataset)}">${esc(d.dataset)}</a><br>${esc(d.description)}</li>`)
    .join("")}</ul>`;
}

const decade = (p) => {
  const y = (p["start-date"] || p["period-start-date"] || "").slice(0, 4);
  return y ? `${y.slice(0, 3)}0s` : "Not stated";
};

function setupSearch() {
  const facet = (id, key, fn, labels = {}) => {
    const counts = {};
    data.plans.forEach((p) => (counts[fn(p)] = (counts[fn(p)] ?? 0) + 1));
    $(id).innerHTML = Object.keys(counts)
      .sort()
      .map(
        (v, i) =>
          `<div class="govuk-checkboxes__item"><input class="govuk-checkboxes__input" type="checkbox" id="${id}-${i}" data-facet="${key}" value="${esc(v)}"><label class="govuk-label govuk-checkboxes__label" for="${id}-${i}">${esc(labels[v] ?? v)} (${counts[v]})</label></div>`,
      )
      .join("");
  };
  facet("f-status", "status", (p) => p["local-plan-process"], STATUS_LABEL);
  facet("f-period", "period", decade);
  $("filters").addEventListener("input", () => {
    state.page = 1;
    renderResults();
  });
  $("filters").addEventListener("reset", () => setTimeout(() => ((state.page = 1), renderResults())));
  $("filters").addEventListener("submit", (e) => e.preventDefault());
  renderResults();
}

function filtered() {
  const q = $("q").value.trim().toLowerCase();
  const sel = (key) => [...document.querySelectorAll(`[data-facet=${key}]:checked`)].map((i) => i.value);
  const [st, pe] = [sel("status"), sel("period")];
  const [d, m, y] = ["ed-day", "ed-month", "ed-year"].map((i) => $(i).value.trim());
  return data.plans.filter((p) => {
    if (q && !`${p.name} ${p["authority-name"]} ${p.reference}`.toLowerCase().includes(q)) return false;
    if (st.length && !st.includes(p["local-plan-process"])) return false;
    if (pe.length && !pe.includes(decade(p))) return false;
    const [py, pm, pd] = p["entry-date"].split("-");
    if (y && py !== y) return false;
    if (m && +pm !== +m) return false;
    if (d && +pd !== +d) return false;
    return true;
  });
}

function renderResults() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  $("count").textContent = `${rows.length.toLocaleString("en-GB")} ${rows.length === 1 ? topic.singular : topic.singular + "s"} found`;
  $("results").innerHTML = rows
    .slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE)
    .map((p) => {
      const hasEvents = data.events.some((e) => e.plan === p.reference);
      const f = (l, v) => (v ? `<div><dt>${l}</dt><dd>${esc(v)}</dd></div>` : "");
      return `<div class="result"><h3 class="govuk-heading-s"><a class="govuk-link" href="https://www.planning.data.gov.uk/entity/${esc(p.entity)}">${esc(p.name)}</a>${templateTag(p)}</h3><dl>${f("Status", statusOf(p))}${f("Authority", p["authority-name"])}${f("Adopted", fmt(adoptedDate(p)))}${f("Period", [p["period-start-date"], p["period-end-date"]].map((d) => d.slice(0, 4)).filter(Boolean).join("–"))}${f("Entry date", fmt(p["entry-date"]))}</dl>${
        hasEvents ? `<a class="govuk-link" href="#timeline-heading" data-timeline="${esc(p.reference)}">View timeline</a>` : ""
      }</div>`;
    })
    .join("");
  $("pager").className = "pager govuk-body";
  $("pager").innerHTML =
    pages > 1
      ? `${state.page > 1 ? '<a class="govuk-link" href="#search" data-page="-1">Previous</a>' : ""}<span>Page ${state.page} of ${pages}</span>${state.page < pages ? '<a class="govuk-link" href="#search" data-page="1">Next</a>' : ""}`
      : "";
}

$("pager").addEventListener("click", (e) => {
  const a = e.target.closest("[data-page]");
  if (a) {
    state.page += +a.dataset.page;
    renderResults();
  }
});

init().catch((e) => {
  $("error").hidden = false;
  $("error-text").textContent = String(e);
});
