#!/usr/bin/env node
/* fetch_hormuz_hf.js
   Syncs the yasumorishima/hormuz-ais dataset on Hugging Face (AIS positions
   around the Strait of Hormuz plus Sentinel-1 radar ship detections) into the
   OS temp cache and converts the parquet files to CSV, ready for
   fetch_shipping_hormuz.js to import:

     daily.csv    every AIS position in positions.parquet, daily/ and raw/
     radar.csv    every radar detection in sar/det/
     scenes.csv   every radar scene in sar/scenes/

   Only files that are new or changed since the last run are downloaded. The
   parquet reader (hyparquet, pure JavaScript) is installed with npm into the
   temp cache the first time, never into this repo.

   Usage:
     node scripts/fetch_hormuz_hf.js            sync and convert, print the import command
     node scripts/fetch_hormuz_hf.js --run      ...then run fetch_shipping_hormuz.js with the CSVs
     node scripts/fetch_hormuz_hf.js --run --quick
                                                same, but skip the per-ship history calls
     node scripts/fetch_hormuz_hf.js --offline  convert what is cached, download nothing

   Terms: the AIS positions come from aisstream.io through the dataset author
   (see the dataset card); the radar detections are derived from Copernicus
   Sentinel-1 data (free and open with attribution). */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { pathToFileURL } = require("url");

const REPO = "yasumorishima/hormuz-ais";
const API = `https://huggingface.co/api/datasets/${REPO}/tree/main`;
const RESOLVE = `https://huggingface.co/datasets/${REPO}/resolve/main`;
const CACHE = path.join(os.tmpdir(), "wpn-cache", "hf-hormuz");
const TOOLS = path.join(os.tmpdir(), "wpn-cache", "hf-tools");
const ROOT = path.join(__dirname, "..");

const POSITION_COLS = ["mmsi", "timestamp", "latitude", "longitude", "speed", "course", "ship_name", "ship_type", "flag", "length", "destination"];
const DET_COLS = ["scene_id", "acq_time", "platform", "latitude", "longitude", "dist_to_land_km", "length_m", "width_m", "snr", "vessel_sized", "reject_reason"];
const SCENE_COLS = ["scene_id", "acq_time", "platform", "aoi_covered_frac", "n_candidates", "n_vessel_sized", "status"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listFiles(dir) {
  const url = `${API}/${dir}?recursive=true`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${res.status} listing ${dir || "/"}`);
    return (await res.json()).filter((e) => e.type === "file").map((e) => ({ path: e.path, size: e.size }));
  }
  throw new Error(`rate limited listing ${dir || "/"}`);
}

async function download(entry) {
  const dest = path.join(CACHE, entry.path);
  if (fs.existsSync(dest) && fs.statSync(dest).size === entry.size) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${RESOLVE}/${entry.path}`);
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${res.status} downloading ${entry.path}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  }
  throw new Error(`rate limited downloading ${entry.path}`);
}

async function parquetTools() {
  const entry = path.join(TOOLS, "node_modules", "hyparquet", "src", "node.js");
  const comp = path.join(TOOLS, "node_modules", "hyparquet-compressors", "src", "index.js");
  if (!fs.existsSync(entry) || !fs.existsSync(comp)) {
    console.log(`installing the parquet reader into ${TOOLS} (one time, outside the repo)`);
    fs.mkdirSync(TOOLS, { recursive: true });
    if (!fs.existsSync(path.join(TOOLS, "package.json"))) fs.writeFileSync(path.join(TOOLS, "package.json"), '{"name":"wpn-hf-tools","private":true}\n');
    execSync(`npm install --prefix "${TOOLS}" --no-audit --no-fund --loglevel=error hyparquet@^1.31 hyparquet-compressors@^1.1`, { stdio: "inherit", shell: true });
  }
  const hp = await import(pathToFileURL(entry).href);
  const { compressors } = await import(pathToFileURL(comp).href);
  return { ...hp, compressors };
}

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) v = v.toISOString();
  else if (typeof v === "bigint") v = v.toString();
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function convert(tools, files, cols, out) {
  const lines = [cols.join(",")];
  let rows = 0;
  for (const f of files) {
    const file = await tools.asyncBufferFromFile(f);
    const data = await tools.parquetReadObjects({ file, compressors: tools.compressors });
    for (const r of data) { lines.push(cols.map((c) => csvCell(r[c])).join(",")); rows++; }
  }
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${path.basename(out)}: ${rows} rows from ${files.length} parquet files`);
  return rows;
}

function cached(prefix, test) {
  const dir = path.join(CACHE, prefix);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (test(p)) out.push(p); } };
  walk(dir);
  return out.sort();
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const run = args.includes("--run");
  const passthrough = args.filter((a) => a !== "--offline" && a !== "--run");
  fs.mkdirSync(CACHE, { recursive: true });

  if (!offline) {
    const entries = [];
    for (const dir of ["", "daily", "raw", "sar"]) {
      const list = await listFiles(dir);
      for (const e of list) {
        if (!e.path.endsWith(".parquet")) continue;
        if (dir === "" && !/^positions.*\.parquet$/.test(e.path)) continue;
        if (!entries.some((x) => x.path === e.path)) entries.push(e);
      }
      await sleep(300);
    }
    let got = 0, bytes = 0;
    for (const e of entries) {
      if (await download(e)) { got++; bytes += e.size; await sleep(250); }
    }
    console.log(`Hugging Face ${REPO}: ${entries.length} parquet files listed, ${got} new or changed downloaded (${(bytes / 1024).toFixed(0)} KB) into ${CACHE}`);
  }

  const tools = await parquetTools();
  const positions = [...cached("", (p) => /positions.*\.parquet$/.test(path.basename(p)) && path.dirname(p) === CACHE), ...cached("daily", (p) => p.endsWith(".parquet")), ...cached("raw", (p) => p.endsWith(".parquet"))];
  const det = cached(path.join("sar", "det"), (p) => p.endsWith(".parquet"));
  const scenes = cached(path.join("sar", "scenes"), (p) => p.endsWith(".parquet"));
  const dailyCsv = path.join(CACHE, "daily.csv"), radarCsv = path.join(CACHE, "radar.csv"), scenesCsv = path.join(CACHE, "scenes.csv");
  await convert(tools, positions, POSITION_COLS, dailyCsv);
  await convert(tools, det, DET_COLS, radarCsv);
  await convert(tools, scenes, SCENE_COLS, scenesCsv);

  const cmd = ["node", path.join("scripts", "fetch_shipping_hormuz.js"), "--hf-csv", dailyCsv, "--radar-csv", radarCsv, scenesCsv, ...passthrough];
  if (run) {
    console.log(`running: ${cmd.join(" ")}`);
    execSync(cmd.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "), { stdio: "inherit", cwd: ROOT, shell: true });
  } else {
    console.log(`next: ${cmd.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
