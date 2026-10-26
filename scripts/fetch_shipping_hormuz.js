#!/usr/bin/env node
/* Snapshots per-vessel AIS tracks around the Strait of Hormuz, plus UKMTO
   incident reports, from the Strait of Hormuz Ship Monitor
   (hormuz.data-tracking.net, CC BY 4.0) into data/conflicts/irus/:

     vessels.json    ship registry (name, category, flag, size) and two-week
                     position tracks for every vessel that crossed the strait
                     recently or is holding at anchor, merged with what earlier
                     runs stored, so history accumulates week by week
     incidents.json  UKMTO incident reports (Crown copyright, Open Government
                     Licence v3.0; attribution required) with positions

   The monitor returns at most 500 positions per ship (about two weeks), so a weekly run keeps the archive
   continuous. Positions are thinned to one fix per 30 minutes per vessel.

   Usage:
     node scripts/fetch_shipping_hormuz.js               fetch and merge
     node scripts/fetch_shipping_hormuz.js --quick       snapshot and incidents only (no per-ship history)
     node scripts/fetch_shipping_hormuz.js --max 400     limit the number of per-ship history calls
     node scripts/fetch_shipping_hormuz.js --hf-archive  also ingest the March to April 2026 archive from
                                                         the yasumorishima/hormuz-ais dataset on Hugging Face
                                                         (aisstream.io positions; see that dataset's terms)
     node scripts/fetch_shipping_hormuz.js --hf-csv <file>  same archive from a CSV exported by hand (the
                                                         dataset viewer's SQL console can save a query as CSV;
                                                         columns as in the dataset: mmsi, timestamp, latitude,
                                                         longitude, speed, course, ship_name, ship_type, flag,
                                                         length, destination)
     node scripts/fetch_shipping_hormuz.js --radar-csv <det.csv> <scenes.csv>  build radar.json from CSV
                                                         exports of the dataset's sar/det and sar/scenes tables */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", "conflicts", "irus");
const BASE = "https://hormuz.data-tracking.net";
const HEADERS = { "User-Agent": "world-patch-notes/0.1 (static site prototype; weekly snapshot)", Accept: "application/json" };
const THIN_MIN = 30; // minutes between stored fixes per vessel
const BOX = [22.0, 48.0, 30.5, 61.0]; // lat min, lon min, lat max, lon max

async function getJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (x) => Math.round(x * 1000) / 1000;
const minutes = (iso) => Math.round(Date.parse(iso) / 60000);

// Decode the monitor's compact incident table: columns `c`, string table `s`,
// rows `r`; the column indexes listed in `k` hold numbers that point into `s`.
function decodeIncidents(j) {
  const cols = j.t.c, keyed = new Set(j.t.k), strings = j.s;
  return j.t.r.map((row) => {
    const o = {};
    cols.forEach((c, i) => {
      const v = row[i];
      o[c] = (keyed.has(i) && typeof v === "number" && strings[v] !== undefined) ? strings[v] : v;
    });
    return o;
  });
}

// AIS ship type codes (ITU) to a coarse category, for archive rows that carry
// only the number.
function aisCategory(code) {
  if (code == null) return "Unknown";
  const c = Math.floor(code);
  if (c >= 80 && c <= 89) return "Tanker";
  if (c >= 70 && c <= 79) return "Cargo";
  if (c >= 60 && c <= 69) return "Passenger";
  if (c === 30) return "Fishing";
  if (c === 31 || c === 32 || c === 52) return "Tug";
  if (c >= 40 && c <= 49) return "High-speed craft";
  if (c === 35) return "Military";
  if (c === 36 || c === 37) return "Pleasure craft";
  return "Other";
}

// Pull the Hugging Face archive (March to April 2026) through the rows API,
// 100 rows per call, caching every page in the OS temp folder.
async function ingestHfArchive(addFix, registry) {
  const os = require("os");
  const cache = path.join(os.tmpdir(), "wpn-hormuz-hf");
  fs.mkdirSync(cache, { recursive: true });
  const base = "https://datasets-server.huggingface.co/rows?dataset=yasumorishima%2Fhormuz-ais&config=default&split=train";
  let offset = 0, total = null, rows = 0;
  while (total === null || offset < total) {
    const file = path.join(cache, `train_${offset}.json`);
    let j;
    if (fs.existsSync(file)) j = JSON.parse(fs.readFileSync(file, "utf8"));
    else {
      let tries = 0;
      while (true) {
        try { j = await getJSON(`${base}&offset=${offset}&length=100`); break; }
        catch (e) { if (++tries > 4) throw e; await sleep(1500 * tries); }
      }
      fs.writeFileSync(file, JSON.stringify(j));
      await sleep(250);
    }
    total = j.num_rows_total;
    for (const { row } of j.rows || []) {
      rows++;
      const mmsi = String(row.mmsi);
      addFix(mmsi, { timestamp: row.timestamp.endsWith("Z") || /[+-]\d\d:\d\d$/.test(row.timestamp) ? row.timestamp : row.timestamp + "Z", latitude: row.latitude, longitude: row.longitude, speed: row.speed, course: row.course });
      if (!registry[mmsi]) registry[mmsi] = { name: row.ship_name || "", category: aisCategory(row.ship_type), flag: row.flag || "", length: row.length || null, dwt: null, destination: row.destination || "", zone: "", still: false, seen: row.timestamp, from: "hf-archive" };
    }
    offset += 100;
    if (offset % 5000 === 0) process.stdout.write(`\r  archive ${Math.min(offset, total)} / ${total}`);
  }
  process.stdout.write("\n");
  console.log(`archive: ${rows} rows read from yasumorishima/hormuz-ais`);
}

// Minimal CSV reader (quoted fields, embedded newlines).
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
  return rows.filter((r) => r.length > 1);
}

function ingestCsvArchive(file, addFix, registry) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const head = rows.shift().map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const need = ["mmsi", "timestamp", "latitude", "longitude"];
  for (const n of need) if (col(n) < 0) throw new Error(`CSV is missing the "${n}" column (found: ${head.join(", ")})`);
  const num = (v) => (v === "" || v == null ? null : Number(v));
  let n = 0;
  for (const r of rows) {
    const mmsi = String(r[col("mmsi")]).trim();
    const ts = String(r[col("timestamp")]).trim();
    if (!mmsi || !ts) continue;
    addFix(mmsi, { timestamp: /Z$|[+-]\d\d:\d\d$/.test(ts) ? ts : ts + "Z", latitude: num(r[col("latitude")]), longitude: num(r[col("longitude")]), speed: num(r[col("speed")]), course: num(r[col("course")]) });
    if (!registry[mmsi]) registry[mmsi] = { name: col("ship_name") >= 0 ? r[col("ship_name")] : "", category: aisCategory(col("ship_type") >= 0 ? num(r[col("ship_type")]) : null), flag: col("flag") >= 0 ? r[col("flag")] : "", length: col("length") >= 0 ? num(r[col("length")]) : null, dwt: null, destination: col("destination") >= 0 ? r[col("destination")] : "", zone: "", still: false, seen: ts, from: "hf-archive" };
    n++;
  }
  console.log(`archive: ${n} rows read from ${path.basename(file)}`);
}

// Sentinel-1 radar ship detections (from the same Hugging Face dataset's
// sar/det and sar/scenes tables, exported as two CSVs). Each vessel-sized
// detection is matched against the AIS archive: a fix within 3 hours and
// 2 km means the ship was transmitting; otherwise it is a "dark" contact.
function buildRadar(detCsv, scenesCsv, tracks, population) {
  const det = parseCsv(fs.readFileSync(detCsv, "utf8"));
  const dh = det.shift().map((h) => h.trim().toLowerCase());
  const dc = (n) => dh.indexOf(n);
  const sc = parseCsv(fs.readFileSync(scenesCsv, "utf8"));
  const sh = sc.shift().map((h) => h.trim().toLowerCase());
  const scol = (n) => sh.indexOf(n);
  const scenes = {};
  for (const r of sc) scenes[r[scol("scene_id")]] = { id: r[scol("scene_id")], time: r[scol("acq_time")], platform: r[scol("platform")], covered: Number(r[scol("aoi_covered_frac")]) || 0, candidates: Number(r[scol("n_candidates")]) || 0, vesselSized: Number(r[scol("n_vessel_sized")]) || 0 };
  const km = (a, b, c, d) => { const R = 6371, D = Math.PI / 180, x = (d - b) * D * Math.cos(((a + c) / 2) * D), y = (c - a) * D; return Math.sqrt(x * x + y * y) * R; };
  // Pass 1: keep vessel-sized detections away from the shore and find the
  // cells that light up in scene after scene (platforms, buoys, islets).
  const NEAR_SHORE_KM = 0.5, FIXED_SCENES = 6, CELL = 0.0015;
  const cellOf = (lat, lon) => `${Math.round(lat / CELL)},${Math.round(lon / CELL)}`;
  const rows = [];
  const cellScenes = {};
  let nearShore = 0;
  for (const r of det) {
    if (String(r[dc("vessel_sized")]).toLowerCase() !== "true" || (r[dc("reject_reason")] || "").trim()) continue;
    const lat = Number(r[dc("latitude")]), lon = Number(r[dc("longitude")]), t = minutes(r[dc("acq_time")]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) continue;
    const dl = Number(r[dc("dist_to_land_km")]);
    if (Number.isFinite(dl) && dl < NEAR_SHORE_KM) { nearShore++; continue; }
    const id = r[dc("scene_id")];
    rows.push({ id, t, time: r[dc("acq_time")], platform: r[dc("platform")], lat, lon, dl, len: Number(r[dc("length_m")]) || 0, wid: Number(r[dc("width_m")]) || 0, snr: Number(r[dc("snr")]) || 0 });
    (cellScenes[cellOf(lat, lon)] = cellScenes[cellOf(lat, lon)] || new Set()).add(id);
  }
  // Pass 2: AIS positions interpolated to each scene time, for the match and
  // for an honest coverage figure per scene.
  const sceneTimes = {};
  for (const r of rows) sceneTimes[r.id] = sceneTimes[r.id] || { t: r.t, grid: {}, ais: 0 };
  const cell = (lat, lon) => `${Math.floor(lat / 0.05)},${Math.floor(lon / 0.05)}`;
  for (const s of Object.values(sceneTimes)) {
    for (const [mmsi, track] of Object.entries(tracks)) {
      let b = null, a = null;
      for (const f of track) { if (f[0] <= s.t && (!b || f[0] > b[0])) b = f; if (f[0] >= s.t && (!a || f[0] < a[0])) a = f; }
      let p = null;
      if (b && a && a[0] - b[0] <= 240) { const w = a[0] === b[0] ? 0 : (s.t - b[0]) / (a[0] - b[0]); p = [b[1] + (a[1] - b[1]) * w, b[2] + (a[2] - b[2]) * w]; }
      else if (b && s.t - b[0] <= 45) p = [b[1], b[2]];
      else if (a && a[0] - s.t <= 45) p = [a[1], a[2]];
      if (!p) continue;
      (s.grid[cell(p[0], p[1])] = s.grid[cell(p[0], p[1])] || []).push([p[0], p[1], mmsi]);
      s.ais++;
    }
  }
  const days = {};
  const sceneList = [];
  const sceneIdx = {};
  let kept = 0, dark = 0, fixed = 0;
  for (const r of rows) {
    if (cellScenes[cellOf(r.lat, r.lon)].size >= FIXED_SCENES) { fixed++; continue; }
    const s = sceneTimes[r.id];
    if (sceneIdx[r.id] === undefined) {
      sceneIdx[r.id] = sceneList.length;
      const meta = scenes[r.id] || { id: r.id, time: r.time };
      if (!meta.platform) meta.platform = r.platform || "";
      meta.ais = s.ais;
      meta.population = population;
      const share = population ? s.ais / population : 0;
      meta.coverage = share >= 0.8 ? "good" : share >= 0.3 ? "partial" : "thin";
      sceneList.push(meta);
    }
    let match = null, best = 1.5;
    const ci = Math.floor(r.lat / 0.05), cj = Math.floor(r.lon / 0.05);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      for (const p of s.grid[`${i},${j}`] || []) { const d = km(r.lat, r.lon, p[0], p[1]); if (d <= best) { best = d; match = p[2]; } }
    }
    const date = new Date(r.t * 60000).toISOString().slice(0, 10);
    (days[date] = days[date] || []).push([r3(r.lat), r3(r.lon), Math.round(r.len), Math.round(r.wid), Math.round(r.snr * 10) / 10, sceneIdx[r.id], match || "", Number.isFinite(r.dl) ? Math.round(r.dl * 10) / 10 : null]);
    kept++;
    if (!match && population && s.ais / population >= 0.8) dark++;
  }
  return {
    source: "Sentinel-1 radar ship detections from the yasumorishima/hormuz-ais dataset (sar/det and sar/scenes tables, detector v1): bright compact objects on the water, filtered to vessel-sized candidates. Copernicus Sentinel data is free and open; the detector output is the dataset author's.",
    note: `A detection is a radar contact, not an identified ship. Contacts within ${NEAR_SHORE_KM} km of the shore (${nearShore}) were dropped as coastal clutter, and ${fixed} contacts at spots that light up in ${FIXED_SCENES} or more scenes were dropped as fixed structures (platforms, buoys, islets). 'match' names the AIS vessel (MMSI) whose interpolated position at the scene time is within 1.5 km. Each scene carries 'ais', the number of archived AIS ships that could be positioned at that moment, 'population', the number of ships the monitor saw in the region on the fetch day, and 'coverage' (good: 80% or more of the population positioned, partial: 30% or more, thin). The archive follows strait crossers and anchored ships, not every vessel in the Gulf, so an unmatched contact only suggests a dark ship when coverage is good.`,
    fields: ["lat", "lon", "length m", "width m", "snr", "scene index", "matched MMSI or empty", "distance to land km"],
    scenes: sceneList, days, counts: { detections: kept, dark, nearShore, fixed },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const ri = args.indexOf("--radar-csv");
  const radarCsv = ri >= 0 ? args[ri + 1] : null, scenesCsv = ri >= 0 ? args[ri + 2] : null;
  const ci = args.indexOf("--hf-csv");
  const csvFile = ci >= 0 ? args[ci + 1] : null;
  const hf = args.includes("--hf-archive") || !!csvFile;
  const mi = args.indexOf("--max");
  const maxCalls = mi >= 0 ? Number(args[mi + 1]) || 400 : 1500;
  fs.mkdirSync(OUT, { recursive: true });
  const vesselsFile = path.join(OUT, "vessels.json");
  const prev = fs.existsSync(vesselsFile) ? JSON.parse(fs.readFileSync(vesselsFile, "utf8")) : { ships: {}, tracks: {} };

  // 1. Current snapshot of every tracked ship.
  const ships = await getJSON(`${BASE}/api/ships`);
  const now = new Date().toISOString();
  const registry = prev.ships || {};
  const tracks = prev.tracks || {};
  const addFix = (mmsi, f) => {
    if (f.latitude == null || f.longitude == null) return;
    if (f.latitude < BOX[0] || f.latitude > BOX[2] || f.longitude < BOX[1] || f.longitude > BOX[3]) return;
    const t = minutes(f.timestamp);
    if (!Number.isFinite(t)) return;
    const arr = (tracks[mmsi] = tracks[mmsi] || []);
    // Keep fixes at least THIN_MIN apart from the nearest stored fix.
    for (let i = arr.length - 1; i >= 0 && arr[i][0] > t - THIN_MIN; i--) if (Math.abs(arr[i][0] - t) < THIN_MIN) return;
    arr.push([t, r3(f.latitude), r3(f.longitude), f.speed == null ? null : Math.round(f.speed * 10) / 10, f.course == null ? null : Math.round(f.course)]);
  };
  if (csvFile) ingestCsvArchive(csvFile, addFix, registry);
  else if (hf) await ingestHfArchive(addFix, registry);
  for (const s of ships) {
    registry[s.mmsi] = { name: s.name, category: s.ship_category, flag: s.flag, length: s.length, dwt: s.dwt, destination: s.destination, zone: s.zone, still: !!s.still, seen: s.timestamp };
    addFix(s.mmsi, s);
  }
  console.log(`snapshot: ${ships.length} ships at ${now.slice(0, 16)}`);

  // 2. Per-ship history for the vessels that matter: recent strait crossers
  //    and ships holding still in the approaches.
  if (!quick) {
    const crossings = await getJSON(`${BASE}/api/crossings?hours=720`);
    const wanted = new Set(crossings.map((c) => String(c.mmsi)));
    // Everything in the strait itself, everything holding still in the Gulf of
    // Oman approaches, and the recent crossers.
    for (const s of ships) if (s.zone === "strait" || (s.still && s.zone === "gulf_of_oman")) wanted.add(String(s.mmsi));
    const list = [...wanted].slice(0, maxCalls);
    console.log(`history: ${wanted.size} vessels of interest (${crossings.length} recent crossings), fetching ${list.length}`);
    let done = 0, failed = 0;
    for (const mmsi of list) {
      try {
        const h = await getJSON(`${BASE}/api/ship/history?mmsi=${mmsi}&days=30&limit=500`);
        const arr = Array.isArray(h) ? h : (h.positions || h.history || []);
        for (const f of arr) addFix(mmsi, f);
      } catch (e) { failed++; }
      done++;
      if (done % 50 === 0) process.stdout.write(`\r  ${done} / ${list.length}`);
      await sleep(220);
    }
    process.stdout.write("\n");
    if (failed) console.log(`  ${failed} history calls failed`);
  }
  // Sort and dedupe every track.
  let fixes = 0;
  for (const mmsi of Object.keys(tracks)) {
    const seen = new Set();
    tracks[mmsi] = tracks[mmsi].filter((f) => !seen.has(f[0]) && seen.add(f[0])).sort((a, b) => a[0] - b[0]);
    if (!tracks[mmsi].length) delete tracks[mmsi];
    else fixes += tracks[mmsi].length;
  }
  const out = {
    source: "Strait of Hormuz Ship Monitor (hormuz.data-tracking.net), AIS positions polled every 30 minutes; per-vessel history limited to the last 500 positions per ship (about two weeks), accumulated across weekly runs." + (hf || prev.archive ? " March to April 2026 positions from the yasumorishima/hormuz-ais dataset on Hugging Face (aisstream.io)." : ""),
    license: "CC BY 4.0 (data-tracking.net). Attribute the monitor when reusing." + (hf || prev.archive ? " The Hugging Face archive carries its source's terms (aisstream.io); confirm before any use beyond this prototype." : ""),
    archive: !!(hf || prev.archive),
    fetched: now.slice(0, 10), thinMinutes: THIN_MIN, snapshotShips: ships.length,
    fields: { track: ["minutes since epoch", "lat", "lon", "speed knots", "course"] },
    ships: registry, tracks,
  };
  fs.writeFileSync(vesselsFile, JSON.stringify(out) + "\n");
  let tMin = Infinity, tMax = -Infinity;
  for (const track of Object.values(tracks)) for (const f of track) { if (f[0] < tMin) tMin = f[0]; if (f[0] > tMax) tMax = f[0]; }
  console.log(`vessels.json: ${Object.keys(registry).length} ships, ${Object.keys(tracks).length} with tracks, ${fixes} fixes from ${new Date(tMin * 60000).toISOString().slice(0, 10)} to ${new Date(tMax * 60000).toISOString().slice(0, 10)}, ${(fs.statSync(vesselsFile).size / 1024 / 1024).toFixed(1)} MB`);

  // 2b. Radar detections, matched against the AIS tracks just written.
  if (radarCsv && scenesCsv) {
    const radar = buildRadar(radarCsv, scenesCsv, tracks, ships.length);
    radar.fetched = now.slice(0, 10);
    fs.writeFileSync(path.join(OUT, "radar.json"), JSON.stringify(radar) + "\n");
    const rd = Object.keys(radar.days).sort();
    console.log(`radar.json: ${radar.counts.detections} vessel-sized detections in ${radar.scenes.length} scenes, ${radar.counts.dark} flagged dark (unmatched with good AIS coverage), ${radar.counts.fixed} fixed structures and ${radar.counts.nearShore} shoreline contacts dropped, ${rd[0]} to ${rd[rd.length - 1]}, ${(fs.statSync(path.join(OUT, "radar.json")).size / 1024).toFixed(0)} KB`);
  }

  // 3. UKMTO incidents via the monitor.
  const inc = await getJSON(`${BASE}/api/incidents`);
  const rows = decodeIncidents(inc).map((o) => ({
    id: o.id, type: o.type, lat: o.lat, lon: o.lon, date: new Date(o.ts * 1000).toISOString().slice(0, 10), ts: o.ts,
    vesselType: o.vessel_type, place: o.place, fire: !!o.fire, sunk: !!o.sunk, abandoned: !!o.abandoned, casualty: !!o.casualty, text: o.text,
  })).sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(path.join(OUT, "incidents.json"), JSON.stringify({
    source: "UKMTO incident reports as mirrored by the Strait of Hormuz Ship Monitor (/api/incidents).",
    license: inc.attribution || "UKMTO (ukmto.org), Crown copyright, Open Government Licence v3.0",
    fetched: now.slice(0, 10), vessels: inc.vessels || {}, incidents: rows,
  }) + "\n");
  console.log(`incidents.json: ${rows.length} incidents from ${rows[0] && rows[0].date} to ${rows[rows.length - 1] && rows[rows.length - 1].date}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
