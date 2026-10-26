#!/usr/bin/env node
/* Snapshots the data behind the Iran and United States play-by-play into
   data/conflicts/irus/:

     events.json    dated, geolocated placemarks from GeoConfirmed's Iran and
                    Israel maps (geoconfirmed.org/api/placemark/<map>), tagged
                    with the faction GeoConfirmed assigns, the country the point
                    falls in (Natural Earth admin-1, public domain), and whether
                    it is an "away" event: an Iranian-side placemark outside
                    Iran, or a coalition-side placemark inside Iran. GeoConfirmed
                    publishes no license for its placemark export.
     shipping.json  daily vessel transits through the Strait of Hormuz, Bab
                    el-Mandeb and the Suez Canal from IMF PortWatch (terms:
                    https://www.imf.org/external/terms.htm), with a pre-war
                    baseline (January to May 2025).

   Optional: --ucdp-token <token> also pulls UCDP GED candidate events for the
   region (requires a free UCDP account) into events.json as "ucdp".

   Usage:
     node scripts/fetch_conflict_irus.js
     node scripts/fetch_conflict_irus.js --offline
     node scripts/fetch_conflict_irus.js --ucdp-token XXXX */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", "conflicts", "irus");
const CACHE = path.join(os.tmpdir(), "wpn-irus");
const NE_CACHE = path.join(os.tmpdir(), "wpn-ne");
const NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";
const GC = (map) => `https://geoconfirmed.org/api/placemark/${map}`;
const PW = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query";
const FROM = "2025-06-01";

// GeoConfirmed factions -> side. Anything not listed is "other".
const SIDE = {
  "Iranian Armed Forces": "iran", "Iranian Civilian": "iran-civ", "Hezbollah": "iran", "Iran": "iran",
  "Israel Defense Forces": "coalition", "IDF": "coalition", "US": "coalition", "French Armed Forces": "coalition",
  "Iraqi Armed Forces": "coalition", "Other Armed Forces.": "coalition", "UN or Western troops": "coalition",
  "Neutral/Infrastructure": "other", "Neutral": "other", "Unknown": "other", "Other factions": "other",
};
// Each chokepoint carries a water-only route ([lat, lon] waypoints) that the
// animation moves ships along, drawn from open sea on one side to open sea on
// the other, hand-plotted to stay clear of the coast.
const CHOKEPOINTS = {
  // Hormuz: in through the traffic lanes off Musandam, then west along the
  // channel south of Qeshm Island and up the Gulf toward Kuwait.
  chokepoint6: { name: "Strait of Hormuz", lat: 26.3, lon: 56.86, route: [
    [22.9, 60.2], [23.9, 59.0], [24.7, 58.1], [25.3, 57.3], [25.9, 56.9], [26.35, 56.72], [26.52, 56.55], [26.55, 56.3], [26.4, 55.9], [26.2, 55.5], [26.25, 55.0], [26.2, 54.3], [26.5, 53.0], [27.2, 51.8], [28.1, 50.6], [29.0, 49.9] ] },
  // Bab el-Mandeb: through the wide western channel past Perim, then up the
  // Red Sea clear of the Hanish islands.
  chokepoint4: { name: "Bab el-Mandeb Strait", lat: 12.79, lon: 43.35, route: [
    [12.0, 47.0], [12.1, 45.5], [12.3, 44.3], [12.45, 43.6], [12.5, 43.33], [12.9, 43.1], [13.5, 42.55], [14.4, 42.15], [15.5, 41.6], [16.8, 40.9], [18.4, 40.0], [20.0, 38.9] ] },
  chokepoint1: { name: "Suez Canal", lat: 30.59, lon: 32.44, route: [
    [26.5, 34.6], [27.4, 33.9], [28.3, 33.4], [29.2, 32.75], [29.9, 32.55], [30.6, 32.33], [31.26, 32.3], [31.8, 32.2], [32.4, 31.6], [33.0, 31.0] ] },
};
// Region bounding box: only placemarks inside it are kept.
const BOX = [24, 10, 66, 42]; // lon min, lat min, lon max, lat max

async function fetchText(url, headers) {
  const res = await fetch(url, { headers: Object.assign({ "User-Agent": "world-patch-notes/0.1 (static site prototype; local script)" }, headers || {}) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}
async function cached(name, url, offline, headers) {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  if (offline) throw new Error("not cached: " + name);
  fs.mkdirSync(CACHE, { recursive: true });
  console.log("downloading", url.slice(0, 110));
  const text = await fetchText(url, headers);
  fs.writeFileSync(file, text);
  return text;
}

// ---------- point in polygon over Natural Earth admin-1 ----------
function inRing(r, x, y) {
  let inside = false;
  for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[k][0], yj = r[k][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeom(g, x, y) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const p of polys) {
    if (!inRing(p[0], x, y)) continue;
    let hole = false;
    for (let i = 1; i < p.length; i++) if (inRing(p[i], x, y)) hole = true;
    if (!hole) return true;
  }
  return false;
}
function bboxOf(g) {
  const b = [1e9, 1e9, -1e9, -1e9];
  const walk = (c) => { if (typeof c[0] === "number") { if (c[0] < b[0]) b[0] = c[0]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[1] > b[3]) b[3] = c[1]; } else c.forEach(walk); };
  walk(g.coordinates);
  return b;
}
async function regionIndex(offline) {
  const file = path.join(NE_CACHE, "ne_10m_admin_1_states_provinces.geojson");
  let text;
  if (fs.existsSync(file)) text = fs.readFileSync(file, "utf8");
  else { if (offline) throw new Error("Natural Earth admin-1 not cached"); fs.mkdirSync(NE_CACHE, { recursive: true }); text = await fetchText(NE_URL); fs.writeFileSync(file, text); }
  const geo = JSON.parse(text);
  const feats = geo.features
    .map((f) => ({ a3: f.properties.adm0_a3, admin: f.properties.admin, geom: f.geometry, bbox: bboxOf(f.geometry) }))
    .filter((f) => f.bbox[2] >= BOX[0] && f.bbox[0] <= BOX[2] && f.bbox[3] >= BOX[1] && f.bbox[1] <= BOX[3]);
  const names = {};
  for (const f of feats) names[f.a3] = f.admin;
  return {
    names,
    of(lon, lat) {
      for (const f of feats) {
        const b = f.bbox;
        if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
        if (inGeom(f.geom, lon, lat)) return f.a3;
      }
      return "SEA";
    },
  };
}

// ---------- events ----------
async function buildEvents(offline, ucdpToken) {
  const maps = { Iran: JSON.parse(await cached("gc_iran.json", GC("Iran"), offline)), Israel: JSON.parse(await cached("gc_israel.json", GC("Israel"), offline)) };
  const regions = await regionIndex(offline);
  const factions = {};
  const days = {};
  const seen = new Set();
  let kept = 0, dropped = 0;
  for (const [map, data] of Object.entries(maps)) {
    for (const f of data) {
      // From the Israel map keep only Iran-side placemarks; the rest is the Gaza and Lebanon fronts.
      if (map === "Israel" && f.name !== "Iran") continue;
      const side = SIDE[f.name] || "other";
      factions[f.factionId] = { name: f.name, side, color: f.color };
      for (const ic of f.icons || []) {
        const icon = String(ic.icon || "").split("/").pop().replace(/\.png$/, "");
        for (const p of ic.placemarks || []) {
          if (!p.date || p.date.slice(0, 10) < FROM || seen.has(p.id)) { dropped++; continue; }
          if (p.lo < BOX[0] || p.lo > BOX[2] || p.la < BOX[1] || p.la > BOX[3]) { dropped++; continue; }
          seen.add(p.id);
          const a3 = regions.of(p.lo, p.la);
          const away = (side === "iran" && a3 !== "IRN") || (side === "coalition" && a3 === "IRN") ? 1 : 0;
          const date = p.date.slice(0, 10);
          (days[date] = days[date] || []).push([+p.la.toFixed(3), +p.lo.toFixed(3), f.factionId, a3, away, icon]);
          kept++;
        }
      }
    }
  }
  const out = {
    source: "GeoConfirmed placemarks (geoconfirmed.org) from its Iran map, plus Iran-side placemarks from its Israel map; country by point-in-polygon against Natural Earth admin-1 (public domain).",
    license: "GeoConfirmed publishes no license file for its placemark export; confirm terms before any use beyond this prototype.",
    note: "A placemark is a geolocated, dated event tied to the faction GeoConfirmed assigns; its icon legend is not public, so events are not typed. 'away' marks an Iranian-side placemark outside Iran or a coalition-side placemark inside Iran, the best available proxy for a strike by that side.",
    from: FROM, fetched: new Date().toISOString().slice(0, 10),
    fields: ["lat", "lon", "faction id", "country (ISO3, SEA for water)", "away (0/1)", "GeoConfirmed icon code"],
    sides: { iran: "Iranian side (armed forces, Hezbollah)", "iran-civ": "Iranian civilian", coalition: "US, Israel and partner forces", other: "neutral, infrastructure, unknown" },
    factions, countries: regions.names, days,
  };
  if (ucdpToken) {
    try { out.ucdp = await fetchUcdp(ucdpToken, offline); }
    catch (e) { console.log("UCDP skipped:", e.message); }
  }
  fs.writeFileSync(path.join(OUT, "events.json"), JSON.stringify(out) + "\n");
  console.log(`events.json: ${kept} placemarks across ${Object.keys(days).length} dates (${dropped} outside the window or box), ${(fs.statSync(path.join(OUT, "events.json")).size / 1024).toFixed(0)} KB`);
}

// UCDP GED candidate events for the region (needs a token from a free UCDP account).
async function fetchUcdp(token, offline) {
  const countries = { 630: "Iran", 666: "Israel", 645: "Iraq", 670: "Saudi Arabia", 696: "UAE", 690: "Kuwait", 692: "Bahrain", 694: "Qatar", 678: "Yemen", 698: "Oman", 660: "Lebanon", 663: "Jordan", 652: "Syria" };
  const year = new Date().getUTCFullYear();
  const versions = [];
  for (let m = 1; m <= 12; m++) versions.push(`${String(year).slice(2)}.0.${m}`);
  const events = [];
  for (const v of versions) {
    for (const id of Object.keys(countries)) {
      let text;
      try { text = await cached(`ucdp_${v}_${id}.json`, `https://ucdpapi.pcr.uu.se/api/gedevents/${v}?pagesize=1000&Country=${id}&StartDate=${FROM}`, offline, { "x-ucdp-access-token": token }); }
      catch (e) { continue; }
      const j = JSON.parse(text);
      for (const r of j.Result || []) events.push({ date: r.date_start.slice(0, 10), lat: r.latitude, lon: r.longitude, a: r.side_a, b: r.side_b, deaths: r.best, country: countries[id], v });
    }
  }
  return { source: "UCDP GED candidate events (ucdp.uu.se), via the UCDP API", events };
}

// ---------- shipping ----------
async function buildShipping(offline) {
  const years = [];
  for (let y = 2024; y <= new Date().getUTCFullYear(); y++) years.push(y);
  const days = {};
  const baseline = {};
  for (const [id, cp] of Object.entries(CHOKEPOINTS)) {
    const sum = { total: 0, tanker: 0, n: 0 };
    for (const y of years) {
      const where = encodeURIComponent(`portid='${id}' AND year=${y}`);
      const url = `${PW}?where=${where}&outFields=date,n_total,n_tanker,n_container,n_cargo&orderByFields=date&returnGeometry=false&f=json`;
      let j;
      try { j = JSON.parse(await cached(`pw_${id}_${y}.json`, url, offline)); }
      catch (e) { console.log("PortWatch skipped", id, y, e.message); continue; }
      for (const f of j.features || []) {
        const a = f.attributes;
        (days[a.date] = days[a.date] || {})[id] = [a.n_total, a.n_tanker, a.n_container, a.n_cargo];
        // Baseline: the five months before the June 2025 war.
        if (a.date >= "2025-01-01" && a.date < "2025-06-01") { sum.total += a.n_total; sum.tanker += a.n_tanker; sum.n++; }
      }
    }
    baseline[id] = sum.n ? { period: "2025-01 to 2025-05", total: +(sum.total / sum.n).toFixed(1), tanker: +(sum.tanker / sum.n).toFixed(1) } : null;
  }
  const out = {
    source: "IMF PortWatch, Daily Chokepoints Data (portwatch.imf.org): daily counts of vessel transits by type from AIS, by chokepoint.",
    license: "IMF data terms: https://www.imf.org/external/terms.htm (free use with attribution to IMF PortWatch).",
    fetched: new Date().toISOString().slice(0, 10),
    fields: ["total transits", "tankers", "container ships", "other cargo"],
    chokepoints: CHOKEPOINTS, baseline, days,
  };
  fs.writeFileSync(path.join(OUT, "shipping.json"), JSON.stringify(out) + "\n");
  const dates = Object.keys(days).sort();
  console.log(`shipping.json: ${dates.length} dates, ${dates[0]} to ${dates[dates.length - 1]}, Hormuz baseline ${JSON.stringify(baseline.chokepoint6)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const ti = args.indexOf("--ucdp-token");
  const token = ti >= 0 ? args[ti + 1] : (process.env.UCDP_TOKEN || null);
  fs.mkdirSync(OUT, { recursive: true });
  await buildEvents(offline, token);
  await buildShipping(offline);
}
main().catch((e) => { console.error(e); process.exit(1); });
