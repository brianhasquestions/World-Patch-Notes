#!/usr/bin/env node
/* Cuts one file of internal regions (states, provinces, oblasts) per country
   out of Natural Earth 10m admin-1 (public domain), simplified, into
   data/regions/<KEY>.json for every country key in data/places.json, plus
   data/regions/index.json. The globe loads a country's file when its team card
   opens.

   Usage:
     node scripts/fetch_regions.js            all countries
     node scripts/fetch_regions.js FR DE      just these keys
     node scripts/fetch_regions.js --offline  use the cached Natural Earth file only */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", "regions");
const NE_CACHE = path.join(os.tmpdir(), "wpn-ne");
const NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";
const PLACES = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "places.json"), "utf8")).places;

// Our keys are ISO 3166-1 alpha-2 except these.
const ISO2_TO_KEY = { GB: "UK", XK: "XK", PS: "PS", EH: "EH" };

async function cachedNE(offline) {
  const file = path.join(NE_CACHE, "ne_10m_admin_1_states_provinces.geojson");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  if (offline) throw new Error("Natural Earth admin-1 file is not cached; run once without --offline");
  fs.mkdirSync(NE_CACHE, { recursive: true });
  console.log("downloading", NE_URL, "(about 40 MB, once)");
  const res = await fetch(NE_URL, { headers: { "User-Agent": "world-patch-notes" } });
  if (!res.ok) throw new Error(`${res.status} ${NE_URL}`);
  const text = await res.text();
  fs.writeFileSync(file, text);
  return text;
}

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
  const ring = (r) => simplify(r.map((c) => [c[0], c[1]]), tol);
  if (g.type === "Polygon") return { type: g.type, coordinates: g.coordinates.map(ring).filter((r) => r.length >= 4) };
  if (g.type === "MultiPolygon") return { type: g.type, coordinates: g.coordinates.map((p) => p.map(ring).filter((r) => r.length >= 4)).filter((p) => p.length) };
  return g;
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const only = args.filter((a) => !a.startsWith("--"));
  fs.mkdirSync(OUT, { recursive: true });
  const geo = JSON.parse(await cachedNE(offline));

  // Group admin-1 features by our country key.
  const byKey = {};
  for (const f of geo.features) {
    const p = f.properties;
    let key = ISO2_TO_KEY[p.iso_a2] || p.iso_a2;
    if (p.adm0_a3 === "UKR" || /^(Crimea|Sevastopol)$/.test(p.name || "")) key = "UA"; // Natural Earth files Crimea under de facto control
    if (!key || !PLACES[key] || (PLACES[key].kind !== "country" && PLACES[key].kind !== "territory")) continue;
    (byKey[key] = byKey[key] || []).push(f);
  }

  const indexFile = path.join(OUT, "index.json");
  const index = { source: "Natural Earth 10m admin-1 (public domain), simplified per country. Crimea and Sevastopol are filed under Ukraine. Area is computed from the full-resolution outline.", countries: {} };
  // A partial run (specific keys) keeps the other countries in the index.
  if (only.length && fs.existsSync(indexFile)) { try { index.countries = JSON.parse(fs.readFileSync(indexFile, "utf8")).countries || {}; } catch (e) { /* rebuild */ } }
  const keys = Object.keys(byKey).filter((k) => !only.length || only.includes(k)).sort();
  const FACT_FIELDS = ["population", "populationYear", "capital", "head", "factsFrom"];
  let total = 0;
  for (const key of keys) {
    const feats = byKey[key];
    // Facts added later by fetch_region_facts.js survive a regeneration.
    const old = {};
    const oldFile = path.join(OUT, key + ".json");
    if (fs.existsSync(oldFile)) {
      try { for (const f of JSON.parse(fs.readFileSync(oldFile, "utf8")).features) if (f.properties.wikidata) old[f.properties.wikidata] = f.properties; } catch (e) { /* ignore */ }
    }
    // Larger countries get a coarser tolerance so the biggest files stay small.
    let span = 0;
    for (const f of feats) { const b = bbox(f.geometry); span = Math.max(span, b[2] - b[0], b[3] - b[1]); }
    const tol = span > 30 ? 0.03 : span > 12 ? 0.018 : 0.01;
    const out = {
      type: "FeatureCollection", key, source: index.source,
      features: feats.map((f) => {
        const p = f.properties;
        const props = { name: p.name_en || p.name, type: p.type_en || "", iso: p.iso_3166_2 || "", wikidata: p.wikidataid || "",
          areaKm2: Math.round(sphericalAreaKm2(f.geometry)), latitude: p.latitude, longitude: p.longitude };
        const prev = p.wikidataid && old[p.wikidataid];
        if (prev) for (const k of FACT_FIELDS) if (prev[k] !== undefined) props[k] = prev[k];
        return { type: "Feature", properties: props, geometry: simplifyGeom(f.geometry, tol) };
      }),
    };
    const file = path.join(OUT, key + ".json");
    fs.writeFileSync(file, JSON.stringify(out) + "\n");
    const size = fs.statSync(file).size;
    total += size;
    index.countries[key] = { regions: feats.length, kb: Math.round(size / 1024) };
  }
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n");
  console.log(`regions: ${keys.length} countries written (${Object.keys(index.countries).length} in the index), ${(total / 1024 / 1024).toFixed(1)} MB total; largest: ` +
    Object.entries(index.countries).sort((a, b) => b[1].kb - a[1].kb).slice(0, 5).map(([k, v]) => `${k} ${v.kb} KB`).join(", "));
  const missing = Object.keys(PLACES).filter((k) => PLACES[k].kind === "country" && !byKey[k]);
  if (missing.length) console.log("no admin-1 regions in Natural Earth for:", missing.join(", "));
}
// Area of a lon/lat polygon on the sphere, in square kilometres (outer rings minus holes).
function sphericalAreaKm2(g) {
  const R = 6371.0088, D2R = Math.PI / 180;
  const ringArea = (r) => {
    let s = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      s += (r[i][0] - r[j][0]) * D2R * (2 + Math.sin(r[i][1] * D2R) + Math.sin(r[j][1] * D2R));
    }
    return Math.abs(s * R * R / 2);
  };
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  let a = 0;
  for (const p of polys) { a += ringArea(p[0]); for (let i = 1; i < p.length; i++) a -= ringArea(p[i]); }
  return a;
}
function bbox(g) {
  const b = [1e9, 1e9, -1e9, -1e9];
  const walk = (c) => { if (typeof c[0] === "number") { if (c[0] < b[0]) b[0] = c[0]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[1] > b[3]) b[3] = c[1]; } else c.forEach(walk); };
  walk(g.coordinates);
  return b;
}
main().catch((e) => { console.error(e); process.exit(1); });
