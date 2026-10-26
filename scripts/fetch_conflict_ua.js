#!/usr/bin/env node
/* Snapshots the data behind the Ukraine play-by-play mode into the repo.

   Writes data/conflicts/ua/
     oblasts.json   Ukraine's 27 admin-1 regions (incl. Crimea and Sevastopol),
                    simplified from Natural Earth 10m admin-1 (public domain)
     strikes.json   per-day, per-city aerial attack records, 2022 to date, from
                    the "time-machine-data" pipeline (github.com/mdniprovskyi/
                    time-machine-data, which cross-references VIINA, the Kaggle
                    "Massive Missile Attacks on Ukraine" dataset and UCDP;
                    described by its author as free for non-commercial use),
                    plus returnFire: Ukrainian-side GeoConfirmed placemarks
                    inside Russia, Belarus and occupied Crimea, per day, and a
                    list of Russian and Belarusian cities for the map

     regions_ru_by.json  admin-1 regions of Belarus and European Russia
     fronts/<date>.json  weekly front line snapshots from DeepStateMap's public
                    history API (occupied, liberated, grey zone, 2014 territories,
                    direction of attack), simplified; fronts/index.json lists them

   Optional: --kaggle <missiles_and_uav.csv> adds per-day launch totals and
   launch areas from the Kaggle dataset (download it yourself after signing in).
   --fronts-every <days> changes the snapshot cadence (default 7); --no-fronts skips them.

   Usage:
     node scripts/fetch_conflict_ua.js
     node scripts/fetch_conflict_ua.js --offline
     node scripts/fetch_conflict_ua.js --kaggle path/to/missiles_and_uav.csv */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", "conflicts", "ua");
const NE_CACHE = path.join(os.tmpdir(), "wpn-ne");
const TM_CACHE = path.join(os.tmpdir(), "wpn-timemachine");
const NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";
const TM_URL = "https://raw.githubusercontent.com/mdniprovskyi/time-machine-data/main/";
const YEARS = [2022, 2023, 2024, 2025, 2026];

// Cities named in the attack records, with an illustrative approach bearing
// (degrees from north) for the tracer animation: where strikes on that city
// typically come from. The bearing is a drawing aid, not data.
const CITIES = {
  Kyiv: [50.45, 30.52, 40], Kharkiv: [49.99, 36.23, 70], Zaporizhzhia: [47.84, 35.14, 130],
  Kherson: [46.64, 32.61, 150], Dnipro: [48.46, 35.05, 110], Odesa: [46.48, 30.73, 165],
  Mykolaiv: [46.97, 32.0, 155], Lviv: [49.84, 24.03, 100], Sumy: [50.91, 34.8, 50],
  Kramatorsk: [48.72, 37.55, 100], Chernihiv: [51.5, 31.3, 30], Poltava: [49.59, 34.55, 80],
  Kropyvnytskyi: [48.51, 32.26, 120], Vinnytsia: [49.23, 28.47, 110], Cherkasy: [49.44, 32.06, 100],
  Zhytomyr: [50.25, 28.66, 60], Ternopil: [49.55, 25.6, 100], Lutsk: [50.75, 25.33, 70],
  Khmelnytskyi: [49.42, 27.0, 105], "Ivano-Frankivsk": [48.92, 24.71, 110], Uzhhorod: [48.62, 22.3, 100],
  Chernivtsi: [48.29, 25.93, 120], Rivne: [50.62, 26.25, 70],
};

// Cities in Russia and Belarus shown in play-by-play mode (targets of return fire, launch areas).
const CITIES_RU_BY = {
  Moscow: [55.76, 37.62, "RU"], "St Petersburg": [59.94, 30.31, "RU"], Belgorod: [50.6, 36.59, "RU"], Kursk: [51.73, 36.19, "RU"],
  Bryansk: [53.24, 34.36, "RU"], Voronezh: [51.66, 39.2, "RU"], "Rostov-on-Don": [47.23, 39.72, "RU"], Taganrog: [47.21, 38.93, "RU"],
  Krasnodar: [45.04, 38.98, "RU"], Novorossiysk: [44.72, 37.77, "RU"], Tuapse: [44.1, 39.07, "RU"], Yeysk: [46.71, 38.27, "RU"],
  "Primorsko-Akhtarsk": [46.05, 38.17, "RU"], Millerovo: [48.92, 40.4, "RU"], Morozovsk: [48.35, 41.83, "RU"], Volgograd: [48.71, 44.51, "RU"],
  Saratov: [51.53, 46.03, "RU"], Engels: [51.48, 46.11, "RU"], Samara: [53.2, 50.15, "RU"], Kazan: [55.79, 49.12, "RU"],
  Ryazan: [54.63, 39.74, "RU"], Tula: [54.19, 37.62, "RU"], Oryol: [52.97, 36.07, "RU"], Lipetsk: [52.6, 39.57, "RU"],
  Tambov: [52.72, 41.45, "RU"], Kaluga: [54.51, 36.26, "RU"], Smolensk: [54.78, 32.05, "RU"], Tver: [56.86, 35.9, "RU"],
  Yaroslavl: [57.63, 39.87, "RU"], "Nizhny Novgorod": [56.3, 44.0, "RU"], Pskov: [57.82, 28.33, "RU"], Astrakhan: [46.35, 48.04, "RU"],
  Ufa: [54.74, 55.97, "RU"], Perm: [58.01, 56.23, "RU"], Shakhty: [47.71, 40.21, "RU"],
  Minsk: [53.9, 27.57, "BY"], Gomel: [52.44, 31.0, "BY"], Brest: [52.1, 23.7, "BY"], Mozyr: [52.05, 29.25, "BY"],
  Baranovichi: [53.13, 26.02, "BY"], Machulishchy: [53.77, 27.58, "BY"],
};

// Launch areas named in the Kaggle dataset (best effort; unknown names are kept as text).
const LAUNCH_AREAS = {
  "Caspian Sea": [42.5, 50.0], "Black Sea": [44.0, 34.0], "Sea of Azov": [46.2, 36.8],
  "Crimea": [45.3, 34.4], "Bryansk": [53.2, 34.4], "Kursk": [51.7, 36.2], "Belgorod": [50.6, 36.6],
  "Primorsko-Akhtarsk": [46.05, 38.17], "Saratov": [51.5, 46.0], "Engels": [51.48, 46.1],
  "Millerovo": [48.92, 40.4], "Shakhty": [47.7, 40.2], "Rostov": [47.2, 39.7], "Voronezh": [51.7, 39.2],
  "Belarus": [52.5, 28.0], "Oryol": [52.97, 36.07], "Tambov": [52.7, 41.4], "Volgograd": [48.7, 44.5],
  "Chauda": [45.0, 35.8], "Balaklava": [44.5, 33.6], "Kapustin Yar": [48.6, 46.3], "Astrakhan": [46.3, 48.0],
};

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "world-patch-notes" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}
async function cached(dir, name, url, offline) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  if (offline) throw new Error("not cached: " + name);
  fs.mkdirSync(dir, { recursive: true });
  console.log("downloading", url);
  const text = await fetchText(url);
  fs.writeFileSync(file, text);
  return text;
}

// ---------- polygon simplification (Douglas-Peucker, degrees) ----------
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push([+pts[i][0].toFixed(3), +pts[i][1].toFixed(3)]);
  return out;
}
function simplifyGeom(g, tol) {
  const ring = (r) => simplify(r, tol);
  if (g.type === "Polygon") return { type: g.type, coordinates: g.coordinates.map(ring).filter((r) => r.length >= 4) };
  if (g.type === "MultiPolygon") return { type: g.type, coordinates: g.coordinates.map((p) => p.map(ring).filter((r) => r.length >= 4)).filter((p) => p.length) };
  return g;
}

// ---------- point in polygon (lon/lat degrees) ----------
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

let adminCache = null;
async function loadAdmin1(offline) {
  if (!adminCache) adminCache = JSON.parse(await cached(NE_CACHE, "ne_10m_admin_1_states_provinces.geojson", NE_URL, offline));
  return adminCache;
}

// Ukrainian-side events geolocated inside Russia and Belarus (and occupied
// Crimea), from GeoConfirmed placemarks carried in the time-machine repo.
async function buildReturnFire(offline) {
  const geo = JSON.parse(await cached(TM_CACHE, "GeoConfirmed - Ukraine.geojson", TM_URL + "GeoConfirmed%20-%20Ukraine.geojson", offline));
  const a1 = await loadAdmin1(offline);
  const regions = a1.features
    .filter((f) => ["RUS", "BLR"].includes(f.properties.adm0_a3))
    .map((f) => {
      let name = f.properties.name_en || f.properties.name, country = f.properties.adm0_a3 === "BLR" ? "BY" : "RU";
      if (/Crimea/.test(name)) { name = "Crimea"; country = "UA (occupied)"; }
      if (name === "Sevastopol") country = "UA (occupied)";
      return { name, country, geom: f.geometry, bbox: bboxOf(f.geometry) };
    });
  const regionOf = (x, y) => {
    for (let i = 0; i < regions.length; i++) {
      const b = regions[i].bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (inGeom(regions[i].geom, x, y)) return i;
    }
    return -1;
  };
  const days = {};
  let n = 0;
  for (const f of geo.features) {
    if (f.properties.factionId !== 9 || !f.geometry || f.geometry.type !== "Point") continue; // 9 = Ukrainian side (blue)
    const [x, y] = f.geometry.coordinates;
    if (x < 22 || x > 62 || y < 41 || y > 62) continue;
    const ri = regionOf(x, y);
    if (ri < 0) continue;
    const date = String(f.properties.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const icon = String(f.properties.icon || "").split("/").pop().replace(/\.png$/, "");
    (days[date] = days[date] || []).push([+y.toFixed(2), +x.toFixed(2), ri, icon]);
    n++;
  }
  console.log(`return fire: ${n} Ukrainian-side events inside Russia, Belarus and Crimea across ${Object.keys(days).length} dates`);
  return {
    source: "GeoConfirmed placemarks (geoconfirmed.org) as carried in github.com/mdniprovskyi/time-machine-data; Ukrainian-side (blue) placemarks located inside Russia, Belarus or occupied Crimea by point-in-polygon against Natural Earth admin-1.",
    note: "Each placemark is a geolocated event, not necessarily a strike: the Kursk and Belgorod border areas include ground actions. GeoConfirmed's icon code is kept per event but its legend is not public.",
    license: "GeoConfirmed publishes no license file for its placemark export; confirm terms before any use beyond this prototype.",
    fields: ["lat", "lon", "region index", "GeoConfirmed icon code"],
    regions: regions.map((r) => ({ name: r.name, country: r.country })),
    days,
  };
}

// Admin-1 regions of Belarus and European Russia (west of 62E), for context
// around the Ukrainian oblasts in play-by-play mode.
async function buildNeighbourRegions(offline) {
  const geo = await loadAdmin1(offline);
  const feats = geo.features.filter((f) => f.properties.adm0_a3 === "BLR" ||
    (f.properties.adm0_a3 === "RUS" && f.properties.longitude < 62 && f.properties.latitude < 62 && !/Crimea|Sevastopol/.test(f.properties.name || "")));
  const out = {
    type: "FeatureCollection",
    source: "Natural Earth 10m admin-1 (public domain), Belarus and Russia west of 62E, simplified to ~1 km.",
    features: feats.map((f) => ({
      type: "Feature",
      properties: { name: f.properties.name_en || f.properties.name, country: f.properties.adm0_a3 === "BLR" ? "BY" : "RU", latitude: f.properties.latitude, longitude: f.properties.longitude },
      geometry: simplifyGeom(f.geometry, 0.012),
    })),
  };
  fs.writeFileSync(path.join(OUT, "regions_ru_by.json"), JSON.stringify(out) + "\n");
  console.log(`regions_ru_by.json: ${out.features.length} regions, ${(fs.statSync(path.join(OUT, "regions_ru_by.json")).size / 1024).toFixed(0)} KB`);
}

// ---------- front lines (DeepStateMap) ----------
const DS_HISTORY = "https://deepstatemap.live/api/history/public";
const DS_GEOJSON = (id) => `https://deepstatemap.live/api/history/${id}/geojson`;
const DS_CACHE = path.join(os.tmpdir(), "wpn-deepstate");

// Polygons must sit inside this box (Ukraine plus the Kursk and Belgorod
// border areas); DeepState also exports political polygons for Karelia,
// East Prussia, the Kurils and others that are not part of this front.
const UA_BOX = [21.5, 44.0, 41.5, 53.0]; // lon min, lat min, lon max, lat max
function centroidIn(polys, box) {
  let sx = 0, sy = 0, n = 0;
  for (const p of polys) for (const c of p[0]) { sx += c[0]; sy += c[1]; n++; }
  if (!n) return false;
  const x = sx / n, y = sy / n;
  return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

// Classify a DeepState feature by its bilingual name.
function frontClass(name) {
  const n = String(name || "");
  if (/Придністров|Абхаз|Цхінвал|Прусс|Карел|Ічкер|Петсамо|Куриль|Transnistria|Abkhazia|Prussia|Karelia|Petsamo|Kuril|Camp N/i.test(n)) return null; // outside Ukraine or not terrain
  if (/territories\.|Окупований Крим|ОРДЛО|Тузла/i.test(n)) return "terr";          // occupied since 2014
  if (/Напрямок удару|Direction of attack|status\.at/i.test(n)) return "attack";
  if (/Звільнено|Liberated|dismissed/i.test(n)) return "lib";
  if (/Окуповано|Occupied|status\.occupied/i.test(n)) return "occ";
  if (/невідом|Unknown|Під питанням|status\.unknown/i.test(n)) return "grey";
  return null;
}

async function buildFronts(offline, everyDays) {
  const dir = path.join(OUT, "fronts");
  fs.mkdirSync(dir, { recursive: true });
  const history = JSON.parse(await cached(DS_CACHE, "history.json", DS_HISTORY, offline));
  // Last snapshot of each N-day bucket, plus the very first and the very last.
  const byDate = {};
  for (const h of history) byDate[h.createdAt.slice(0, 10)] = h; // later entries win within a day
  const dates = Object.keys(byDate).sort();
  const picked = [];
  let lastT = -Infinity;
  for (const d of dates) {
    const t = Date.parse(d);
    if (t - lastT >= everyDays * 86400000 - 1) { picked.push(d); lastT = t; }
  }
  if (picked[picked.length - 1] !== dates[dates.length - 1]) picked.push(dates[dates.length - 1]);
  const index = { source: "DeepStateMap (deepstatemap.live) public history API; one snapshot per " + everyDays + " days, polygons simplified to ~1 km.",
    license: "DeepStateMap publishes no machine-readable license for its API output; it is widely cited with attribution. Confirm terms before any use beyond this prototype.",
    classes: { occ: "occupied (assessed)", lib: "liberated", grey: "grey zone / unknown", terr: "occupied since 2014 (Crimea, parts of Donetsk and Luhansk)", attack: "direction of attack" },
    coverage: { partialBefore: "2022-09-27", note: "DeepState's early exports drew only parts of the front: Crimea appears from 2022-09-20 and the southern occupied zone (Kherson and Zaporizhzhia) from 2022-09-27. Earlier snapshots understate occupied territory; the jump on those dates is a change in the data, not an advance." },
    fetched: new Date().toISOString().slice(0, 10), dates: [] };
  let bytes = 0;
  for (const d of picked) {
    const h = byDate[d];
    const file = path.join(dir, d + ".json");
    if (!fs.existsSync(file)) {
      let text;
      try { text = await cached(DS_CACHE, `${h.id}.json`, DS_GEOJSON(h.id), offline); }
      catch (e) { console.log("front snapshot skipped", d, e.message); continue; }
      const geo = JSON.parse(text);
      const feats = [];
      for (const f of geo.features) {
        if (!f.geometry || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) continue;
        const k = frontClass(f.properties && f.properties.name);
        if (!k) continue;
        const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
        if (!centroidIn(polys, UA_BOX)) continue;
        for (const p of polys) {
          const rings = p.map((r) => simplify(r.map((c) => [c[0], c[1]]), k === "attack" ? 0.006 : 0.01)).filter((r) => r.length >= 4);
          if (rings.length) feats.push({ k, rings });
        }
      }
      fs.writeFileSync(file, JSON.stringify({ date: d, id: h.id, note: (h.descriptionEn || "").replace(/<[^>]+>/g, "").slice(0, 300), features: feats }) + "\n");
      if (!offline) await new Promise((r) => setTimeout(r, 350)); // be polite to their API
    }
    bytes += fs.statSync(file).size;
    index.dates.push(d);
  }
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`fronts: ${index.dates.length} snapshots, ${(bytes / 1024 / 1024).toFixed(1)} MB total`);
}

async function buildOblasts(offline) {
  const geo = await loadAdmin1(offline);
  const feats = geo.features.filter((f) => f.properties.adm0_a3 === "UKR" || /^(Crimea|Sevastopol)$/.test(f.properties.name || ""));
  const out = {
    type: "FeatureCollection",
    source: "Natural Earth 10m admin-1 (public domain), simplified to ~1 km. Crimea and Sevastopol are included as Ukrainian oblasts; Natural Earth itself files them under de facto control.",
    features: feats.map((f) => ({
      type: "Feature",
      properties: { name: f.properties.name_en || f.properties.name, latitude: f.properties.latitude, longitude: f.properties.longitude },
      geometry: simplifyGeom(f.geometry, 0.012),
    })),
  };
  fs.writeFileSync(path.join(OUT, "oblasts.json"), JSON.stringify(out) + "\n");
  console.log(`oblasts.json: ${out.features.length} regions, ${(fs.statSync(path.join(OUT, "oblasts.json")).size / 1024).toFixed(0)} KB`);
}

// ---------- strikes ----------
async function buildStrikes(offline, kaggleCsv) {
  const names = Object.keys(CITIES);
  const days = {};
  let total = 0, skipped = {};
  for (const y of YEARS) {
    let text;
    try { text = await cached(TM_CACHE, `time_machine_${y}.json`, `${TM_URL}time_machine_${y}.json`, offline); }
    catch (e) { console.log("no file for", y, e.message); continue; }
    const j = JSON.parse(text);
    for (const r of j.records || []) {
      if (!r.airAttackRecorded) continue;
      const ci = names.indexOf(r.location);
      if (ci < 0) { skipped[r.location] = (skipped[r.location] || 0) + 1; continue; }
      (days[r.date] = days[r.date] || []).push([
        ci, r.missiles || 0, r.attackDrones || 0, r.civilianDeaths || 0, r.civilianInjuries || 0,
        r.nightRaid ? 1 : 0, r.viinaEventCount || 0,
      ]);
      total++;
    }
  }
  const out = {
    source: "github.com/mdniprovskyi/time-machine-data (cross-references VIINA, the Kaggle 'Massive Missile Attacks on Ukraine' dataset and UCDP). Documented-minimum counts; missiles and drones are only filled where a weapon count could be attributed to that city and day.",
    license: "Author describes the pipeline output as free for non-commercial use; confirm before any commercial use.",
    fetched: new Date().toISOString().slice(0, 10),
    fields: ["city index", "missiles", "attack drones", "civilian deaths", "civilian injuries", "night raid (0/1)", "report count"],
    cities: names.map((n) => ({ name: n, lat: CITIES[n][0], lon: CITIES[n][1], bearing: CITIES[n][2] })),
    bearingNote: "bearing is an illustrative approach direction for the tracer animation, not recorded launch data",
    otherCities: Object.entries(CITIES_RU_BY).map(([n, v]) => ({ name: n, lat: v[0], lon: v[1], country: v[2] })),
    days,
  };
  if (kaggleCsv) out.launches = parseKaggle(kaggleCsv);
  try { out.returnFire = await buildReturnFire(offline); }
  catch (e) { console.log("return fire skipped:", e.message); }
  fs.writeFileSync(path.join(OUT, "strikes.json"), JSON.stringify(out) + "\n");
  console.log(`strikes.json: ${total} city-days across ${Object.keys(days).length} dates, ${(fs.statSync(path.join(OUT, "strikes.json")).size / 1024).toFixed(0)} KB`);
  if (Object.keys(skipped).length) console.log("locations without coordinates (add to CITIES):", JSON.stringify(skipped));
}

// Kaggle missiles_and_uav.csv -> per day {launched, destroyed, from: {area: launched}}
function parseKaggle(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const head = rows.shift().map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const iDate = col("time_end") >= 0 ? col("time_end") : col("time_start");
  const iPlace = col("launch_place"), iLaunched = col("launched"), iDestroyed = col("destroyed"), iModel = col("model");
  const out = {};
  for (const r of rows) {
    const date = (r[iDate] || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const d = (out[date] = out[date] || { launched: 0, destroyed: 0, from: {}, drones: 0, missiles: 0 });
    const launched = Number(r[iLaunched]) || 0, destroyed = Number(r[iDestroyed]) || 0;
    d.launched += launched; d.destroyed += destroyed;
    if (/shahed|geran|lancet|orlan|uav|drone/i.test(r[iModel] || "")) d.drones += launched; else d.missiles += launched;
    for (const place of String(r[iPlace] || "").split(/\s*(?:,|and|\/)\s*/)) {
      const key = Object.keys(LAUNCH_AREAS).find((k) => place.toLowerCase().includes(k.toLowerCase())) || place.trim();
      if (key) d.from[key] = (d.from[key] || 0) + launched;
    }
  }
  return { source: "Kaggle: Massive Missile Attacks on Ukraine (Petro Ivaniuk)", areas: LAUNCH_AREAS, days: out };
}
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const ki = args.indexOf("--kaggle");
  const kaggle = ki >= 0 ? args[ki + 1] : null;
  const fi = args.indexOf("--fronts-every");
  const everyDays = fi >= 0 ? Number(args[fi + 1]) || 7 : 7;
  fs.mkdirSync(OUT, { recursive: true });
  await buildOblasts(offline);
  await buildNeighbourRegions(offline);
  await buildStrikes(offline, kaggle);
  if (!args.includes("--no-fronts")) await buildFronts(offline, everyDays);
}
main().catch((e) => { console.error(e); process.exit(1); });
