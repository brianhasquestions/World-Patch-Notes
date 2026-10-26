#!/usr/bin/env node
/* Adds a few facts to every region in data/regions/<KEY>.json from Wikidata
   (CC0): latest population with its year, capital, and head of government.
   Regions are matched by the Wikidata id Natural Earth carries. Results are
   cached in the OS temp folder so a rerun is cheap.

   Usage:
     node scripts/fetch_region_facts.js            every country file
     node scripts/fetch_region_facts.js FR DE      just these keys
     node scripts/fetch_region_facts.js --offline  rebuild from the cache only */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "data", "regions");
const CACHE = path.join(os.tmpdir(), "wpn-wikidata");
const ENDPOINT = "https://query.wikidata.org/sparql";
const BATCH = 120;

function query(ids) {
  const values = ids.map((q) => "wd:" + q).join(" ");
  return `SELECT ?item ?pop ?popTime ?capLabel ?headLabel WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item p:P1082 ?ps . ?ps ps:P1082 ?pop . OPTIONAL { ?ps pq:P585 ?popTime } }
  OPTIONAL { ?item wdt:P36 ?cap }
  OPTIONAL { ?item wdt:P6 ?head }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}`;
}

async function fetchBatch(ids, offline) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, ids.join("_").slice(0, 200) + "_" + ids.length + ".json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  if (offline) return null;
  const url = ENDPOINT + "?format=json&query=" + encodeURIComponent(query(ids));
  const res = await fetch(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": "world-patch-notes/0.1 (static site prototype; local script)" } });
  if (!res.ok) throw new Error(`${res.status} from Wikidata`);
  const json = await res.json();
  fs.writeFileSync(file, JSON.stringify(json));
  return json;
}

// Collapse SPARQL rows into one fact set per item: newest population wins.
function collapse(json, facts) {
  for (const row of json.results.bindings) {
    const q = row.item.value.split("/").pop();
    const f = (facts[q] = facts[q] || {});
    if (row.pop) {
      const t = row.popTime ? row.popTime.value.slice(0, 4) : "";
      if (f.populationYear === undefined || t > (f.populationYear || "")) { f.population = Math.round(Number(row.pop.value)); f.populationYear = t; }
    }
    if (row.capLabel && !f.capital && !/^Q\d+$/.test(row.capLabel.value)) f.capital = row.capLabel.value;
    if (row.headLabel && !f.head && !/^Q\d+$/.test(row.headLabel.value)) f.head = row.headLabel.value;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const only = args.filter((a) => !a.startsWith("--"));
  const files = fs.readdirSync(DIR).filter((f) => /^[A-Z]{2}\.json$/.test(f)).filter((f) => !only.length || only.includes(f.slice(0, 2)));
  const ids = new Set();
  const docs = {};
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    docs[f] = doc;
    for (const feat of doc.features) if (feat.properties.wikidata) ids.add(feat.properties.wikidata);
  }
  const list = [...ids].sort();
  console.log(`${files.length} country files, ${list.length} regions with a Wikidata id`);
  const facts = {};
  let skipped = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    let json = null;
    try { json = await fetchBatch(batch, offline); }
    catch (e) { console.log(`batch ${i / BATCH + 1} failed: ${e.message}`); }
    if (!json) { skipped += batch.length; continue; }
    collapse(json, facts);
    process.stdout.write(`\r  ${Math.min(i + BATCH, list.length)} / ${list.length}`);
    if (!offline && i + BATCH < list.length) await new Promise((r) => setTimeout(r, 1200));
  }
  process.stdout.write("\n");
  let withPop = 0, withCap = 0, withHead = 0, n = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const [f, doc] of Object.entries(docs)) {
    for (const feat of doc.features) {
      const q = feat.properties.wikidata;
      const fx = q && facts[q];
      if (!fx) continue;
      n++;
      if (fx.population) { feat.properties.population = fx.population; feat.properties.populationYear = fx.populationYear || ""; withPop++; }
      if (fx.capital) { feat.properties.capital = fx.capital; withCap++; }
      if (fx.head) { feat.properties.head = fx.head; withHead++; }
      feat.properties.factsFrom = "Wikidata " + today;
    }
    fs.writeFileSync(path.join(DIR, f), JSON.stringify(doc) + "\n");
  }
  console.log(`facts written for ${n} regions: ${withPop} with population, ${withCap} with capital, ${withHead} with head of government` + (skipped ? `; ${skipped} ids skipped` : ""));
}
main().catch((e) => { console.error(e); process.exit(1); });
