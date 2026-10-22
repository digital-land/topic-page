const GROUPS = {
  draft: { label: "Draft and consultation", colour: "#1d70b8" },
  submitted: { label: "Submitted for examination", colour: "#f47738" },
  sound: { label: "Found sound or inspector report", colour: "#4c2c92" },
  adopted: { label: "Adopted", colour: "#00703c" },
  withdrawn: { label: "Withdrawn", colour: "#d4351c" },
};
const EVENT_GROUP = {
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
const EVENT_STAGE = {
  commenced: 0,
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
  adopted: 4,
};
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
const slugFromPath = () => new URLSearchParams(location.search).get("topic");

let topic, data, planByRef, state = { page: 1 };

async function init() {
  const slug = slugFromPath();
  const topics = await (await fetch("topics.json")).json();
  topic = topics[slug];
  if (!topic) {
    $("error").hidden = false;
    $("error-text").textContent = `Topic "${slug}" not found. Try ${Object.keys(topics).join(", ")}.`;
    return;
  }
  data = await (await fetch(`data/${slug}.json`)).json();
  data.plans.sort((a, b) => a.name.localeCompare(b.name));
  // only keep timetables linked to a plan in the dataset
  const refs = new Set(data.plans.map((p) => p.reference));
  data.events = data.events.filter((e) => refs.has(e.plan));
  document.title = `${topic.name} - Planning Data`;
  $("crumb").textContent = topic.name;
  $("heading").textContent = topic.name;
  $("summary").textContent = topic.summary;
  renderStats();
  renderMap();
  renderTimeline();
  renderLinks();
  renderDatasets();
  setupSearch();
}

function renderStats() {
  const plans = data.plans;
  const adopted = plans.filter(isAdopted).length;
  const authorities = new Set(plans.map((p) => p.boundary).filter(Boolean)).size;
  const stats = [
    [plans.length, `${topic.singular}s on the platform`],
    [adopted, "adopted"],
    [data.counts.boundaries, "with a boundary"],
  ];
  if (topic.expected) stats.push([topic.expected, topic.expectedNote + " in England"]);
  $("stats").innerHTML = stats
    .map(([n, l]) => `<div class="stat"><strong>${n.toLocaleString("en-GB")}</strong><span>${esc(l)}</span></div>`)
    .join("");
}

function boundaryColour(plans) {
  if (plans.some(isAdopted)) return "#00703c";
  if (plans.some((p) => p["local-plan-process"])) return "#1d70b8";
  return "#505a5f";
}

function planLine(p) {
  const hasEvents = data.events.some((e) => e.plan === p.reference);
  return `<li><a class="govuk-link" href="${esc(p["documentation-url"] || p["document-url"] || "#")}">${esc(p.name)}</a> (${esc(statusOf(p))})${
    hasEvents ? ` <a class="govuk-link" href="#timeline-heading" data-timeline="${esc(p.reference)}">timeline</a>` : ""
  }</li>`;
}

function renderMap() {
  planByRef = {};
  data.plans.forEach((p) => (planByRef[p.boundary] ??= []).push(p));
  const map = L.map("map").setView([52.9, -1.6], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);
  const layer = L.geoJSON(data.boundaries, {
    style: (f) => ({
      color: "#0b0c0c",
      weight: 1,
      fillOpacity: 0.45,
      fillColor: boundaryColour(planByRef[f.properties.reference] ?? []),
    }),
    onEachFeature: (f, l) => {
      const plans = planByRef[f.properties.reference] ?? [];
      l.bindTooltip(esc(f.properties.name));
      l.on("click", () => {
        toggleMapPanel(true, false);
        $("map-selected").innerHTML =
          `<h3 class="govuk-heading-s">${esc(f.properties.name)}</h3>` +
          (plans.length
            ? `<ul class="govuk-list">${plans.map(planLine).join("")}</ul>`
            : `<p class="govuk-body">No ${topic.singular} linked to this boundary.</p>`);
      });
    },
  }).addTo(map);
  // keep boundaries clear of the key panel, unless the map is too narrow to fit both
  const keyWidth = $("map-panel").offsetWidth + 30;
  const padRight = map.getSize().x - keyWidth >= 300 ? keyWidth : 0;
  if (layer.getBounds().isValid()) map.fitBounds(layer.getBounds(), { paddingBottomRight: [padRight, 0] });
  const noBoundary = data.plans.filter((p) => !planByRef[p.boundary] || !data.boundaries.features.some((f) => f.properties.reference === p.boundary)).length;
  $("legend").innerHTML =
    [["#00703c", "Has an adopted plan"], ["#1d70b8", "Plan in progress"], ["#505a5f", "Status not stated"]]
      .map(([c, l]) => `<div class="legend-item"><span class="swatch" style="background:${c}"></span>${l}</div>`)
      .join("") +
    `<p class="govuk-body-s">${noBoundary} of ${data.plans.length} plans have no boundary on the map. Select an area to see its plans.</p>`;
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
    if (!g || !y) return;
    ((counts[y] ??= {})[g] ??= new Set()).add(e.plan);
  });
  const years = Object.keys(counts).map(Number).filter((y) => y >= 2004);
  const [y0, y1] = [Math.min(...years), Math.max(...years)];
  const groups = Object.keys(GROUPS);
  const totals = (y) => groups.reduce((s, g) => s + (counts[y]?.[g]?.size ?? 0), 0);
  const max = Math.max(...years.map(totals));
  const [w, h, ml, mb, mt] = [Math.max(720, (y1 - y0 + 1) * 34 + 60), 320, 40, 30, 10];
  const bw = (w - ml) / (y1 - y0 + 1);
  const sy = (v) => h - mb - (v / max) * (h - mb - mt);
  let svg = `<svg class="chart" width="${w}" height="${h}" role="img" aria-label="Stacked bar chart of plans reaching each milestone by year">`;
  for (let t = 0; t <= max; t += Math.ceil(max / 5 / 10) * 10) {
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
  el.innerHTML =
    `<p class="govuk-body">Number of plans reaching each milestone, by year, from the timetable dataset. ${data.events.length.toLocaleString("en-GB")} events across ${new Set(data.events.map((e) => e.plan)).size} plans.</p>` +
    `<div class="chart-key">${groups.map((g) => `<span class="legend-item"><span class="swatch" style="background:${GROUPS[g].colour}"></span>${GROUPS[g].label}</span>`).join("")}</div>` +
    `<div class="chart-wrap">${svg}</div>` +
    renderJourney() +
    `<div id="plan-timeline" aria-live="polite"></div>` +
    `<p class="govuk-body-s">Select a plan on the map or in the search results to see its own timetable.</p>`;
}

function renderJourney() {
  const byPlan = {};
  data.events.forEach((e) => {
    const stage = EVENT_STAGE[e.event];
    if (stage === undefined || !e.date) return;
    const stages = (byPlan[e.plan] ??= {});
    if (!stages[stage] || e.date < stages[stage]) stages[stage] = e.date;
  });
  const withdrawn = new Set(data.events.filter((e) => e.event === "plan-withdrawn").map((e) => e.plan));
  const names = Object.fromEntries(data.plans.map((p) => [p.reference, p.name]));
  const journeys = Object.entries(byPlan)
    .map(([ref, st]) => ({
      ref,
      points: Object.entries(st)
        .map(([stage, date]) => ({ stage: +stage, t: new Date(date).getTime(), date }))
        .filter((p) => p.t >= Date.UTC(2004, 0, 1))
        .sort((a, b) => a.stage - b.stage),
      outcome: withdrawn.has(ref) ? "withdrawn" : st[4] ? "adopted" : "progress",
    }))
    .filter((j) => j.points.length >= 2);
  if (!journeys.length) return "";
  const colour = { adopted: "#00703c", progress: "#1d70b8", withdrawn: "#d4351c" };
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
      const pts = j.points.map((p) => `${sx(p.t).toFixed(1)},${sy(p.stage).toFixed(1)}`).join(" ");
      const [a, b] = [j.points[0], j.points.at(-1)];
      const dur = ((days(a.t, b.t) / 365.25)).toFixed(1);
      svg += `<polyline class="journey" data-timeline="${esc(j.ref)}" points="${pts}" fill="none" stroke="${colour[j.outcome]}"><title>${esc(names[j.ref] ?? j.ref)}: ${esc(STAGES[a.stage])} to ${esc(STAGES[b.stage])} in ${dur} years (${label[j.outcome].toLowerCase()})</title></polyline>`;
    });
  svg += `</svg>`;
  const durations = journeys
    .filter((j) => j.outcome === "adopted" && j.points[0].stage < 3)
    .map((j) => days(j.points[0].t, j.points.at(-1).t) / 365.25)
    .sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)].toFixed(1) : null;
  return (
    `<h3 class="govuk-heading-m">Progress through the stages</h3>` +
    `<p class="govuk-body">One line per plan, from the first date recorded at each stage. ${journeys.length} plans have dates for at least two stages.${
      median ? ` For the ${durations.length} adopted plans with early consultation or publication dates, the median time from first recorded stage to adoption is ${median} years.` : ""
    } Select a line to see the plan's timetable.</p>` +
    `<div class="chart-key">${Object.keys(colour).map((k) => `<span class="legend-item"><span class="swatch" style="background:${colour[k]}"></span>${label[k]}</span>`).join("")}</div>` +
    `<div class="chart-wrap">${svg}</div>`
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
        return `<li><span class="swatch" style="background:${c}"></span><strong>${esc(date)}</strong> ${esc(e.event.replaceAll("-", " "))}</li>`;
      })
      .join("") +
    `</ol></div>`;
}

document.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-timeline]");
  if (!a) return;
  showPlanTimeline(a.dataset.timeline);
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
      return `<div class="result"><h3 class="govuk-heading-s"><a class="govuk-link" href="https://www.planning.data.gov.uk/entity/${esc(p.entity)}">${esc(p.name)}</a></h3><dl>${f("Status", statusOf(p))}${f("Authority", p["authority-name"])}${f("Adopted", fmt(adoptedDate(p)))}${f("Period", [p["period-start-date"], p["period-end-date"]].map((d) => d.slice(0, 4)).filter(Boolean).join("–"))}${f("Entry date", fmt(p["entry-date"]))}</dl>${
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
