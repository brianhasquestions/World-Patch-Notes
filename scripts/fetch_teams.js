#!/usr/bin/env node
/* Snapshots CIA World Factbook profiles into the repo as small "team cards".

   Source: the factbook.json mirror (github.com/factbook/factbook.json, CC0;
   the Factbook itself is public domain). The full files are cached in the OS
   temp dir; only ~25 fields per country are written to data/teams/<KEY>.json,
   plus data/teams/index.json.

   Usage:
     node scripts/fetch_teams.js            refresh every country in data/places.json
     node scripts/fetch_teams.js FR DE      refresh just these keys
     node scripts/fetch_teams.js --offline  rebuild from the cache without downloading */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "teams");
const CACHE = path.join(os.tmpdir(), "wpn-factbook");
const RAW = "https://raw.githubusercontent.com/factbook/factbook.json/master/";
const TREE = "https://api.github.com/repos/factbook/factbook.json/git/trees/master?recursive=1";
const PLACES = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "places.json"), "utf8")).places;

// Our key -> Factbook file, where the name match is not obvious.
const OVERRIDES = {
  US: "north-america/us.json", UK: "europe/uk.json", KR: "east-n-southeast-asia/ks.json",
  KP: "east-n-southeast-asia/kn.json", CD: "africa/cg.json", CG: "africa/cf.json", CF: "africa/ct.json",
  MM: "east-n-southeast-asia/bm.json", CI: "africa/iv.json", VA: "europe/vt.json", TR: "middle-east/tu.json",
  PS: "middle-east/gz.json", WB: "middle-east/we.json", GM: "africa/ga.json", GA: "africa/gb.json",
  TL: "east-n-southeast-asia/tt.json", XK: "europe/kv.json", MK: "europe/mk.json", CZ: "europe/ez.json",
  HK: "east-n-southeast-asia/hk.json", EH: "africa/wi.json", SS: "africa/od.json", BA: "europe/bk.json",
  ME: "europe/mj.json", RS: "europe/ri.json", MD: "europe/md.json", GE: "central-asia/gg.json",
  AM: "central-asia/am.json", AZ: "central-asia/aj.json", KZ: "central-asia/kz.json", UZ: "central-asia/uz.json",
  KG: "central-asia/kg.json", TJ: "central-asia/ti.json", TM: "central-asia/tx.json", RU: "central-asia/rs.json",
  IQ: "middle-east/iz.json", IR: "middle-east/ir.json", IL: "middle-east/is.json", LB: "middle-east/le.json",
  OM: "middle-east/mu.json", AE: "middle-east/ae.json", BH: "middle-east/ba.json", QA: "middle-east/qa.json",
  DO: "central-america-n-caribbean/dr.json", KW: "middle-east/ku.json", YE: "middle-east/ym.json", SY: "middle-east/sy.json", JO: "middle-east/jo.json",
  SA: "middle-east/sa.json", GL: "north-america/gl.json", AQ: "antarctica/ay.json",
};

function log(...a) { console.log(...a); }

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "world-patch-notes" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function listFiles(offline) {
  const cacheFile = path.join(CACHE, "_tree.json");
  if (offline || fs.existsSync(cacheFile)) {
    if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    throw new Error("no cached file list; run once without --offline");
  }
  const tree = JSON.parse(await fetchText(TREE)).tree;
  const files = tree.filter((t) => t.type === "blob" && /^[a-z-]+\/[a-z]{2}\.json$/.test(t.path)).map((t) => t.path);
  fs.writeFileSync(cacheFile, JSON.stringify(files));
  return files;
}

async function loadCountry(file, offline) {
  const cached = path.join(CACHE, file.replace("/", "__"));
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, "utf8"));
  if (offline) return null;
  const text = await fetchText(RAW + file);
  fs.writeFileSync(cached, text);
  return JSON.parse(text);
}

// ---------- field helpers ----------
const ENTITIES = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
  ndash: "-", mdash: "-", hellip: "...", eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", aacute: "á", agrave: "à", acirc: "â",
  auml: "ä", atilde: "ã", aring: "å", ccedil: "ç", iacute: "í", icirc: "î", iuml: "ï", oacute: "ó", ocirc: "ô", ouml: "ö",
  otilde: "õ", oslash: "ø", uacute: "ú", ucirc: "û", uuml: "ü", ntilde: "ñ", szlig: "ß", yacute: "ý", Eacute: "É", Aacute: "Á",
  Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Ccedil: "Ç", deg: "°", euro: "€", pound: "£", yen: "¥" };
const clean = (s) => String(s == null ? "" : s)
  .replace(/<br\s*\/?>/gi, " ").replace(/<\/?[a-z][^>]*>/gi, "")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&([a-zA-Z]+);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m))
  .replace(/\s+/g, " ").replace(/\s+-\s*$/, "").trim();
const text = (o) => (o && typeof o === "object" && "text" in o ? clean(o.text) : typeof o === "string" ? clean(o) : "");
// For {"X 2024": {text}, "X 2023": {text}, note} pick the newest year.
function latest(o) {
  if (!o || typeof o !== "object") return "";
  if ("text" in o) return text(o);
  let best = null, bestYear = -1;
  for (const [k, v] of Object.entries(o)) {
    const m = /(\d{4})\s*$/.exec(k);
    if (m && Number(m[1]) > bestYear) { bestYear = Number(m[1]); best = v; }
  }
  return best ? text(best) : "";
}
const sub = (o, ...keys) => { let cur = o; for (const k of keys) { if (!cur || typeof cur !== "object") return undefined; cur = cur[k]; } return cur; };
const short = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

function slim(j, key) {
  const gov = j.Government || {}, geo = j.Geography || {}, ppl = j["People and Society"] || {};
  const eco = j.Economy || {}, mil = j["Military and Security"] || {}, tni = j["Transnational Issues"] || {};
  const com = j.Communications || {};
  const name = text(sub(gov, "Country name", "conventional short form")) || PLACES[key].label;
  return {
    key, name,
    longName: text(sub(gov, "Country name", "conventional long form")),
    capital: text(sub(gov, "Capital", "name")),
    governmentType: text(gov["Government type"]),
    chiefOfState: short(text(sub(gov, "Executive branch", "chief of state")), 160),
    headOfGovernment: short(text(sub(gov, "Executive branch", "head of government")), 160),
    independence: short(text(gov.Independence), 160),
    background: short(text(sub(j, "Introduction", "Background")), 1400),
    location: short(text(geo.Location), 220),
    area: text(sub(geo, "Area", "total")),
    naturalResources: short(text(geo["Natural resources"]), 200),
    population: text(sub(ppl, "Population", "total")) || text(ppl.Population),
    populationGrowth: text(ppl["Population growth rate"]),
    medianAge: text(sub(ppl, "Median age", "total")),
    lifeExpectancy: text(sub(ppl, "Life expectancy at birth", "total population")),
    urbanization: text(sub(ppl, "Urbanization", "urban population")),
    languages: short(text(sub(ppl, "Languages", "Languages")) || text(ppl.Languages), 220),
    economicOverview: short(text(eco["Economic overview"]), 500),
    gdpPpp: latest(eco["Real GDP (purchasing power parity)"]),
    gdpGrowth: latest(eco["Real GDP growth rate"]),
    gdpPerCapita: latest(eco["Real GDP per capita"]),
    inflation: latest(eco["Inflation rate (consumer prices)"]),
    unemployment: latest(eco["Unemployment rate"]),
    publicDebt: latest(eco["Public debt"]),
    exports: latest(eco.Exports),
    exportPartners: text(eco["Exports - partners"]),
    exportCommodities: text(eco["Exports - commodities"]),
    importPartners: text(eco["Imports - partners"]),
    currency: text(sub(eco, "Exchange rates", "Currency")),
    militaryExpenditures: latest(mil["Military expenditures"]),
    militaryForces: short(text(mil["Military and security forces"]), 300),
    militaryPersonnel: short(text(mil["Military and security service personnel strengths"]), 300),
    militaryNote: short(text(mil["Military - note"]), 500),
    disputes: short(text(tni["Disputes - international"]), 700),
    refugees: short(text(sub(tni, "Refugees and internally displaced persons", "refugees")), 300),
    internetUsers: text(sub(com, "Internet users", "percent of population")),
    source: "CIA World Factbook via factbook.json (public domain)",
  };
}

// ---------- name matching ----------
const norm = (s) => clean(s).toLowerCase()
  .replace(/\(.*?\)/g, "").replace(/\bthe\b/g, "")
  .replace(/^([^,]+),\s*(.+)$/, "$2 $1") // "Korea, South" -> "south korea"
  .replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const only = args.filter((a) => !a.startsWith("--"));
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = await listFiles(offline);
  const wanted = Object.keys(PLACES).filter((k) => (PLACES[k].kind === "country" || PLACES[k].kind === "territory") && (!only.length || only.includes(k)));

  // Load every Factbook file once (cached), index by normalized short name.
  const byName = {};
  const loaded = {};
  for (const f of files) {
    try {
      const j = await loadCountry(f, offline);
      if (!j) continue;
      loaded[f] = j;
      const n = norm(text(sub(j, "Government", "Country name", "conventional short form")));
      if (n) byName[n] = f;
    } catch (e) { log("skip", f, e.message); }
  }

  const index = [];
  const missing = [];
  for (const key of wanted) {
    const p = PLACES[key];
    let file = OVERRIDES[key] || byName[norm(p.label)] || (p.ne && byName[norm(p.ne)]);
    if (!file || !loaded[file]) { missing.push(key + " (" + p.label + ")"); continue; }
    const card = slim(loaded[file], key);
    fs.writeFileSync(path.join(OUT_DIR, key + ".json"), JSON.stringify(card, null, 2) + "\n");
    index.push({ key, name: card.name, file: file });
  }
  index.sort((a, b) => a.key.localeCompare(b.key));
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify({
    source: "CIA World Factbook via github.com/factbook/factbook.json (CC0 mirror of a public domain work)",
    fetched: new Date().toISOString().slice(0, 10),
    teams: index,
  }, null, 2) + "\n");
  log(`wrote ${index.length} team cards to data/teams/`);
  if (missing.length) log("no Factbook match (add to OVERRIDES):", missing.join(", "));
}

main().catch((e) => { console.error(e); process.exit(1); });
