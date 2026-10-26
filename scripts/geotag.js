#!/usr/bin/env node
/* Suggests a "places" list and a "guilds" list for every change in
   data/weeks/*.json using the keyword rules in data/places.json and the
   patterns in data/guilds.json, then writes the files back.

   Usage:
     node scripts/geotag.js                 tag every week, only changes that lack "places"
     node scripts/geotag.js 2026-W43        tag one week
     node scripts/geotag.js --force         retag everything, overwriting existing "places"
     node scripts/geotag.js --dry           report only, write nothing
     node scripts/geotag.js --report        print every change with its places

   A change with no match gets "places": [] (global). The script prints the
   unmatched changes so the editor can fill them in by hand. */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WEEKS_DIR = path.join(ROOT, "data", "weeks");
const TABLE = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "places.json"), "utf8"));
const PLACES = TABLE.places;
const RULES = TABLE.rules.map((r) => ({ key: r.key, re: new RegExp("\\b(" + r.pattern + ")\\b") }));
const US_SUB = new Set(Object.keys(PLACES).filter((k) => PLACES[k].country === "US"));
const GUILD_TABLE = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "guilds.json"), "utf8"));
const GUILDS = Object.entries(GUILD_TABLE.guilds).map(([key, g]) => ({ key, re: new RegExp("(?:^|[^A-Za-z0-9])(" + g.pattern + ")(?![A-Za-z0-9])") }));

// Up to five guild keys, in order of first appearance in the text.
function guildtag(text) {
  const hits = [];
  for (const { key, re } of GUILDS) {
    const m = re.exec(text);
    if (m) hits.push({ key, at: m.index });
  }
  hits.sort((a, b) => a.at - b.at);
  return hits.map((h) => h.key).slice(0, 5);
}

function findIn(str) {
  const hits = [];
  for (const { key, re } of RULES) {
    const m = re.exec(str);
    if (m) hits.push({ key, at: m.index });
  }
  hits.sort((a, b) => a.at - b.at);
  return hits.map((h) => h.key);
}

// Up to three place keys, primary first. The text before the first colon
// ("US team:", "Europe server:") wins over the body. A generic "US" match is
// dropped when a more specific US place appears anywhere in the text.
function geotag(text) {
  const colon = text.indexOf(":");
  const prefix = colon > 0 && colon < 60 ? text.slice(0, colon) : "";
  const body = colon > 0 ? text.slice(colon + 1) : text;
  let all = findIn(prefix).concat(findIn(body));
  if (all.some((k) => US_SUB.has(k))) all = all.filter((k) => k !== "US");
  const keys = [];
  for (const k of all) {
    if (!keys.includes(k)) keys.push(k);
    if (keys.length === 3) break;
  }
  return keys;
}

function withPlaces(change, places, guilds) {
  // Rebuild the object so "places" and "guilds" sit after "sources" and before "highlight".
  const out = {};
  for (const [k, v] of Object.entries(change)) {
    if (k === "places" || k === "guilds" || k === "highlight") continue;
    out[k] = v;
  }
  out.places = places;
  out.guilds = guilds;
  if (change.highlight !== undefined) out.highlight = change.highlight;
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dry = args.includes("--dry");
  const report = args.includes("--report");
  const ids = args.filter((a) => !a.startsWith("--"));
  const files = fs.readdirSync(WEEKS_DIR).filter((f) => f.endsWith(".json")).sort();
  const chosen = ids.length ? files.filter((f) => ids.includes(f.replace(/\.json$/, ""))) : files;
  if (!chosen.length) { console.error("no week files matched"); process.exit(1); }

  let total = 0, tagged = 0, empty = 0, kept = 0, withGuild = 0;
  const unmatched = [];
  const guildCounts = {};
  for (const f of chosen) {
    const p = path.join(WEEKS_DIR, f);
    const week = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const sec of week.sections || []) {
      sec.changes = (sec.changes || []).map((c) => {
        total++;
        let places;
        if (Array.isArray(c.places) && !force) { places = c.places; kept++; }
        else { places = geotag(c.text); tagged++; }
        for (const k of places) if (!PLACES[k]) console.warn(`${week.id}: unknown place key "${k}" in: ${c.text.slice(0, 60)}`);
        if (!places.length) { empty++; unmatched.push({ id: week.id, cat: sec.category, text: c.text }); }
        let guilds;
        if (Array.isArray(c.guilds) && !force) guilds = c.guilds;
        else guilds = guildtag(c.text);
        for (const k of guilds) { if (!GUILD_TABLE.guilds[k]) console.warn(`${week.id}: unknown guild key "${k}"`); guildCounts[k] = (guildCounts[k] || 0) + 1; }
        if (guilds.length) withGuild++;
        if (report) console.log(`${week.id} [${places.join(",") || "-"}] {${guilds.join(",")}} ${c.text.slice(0, 90)}`);
        return withPlaces(c, places, guilds);
      });
    }
    if (!dry) fs.writeFileSync(p, JSON.stringify(week, null, 2) + "\n");
  }
  console.log(`${chosen.length} week(s), ${total} changes: ${tagged} tagged now, ${kept} already had places, ${empty} with no place (global), ${withGuild} name a guild.`);
  const topGuilds = Object.entries(guildCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ${n}`).join(", ");
  if (topGuilds) console.log(`most mentioned guilds: ${topGuilds}`);
  if (unmatched.length && !report) {
    console.log("\nNo place found (left as [] = global). Fill in by hand if one applies:");
    for (const u of unmatched) console.log(`  ${u.id} | ${u.cat} | ${u.text.slice(0, 110)}`);
  }
}

main();
