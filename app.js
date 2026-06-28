"use strict";

// Maps a change "type" to its CSS badge class + display label.
const TAG_STYLES = {
  NEW:        { cls: "tag-new",        label: "NEW" },
  CHANGE:     { cls: "tag-change",     label: "CHANGE" },
  FIX:        { cls: "tag-fix",        label: "FIX" },
  DEPRECATED: { cls: "tag-deprecated", label: "DEPRECATED" },
  ISSUE:      { cls: "tag-issue",      label: "KNOWN ISSUE" },
  BUFF:       { cls: "tag-buff",       label: "BUFF" },
  NERF:       { cls: "tag-nerf",       label: "NERF" },
  HOTFIX:     { cls: "tag-hotfix",     label: "HOTFIX" },
  EXPLOIT:    { cls: "tag-exploit",    label: "EXPLOIT" },
};

const els = {
  weekList: document.getElementById("weekList"),
  content: document.getElementById("content"),
};

// Theme toggle: flip data-theme on <html> and remember the choice.
// The initial theme is set by an inline script in <head> (before paint).
const themeToggle = document.getElementById("themeToggle");
function syncThemeButton() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  themeToggle.textContent = dark ? "Light" : "Dark"; // label shows the target mode
}
themeToggle.addEventListener("click", () => {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const next = dark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
  syncThemeButton();
});
syncThemeButton();

let weeks = []; // from data/index.json, newest first

async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} - ${url}`);
  return res.json();
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* ---------- Sidebar ---------- */

function renderSidebar(activeId) {
  if (!weeks.length) {
    els.weekList.innerHTML = '<p class="loading">No weeks published yet.</p>';
    return;
  }
  let html = "";
  let lastYear = null;
  for (const w of weeks) {
    const year = (w.id || "").slice(0, 4);
    if (year !== lastYear) {
      html += `<div class="week-year">${escapeHTML(year)}</div>`;
      lastYear = year;
    }
    const active = w.id === activeId ? " active" : "";
    // The year header already gives context, so trim "Week of " and the ", YYYY"
    // suffix to keep each row on one line (e.g. "Jun 22-28").
    const label = (w.title || w.id).replace(/^Week of /, "").replace(/,\s*\d{4}$/, "");
    html += `<a class="week-item${active}" href="#${encodeURIComponent(w.id)}">` +
            `<span class="wk-label">${escapeHTML(label)}</span>` +
            `<span class="ver">${escapeHTML(w.version || "")}</span></a>`;
  }
  els.weekList.innerHTML = html;
}

/* ---------- Release rendering ---------- */

function renderChange(change) {
  const style = TAG_STYLES[change.type] || { cls: "tag-change", label: change.type || "NOTE" };
  let sources = "";
  if (Array.isArray(change.sources) && change.sources.length) {
    sources = change.sources
      .map((u, i) => `<a class="src" href="${escapeHTML(u)}" target="_blank" rel="noopener">[${i + 1}]</a>`)
      .join("");
  }
  return `<div class="change">` +
    `<span class="tag ${style.cls}">${escapeHTML(style.label)}</span>` +
    `<span class="change-text">${escapeHTML(change.text || "")}${sources}</span>` +
    `</div>`;
}

function renderRelease(week) {
  const sections = (week.sections || []).map((s) => (
    `<section class="section">` +
    `<h2>${escapeHTML(s.category || "")}</h2>` +
    (s.changes || []).map(renderChange).join("") +
    `</section>`
  )).join("");

  // Highlights: entries flagged highlight:true, gathered to the top (max 10).
  const highlights = (week.sections || [])
    .flatMap((s) => s.changes || [])
    .filter((c) => c && c.highlight)
    .slice(0, 10);
  const highlightsHTML = highlights.length
    ? `<section class="section">` +
        `<h2>Highlights</h2>` +
        highlights.map(renderChange).join("") +
      `</section>`
    : "";

  // Patch summary: an array renders as a bullet list; a string as one line.
  let summaryHTML = "";
  if (Array.isArray(week.summary) && week.summary.length) {
    summaryHTML = `<ul class="patch-summary">` +
      week.summary.map((s) => `<li>${escapeHTML(s)}</li>`).join("") +
      `</ul>`;
  } else if (typeof week.summary === "string" && week.summary) {
    summaryHTML = `<p class="patch-summary">${escapeHTML(week.summary)}</p>`;
  }

  els.content.innerHTML =
    `<div class="release-head">` +
      `<h1>${escapeHTML(week.title || week.id)}</h1>` +
      `<div class="release-meta">` +
        `<span class="ver">${escapeHTML(week.version || "")}</span>` +
        (week.released ? ` · released ${escapeHTML(week.released)}` : "") +
      `</div>` +
      summaryHTML +
      (week.note ? `<p class="release-note">${escapeHTML(week.note)}</p>` : "") +
    `</div>` +
    highlightsHTML +
    sections;
  document.title = `${week.version || week.id} - World Patch Notes`;
}

/* ---------- Routing ---------- */

async function showWeek(id) {
  renderSidebar(id);
  els.content.innerHTML = '<p class="loading">Loading release…</p>';
  try {
    const week = await fetchJSON(`data/weeks/${id}.json`);
    renderRelease(week);
  } catch (err) {
    els.content.innerHTML = `<p class="loading">Couldn't load <code>${escapeHTML(id)}</code>: ${escapeHTML(err.message)}</p>`;
  }
}

function currentId() {
  return decodeURIComponent(location.hash.replace(/^#/, ""));
}

async function route() {
  const id = currentId();
  if (id && weeks.some((w) => w.id === id)) {
    showWeek(id);
  } else if (weeks.length) {
    location.replace(`#${encodeURIComponent(weeks[0].id)}`); // default: newest
  } else {
    els.content.innerHTML = '<p class="loading">No releases published yet. Run the patch-notes-writer agent to generate the first week.</p>';
  }
}

/* ---------- Init ---------- */

window.addEventListener("hashchange", route);

(async function init() {
  try {
    weeks = await fetchJSON("data/index.json");
    weeks.sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first
  } catch (err) {
    els.weekList.innerHTML = `<p class="loading">Couldn't load index: ${escapeHTML(err.message)}</p>`;
    weeks = [];
  }
  renderSidebar(currentId());
  route();
})();
