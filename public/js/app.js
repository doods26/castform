import { describe, icon, compass } from "./wmo.js";
import { initRadar } from "./radar.js";
import { applyEffects, wireFullscreen } from "./effects.js";
import { gauge, compassGauge } from "./gauge.js";
import { prayerTimes, qiblaBearing, qiblaDistanceKm, compass16, methodForCountry, currentAndNext } from "./prayer.js";

// Build number — shown in the footer so we can tell at a glance which code a
// device is actually running (iOS caches PWAs/Safari aggressively). MUST stay
// in lockstep with the ?b=N cache-bust in index.html (a test enforces this).
const BUILD = 16;

// --- State ----------------------------------------------------------------
const state = {
  units: localStorage.getItem("units") || "imperial",
  place: JSON.parse(localStorage.getItem("place") || "null"),
  favorites: JSON.parse(localStorage.getItem("favorites") || "[]"),
  lang: localStorage.getItem("lang") || "auto",
  // Settings (see the settings panel)
  timeFormat: localStorage.getItem("timeFormat") || "auto",     // auto | 12 | 24
  windUnit: localStorage.getItem("windUnit") || "auto",         // auto | mph | kmh | ms | kn
  pressureUnit: localStorage.getItem("pressureUnit") || "auto", // auto | hPa | inHg | mmHg
  reduceMotion: localStorage.getItem("reduceMotion") === "1",
  defaultPlace: JSON.parse(localStorage.getItem("defaultPlace") || "null"),
  themeMode: localStorage.getItem("themeMode") || "auto",        // auto | dark | light
  accent: localStorage.getItem("accent") || "",                  // "" = default
  prayer: localStorage.getItem("prayerTimes") === "1",           // show prayer card (replaces Sun)
  prayerOpen: localStorage.getItem("prayerOpen") === "1",        // prayer card expanded?
  cardOrder: JSON.parse(localStorage.getItem("cardOrder") || "null"),  // custom card order (keys) or null
  cardHidden: JSON.parse(localStorage.getItem("cardHidden") || "[]"),  // hidden card keys
  cardSpans: JSON.parse(localStorage.getItem("cardSpans") || "{}"),    // per-card column span (3–12)
};
const GRID_COLS = 12, MIN_SPAN = 3;
// Default dashboard order + friendly labels (used by the layout editor).
const DEFAULT_CARD_ORDER = ["current", "conditions", "radar", "hourly", "daily",
  "history", "marine", "aqi", "sun", "prayer", "lifestyle", "compare"];
const CARD_LABELS = {
  current: "Current conditions", conditions: "Conditions now", radar: "Radar",
  hourly: "Next 48 hours", daily: "7-day forecast", history: "Historical reference",
  marine: "Marine & surf", aqi: "Air quality", sun: "Sun & daylight",
  prayer: "Prayer times", lifestyle: "Good day for…", compare: "Compare cities",
};
const ACCENTS = ["#6fb7ff", "#54d6c2", "#a3e635", "#ffd45e", "#ff8a5f", "#c08cff"];
// Language: localizes place names (geocoding) and date/time/number formatting.
const LANGS = [["auto", "Auto"], ["en", "English"], ["es", "Español"], ["fr", "Français"],
  ["de", "Deutsch"], ["pt", "Português"], ["it", "Italiano"], ["nl", "Nederlands"],
  ["sv", "Svenska"], ["pl", "Polski"], ["ja", "日本語"], ["zh", "中文"]];
const effLangTag = () => (state.lang === "auto" ? (navigator.language || "en") : state.lang);
const effLang2 = () => effLangTag().slice(0, 2).toLowerCase();
const LOCALE = () => effLangTag();
function applyLang() {
  document.documentElement.lang = effLang2();
  document.documentElement.dir = ["ar", "he", "fa", "ur"].includes(effLang2()) ? "rtl" : "ltr";
}
let refreshTimer = null;
let chart = null;
let histChart = null;

const $ = (id) => document.getElementById(id);
const tempU = () => (state.units === "imperial" ? "°F" : "°C");
const precU = () => (state.units === "imperial" ? "in" : "mm");
const r0 = (n) => (n == null ? "–" : Math.round(n));
const r1 = (n) => (n == null ? "–" : Math.round(n * 10) / 10);

// Wind: convertible independently of the temperature units ------------------
const WIND_TO_MS = { mph: 0.44704, kmh: 1 / 3.6, ms: 1, kn: 0.514444 };
const WIND_LABEL = { mph: "mph", kmh: "km/h", ms: "m/s", kn: "kn" };
const effWind = () => (state.windUnit === "auto" ? (state.units === "imperial" ? "mph" : "kmh") : state.windUnit);
const fetchedWind = () => ((state.lastData && state.lastData.units && state.lastData.units.wind) || (state.units === "imperial" ? "mph" : "kmh"));
const toWind = (v) => (v == null ? null : (v * (WIND_TO_MS[fetchedWind()] || WIND_TO_MS.mph)) / WIND_TO_MS[effWind()]);
const windU = () => WIND_LABEL[effWind()];
const wv = (v) => r0(toWind(v));

// Pressure: hPa from the API, displayed in the chosen unit ------------------
const effPress = () => (state.pressureUnit === "auto" ? (state.units === "imperial" ? "inHg" : "hPa") : state.pressureUnit);
function pressureParts(hPa) {
  const u = effPress();
  if (hPa == null) return { value: null, v: "–", u, min: 960, max: 1050, dec: 0 };
  if (u === "inHg") return { value: hPa * 0.02953, v: (hPa * 0.02953).toFixed(2), u: "inHg", min: 28.0, max: 31.2, dec: 2 };
  if (u === "mmHg") return { value: hPa * 0.7500617, v: String(Math.round(hPa * 0.7500617)), u: "mmHg", min: 720, max: 790, dec: 0 };
  return { value: hPa, v: String(Math.round(hPa)), u: "hPa", min: 960, max: 1050, dec: 0 };
}

// Time formatting honoring the 12/24h setting -------------------------------
const hourPref = () => (state.timeFormat === "24" ? false : state.timeFormat === "12" ? true : undefined);
function clk(d, withMin) {
  const dt = d instanceof Date ? d : new Date(d);
  const o = { hour: "numeric" };
  if (withMin !== false) o.minute = "2-digit";
  const h12 = hourPref(); if (h12 !== undefined) o.hour12 = h12;
  return dt.toLocaleTimeString(LOCALE(), o);
}

// Re-render only the views affected by a client-side setting change (time /
// wind / pressure units) using the data we already have — no refetch, and no
// need to rebuild the radar map or re-pull history.
function rerender() {
  if (!(state.lastData && state.place)) return;
  const f = state.lastData.forecast;
  const meta = describe(f.current.weather_code);
  renderCurrent(state.place, f, meta);
  renderTiles(f, state.lastData.air_quality);
  renderHourly(f);
  renderDaily(f);
  renderSun(f);
  renderPrayer(f);
  applyPrayerVisibility();
  renderLifestyle(f, state.lastData.air_quality);
  renderActivityHint(f);
}

// --- Boot -----------------------------------------------------------------
function boot() {
  $("unitToggle").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.units === state.units);
    b.onclick = () => setUnits(b.dataset.units);
  });
  $("geoBtn").onclick = useMyLocation;
  $("starBtn").onclick = toggleFavorite;
  $("refreshBtn").onclick = doRefresh;
  setupSearch();
  setupCompare();
  setupNotifications();
  setupSettings();
  applyReduceMotion();
  applyTheme();
  applyLang();
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(() => {
      if (state.themeMode === "auto") applyTheme();
    });
  }
  registerSW();
  setupInstall();
  wireFullscreen($("fullscreenBtn"));
  buildStars();
  renderFavorites();
  applyCardLayout();
  scheduleRefresh();

  // Load the startup default if the user pinned one, else the last place,
  // else a sensible fallback. We intentionally do NOT auto-prompt geolocation.
  loadWeather(state.defaultPlace || state.place || fallbackPlace());
}

function applyReduceMotion() {
  document.body.classList.toggle("reduce-motion", !!state.reduceMotion);
}

// Light/dark theme + accent color.
function applyTheme() {
  const m = state.themeMode;
  const light = m === "light" ||
    (m === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.body.classList.toggle("light", light);
  if (state.accent) document.documentElement.style.setProperty("--accent", state.accent);
  else document.documentElement.style.removeProperty("--accent");
}

// Register the service worker (PWA offline + installability). Same-origin only;
// silently ignored where unsupported or blocked (e.g. file://).
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  const reg = () => navigator.serviceWorker.register("sw.js").catch(() => {});
  if (document.readyState === "complete") reg();
  else window.addEventListener("load", reg);
}

// Android / desktop-Chrome "Install app" button. The browser fires
// beforeinstallprompt when the PWA is installable; we stash it and reveal the
// toolbar button, then replay it on click. iOS never fires this event (install
// there is manual via Share → Add to Home Screen), so the button stays hidden.
let deferredInstall = null;
function setupInstall() {
  const btn = $("installBtn");
  if (!btn) return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    btn.classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    btn.classList.add("hidden");
  });
  btn.onclick = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null;
    btn.classList.add("hidden");
  };
}

// --- Customizable dashboard layout (hide + reorder cards) ------------------
// Each top-level card carries data-card="key". Order + hidden set persist in
// localStorage. `.lay-hidden` (layout) composes with `.hidden` (feature gates
// like marine/prayer) — a card shows only when neither applies.
function cardSections() {
  const c = $("content");
  return c ? [...c.querySelectorAll(":scope > section[data-card]")] : [];
}
function applyCardLayout() {
  const c = $("content");
  if (!c) return;
  const byKey = {};
  cardSections().forEach((s) => { byKey[s.dataset.card] = s; });
  const order = [];
  (state.cardOrder || []).forEach((k) => { if (byKey[k] && !order.includes(k)) order.push(k); });
  // Append any cards missing from the saved order (e.g. newly added features).
  Object.keys(byKey).forEach((k) => { if (!order.includes(k)) order.push(k); });
  const foot = c.querySelector(":scope > .foot");
  order.forEach((k) => c.insertBefore(byKey[k], foot || null));
  const hidden = new Set(state.cardHidden);
  Object.entries(byKey).forEach(([k, s]) => {
    s.classList.toggle("lay-hidden", hidden.has(k));
    applyOneCard(s, k);
  });
}
// Per-card size config: { c: columns(3–12), h: height(px) }; either may be unset.
// Back-compat: an old plain-number value means a column span.
const MIN_H = 140, MAX_H = 1400;
function cardCfg(key) {
  const v = state.cardSpans[key];
  if (v == null) return {};
  return typeof v === "number" ? { c: v } : v;
}
function setCardCfg(key, patch) {
  const next = { ...cardCfg(key), ...patch };
  Object.keys(next).forEach((k) => { if (next[k] == null) delete next[k]; });
  if (Object.keys(next).length) state.cardSpans[key] = next; else delete state.cardSpans[key];
  localStorage.setItem("cardSpans", JSON.stringify(state.cardSpans));
}
// Apply a single card's width (column span) + optional fixed height.
function applyOneCard(s, key) {
  const cfg = cardCfg(key);
  s.style.gridColumn = cfg.c ? `span ${cfg.c}` : "";        // "" → fall back to sp* class
  if (cfg.h) {
    s.style.height = cfg.h + "px"; s.style.overflow = "auto"; s.classList.add("lay-sized");
  } else {
    s.style.height = ""; s.style.overflow = ""; s.classList.remove("lay-sized");
  }
}
// A card's effective column span: inline override → sp* class → full width.
function spanFromClass(s) {
  for (const n of [4, 5, 6, 7, 8]) if (s.classList.contains("sp" + n)) return n;
  return GRID_COLS;
}
function currentSpan(s) {
  const m = /span\s+(\d+)/.exec(s.style.gridColumn || "");
  return m ? +m[1] : spanFromClass(s);
}
// Width (px) of one grid column including its gap — to convert drag → columns.
function gridColumnUnit() {
  const c = $("content");
  const gap = parseFloat(getComputedStyle(c).columnGap) || 14;
  return (c.clientWidth - gap * (GRID_COLS - 1)) / GRID_COLS + gap;
}
function persistCardOrder() {
  state.cardOrder = cardSections().map((s) => s.dataset.card);
  localStorage.setItem("cardOrder", JSON.stringify(state.cardOrder));
}
function moveCard(key, dir) {
  const c = $("content");
  const s = c.querySelector(`:scope > section[data-card="${key}"]`);
  if (!s) return;
  const sel = "section[data-card]";
  if (dir < 0) {
    let p = s.previousElementSibling; while (p && !p.matches(sel)) p = p.previousElementSibling;
    if (p) c.insertBefore(s, p);
  } else {
    let n = s.nextElementSibling; while (n && !n.matches(sel)) n = n.nextElementSibling;
    if (n) c.insertBefore(n, s);
  }
  persistCardOrder();
}
function toggleCardHidden(key) {
  const set = new Set(state.cardHidden);
  set.has(key) ? set.delete(key) : set.add(key);
  state.cardHidden = [...set];
  localStorage.setItem("cardHidden", JSON.stringify(state.cardHidden));
  $("content").querySelector(`:scope > section[data-card="${key}"]`)
    ?.classList.toggle("lay-hidden", set.has(key));
}
function resetLayout() {
  state.cardOrder = DEFAULT_CARD_ORDER.slice();
  state.cardHidden = [];
  state.cardSpans = {};
  localStorage.setItem("cardOrder", JSON.stringify(state.cardOrder));
  localStorage.setItem("cardHidden", "[]");
  localStorage.removeItem("cardSpans");
  cardSections().forEach((s) => {                                // drop inline size overrides
    s.style.gridColumn = ""; s.style.height = ""; s.style.overflow = "";
    s.classList.remove("lay-sized");
  });
  applyCardLayout();
  if (layoutEditing) { removeEditUI(); buildEditUI(); }
}

let layoutEditing = false;
let layoutDragKey = null;
function enterLayoutEdit() {
  layoutEditing = true;
  document.body.classList.add("editing-layout");
  buildEditUI();
  showLayoutBar();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function exitLayoutEdit() {
  layoutEditing = false;
  document.body.classList.remove("editing-layout");
  removeEditUI();
  $("layoutBar")?.classList.remove("show");
}
function buildEditUI() {
  const c = $("content");
  cardSections().forEach((s) => {
    if (s.classList.contains("hidden")) return;           // feature-gated off → not editable now
    if (s.querySelector(":scope > .card-edit")) return;
    const key = s.dataset.card;
    const bar = document.createElement("div");
    bar.className = "card-edit";
    bar.innerHTML =
      `<span class="ce-grip" draggable="true" title="Drag to reorder">⠿</span>` +
      `<span class="ce-name">${CARD_LABELS[key] || key}</span>` +
      `<button class="ce-btn" data-mv="up" title="Move up">↑</button>` +
      `<button class="ce-btn" data-mv="down" title="Move down">↓</button>` +
      `<button class="ce-btn ce-hide" data-hide>${state.cardHidden.includes(key) ? "Show" : "Hide"}</button>`;
    bar.querySelector('[data-mv="up"]').onclick = () => moveCard(key, -1);
    bar.querySelector('[data-mv="down"]').onclick = () => moveCard(key, 1);
    bar.querySelector("[data-hide]").onclick = (e) => {
      toggleCardHidden(key);
      e.currentTarget.textContent = state.cardHidden.includes(key) ? "Show" : "Hide";
      s.classList.toggle("lay-dim", state.cardHidden.includes(key));
    };
    const grip = bar.querySelector(".ce-grip");
    grip.addEventListener("dragstart", () => { layoutDragKey = key; s.classList.add("dragging"); });
    grip.addEventListener("dragend", () => { s.classList.remove("dragging"); layoutDragKey = null; persistCardOrder(); });
    s.prepend(bar);
    s.classList.toggle("lay-dim", state.cardHidden.includes(key));
    attachResize(s, key);
  });
  c.addEventListener("dragover", onLayoutDragOver);
}
// Corner handle to resize a card in 2 dimensions: horizontal drag snaps the
// column span to the grid (width); vertical drag sets a fixed pixel height.
// An axis only becomes an override if the user actually drags it, so height
// stays content-driven (no dead space) until deliberately changed.
function attachResize(section, key) {
  const handle = document.createElement("div");
  handle.className = "card-resize";
  handle.title = "Drag to resize (width ↔, height ↕)";
  section.appendChild(handle);
  let startX = 0, startY = 0, startC = 0, startH = 0, liveC = 0, liveH = 0, label = null;
  const onMove = (e) => {
    liveC = Math.max(MIN_SPAN, Math.min(GRID_COLS,
      Math.round(startC + (e.clientX - startX) / gridColumnUnit())));
    liveH = Math.max(MIN_H, Math.min(MAX_H, startH + (e.clientY - startY)));
    section.style.gridColumn = `span ${liveC}`;
    section.style.height = liveH + "px";
    section.style.overflow = "auto";
    if (label) label.textContent = `${liveC}/${GRID_COLS} · ${Math.round(liveH)}px`;
  };
  const onUp = (e) => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    label?.remove(); label = null;
    const cfg = cardCfg(key);
    // Only persist an axis the user meaningfully dragged.
    const draggedX = Math.abs(e.clientX - startX) > gridColumnUnit() / 2;
    const draggedY = Math.abs(e.clientY - startY) > 16;
    setCardCfg(key, {
      c: draggedX ? liveC : (cfg.c ?? null),
      h: draggedY ? Math.round(liveH) : (cfg.h ?? null),
    });
    applyOneCard(section, key);                  // snap back to persisted config
    window.dispatchEvent(new Event("resize"));   // reflow Chart.js canvases + Leaflet map
  };
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    startX = e.clientX; startY = e.clientY;
    startC = liveC = currentSpan(section);
    startH = liveH = Math.round(section.getBoundingClientRect().height);
    label = document.createElement("div");
    label.className = "card-resize-label";
    label.textContent = `${startC}/${GRID_COLS} · ${startH}px`;
    section.appendChild(label);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}
function removeEditUI() {
  const c = $("content");
  c.removeEventListener("dragover", onLayoutDragOver);
  c.querySelectorAll(":scope > section > .card-edit, :scope > section > .card-resize, :scope > section > .card-resize-label")
    .forEach((b) => b.remove());
  cardSections().forEach((s) => s.classList.remove("lay-dim", "dragging"));
}
function onLayoutDragOver(e) {
  if (!layoutEditing || !layoutDragKey) return;
  e.preventDefault();
  const c = $("content");
  const dragging = c.querySelector("section.dragging");
  if (!dragging) return;
  const others = cardSections().filter((s) => s !== dragging);
  const after = others.find((s) => {
    const r = s.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  if (after) c.insertBefore(dragging, after);
  else c.insertBefore(dragging, c.querySelector(":scope > .foot") || null);
}
function showLayoutBar() {
  let bar = $("layoutBar");
  if (!bar) { bar = document.createElement("div"); bar.id = "layoutBar"; bar.className = "layout-bar"; document.body.appendChild(bar); }
  bar.innerHTML =
    `<span class="lb-hint">✦ Editing — reorder (⠿ / ↑ ↓), drag corner ◢ to resize width &amp; height, Hide</span>` +
    `<button class="btn" id="layoutReset">Reset</button>` +
    `<button class="btn lb-done" id="layoutDone">Done</button>`;
  $("layoutDone").onclick = exitLayoutEdit;
  $("layoutReset").onclick = resetLayout;
  requestAnimationFrame(() => bar.classList.add("show"));
}

function setUnits(u) {
  if (u === state.units) return;
  state.units = u;
  localStorage.setItem("units", u);
  favCache.clear(); // temps were fetched in the old unit
  $("unitToggle").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", b.dataset.units === u)
  );
  if (state.place) loadWeather(state.place);
}

// --- Search (debounced geocoding + ZIP + recents + flags) ----------------
// ISO country code → flag emoji (regional-indicator letters).
function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  const up = cc.toUpperCase();
  if (up < "AA" || up > "ZZ") return "";
  return String.fromCodePoint(0x1F1E6 + up.charCodeAt(0) - 65, 0x1F1E6 + up.charCodeAt(1) - 65);
}

let recent = JSON.parse(localStorage.getItem("recent") || "[]");
function recordRecent(p) {
  if (!p || !p.name || p.name === "Pinned point" || p.name === "My location") return;
  const k = placeKey(p);
  recent = [{ name: p.name, admin1: p.admin1, country: p.country, country_code: p.country_code, lat: p.lat, lon: p.lon },
    ...recent.filter((q) => placeKey(q) !== k)].slice(0, 6);
  localStorage.setItem("recent", JSON.stringify(recent));
}

// Postal-code lookup via zippopotam.us (free, CORS-enabled). Tries the current
// country first, then a few common ones.
async function zipSearch(zip) {
  const z = zip.replace(/\s/g, "");
  const ccs = [];
  if (state.place && state.place.country_code) ccs.push(state.place.country_code.toLowerCase());
  ["us", "gb", "ca", "de", "fr", "au"].forEach((c) => { if (!ccs.includes(c)) ccs.push(c); });
  for (const cc of ccs.slice(0, 3)) {
    try {
      const r = await fetch(`https://api.zippopotam.us/${cc}/${encodeURIComponent(z)}`);
      if (!r.ok) continue;
      const d = await r.json();
      if (d.places && d.places.length) {
        return d.places.slice(0, 5).map((p) => ({
          name: `${p["place name"]}${p.state ? ", " + (p["state abbreviation"] || p.state) : ""}`,
          admin1: p.state, country: d.country, country_code: (d["country abbreviation"] || cc).toUpperCase(),
          lat: +p.latitude, lon: +p.longitude,
        }));
      }
    } catch (e) { /* try next country */ }
  }
  return [];
}

function searchResultBtn(p, input, box) {
  const btn = document.createElement("button");
  const where = [p.admin1, p.country].filter(Boolean).join(", ");
  const fl = flag(p.country_code);
  btn.innerHTML = `<span>${fl ? fl + " " : ""}${p.name}</span><span class="sub">${where}</span>`;
  btn.onclick = () => { input.value = ""; box.innerHTML = ""; loadWeather(p); };
  return btn;
}

function renderResults(box, results, input) {
  box.innerHTML = "";
  results.forEach((p) => box.appendChild(searchResultBtn(p, input, box)));
}

function renderRecent(box, input) {
  if (!recent.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="results-head">Recent</div>`;
  recent.forEach((p) => box.appendChild(searchResultBtn(p, input, box)));
}

function setupSearch() {
  const input = $("searchInput");
  const box = $("searchResults");
  let timer;
  input.addEventListener("focus", () => { if (!input.value.trim()) renderRecent(box, input); });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { renderRecent(box, input); return; }
    timer = setTimeout(async () => {
      try {
        let results = [];
        if (/^\d[\d\s-]{2,}$/.test(q)) results = await zipSearch(q);   // looks like a postal code
        if (!results.length) {
          const data = await (await fetch(`/api/geocode?q=${encodeURIComponent(q)}&lang=${effLang2()}`)).json();
          results = (data.results || []).map((p) => ({
            name: p.name, admin1: p.admin1, country: p.country,
            country_code: p.country_code, lat: p.latitude, lon: p.longitude,
          }));
        }
        renderResults(box, results, input);
      } catch (e) { /* ignore */ }
    }, 280);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) box.innerHTML = "";
  });
}

// --- Geolocation ----------------------------------------------------------
function useMyLocation() {
  // Browsers block geolocation on insecure (plain http, non-localhost) origins —
  // e.g. when viewing over the LAN on a phone. The installed PWA is served over
  // HTTPS (GitHub Pages), so this guard only trips on the dev box over the LAN.
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    toast("Location needs HTTPS — search your city instead", 3200);
    $("searchInput").focus();
    $("searchInput").placeholder = "Search your city ↵";
    return;
  }
  if (!navigator.geolocation) { toast("This device can't share its location"); return; }
  const btn = $("geoBtn");
  btn?.classList.add("locating");
  toast("Finding your location…", 15000);
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      btn?.classList.remove("locating");
      const { latitude: lat, longitude: lon } = pos.coords;
      let info = {};
      try {
        const r = await fetch(`/api/reverse?lat=${lat}&lon=${lon}&lang=${effLang2()}`);
        info = await r.json();
      } catch (e) { /* name is optional — fall back to "My location" */ }
      loadWeather({
        name: info.name || "My location", admin1: info.admin1,
        country: info.country, country_code: info.country_code, lat, lon,
      });
    },
    (err) => {
      // Don't silently strand the user — say what happened so the pin feels alive.
      btn?.classList.remove("locating");
      const msg = err.code === err.PERMISSION_DENIED
        ? "Location blocked — allow it in your device settings, or search your city"
        : err.code === err.TIMEOUT
        ? "Couldn't get a location fix in time — try again"
        : "Location unavailable — search your city instead";
      toast(msg, 3600);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

// One-time twinkling starfield (revealed at night via CSS).
function buildStars() {
  const el = $("stars");
  if (!el || el.childElementCount) return;
  let html = "";
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 100, y = Math.random() * 100;
    const tw = 2 + Math.random() * 4, td = Math.random() * 4;
    const sz = Math.random() < 0.2 ? 3 : 2;
    html += `<i style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;width:${sz}px;height:${sz}px;--tw:${tw.toFixed(1)}s;--td:${td.toFixed(1)}s"></i>`;
  }
  el.innerHTML = html;
}

const fallbackPlace = () => ({
  name: "New York", admin1: "New York", country: "United States",
  country_code: "US", lat: 40.7128, lon: -74.006,
});

// --- Load + render --------------------------------------------------------
function setLoading(msg) {
  $("loading").classList.remove("hidden");
  $("content").classList.add("hidden");
  $("loadingText").textContent = msg || "Loading weather…";
}

async function loadWeather(place, silent) {
  state.place = place;
  localStorage.setItem("place", JSON.stringify(place));
  recordRecent(place);
  if (!silent) setLoading(`Loading weather for ${place.name}…`);
  try {
    const url = `/api/weather?lat=${place.lat}&lon=${place.lon}` +
      `&units=${state.units}&country_code=${place.country_code || ""}` +
      `&admin1=${encodeURIComponent(place.admin1 || "")}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.detail || data.error);
    // Reveal content BEFORE rendering so the chart container has a real
    // width — Chart.js sizes its canvas to the container at creation time,
    // and a display:none parent would collapse it to 0px.
    $("loading").classList.add("hidden");
    $("content").classList.remove("hidden");
    render(place, data);
    if (silent) pulseUpdated();
  } catch (e) {
    if (silent) return; // keep showing the last good data on a failed refresh
    $("loading").innerHTML = `<div class="error-box"><b>Couldn't load weather.</b><br>${e.message}<br><br><button class="btn" onclick="location.reload()">Retry</button></div>`;
  }
}

function render(place, data) {
  state.lastData = data; // reused by the city comparison (no refetch of city A)
  const f = data.forecast;
  const cur = f.current;
  const code = cur.weather_code;
  const meta = describe(code);

  // Theme the page
  document.body.dataset.theme = meta.theme;
  document.body.dataset.night = cur.is_day ? "0" : "1";
  toggleRain(meta.theme === "rain" || meta.theme === "storm");

  applyEffects(meta.theme, cur);
  renderCurrent(place, f, meta);
  renderTiles(f, data.air_quality);
  renderHourly(f);
  renderDaily(f);
  renderAirQuality(data.air_quality, data.pollen);
  renderSun(f);
  renderPrayer(f);
  applyPrayerVisibility();
  renderLifestyle(f, data.air_quality);
  renderMarine(data.marine);
  renderAlerts(data.alerts);
  renderNowcast(f);
  renderActivityHint(f);
  maybeNotify(place, f, data.alerts);
  renderFavorites();
  // Radar map (created once, re-centered on each location change).
  initRadar(place.lat, place.lon, place.name, onMapPick);
  // Historical reference (async — compares today to the climate normal).
  const todayStr2 = new Date().toLocaleDateString("en-CA", { timeZone: f.timezone });
  let di2 = f.daily.time.indexOf(todayStr2); if (di2 < 0) di2 = 1;
  loadHistory(place, f.daily.temperature_2m_max[di2], f.daily.temperature_2m_min[di2]);

  const when = clk(new Date(data.fetched_at * 1000));
  $("foot").innerHTML =
    `Updated ${when} · ${place.lat.toFixed(2)}, ${place.lon.toFixed(2)} · ` +
    `Data: <a href="https://open-meteo.com" target="_blank">Open-Meteo</a>` +
    `${(data.alerts && data.alerts.length) || (place.country_code === "US") ? ` + <a href="https://weather.gov" target="_blank">NWS</a>` : ""}` +
    ` · timezone ${f.timezone} · build ${BUILD}`;
}

// --- Current --------------------------------------------------------------
function renderCurrent(place, f, meta) {
  const c = f.current;
  const today = f.daily;
  // find today's index (past_days=1 shifts index; match by date)
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: f.timezone });
  let di = today.time.indexOf(todayStr);
  if (di < 0) di = 1;
  const where = [place.admin1, place.country].filter(Boolean).join(", ");
  const form = castformForm(meta.theme, c.is_day);
  const imp = state.units === "imperial";
  const tMin = imp ? -10 : -25, tMax = imp ? 115 : 46;
  const tempGauge = gauge({
    value: c.temperature_2m, min: tMin, max: tMax, unit: "°", decimals: 0,
    label: meta.label,
    colors: ["#5aa9ff", "#54d6c2", "#a3e635", "#ffd45e", "#ff8a3d", "#ff4d4d"],
  });
  $("currentCard").innerHTML = `
    <div class="place">${place.name}${where ? `<span class="sub"> · ${where}</span>` : ""}<span class="form-badge" title="Castform changes form with the weather">${form.emoji} ${form.name}</span></div>
    <div class="cur-main">
      <div class="hero-gauge">${tempGauge}</div>
      <div class="cur-info">
        <div class="hero-cond">
          <span class="hero-ico">${icon(c.weather_code, c.is_day)}</span>
          <div>
            <div class="cond">${meta.label}</div>
            <div class="feels">Feels like ${r0(c.apparent_temperature)}${tempU()}</div>
          </div>
        </div>
        <div class="hilo">High <b>${r0(today.temperature_2m_max[di])}°</b> · Low <b>${r0(today.temperature_2m_min[di])}°</b></div>
        ${comfortLine(c)}
        ${vsYesterdayLine(today, di, c)}
      </div>
    </div>
    <div class="daystory">${todayStory(f, di)}</div>
    <div class="hero-today">
      <div class="ht"><span class="htk">🌅 Sunrise</span><span class="htv">${sunFmt(today.sunrise[di])}</span></div>
      <div class="ht"><span class="htk">🌇 Sunset</span><span class="htv">${sunFmt(today.sunset[di])}</span></div>
      <div class="ht"><span class="htk">☔ Rain today</span><span class="htv">${today.precipitation_probability_max ? r0(today.precipitation_probability_max[di]) + "%" : "–"}</span></div>
    </div>
  `;
}

const sunFmt = (iso) => iso ? clk(iso) : "–";

// Castform's in-game forms, mapped to the live weather (its gimmick!).
function castformForm(theme, isDay) {
  if (theme === "clear") return { name: isDay ? "Sunny Form" : "Normal Form", emoji: isDay ? "☀️" : "🌙" };
  if (theme === "rain" || theme === "storm") return { name: "Rainy Form", emoji: "🌧️" };
  if (theme === "snow") return { name: "Snowy Form", emoji: "❄️" };
  return { name: "Normal Form", emoji: "🌥️" };
}

// "Feels like" comfort breakdown: heat index / wind chill + a human descriptor.
function comfortLine(c) {
  const t = c.temperature_2m, feels = c.apparent_temperature, rh = c.relative_humidity_2m;
  const imp = state.units === "imperial";
  const hot = imp ? 80 : 27, cold = imp ? 50 : 10;
  let driver = "", label = "";
  if (t >= hot) {
    driver = `Heat index ${r0(feels)}${tempU()}`;
    label = rh >= 70 ? "Muggy & oppressive" : rh >= 50 ? "Warm & humid" : "Hot but dry";
  } else if (t <= cold) {
    driver = `Wind chill ${r0(feels)}${tempU()}`;
    const w = c.wind_speed_10m;
    label = t <= (imp ? 20 : -6) ? "Bitterly cold" : (w >= (imp ? 15 : 24) ? "Raw & windy" : "Crisp & cold");
  } else {
    const diff = feels - t;
    label = Math.abs(diff) < (imp ? 2 : 1) ? "Comfortable" : diff > 0 ? "A touch warm" : "Pleasantly cool";
    driver = `${rh}% humidity`;
  }
  return `<div class="comfort"><span class="comfort-dot"></span>${label} <span class="comfort-sub">· ${driver}</span></div>`;
}

// "Warmer/cooler than yesterday" + a quick clothing/activity tip.
function vsYesterdayLine(today, di, c) {
  let vs = "";
  if (di >= 1 && today.temperature_2m_max && today.temperature_2m_max[di - 1] != null && today.temperature_2m_max[di] != null) {
    const d = Math.round(today.temperature_2m_max[di] - today.temperature_2m_max[di - 1]);
    vs = d === 0 ? "Same high as yesterday" : `${Math.abs(d)}° ${d > 0 ? "warmer" : "cooler"} than yesterday`;
  }
  const tip = dayTip(c, today, di);
  if (!vs && !tip) return "";
  return `<div class="vsy">${vs ? `<span class="vsy-d">${vs}</span>` : ""}${tip ? `<span class="vsy-tip">${tip}</span>` : ""}</div>`;
}

function dayTip(c, today, di) {
  const imp = state.units === "imperial";
  const feels = c.apparent_temperature;
  const pop = today.precipitation_probability_max ? today.precipitation_probability_max[di] : 0;
  const code = c.weather_code;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "🧤 Snowy — bundle up";
  if (pop >= 60) return "☔ Take an umbrella";
  const cold = imp ? 38 : 3, cool = imp ? 56 : 13, warm = imp ? 86 : 30;
  if (feels != null && feels <= cold) return "🧥 Heavy coat weather";
  if (feels != null && feels <= cool) return "🧥 Light jacket";
  if (feels != null && feels >= warm) return "🥵 Stay cool & hydrated";
  const uv = today.uv_index_max ? today.uv_index_max[di] : 0;
  if (uv >= 8) return "🧴 High UV — wear sunscreen";
  return "👕 Comfortable out";
}

// Condition + temps headline (no precip — that's shown separately).
function dayHeadline(f, i) {
  const d = f.daily;
  const meta = describe(d.weather_code[i]);
  return `${meta.label}. High ${r0(d.temperature_2m_max[i])}°, low ${r0(d.temperature_2m_min[i])}°.`;
}

// Fuller one-sentence story (headline + precip window) for today's hero.
function dayStorySentence(f, i) {
  let s = dayHeadline(f, i);
  const sum = precipSummary(f, hourIdxForDay(f, f.daily.time[i]));
  if (sum && !sum.dry) s += ` ${sum.text}.`;
  return s;
}

function todayStory(f, di) {
  let s = dayStorySentence(f, di);
  // Teaser: if today is dry but tomorrow isn't, flag the change.
  const todaySum = precipSummary(f, hourIdxForDay(f, f.daily.time[di]));
  if ((!todaySum || todaySum.dry) && di + 1 < f.daily.time.length) {
    const tmrw = precipSummary(f, hourIdxForDay(f, f.daily.time[di + 1]));
    if (tmrw && !tmrw.dry) s += " Rain moving in tomorrow.";
  }
  return s;
}

// Animate a number from 0 → target for a premium "spin-up" feel.
function countUp(el, target, ms) {
  if (!el || target == null || isNaN(target)) return;
  const start = performance.now();
  const from = 0;
  function frame(now) {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    el.textContent = Math.round(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = target;
  }
  requestAnimationFrame(frame);
}

// --- Conditions gauges + stat strip ---------------------------------------
const UV_COLORS = ["#a3e635", "#ffd45e", "#ff8a3d", "#ff4d4d", "#a13be0"];

function renderTiles(f, air) {
  const c = f.current;
  const aq = air && air.current ? air.current : {};
  const uv = hourlyNow(f, "uv_index");
  const visM = c.visibility != null ? c.visibility : hourlyNow(f, "visibility");

  // Gauges — the console centerpiece.
  const press = pressureParts(c.pressure_msl);
  const gauges = [
    compassGauge(c.wind_direction_10m, toWind(c.wind_speed_10m), windU(), toWind(c.wind_gusts_10m)) +
      `<div class="gauge-cap">Wind · ${compass(c.wind_direction_10m)}</div>`,
    gauge({ value: c.relative_humidity_2m, min: 0, max: 100, unit: "%", label: "Humidity",
      sub: c.dew_point_2m != null ? `dew ${r0(c.dew_point_2m)}°` : "", color: "#54d6c2" }),
    gauge({ value: press.value, min: press.min, max: press.max, unit: "", decimals: press.dec, label: "Pressure",
      sub: press.u, color: "#9b8cff" }),
    gauge({ value: uv, min: 0, max: 12, unit: "", decimals: 0, label: "UV index",
      sub: uvLabel(uv), colors: UV_COLORS }),
    gauge({ value: c.cloud_cover, min: 0, max: 100, unit: "%", label: "Cloud", color: "#7fb2ff" }),
    gauge({ value: aq.us_aqi != null ? aq.us_aqi : aq.european_aqi, min: 0, max: aq.us_aqi != null ? 200 : 100,
      unit: "", label: aq.us_aqi != null ? "US AQI" : "EU AQI",
      sub: aq.pm2_5 != null ? `PM2.5 ${r1(aq.pm2_5)}` : "", colors: ["#7ed957", "#ffd45e", "#ff8a3d", "#ff4d4d"] }),
  ];

  // Compact secondary stats.
  let vis = "–";
  if (visM != null) {
    const mi = visM / 1609, km = visM / 1000;
    vis = state.units === "imperial" ? (mi >= 10 ? "10+ mi" : `${r1(mi)} mi`) : (km >= 16 ? "16+ km" : `${r1(km)} km`);
  }
  const stats = [
    ["Feels like", `${r0(c.apparent_temperature)}°`],
    ["Visibility", vis],
    ["Precip now", `${r1(c.precipitation)} ${precU()}`],
    ["Wind gust", `${wv(c.wind_gusts_10m)} ${windU()}`],
  ];

  $("tiles").innerHTML =
    `<div class="gauge-grid">${gauges.map((g) => `<div class="gauge-cell">${g}</div>`).join("")}</div>` +
    `<div class="statstrip">${stats.map((s) => `<div class="stat"><span class="sk">${s[0]}</span><span class="sv">${s[1]}</span></div>`).join("")}</div>`;
}

function hourlyNow(f, field) {
  const h = f.hourly;
  if (!h || !h[field]) return null;
  const now = new Date();
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const diff = Math.abs(new Date(h.time[i]) - now);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return h[field][best];
}

const uvLabel = (uv) => uv == null ? "" : uv < 3 ? "Low" : uv < 6 ? "Moderate" : uv < 8 ? "High" : uv < 11 ? "Very high" : "Extreme";

// --- Hourly chart + strip -------------------------------------------------
function renderHourly(f) {
  const h = f.hourly;
  // Start from current hour, show 48
  const now = new Date();
  let start = h.time.findIndex((t) => new Date(t) >= now);
  if (start < 0) start = 0;
  start = Math.max(0, start - 1);
  const end = Math.min(h.time.length, start + 48);
  const idx = [];
  for (let i = start; i < end; i++) idx.push(i);

  const labels = idx.map((i) => clk(h.time[i], false));
  const temps = idx.map((i) => h.temperature_2m[i]);
  const pop = idx.map((i) => h.precipitation_probability[i]);

  const ctx = $("hourlyChart").getContext("2d");
  if (chart) chart.destroy();
  const grad = ctx.createLinearGradient(0, 0, 0, 200);
  grad.addColorStop(0, "rgba(111,183,255,0.45)");
  grad.addColorStop(1, "rgba(111,183,255,0)");

  chart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: "line", label: `Temp ${tempU()}`, data: temps, yAxisID: "y",
          borderColor: "#ffd45e", backgroundColor: grad, fill: true, tension: 0.4,
          pointRadius: 0, borderWidth: 2.5 },
        { type: "bar", label: "Precip %", data: pop, yAxisID: "y1",
          backgroundColor: "rgba(95,168,255,0.55)", borderRadius: 4, barPercentage: 0.6 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => c.dataset.yAxisID === "y1"
              ? `Precip ${r0(c.raw)}%` : `${r0(c.raw)}${tempU()}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "rgba(238,242,251,0.5)", maxTicksLimit: 12 } },
        y: { position: "left", grid: { color: "rgba(255,255,255,0.06)" },
             ticks: { color: "rgba(238,242,251,0.5)", callback: (v) => `${v}°` } },
        y1: { position: "right", min: 0, max: 100, grid: { display: false },
              ticks: { color: "rgba(95,168,255,0.6)", callback: (v) => `${v}%` } },
      },
    },
  });

  // Icon strip (every 3 hours)
  const strip = $("hourStrip");
  strip.innerHTML = "";
  for (let k = 0; k < idx.length; k += 3) {
    const i = idx[k];
    const el = document.createElement("div");
    el.className = "hour";
    const label = k === 0 ? "Now" : clk(h.time[i], false);
    el.innerHTML = `
      <div class="t">${label}</div>
      ${icon(h.weather_code[i], h.is_day[i])}
      <div class="tp">${r0(h.temperature_2m[i])}°</div>
      <div class="pp">${h.precipitation_probability[i] > 5 ? "💧" + r0(h.precipitation_probability[i]) + "%" : ""}</div>`;
    strip.appendChild(el);
  }
}

// --- Daily ----------------------------------------------------------------
let daysWired = false;

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function precipNoun(code) {
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storms";
  if (code >= 80 && code <= 82) return "showers";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  return "precipitation";
}

function hourLabel(hr) {
  hr = ((hr % 24) + 24) % 24;
  if (hr === 0) return "midnight";
  if (hr === 12) return "noon";
  const ap = hr < 12 ? "AM" : "PM";
  let h = hr % 12; if (h === 0) h = 12;
  return `${h} ${ap}`;
}

// Build the indices of the hourly arrays that fall on a given YYYY-MM-DD.
function hourIdxForDay(f, ds) {
  const t = (f.hourly && f.hourly.time) || [];
  const out = [];
  for (let j = 0; j < t.length; j++) if (t[j].slice(0, 10) === ds) out.push(j);
  return out;
}

// Plain-language summary of WHEN precip is likely during a day (so a "rainy"
// icon doesn't imply rain all day).
function precipSummary(f, idxs) {
  const h = f.hourly || {};
  const pops = h.precipitation_probability || [];
  const codes = h.weather_code || [];
  const hrs = idxs.map((j) => ({ hour: new Date(h.time[j]).getHours(), pop: pops[j] == null ? 0 : pops[j], code: codes[j] }));
  if (!hrs.length) return null;
  const peak = Math.max(...hrs.map((x) => x.pop));
  if (peak < 20) return { text: "Dry — little to no chance of precipitation", dry: true };
  const thr = Math.max(25, Math.round(peak * 0.5));
  const runs = []; let cur = null;
  hrs.forEach((x) => {
    if (x.pop >= thr) {
      if (!cur) cur = { s: x.hour, e: x.hour, peak: x.pop, code: x.code };
      else { cur.e = x.hour; if (x.pop > cur.peak) { cur.peak = x.pop; cur.code = x.code; } }
    } else if (cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  if (!runs.length) {
    const top = hrs.find((x) => x.pop === peak);
    return { text: `Slight chance of ${precipNoun(top.code)} · up to ${peak}% chance` };
  }
  runs.sort((a, b) => (b.e - b.s) - (a.e - a.s));
  const w = runs[0];
  const verb = peak >= 60 ? "likely" : "possible";
  const allDay = (w.e - w.s + 1) >= 20 || (w.s <= 1 && w.e >= 22);
  const when = allDay ? "most of the day" : `${hourLabel(w.s)}–${hourLabel(w.e + 1)}`;
  let text = `${cap(precipNoun(w.code))} ${verb} ${when}`;
  if (runs.length > 1 && !allDay) text += " (& other times)";
  text += ` · up to ${peak}% chance`;
  return { text };
}

// Thin 24-segment precip-probability bar shown inline on each 7-day row, so
// the rainy window is visible at a glance without expanding the day.
function precipBar(f, ds) {
  const idxs = hourIdxForDay(f, ds);
  const pops = (f.hourly && f.hourly.precipitation_probability) || [];
  if (!idxs.length) return "";
  let peak = 0;
  const segs = idxs.map((j) => {
    const p = pops[j] == null ? 0 : pops[j];
    if (p > peak) peak = p;
    const a = p <= 3 ? 0 : Math.max(0.12, p / 100);
    return `<i style="--a:${a.toFixed(2)}"></i>`;
  }).join("");
  return `<div class="dprecip" title="Hourly chance of precipitation (peak ${peak}%)">${segs}</div>`;
}

function dayDetail(f, i, ds) {
  const d = f.daily, h = f.hourly || {};
  const idxs = hourIdxForDay(f, ds);
  const sum = precipSummary(f, idxs);

  let chips = "";
  for (let k = 0; k < idxs.length; k += 2) {
    const j = idxs[k];
    const lbl = clk(h.time[j], false);
    const pp = h.precipitation_probability ? h.precipitation_probability[j] : null;
    const isDay = h.is_day ? h.is_day[j] : 1;
    chips += `<div class="dd-hour"><div class="t">${lbl}</div>${icon(h.weather_code[j], isDay)}` +
      `<div class="tp">${r0(h.temperature_2m[j])}°</div>` +
      `<div class="pp">${pp != null && pp >= 5 ? pp + "%" : ""}</div></div>`;
  }

  const fmtT = (s) => (s ? clk(s) : "–");
  const stats = [];
  if (d.sunrise) stats.push(`🌅 ${fmtT(d.sunrise[i])}`);
  if (d.sunset) stats.push(`🌇 ${fmtT(d.sunset[i])}`);
  if (d.precipitation_sum && d.precipitation_sum[i] != null) stats.push(`🌧 ${r1(d.precipitation_sum[i])} ${precU()} total`);
  if (d.wind_speed_10m_max) stats.push(`🌬 ${wv(d.wind_speed_10m_max[i])} ${windU()} max`);
  if (d.uv_index_max) stats.push(`☀ UV ${r0(d.uv_index_max[i])}`);

  return `<div class="day-detail" hidden>
    <div class="dd-story">${dayHeadline(f, i)}</div>
    ${sum ? `<div class="dd-sum${sum.dry ? " dry" : ""}">${sum.text}</div>` : ""}
    <div class="dd-hours">${chips}</div>
    <div class="dd-stats">${stats.map((s) => `<span>${s}</span>`).join("")}</div>
  </div>`;
}

function renderDaily(f) {
  const d = f.daily;
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: f.timezone });
  let start = d.time.indexOf(todayStr);
  if (start < 0) start = 0;
  const lows = [], highs = [];
  for (let i = start; i < d.time.length; i++) { lows.push(d.temperature_2m_min[i]); highs.push(d.temperature_2m_max[i]); }
  const gMin = Math.min(...lows), gMax = Math.max(...highs);
  const span = Math.max(1, gMax - gMin);

  const rows = [];
  for (let i = start; i < d.time.length; i++) {
    const ds = d.time[i];
    const date = new Date(ds + "T12:00:00");
    const name = i === start ? "Today" : date.toLocaleDateString(LOCALE(), { weekday: "short" });
    const sub = date.toLocaleDateString(LOCALE(), { month: "short", day: "numeric" });
    const lo = d.temperature_2m_min[i], hi = d.temperature_2m_max[i];
    const left = ((lo - gMin) / span) * 100;
    const width = ((hi - lo) / span) * 100;
    const pop = d.precipitation_probability_max ? d.precipitation_probability_max[i] : null;
    const cond = describe(d.weather_code[i]).label;
    rows.push(`
      <div class="day-item">
        <div class="day" role="button" tabindex="0" aria-expanded="false">
          <div class="dname"><span class="dchev">›</span>${name}<span class="sub">${sub}</span><span class="dcond" title="${cond}">${cond}</span></div>
          ${icon(d.weather_code[i], 1)}
          <div class="barwrap">
            <span class="lo">${r0(lo)}°</span>
            <span class="track"><span class="fill" style="left:${left}%;width:${Math.max(6, width)}%"></span></span>
            <span class="hi">${r0(hi)}°</span>
          </div>
          <div class="meta">
            <span>${pop != null ? "💧 " + r0(pop) + "%" : ""}</span>
            <span>🌬 ${wv(d.wind_speed_10m_max[i])}</span>
            <span>☀ ${r0(d.uv_index_max[i])}</span>
          </div>
          ${precipBar(f, ds)}
        </div>
        ${dayDetail(f, i, ds)}
      </div>`);
  }
  $("days").innerHTML = rows.join("");

  if (!daysWired) {
    daysWired = true;
    const toggle = (head) => {
      const item = head.closest(".day-item");
      const det = item.querySelector(".day-detail");
      const open = item.classList.toggle("open");
      head.setAttribute("aria-expanded", open ? "true" : "false");
      if (det) det.hidden = !open;
    };
    $("days").addEventListener("click", (e) => {
      const head = e.target.closest(".day");
      if (head) toggle(head);
    });
    $("days").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const head = e.target.closest(".day");
      if (head) { e.preventDefault(); toggle(head); }
    });
  }
}

// --- Air quality ----------------------------------------------------------
function aqiCategory(aqi, european) {
  if (aqi == null) return { cat: "No data", color: "#888", desc: "" };
  if (european) {
    const t = [[20,"Good","#7ed957"],[40,"Fair","#b5e853"],[60,"Moderate","#ffd45e"],[80,"Poor","#ff8a5f"],[100,"Very poor","#ff5f5f"],[1e9,"Extremely poor","#a13be0"]];
    const m = t.find((x) => aqi <= x[0]);
    return { cat: m[1], color: m[2], desc: "European AQI scale (0–100+)." };
  }
  const t = [[50,"Good","#7ed957","Air quality is satisfactory; little or no risk."],
    [100,"Moderate","#ffd45e","Acceptable; unusually sensitive people should consider limiting prolonged exertion."],
    [150,"Unhealthy for sensitive","#ff8a5f","Sensitive groups may experience effects."],
    [200,"Unhealthy","#ff5f5f","Everyone may begin to experience effects."],
    [300,"Very unhealthy","#a13be0","Health alert: serious effects for everyone."],
    [1e9,"Hazardous","#7e1f1f","Emergency conditions; entire population affected."]];
  const m = t.find((x) => aqi <= x[0]);
  return { cat: m[1], color: m[2], desc: m[3] };
}

function renderAirQuality(air, googlePollen) {
  if (!air || !air.current) { $("aqiBody").innerHTML = `<p style="color:var(--muted)">No air-quality data for this location.</p>`; return; }
  const c = air.current, u = air.current_units || {};
  const useEU = c.us_aqi == null && c.european_aqi != null;
  const aqi = useEU ? c.european_aqi : c.us_aqi;
  const { cat, color, desc } = aqiCategory(aqi, useEU);
  const max = useEU ? 100 : 300;
  const pct = Math.min(1, (aqi || 0) / max);
  const circ = 2 * Math.PI * 52;

  const pollutants = [
    ["PM2.5", c.pm2_5, "µg/m³"], ["PM10", c.pm10, "µg/m³"],
    ["Ozone", c.ozone, "µg/m³"], ["NO₂", c.nitrogen_dioxide, "µg/m³"],
    ["SO₂", c.sulphur_dioxide, "µg/m³"], ["CO", c.carbon_monoxide, "µg/m³"],
  ].filter((p) => p[1] != null);

  const pollen = [
    ["Grass", c.grass_pollen], ["Birch", c.birch_pollen], ["Alder", c.alder_pollen],
    ["Ragweed", c.ragweed_pollen], ["Olive", c.olive_pollen], ["Mugwort", c.mugwort_pollen],
  ].filter((p) => p[1] != null && p[1] > 0);

  $("aqiBody").innerHTML = `
    <div class="aqi-head">
      <div class="aqi-dial">
        <svg viewBox="0 0 120 120" style="transform:rotate(-90deg)">
          <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="10"/>
          <circle cx="60" cy="60" r="52" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
            stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct)}"/>
        </svg>
        <div class="val"><div class="num" style="color:${color}">${r0(aqi)}</div><div class="lbl">${useEU ? "EU AQI" : "US AQI"}</div></div>
      </div>
      <div>
        <div class="aqi-cat" style="color:${color}">${cat}</div>
        <div class="aqi-desc">${desc}</div>
      </div>
    </div>
    <div class="pollutants">
      ${pollutants.map((p) => `<div class="poll"><div class="k">${p[0]}</div><div class="v">${r1(p[1])}</div><div class="u">${p[2]}</div></div>`).join("")}
    </div>
    ${pollenSection(googlePollen, pollen)}
  `;
}

// Global pollen (Google) when a key is configured, else the Europe-only
// values that come bundled in the air-quality response.
function pollenSection(google, europe) {
  if (google && google.enabled && google.types && google.types.length) {
    const cells = google.types.map((p) => {
      const col = p.color ? `rgb(${Math.round((p.color.red||0)*255)},${Math.round((p.color.green||0)*255)},${Math.round((p.color.blue||0)*255)})` : "var(--text)";
      return `<div class="poll"><div class="k">${p.name}</div><div class="v" style="color:${p.value ? col : 'var(--faint)'}">${p.value != null ? p.value : "–"}</div><div class="u">${p.category || (p.in_season ? "in season" : "off season")}</div></div>`;
    }).join("");
    return `<h2 style="margin-top:18px">Pollen <span style="font-weight:400;text-transform:none;letter-spacing:0">(Google, index 0–5)</span></h2><div class="pollutants">${cells}</div>`;
  }
  if (europe && europe.length) {
    return `<h2 style="margin-top:18px">Pollen <span style="font-weight:400;text-transform:none;letter-spacing:0">(grains/m³, Europe)</span></h2>
      <div class="pollutants">${europe.map((p) => `<div class="poll"><div class="k">${p[0]}</div><div class="v">${r0(p[1])}</div><div class="u">grains/m³</div></div>`).join("")}</div>`;
  }
  return "";
}

// Moon phase from date (synodic month from a known new moon).
function moonPhase(date) {
  const KNOWN_NEW = Date.UTC(2000, 0, 6, 18, 14) / 1000; // 2000-01-06 new moon
  const SYN = 29.530588853 * 86400;
  let age = (((date.getTime() / 1000) - KNOWN_NEW) % SYN + SYN) % SYN;
  const frac = age / SYN; // 0..1
  const illum = Math.round((1 - Math.cos(frac * 2 * Math.PI)) / 2 * 100);
  const phases = [
    [0.03, "New moon", "🌑"], [0.22, "Waxing crescent", "🌒"], [0.28, "First quarter", "🌓"],
    [0.47, "Waxing gibbous", "🌔"], [0.53, "Full moon", "🌕"], [0.72, "Waning gibbous", "🌖"],
    [0.78, "Last quarter", "🌗"], [0.97, "Waning crescent", "🌘"], [1.01, "New moon", "🌑"],
  ];
  const p = phases.find((x) => frac < x[0]) || phases[phases.length - 1];
  return { name: p[1], emoji: p[2], illum };
}

// --- Sun arc --------------------------------------------------------------
function renderSun(f) {
  const d = f.daily;
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: f.timezone });
  let i = d.time.indexOf(todayStr);
  if (i < 0) i = 1;
  const rise = new Date(d.sunrise[i]);
  const set = new Date(d.sunset[i]);
  const now = new Date();
  const t = (set - rise) > 0 ? Math.min(1, Math.max(0, (now - rise) / (set - rise))) : 0;
  const ax = 20 + t * 200;
  const ay = 100 - Math.sin(t * Math.PI) * 80;
  const fmt = (dt) => clk(dt);
  const dayLenMin = Math.round((set - rise) / 60000);
  const h = Math.floor(dayLenMin / 60), m = dayLenMin % 60;

  // Daylight change vs yesterday (index i-1, which exists because past_days=1).
  let deltaStr = "";
  if (i > 0 && d.sunrise[i - 1] && d.sunset[i - 1]) {
    const ySec = (new Date(d.sunset[i - 1]) - new Date(d.sunrise[i - 1])) / 1000;
    const tSec = (set - rise) / 1000;
    const diff = Math.round(tSec - ySec);
    const sign = diff >= 0 ? "+" : "−";
    const am = Math.abs(diff);
    deltaStr = `${sign}${Math.floor(am / 60)}m ${am % 60}s`;
  }
  // Golden hour ≈ within ~50 min of sunrise/sunset.
  const GH = 50 * 60000;
  const ghEve = `${fmt(new Date(set - GH))}–${fmt(set)}`;
  const moon = moonPhase(now);

  $("sunCard").innerHTML = `
    <svg class="sun-arc" viewBox="0 0 240 110">
      <defs><linearGradient id="ghg" x1="0" x2="1"><stop offset="0" stop-color="#ffd45e"/><stop offset="1" stop-color="#ff8a5f"/></linearGradient></defs>
      <path d="M20 100 A 100 100 0 0 1 220 100" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2" stroke-dasharray="4 5"/>
      <line x1="20" y1="100" x2="220" y2="100" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
      ${t > 0 && t < 1 ? `<circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="7" fill="url(#ghg)"/>
        <circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="13" fill="#ffd45e" opacity="0.22"/>` : ""}
    </svg>
    <div class="sun-times">
      <div><div class="k">Sunrise</div><div class="v">${fmt(rise)}</div></div>
      <div><div class="k">Sunset</div><div class="v">${fmt(set)}</div></div>
      <div><div class="k">Daylight</div><div class="v">${h}h ${m}m</div>${deltaStr ? `<div class="k" style="color:var(--accent)">${deltaStr} vs yest.</div>` : ""}</div>
    </div>
    <div class="sun-extra">
      <div><div class="k">🌇 Golden hour</div><div class="v2">${ghEve}</div></div>
      <div><div class="k">${moon.emoji} ${moon.name}</div><div class="v2">${moon.illum}% lit</div></div>
    </div>`;
}

// --- Islamic prayer times + Qibla -----------------------------------------
const PRAYER_META = [
  { key: "fajr",    name: "Fajr",    ar: "الفجر" },
  { key: "sunrise", name: "Sunrise", ar: "الشروق", sun: true },
  { key: "dhuhr",   name: "Dhuhr",   ar: "الظهر" },
  { key: "asr",     name: "Asr",     ar: "العصر" },
  { key: "maghrib", name: "Maghrib", ar: "المغرب" },
  { key: "isha",    name: "Isha",    ar: "العشاء" },
];

// Decimal local-clock hours → a localized "h:mm" honoring the 12/24h setting.
function prayerClock(hours) {
  if (hours == null) return "—";
  let H = Math.floor(hours), M = Math.round((hours - H) * 60);
  if (M === 60) { M = 0; H = (H + 1) % 24; }
  return clk(new Date(2000, 0, 1, H, M), true);
}
// Absolute epoch-ms for a local-clock `hours` on calendar date y/mo/da.
function prayerInstant(y, mo, da, hours, tzOffset) {
  return Date.UTC(y, mo - 1, da, 0, 0, 0) + (hours - tzOffset) * 3600000;
}
function fmtPrayerCountdown(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

// Toggle Sun card ↔ Prayer card based on the setting.
function applyPrayerVisibility() {
  $("sunSection")?.classList.toggle("hidden", state.prayer);
  $("praySection")?.classList.toggle("hidden", !state.prayer);
}

function renderPrayer(f) {
  const card = $("prayerCard");
  if (!card) return;
  const place = state.place;
  if (!place || !f) return;
  const tzOffset = (f.utc_offset_seconds || 0) / 3600;
  // Location-local "now" (read UTC fields off a shifted Date = local wall-clock).
  const localNow = new Date(Date.now() + tzOffset * 3600000);
  const y = localNow.getUTCFullYear(), mo = localNow.getUTCMonth() + 1, da = localNow.getUTCDate();
  const methodKey = methodForCountry(place.country_code);
  const t = prayerTimes({ year: y, month: mo, day: da, lat: place.lat, lon: place.lon,
    tzOffset, method: methodKey, asr: "standard" });

  // Current & next prayer. Handles past-midnight wrap AND the sunrise gap:
  // Fajr ends at sunrise, so between sunrise and Dhuhr there is no active
  // prayer (cn.current is null / cn.gap is true) — we must not show "Fajr" then.
  const now = Date.now();
  const cn = currentAndNext(t, now, { y, mo, da }, tzOffset);
  const curKey = cn.current, nextKey = cn.next, nextAt = cn.nextAt;
  if (!nextKey) { card.innerHTML = ""; return; }  // polar day/night: no usable times
  // Per-row "passed" styling still uses today's instants.
  const inst = {};
  ["fajr", "dhuhr", "asr", "maghrib", "isha"].forEach((k) => {
    inst[k] = t[k] == null ? null : prayerInstant(y, mo, da, t[k], tzOffset);
  });
  const meta = (k) => PRAYER_META.find((p) => p.key === k);
  const cur = curKey ? meta(curKey) : null;   // null during the sunrise→Dhuhr gap
  const nxt = meta(nextKey);
  const countdown = fmtPrayerCountdown(nextAt - now);
  const qb = qiblaBearing(place.lat, place.lon);
  const qd = qiblaDistanceKm(place.lat, place.lon);

  const rows = PRAYER_META.map((p) => {
    let cls = "pray-row";
    if (p.sun) cls += " sun";
    else if (p.key === curKey) cls += " now-row";
    else if (p.key === nextKey) cls += " next-row";
    else if (inst[p.key] != null && inst[p.key] < now) cls += " passed";
    const tag = (!p.sun && p.key === curKey) ? `<span class="pray-tag now">now</span>`
      : (!p.sun && p.key === nextKey) ? `<span class="pray-tag next">next</span>` : "";
    return `<div class="${cls}"><span class="pray-dot"></span>` +
      `<span class="pray-nm">${p.name}<span class="pray-ar">${p.ar}</span>${tag}</span>` +
      `<span class="pray-tm">${prayerClock(t[p.key])}</span></div>`;
  }).join("");

  // Sun/moon strip (folded in from the Sun card).
  const d = f.daily;
  let si = d.time.indexOf(localNow.toISOString().slice(0, 10)); if (si < 0) si = 1;
  const rise = d.sunrise && d.sunrise[si] ? new Date(d.sunrise[si]) : null;
  const set = d.sunset && d.sunset[si] ? new Date(d.sunset[si]) : null;
  let dayLen = "—";
  if (rise && set) { const mn = Math.round((set - rise) / 60000); dayLen = `${Math.floor(mn / 60)}h ${mn % 60}m`; }
  const moon = moonPhase(new Date());

  card.className = "pray" + (state.prayerOpen ? " open" : "");
  card.innerHTML = `
    <div class="pray-head">
      <span class="pray-title">🕌 Prayer times</span>
      <span class="pray-method">${t.methodLabel} · auto<br>Standard Asr</span>
    </div>
    <div class="pray-summary" id="praySummary">
      ${cur
        ? `<div class="pray-cell now"><div class="k">🟢 Now</div><div class="nm">${cur.name} <span class="ar">${cur.ar}</span></div><div class="tm">since ${prayerClock(t[curKey])}</div></div>`
        : `<div class="pray-cell now gap"><div class="k">☀️ Now</div><div class="nm">No prayer</div><div class="tm">Fajr ended at sunrise ${prayerClock(t.sunrise)}</div></div>`}
      <div class="pray-cell next"><div class="k">Up next</div><div class="nm">${nxt.name} <span class="ar">${nxt.ar}</span></div><div class="tm">${prayerClock(t[nextKey])} · in ${countdown}</div></div>
      <div class="pray-chev">⌄</div>
    </div>
    <div class="pray-hint">tap for all times, Qibla &amp; sun ⌄</div>
    <div class="pray-more">
      <div class="pray-rows">${rows}</div>
      <div class="pray-qibla">
        <svg width="104" height="104" viewBox="0 0 104 104" class="qdial" aria-label="Qibla compass">
          <g id="qiblaRing">
            <circle cx="52" cy="52" r="48" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/>
            <circle cx="52" cy="52" r="40" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
            <g stroke="rgba(255,255,255,0.25)" stroke-width="1.5">
              <line x1="52" y1="6" x2="52" y2="14"/><line x1="52" y1="90" x2="52" y2="98"/>
              <line x1="6" y1="52" x2="14" y2="52"/><line x1="90" y1="52" x2="98" y2="52"/></g>
            <text x="52" y="20" fill="rgba(238,242,251,0.6)" font-size="10" font-weight="700" text-anchor="middle">N</text>
            <text x="52" y="98" fill="rgba(238,242,251,0.38)" font-size="9" text-anchor="middle">S</text>
            <text x="96" y="55" fill="rgba(238,242,251,0.38)" font-size="9" text-anchor="middle">E</text>
            <text x="9" y="55" fill="rgba(238,242,251,0.38)" font-size="9" text-anchor="middle">W</text>
          </g>
          <g id="qiblaNeedle" transform="rotate(${qb.toFixed(1)} 52 52)">
            <line x1="52" y1="52" x2="52" y2="17" stroke="var(--amber)" stroke-width="3" stroke-linecap="round"/>
            <circle cx="52" cy="17" r="7" fill="var(--amber)"/>
            <text x="52" y="20.5" font-size="9" text-anchor="middle">🕋</text>
          </g>
          <circle cx="52" cy="52" r="4" fill="var(--text)"/>
        </svg>
        <div class="qmeta">
          <div class="k">Qibla direction</div>
          <div class="v">${Math.round(qb)}° <span class="dir">${compass16(qb)}</span></div>
          <div class="x">Toward Makkah · ${qd.toLocaleString()} km</div>
          <button class="pray-live" id="qiblaLive">🧭 Tap for live compass</button>
        </div>
      </div>
      <div class="pray-sun">
        <div class="ss"><div class="k">Sunrise</div><div class="v">${rise ? clk(rise) : "—"}</div></div>
        <div class="ss"><div class="k">Sunset</div><div class="v">${set ? clk(set) : "—"}</div></div>
        <div class="ss"><div class="k">Day length</div><div class="v">${dayLen}</div></div>
        <div class="ss"><div class="k">Moon</div><div class="v">${moon.emoji} <small>${moon.illum}%</small></div></div>
      </div>
    </div>`;

  $("praySummary").onclick = () => {
    state.prayerOpen = !state.prayerOpen;
    localStorage.setItem("prayerOpen", state.prayerOpen ? "1" : "0");
    card.classList.toggle("open", state.prayerOpen);
  };
  const liveBtn = $("qiblaLive");
  if (liveBtn) liveBtn.onclick = (e) => { e.stopPropagation(); startLiveCompass(liveBtn, qb); };
}

// Live Qibla compass via DeviceOrientation. iOS needs a permission tap
// (granted to THIS origin only); Android/desktop stream events on HTTPS with
// no prompt. Heading source differs: iOS exposes webkitCompassHeading (true
// north); Android uses the absolute-orientation alpha.
let qiblaLiveOn = false;
function startLiveCompass(btn, qiblaDeg) {
  const apply = (heading) => {
    if (heading == null || isNaN(heading)) return;
    const needle = $("qiblaNeedle"), ring = $("qiblaRing");
    if (needle) needle.setAttribute("transform", `rotate(${(qiblaDeg - heading).toFixed(1)} 52 52)`);
    if (ring) ring.setAttribute("transform", `rotate(${(-heading).toFixed(1)} 52 52)`);
  };
  const onOrient = (e) => {
    if (typeof e.webkitCompassHeading === "number") apply(e.webkitCompassHeading);
    else if (typeof e.alpha === "number") apply(360 - e.alpha);
  };
  const begin = () => {
    if (qiblaLiveOn) return;
    qiblaLiveOn = true;
    window.addEventListener("deviceorientationabsolute", onOrient, true);
    window.addEventListener("deviceorientation", onOrient, true);
    btn.textContent = "🧭 Live · point your phone";
    btn.classList.add("on");
  };
  if (typeof DeviceOrientationEvent === "undefined") {
    btn.textContent = "🧭 No compass on this device";
  } else if (typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission()
      .then((s) => { s === "granted" ? begin() : (btn.textContent = "🧭 Motion access denied"); })
      .catch(() => { btn.textContent = "🧭 Compass unavailable"; });
  } else {
    begin();
  }
}

// --- Lifestyle / activity indices -----------------------------------------
// Each index is a weighted blend of factors computed from data we already have.
function renderLifestyle(f, air) {
  const body = $("lifestyleBody");
  if (!body) return;
  const c = f.current, d = f.daily;
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: f.timezone });
  let di = d.time.indexOf(todayStr); if (di < 0) di = 1;
  const imp = state.units === "imperial";
  const feels = c.apparent_temperature, rh = c.relative_humidity_2m, cloud = c.cloud_cover != null ? c.cloud_cover : 50;
  const windMs = (c.wind_speed_10m || 0) * (WIND_TO_MS[fetchedWind()] || WIND_TO_MS.mph);
  const precipNow = c.precipitation || 0;
  const pop = d.precipitation_probability_max ? (d.precipitation_probability_max[di] || 0) : 0;
  const uvMax = d.uv_index_max ? (d.uv_index_max[di] || 0) : 0;
  const aq = (air && air.current) || {};
  const aqiEU = aq.us_aqi == null && aq.european_aqi != null;
  const aqi = aq.us_aqi != null ? aq.us_aqi : (aq.european_aqi != null ? aq.european_aqi : 0);
  const visM = c.visibility != null ? c.visibility : hourlyNow(f, "visibility");
  const cl = (x) => Math.max(0, Math.min(1, x));

  const F = {
    tempComfort: feels == null ? 0.7 : cl(1 - Math.abs(feels - (imp ? 68 : 20)) / (imp ? 24 : 13)),
    warmth: feels == null ? 0.5 : cl((feels - (imp ? 68 : 20)) / (imp ? 17 : 9)),
    clear: cl(1 - cloud / 100),
    dry: precipNow > 0 ? cl(1 - precipNow / (imp ? 0.1 : 2.5)) : 1,
    lowpop: cl(1 - pop / 100),
    calm: windMs <= 2 ? 1 : cl(1 - (windMs - 2) / 9),
    breeze: cl(windMs / 4),
    aqi: aqiEU ? cl(1 - aqi / 80) : cl(1 - aqi / 150),
    uvSafe: cl(1 - (uvMax - 2) / 8),
    humLow: cl(1 - (rh - 40) / 50),
    vis: visM != null ? cl(visM / 16000) : 0.8,
    noIce: feels == null ? 1 : feels > (imp ? 34 : 1) ? 1 : feels < (imp ? 28 : -2) ? 0 : cl((feels - (imp ? 28 : -2)) / (imp ? 6 : 3)),
    moon: cl(1 - moonPhase(new Date()).illum / 100),
  };
  const PH = { clear: "clouds", warmth: "cool temps", dry: "rain", lowpop: "rain chance", calm: "wind",
    aqi: "air quality", uvSafe: "strong UV", humLow: "humidity", breeze: "still air", vis: "low visibility",
    noIce: "icy risk", moon: "bright moon", tempComfort: "temperature" };

  const INDICES = [
    { name: "Stargazing", emoji: "🔭", sub: "tonight", fac: [["clear", 0.45], ["moon", 0.25], ["aqi", 0.15], ["dry", 0.15]] },
    { name: "Running", emoji: "🏃", sub: "now", fac: [["tempComfort", 0.35], ["lowpop", 0.2], ["aqi", 0.2], ["calm", 0.15], ["uvSafe", 0.1]] },
    { name: "Beach", emoji: "🏖️", sub: "today", fac: [["warmth", 0.3], ["clear", 0.25], ["lowpop", 0.25], ["calm", 0.2]] },
    { name: "Gardening", emoji: "🪴", sub: "now", fac: [["tempComfort", 0.4], ["dry", 0.25], ["calm", 0.2], ["aqi", 0.15]] },
    { name: "Line-dry", emoji: "🧺", sub: "laundry", fac: [["lowpop", 0.4], ["humLow", 0.3], ["breeze", 0.15], ["clear", 0.15]] },
    { name: "Commute", emoji: "🚗", sub: "now", fac: [["vis", 0.3], ["dry", 0.3], ["calm", 0.2], ["noIce", 0.2]] },
  ];
  const tierOf = (s) => s >= 78 ? { t: "Great", c: "#7ed957" } : s >= 55 ? { t: "Good", c: "#a3e635" }
    : s >= 30 ? { t: "Fair", c: "#ffd45e" } : { t: "Poor", c: "#ff8a5f" };

  body.innerHTML = INDICES.map((ix) => {
    let sum = 0, wsum = 0, worst = null;
    ix.fac.forEach(([k, w]) => { const v = F[k]; sum += v * w; wsum += w; if (!worst || v < worst.v) worst = { k, v }; });
    const score = Math.round(100 * sum / wsum);
    const tier = tierOf(score);
    const reason = score >= 78 ? "Excellent conditions" : `Held back by ${PH[worst.k] || worst.k}`;
    return `<div class="life" title="${ix.name} (${ix.sub}): ${reason}">
      <div class="life-top"><span class="life-emoji">${ix.emoji}</span><span class="life-score" style="color:${tier.c}">${score}</span></div>
      <div class="life-name">${ix.name}<span class="life-sub">${ix.sub}</span></div>
      <div class="life-bar"><i style="width:${score}%;background:${tier.c}"></i></div>
      <div class="life-reason"><b style="color:${tier.c}">${tier.t}</b> · ${reason}</div>
    </div>`;
  }).join("");
}

// --- Marine conditions ----------------------------------------------------
function renderMarine(marine) {
  const card = $("marineCard");
  if (!card) return;
  if (!marine || !marine.available || !marine.current) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  const c = marine.current, u = marine.units || {};
  const imp = state.units === "imperial";
  const toLen = (m) => m == null ? "–" : imp ? `${r1(m * 3.281)} <span class="x">ft</span>` : `${r1(m)} <span class="x">m</span>`;
  const tiles = [
    { k: "Wave height", v: toLen(c.wave_height), x: c.wave_direction != null ? `${compass(c.wave_direction)} · ${r0(c.wave_period)}s` : "" },
    { k: "Swell", v: toLen(c.swell_wave_height), x: c.swell_wave_period != null ? `period ${r0(c.swell_wave_period)}s` : "" },
    { k: "Wind waves", v: toLen(c.wind_wave_height), x: "" },
    { k: "Sea temp", v: c.sea_surface_temperature != null ? `${r0(c.sea_surface_temperature)}<span class="x">${tempU()}</span>` : "–", x: "surface" },
  ];
  $("marineBody").innerHTML = tiles.map((t) =>
    `<div class="tile"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="x">${t.x}</div></div>`).join("");
}

// --- Alerts ---------------------------------------------------------------
function renderAlerts(alerts) {
  const box = $("alerts");
  if (!alerts || !alerts.length) { box.innerHTML = ""; return; }
  box.innerHTML = alerts.map((a) => `
    <div class="alert ${a.severity || ""} fade-in">
      <div class="ev">⚠ ${a.event}${a.severity ? ` · ${a.severity}` : ""}</div>
      <div class="hl">${a.headline || ""}</div>
      ${a.description ? `<details><summary>Details${a.expires ? ` · until ${new Date(a.expires).toLocaleString()}` : ""}</summary>
        <div class="desc">${(a.description || "").trim()}${a.instruction ? "\n\nINSTRUCTIONS:\n" + a.instruction.trim() : ""}</div></details>` : ""}
    </div>`).join("");
}

// --- Nowcast banner (next ~2h precipitation) ------------------------------
function renderNowcast(f) {
  const box = $("nowcast");
  const m = f.minutely_15;
  if (!m || !m.precipitation || !m.time) { box.classList.add("hidden"); return; }
  const now = Date.now();
  let i0 = m.time.findIndex((t) => new Date(t).getTime() >= now);
  if (i0 < 0) { box.classList.add("hidden"); return; }
  const thr = state.units === "imperial" ? 0.004 : 0.1; // ~trace, per step
  const horizon = 8; // 8 × 15min = 2h
  const steps = [];
  for (let i = i0; i < Math.min(m.time.length, i0 + horizon + 1); i++) {
    steps.push({ t: new Date(m.time[i]).getTime(), p: m.precipitation[i] });
  }
  const wet = (p) => p != null && p > thr;
  const nowWet = wet(steps[0].p);
  let trans = null;
  for (let k = 1; k < steps.length; k++) {
    if (wet(steps[k].p) !== nowWet) { trans = steps[k]; break; }
  }
  const mins = (t) => Math.max(0, Math.round((t - now) / 60000 / 5) * 5);
  const peak = Math.max(...steps.map((s) => s.p || 0));
  const intensity = peak > (state.units === "imperial" ? 0.1 : 2.5) ? "heavy"
    : peak > (state.units === "imperial" ? 0.02 : 0.5) ? "moderate" : "light";

  let icon = "🌦️", cls = "nowcast", title = "", sub = "";
  if (nowWet && trans) {
    icon = "🌧️"; const mm = mins(trans.t);
    title = mm <= 5 ? "Rain stopping shortly" : `Rain easing in ~${mm} min`;
    sub = "Then dry for a while.";
  } else if (nowWet && !trans) {
    icon = "🌧️"; title = `${intensity[0].toUpperCase() + intensity.slice(1)} rain continuing`;
    sub = "Expected to keep up over the next 2 hours.";
  } else if (!nowWet && trans) {
    icon = "🌦️"; const mm = mins(trans.t);
    title = mm <= 5 ? "Rain starting any minute" : `Rain starting in ~${mm} min`;
    sub = `${intensity[0].toUpperCase() + intensity.slice(1)} precipitation moving in.`;
  } else {
    icon = "☀️"; cls = "nowcast dry"; title = "No rain in the next 2 hours";
    sub = "Skies look clear of precipitation for now.";
  }
  box.className = cls;
  box.innerHTML = `<div class="nc-main"><span class="nc-icon">${icon}</span>` +
    `<span>${title}<br><span class="nc-sub">${sub}</span></span></div>` +
    minutecastGraph(steps, thr);
}

// Minutecast: a small bar chart of precipitation over the next ~2 hours
// (Open-Meteo 15-min data). Only shown when precip is actually in the window.
function minutecastGraph(steps, thr) {
  if (!steps || steps.length < 2) return "";
  const peak = Math.max(...steps.map((s) => s.p || 0));
  if (peak <= thr) return ""; // dry — the banner already says "all clear"
  const imp = state.units === "imperial";
  const W = 300, H = 48, base = H - 12, pad = 3;
  const n = steps.length, bw = (W - pad * 2) / n;
  const scale = Math.max(peak, thr * 5);
  const heavy = imp ? 0.1 : 2.5, moderate = imp ? 0.02 : 0.5;
  const bars = steps.map((s, k) => {
    const p = s.p || 0;
    const h = p > thr ? Math.max(2.5, (p / scale) * base) : 0;
    const x = pad + k * bw;
    const col = p > heavy ? "#ff6b6b" : p > moderate ? "#ffd45e" : "#5fa8ff";
    return `<rect x="${(x + 1).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${col}"><title>${clk(new Date(s.t))} · ${r1(p)} ${precU()}</title></rect>`;
  }).join("");
  return `<div class="nc-graph">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Precipitation, next 2 hours">
      <line x1="${pad}" y1="${base}" x2="${W - pad}" y2="${base}" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>
      ${bars}
    </svg>
    <div class="nc-graph-x"><span>Now</span><span>+1h</span><span>+2h</span></div>
  </div>`;
}

// --- Activity outlook (plain-language hint for the next few hours) ---------
// A single, human-readable "what should I do" read derived from the hourly
// forecast window — e.g. "Rain likely around 3 PM — a good window for indoor
// plans" or "Clear and mild for the next few hours — perfect for a walk."
// Surfaced as a prominent banner (most useful on mobile, where the index grid
// is far down the page).
const WMO_WET = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82);
const WMO_SNOW = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
const WMO_STORM = (c) => c >= 95;

function renderActivityHint(f) {
  const box = $("activityHint");
  if (!box) return;
  const h = f.hourly;
  if (!h || !h.time || !h.time.length) { box.classList.add("hidden"); return; }
  const now = Date.now();
  let i0 = h.time.findIndex((t) => new Date(t).getTime() >= now - 30 * 60000);
  if (i0 < 0) i0 = 0;
  const HORIZON = 6; // hours ahead to characterize
  const wmul = WIND_TO_MS[fetchedWind()] || WIND_TO_MS.mph;
  const win = [];
  for (let i = i0; i < Math.min(h.time.length, i0 + HORIZON); i++) {
    win.push({
      t: new Date(h.time[i]).getTime(),
      pop: h.precipitation_probability ? (h.precipitation_probability[i] || 0) : 0,
      precip: h.precipitation ? (h.precipitation[i] || 0) : 0,
      code: h.weather_code ? h.weather_code[i] : 0,
      feels: h.apparent_temperature ? h.apparent_temperature[i]
        : (h.temperature_2m ? h.temperature_2m[i] : null),
      uv: h.uv_index ? (h.uv_index[i] || 0) : 0,
      wind: (h.wind_speed_10m ? (h.wind_speed_10m[i] || 0) : 0) * wmul,
      day: h.is_day ? h.is_day[i] === 1 : true,
    });
  }
  if (!win.length) { box.classList.add("hidden"); return; }
  const out = activityOutlook(win, state.units === "imperial");
  box.className = `activity-hint ${out.tone}`;
  box.innerHTML = `<span class="ah-icon" aria-hidden="true">${out.emoji}</span>` +
    `<span class="ah-text"><b>${out.title}</b>` +
    (out.detail ? `<span class="ah-sub">${out.detail}</span>` : "") + `</span>`;
}

// Pure decision cascade: given a window of hourly samples (and the unit system)
// return { emoji, title, detail, tone }. Ordered most-actionable first.
function activityOutlook(win, imp) {
  const at = (t) => clk(new Date(t), false);
  const wetTrace = imp ? 0.004 : 0.1;               // ~trace precip, per hour
  const hotT = imp ? 90 : 32, coldT = imp ? 36 : 2; // feels-like thresholds
  const windHi = 9, uvHi = 6;                       // m/s (~20 mph), UV index
  const isWet = (s) => WMO_WET(s.code) || WMO_SNOW(s.code) || WMO_STORM(s.code)
    || s.pop >= 55 || s.precip > wetTrace;

  const firstWet = win.find(isWet);
  const nowWet = isWet(win[0]);
  let run = 0; while (run < win.length && isWet(win[run])) run++;  // wet hours from now
  const clearsWithin = nowWet && run < win.length;
  const stormy = win.some((s) => WMO_STORM(s.code));
  const snowy = win.some((s) => WMO_SNOW(s.code)
    || (s.precip > wetTrace && s.feels != null && s.feels <= (imp ? 34 : 1)));
  const maxPop = Math.max(...win.map((s) => s.pop));
  const maxUV = Math.max(...win.map((s) => s.uv));
  const maxWind = Math.max(...win.map((s) => s.wind));
  const feelsVals = win.map((s) => s.feels).filter((v) => v != null);
  const feelsMax = feelsVals.length ? Math.max(...feelsVals) : null;
  const dayMost = win.filter((s) => s.day).length >= win.length / 2;
  const hrs = (n) => `${n} ${n === 1 ? "hour" : "hours"}`;

  // 1) Thunderstorms — strongest signal, keep people in.
  if (stormy) {
    const s = win.find((x) => WMO_STORM(x.code));
    return { emoji: "⛈️", tone: "ah-bad",
      title: `Thunderstorms ${nowWet ? "right now" : `likely around ${at(s.t)}`} — keep plans indoors`,
      detail: "Best to hold off on anything outdoors until the storms pass." };
  }
  // 2) Snow
  if (snowy) {
    const s = win.find((x) => WMO_SNOW(x.code)) || firstWet;
    return { emoji: "🌨️", tone: "ah-cool",
      title: nowWet ? "Snow falling — a cozy day for indoor plans"
                    : `Snow likely around ${at(s.t)}`,
      detail: "Roads may be slick; bundle up well if you head out." };
  }
  // 3) Raining now
  if (nowWet) {
    if (clearsWithin) {
      return { emoji: "🌧️", tone: "ah-wet",
        title: `Wet now, easing around ${at(win[run].t)}`,
        detail: "Good window for indoor activities — it opens up for outdoor plans after that." };
    }
    return { emoji: "🌧️", tone: "ah-wet",
      title: `Wet for the next ${hrs(run)}`,
      detail: "A good stretch for indoor plans — errands, a café, or a workout inside." };
  }
  // 4) Dry now, rain coming later in the window
  if (firstWet) {
    return { emoji: "🌦️", tone: "ah-wet",
      title: `Dry for now — rain likely around ${at(firstWet.t)}`,
      detail: "Get outdoor plans in early, then keep an indoor backup ready." };
  }
  if (maxPop >= 35) {
    return { emoji: "🌥️", tone: "ah-neutral",
      title: "Mostly dry, with a chance of showers",
      detail: "Outdoor plans should be fine — maybe pack a backup just in case." };
  }
  // 5) Dry window — characterize comfort.
  if (feelsMax != null && feelsMax >= hotT && maxUV >= uvHi) {
    return { emoji: "🥵", tone: "ah-hot",
      title: "Hot with strong sun for the next few hours",
      detail: "Head out early or toward evening, hydrate, and wear sunscreen." };
  }
  if (feelsMax != null && feelsMax <= coldT) {
    return { emoji: "🧥", tone: "ah-cool",
      title: "Cold for the next few hours",
      detail: "Bundle up well for anything outdoors — or keep it indoors." };
  }
  if (maxWind >= windHi) {
    return { emoji: "🌬️", tone: "ah-neutral",
      title: "Breezy for a while",
      detail: "Fine for a brisk walk; less ideal for cycling, the beach, or umbrellas." };
  }
  if (!dayMost) {
    return { emoji: "🌙", tone: "ah-good",
      title: "Clear and calm this evening",
      detail: `Nice for a stroll${maxUV < 1 ? " or a bit of stargazing." : "."}` };
  }
  // Pleasant daytime
  return { emoji: "😎", tone: "ah-good",
    title: "Great few hours for outdoor plans",
    detail: "Comfortable and dry — perfect for a walk, a run, or time outside."
      + (maxUV >= uvHi ? " Grab sunscreen if you'll be out a while." : "") };
}

// --- Historical reference -------------------------------------------------
async function loadHistory(place, todayHigh, todayLow) {
  const sum = $("historySummary");
  sum.innerHTML = `<div class="hstat"><div class="k">Historical</div><div class="x">Loading climate reference…</div></div>`;
  try {
    const res = await fetch(`/api/history?lat=${place.lat}&lon=${place.lon}&units=${state.units}`);
    const h = await res.json();
    if (h.error || !h.normals) throw new Error("no data");
    renderHistory(h, todayHigh, todayLow);
  } catch (e) {
    sum.innerHTML = `<div class="hstat"><div class="k">Historical</div><div class="x">Reference data unavailable for this location.</div></div>`;
    if (histChart) { histChart.destroy(); histChart = null; }
  }
}

function renderHistory(h, todayHigh, todayLow) {
  const n = h.normals;
  $("historySub").textContent = `${n.years}-yr climate normal`;
  const delta = (todayHigh != null && n.high != null) ? todayHigh - n.high : null;
  const dCls = delta == null ? "" : delta >= 0.5 ? "delta-warm" : delta <= -0.5 ? "delta-cool" : "";
  const dTxt = delta == null ? "–" : `${delta >= 0 ? "+" : ""}${r0(delta)}°`;
  $("historySummary").innerHTML = `
    <div class="hstat"><div class="k">Normal high / low</div><div class="v">${r0(n.high)}° / ${r0(n.low)}°</div><div class="x">avg for this date</div></div>
    <div class="hstat ${dCls}"><div class="k">Today vs normal</div><div class="v">${dTxt}</div><div class="x">${delta == null ? "" : delta >= 0.5 ? "warmer than usual" : delta <= -0.5 ? "cooler than usual" : "right about normal"}</div></div>
    <div class="hstat"><div class="k">Record high</div><div class="v">${r0(n.record_high)}°</div><div class="x">set ${n.record_high_year || "–"}</div></div>
    <div class="hstat"><div class="k">Record low</div><div class="v">${r0(n.record_low)}°</div><div class="x">set ${n.record_low_year || "–"}</div></div>`;

  // "This day in history" facts line.
  const facts = [];
  if (n.last_year_high != null) facts.push(`One year ago today it reached <b>${r0(n.last_year_high)}°</b> / ${r0(n.last_year_low)}°.`);
  if (n.record_high != null) facts.push(`The hottest this date ever got was <b>${r0(n.record_high)}°</b> in ${n.record_high_year}.`);
  if (n.wettest != null && n.wettest > 0) facts.push(`Wettest on record: <b>${r1(n.wettest)} ${precU()}</b> (${n.wettest_year}).`);
  const factsEl = $("historyFacts");
  if (factsEl) factsEl.innerHTML = facts.length ? `📅 ${facts.join(" ")}` : "";

  const rec = h.recent;
  const labels = rec.time.map((t) => new Date(t + "T12:00:00").toLocaleDateString(LOCALE(), { month: "short", day: "numeric" }));
  const ctx = $("historyChart").getContext("2d");
  if (histChart) histChart.destroy();
  const nHigh = rec.time.map(() => n.high);
  const nLow = rec.time.map(() => n.low);
  histChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type: "line", label: "High", data: rec.tmax, borderColor: "#ff8a5f", backgroundColor: "rgba(255,138,95,0.08)", fill: false, tension: 0.35, pointRadius: 0, borderWidth: 2.5 },
        { type: "line", label: "Low", data: rec.tmin, borderColor: "#6fb7ff", backgroundColor: "rgba(111,183,255,0.08)", fill: false, tension: 0.35, pointRadius: 0, borderWidth: 2.5 },
        { type: "line", label: "Normal high", data: nHigh, borderColor: "rgba(255,138,95,0.5)", borderDash: [5, 5], pointRadius: 0, borderWidth: 1.5 },
        { type: "line", label: "Normal low", data: nLow, borderColor: "rgba(111,183,255,0.5)", borderDash: [5, 5], pointRadius: 0, borderWidth: 1.5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { color: "rgba(238,242,251,0.6)", boxWidth: 12, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${r0(c.raw)}${tempU()}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "rgba(238,242,251,0.5)", maxTicksLimit: 10 } },
        y: { grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "rgba(238,242,251,0.5)", callback: (v) => `${v}°` } },
      },
    },
  });
}

// --- Rain overlay ---------------------------------------------------------
function toggleRain(on) {
  const fx = $("rainFx");
  if (on && !fx.dataset.built) {
    let html = "";
    for (let i = 0; i < 60; i++) {
      const left = Math.random() * 100;
      const dur = 0.6 + Math.random() * 0.8;
      const delay = Math.random() * 2;
      html += `<i style="left:${left}%;animation-duration:${dur}s;animation-delay:${delay}s"></i>`;
    }
    fx.innerHTML = html;
    fx.dataset.built = "1";
  }
  fx.classList.toggle("on", on);
}

// --- Favorites (saved locations) ------------------------------------------
const placeKey = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;

function isFavorite(p) {
  return state.favorites.some((q) => placeKey(q) === placeKey(p));
}

function toggleFavorite() {
  if (!state.place) return;
  const k = placeKey(state.place);
  if (isFavorite(state.place)) {
    state.favorites = state.favorites.filter((q) => placeKey(q) !== k);
  } else {
    state.favorites.push({
      name: state.place.name, admin1: state.place.admin1, country: state.place.country,
      country_code: state.place.country_code, lat: state.place.lat, lon: state.place.lon,
    });
  }
  localStorage.setItem("favorites", JSON.stringify(state.favorites));
  renderFavorites();
}

// Cache of each favorite's current conditions (so chips can show live temps
// without hammering the API). Keyed by place; 10-min TTL.
const favCache = new Map();
async function favData(p) {
  const k = placeKey(p);
  const c = favCache.get(k);
  if (c && Date.now() - c.t < 600000) return c;
  try {
    const r = await fetch(`/api/weather?lat=${p.lat}&lon=${p.lon}&units=${state.units}&compact=1`);
    const d = await r.json();
    const cur = (d.forecast && d.forecast.current) || {};
    const v = { t: Date.now(), temp: cur.temperature_2m, code: cur.weather_code, day: cur.is_day != null ? cur.is_day : 1 };
    favCache.set(k, v);
    return v;
  } catch (e) { return null; }
}

function renderFavorites() {
  const bar = $("favBar");
  if (!bar) return;
  const star = $("starBtn");
  if (star) {
    const on = state.place && isFavorite(state.place);
    star.textContent = on ? "★" : "☆";
    star.classList.toggle("active", !!on);
    star.title = on ? "Remove from favorites" : "Save this location";
  }
  bar.innerHTML = state.favorites.map((p, i) => {
    const active = state.place && placeKey(p) === placeKey(state.place);
    return `<button class="fav-chip ${active ? "active" : ""}" data-i="${i}" draggable="true">` +
      `<span class="fav-ico"></span><span class="fav-name">${p.name}</span>` +
      `<span class="fav-temp"></span><span class="fav-x" data-x="${i}" title="Remove">×</span></button>`;
  }).join("");

  bar.querySelectorAll(".fav-chip").forEach((b) => {
    const i = +b.dataset.i;
    b.onclick = (e) => {
      if (e.target.classList.contains("fav-x")) {
        state.favorites.splice(+e.target.dataset.x, 1);
        localStorage.setItem("favorites", JSON.stringify(state.favorites));
        renderFavorites();
      } else {
        loadWeather(state.favorites[i]);
      }
    };
    // Drag-to-reorder (desktop). Touch falls back to tap-to-open.
    b.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", String(i)); b.classList.add("dragging"); });
    b.addEventListener("dragend", () => b.classList.remove("dragging"));
    b.addEventListener("dragover", (e) => e.preventDefault());
    b.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = +e.dataTransfer.getData("text/plain"), to = i;
      if (from === to || isNaN(from)) return;
      const arr = state.favorites;
      arr.splice(to, 0, arr.splice(from, 1)[0]);
      localStorage.setItem("favorites", JSON.stringify(arr));
      renderFavorites();
    });
    // Fill live temperature + icon asynchronously.
    favData(state.favorites[i]).then((v) => {
      if (!v) return;
      const t = b.querySelector(".fav-temp"), ic = b.querySelector(".fav-ico");
      if (t && v.temp != null) t.textContent = `${r0(v.temp)}°`;
      if (ic && v.code != null) ic.innerHTML = icon(v.code, v.day);
    });
  });
  bar.classList.toggle("hidden", state.favorites.length === 0);
}

// --- Settings panel -------------------------------------------------------
const SEGMENTS = {
  units: [["imperial", "°F"], ["metric", "°C"]],
  themeMode: [["auto", "Auto"], ["dark", "Dark"], ["light", "Light"]],
  timeFormat: [["auto", "Auto"], ["12", "12-hour"], ["24", "24-hour"]],
  windUnit: [["auto", "Auto"], ["mph", "mph"], ["kmh", "km/h"], ["ms", "m/s"], ["kn", "kn"]],
  pressureUnit: [["auto", "Auto"], ["hPa", "hPa"], ["inHg", "inHg"], ["mmHg", "mmHg"]],
};

function seg(key, value) {
  return `<div class="set-seg" data-seg="${key}">` +
    SEGMENTS[key].map(([v, l]) => `<button class="${v === value ? "active" : ""}" data-v="${v}">${l}</button>`).join("") +
    `</div>`;
}

function setupSettings() {
  const btn = $("settingsBtn"), overlay = $("settingsOverlay");
  if (!btn || !overlay) return;
  // Toggle a body class so the page behind is scroll-locked — without it iOS
  // scroll-chains the page and the settings sheet barely scrolls (its lower
  // rows become unreachable in the installed PWA).
  const open = () => { renderSettings(); overlay.classList.remove("hidden"); document.body.classList.add("settings-open"); };
  const close = () => { overlay.classList.add("hidden"); document.body.classList.remove("settings-open"); };
  btn.onclick = open;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest("[data-close]")) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.classList.contains("hidden")) close(); });
}

function renderSettings() {
  const body = $("settingsBody");
  if (!body) return;
  const startup = state.defaultPlace ? state.defaultPlace.name : "Last viewed";
  body.innerHTML = `
    <div class="set-row"><label>Temperature</label>${seg("units", state.units)}</div>
    <div class="set-row"><label>Theme</label>${seg("themeMode", state.themeMode)}</div>
    <div class="set-row"><label>Accent</label><div class="set-accents">${ACCENTS.map((c) => `<button class="set-swatch${state.accent === c ? " active" : ""}" data-accent="${c}" style="background:${c}" aria-label="Accent ${c}"></button>`).join("")}</div></div>
    <div class="set-row"><label>Language<span class="set-hint">Place names &amp; dates</span></label>
      <select class="set-select" id="langSelect">${LANGS.map(([v, l]) => `<option value="${v}"${state.lang === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="set-row"><label>Time format</label>${seg("timeFormat", state.timeFormat)}</div>
    <div class="set-row"><label>Wind speed</label>${seg("windUnit", state.windUnit)}</div>
    <div class="set-row"><label>Pressure</label>${seg("pressureUnit", state.pressureUnit)}</div>
    <div class="set-row"><label>Prayer times<span class="set-hint">Replaces the Sun card · method auto-detected</span></label>
      <button class="set-toggle ${state.prayer ? "on" : ""}" data-toggle="prayer" aria-pressed="${state.prayer}"><span></span></button></div>
    <div class="set-row"><label>Reduce motion<span class="set-hint">Calmer — fewer animations</span></label>
      <button class="set-toggle ${state.reduceMotion ? "on" : ""}" data-toggle="reduceMotion" aria-pressed="${state.reduceMotion}"><span></span></button></div>
    <div class="set-row"><label>Dashboard layout<span class="set-hint">Hide &amp; reorder cards</span></label>
      <button class="btn sm" data-act="editlayout">Customize</button></div>
    <div class="set-row"><label>Startup location<span class="set-hint">Opens to ${startup}</span></label>
      <div class="set-startup">
        <button class="btn sm" data-act="setdefault">Pin current</button>
        ${state.defaultPlace ? `<button class="btn sm" data-act="cleardefault">Reset</button>` : ""}
      </div></div>`;

  body.querySelectorAll(".set-seg").forEach((sgEl) => {
    sgEl.querySelectorAll("button").forEach((b) => { b.onclick = () => setSetting(sgEl.dataset.seg, b.dataset.v); });
  });
  body.querySelectorAll("[data-accent]").forEach((b) => { b.onclick = () => setSetting("accent", b.dataset.accent); });
  const langSel = body.querySelector("#langSelect");
  if (langSel) langSel.onchange = () => setSetting("lang", langSel.value);
  const tog = body.querySelector('[data-toggle="reduceMotion"]');
  if (tog) tog.onclick = () => {
    state.reduceMotion = !state.reduceMotion;
    localStorage.setItem("reduceMotion", state.reduceMotion ? "1" : "0");
    applyReduceMotion(); renderSettings();
  };
  const ptog = body.querySelector('[data-toggle="prayer"]');
  if (ptog) ptog.onclick = () => {
    state.prayer = !state.prayer;
    localStorage.setItem("prayerTimes", state.prayer ? "1" : "0");
    if (state.prayer && state.lastData) renderPrayer(state.lastData.forecast);
    applyPrayerVisibility(); renderSettings();
  };
  const act = (n, fn) => { const el = body.querySelector(`[data-act="${n}"]`); if (el) el.onclick = fn; };
  act("setdefault", () => {
    if (!state.place) return;
    state.defaultPlace = { name: state.place.name, admin1: state.place.admin1, country: state.place.country,
      country_code: state.place.country_code, lat: state.place.lat, lon: state.place.lon };
    localStorage.setItem("defaultPlace", JSON.stringify(state.defaultPlace));
    renderSettings();
  });
  act("cleardefault", () => { state.defaultPlace = null; localStorage.removeItem("defaultPlace"); renderSettings(); });
  act("editlayout", () => {
    $("settingsOverlay").classList.add("hidden");
    document.body.classList.remove("settings-open");
    enterLayoutEdit();
  });
}

function setSetting(key, value) {
  if (state[key] === value) return;
  if (key === "units") { setUnits(value); renderSettings(); return; } // needs a refetch
  state[key] = value;
  localStorage.setItem(key, value);
  if (key === "themeMode" || key === "accent") applyTheme(); // pure CSS, no re-render
  else if (key === "lang") { applyLang(); rerender(); }      // re-locale dates/times
  else rerender();                                           // client-side re-render, no refetch
  renderSettings();
}

// --- Click-to-pick on the radar map ---------------------------------------
async function onMapPick(lat, lon) {
  let info = {};
  try { info = await (await fetch(`/api/reverse?lat=${lat}&lon=${lon}&lang=${effLang2()}`)).json(); } catch (e) {}
  loadWeather({
    name: info.name || "Pinned point", admin1: info.admin1, country: info.country,
    country_code: info.country_code, lat, lon,
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// --- Compare a second city ------------------------------------------------
function setupCompare() {
  const input = $("compareInput");
  const box = $("compareResults");
  if (!input) return;
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { box.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      try {
        const data = await (await fetch(`/api/geocode?q=${encodeURIComponent(q)}&lang=${effLang2()}`)).json();
        box.innerHTML = "";
        (data.results || []).forEach((p) => {
          const btn = document.createElement("button");
          btn.innerHTML = `<span>${p.name}</span><span class="sub">${[p.admin1, p.country].filter(Boolean).join(", ")}</span>`;
          btn.onclick = () => {
            input.value = ""; box.innerHTML = "";
            loadCompare({ name: p.name, country_code: p.country_code, lat: p.latitude, lon: p.longitude });
          };
          box.appendChild(btn);
        });
      } catch (e) {}
    }, 280);
  });
}

async function loadCompare(place) {
  const panel = $("comparePanel");
  panel.classList.remove("hidden");
  const a = state.place;
  let da = state.lastData;
  if (!da) {
    da = await fetch(`/api/weather?lat=${a.lat}&lon=${a.lon}&units=${state.units}&compact=1`).then((r) => r.json());
  }
  const wireClose = () => $("compareClose")?.addEventListener("click", () => panel.classList.add("hidden"));
  // Render city A instantly (already loaded); city B shows a spinner while it fetches.
  panel.innerHTML = compareHtml(a, da) + `<div class="cmp-vs">vs</div>` +
    `<div class="cmp-col"><button class="cmp-close btn" id="compareClose">×</button>` +
    `<div class="cmp-name">${place.name}</div><div class="cmp-loading"><div class="spinner"></div></div></div>`;
  wireClose();
  try {
    const db = await fetch(
      `/api/weather?lat=${place.lat}&lon=${place.lon}&units=${state.units}&compact=1`
    ).then((r) => r.json());
    if (db.error || !db.forecast) throw new Error(db.detail || "no data");
    panel.innerHTML = compareHtml(a, da) + `<div class="cmp-vs">vs</div>` + compareHtml(place, db, true);
    wireClose();
  } catch (e) {
    panel.innerHTML = compareHtml(a, da) + `<div class="cmp-vs">vs</div>` +
      `<div class="cmp-col"><button class="cmp-close btn" id="compareClose">×</button>` +
      `<div class="cmp-name">${place.name}</div><div class="cmp-loading">Couldn't load.</div></div>`;
    wireClose();
  }
}

function compareHtml(place, data, showClose) {
  const c = data.forecast.current;
  const aq = data.air_quality && data.air_quality.current ? data.air_quality.current : {};
  const m = describe(c.weather_code);
  return `<div class="cmp-col">
    ${showClose ? '<button class="cmp-close btn" id="compareClose">×</button>' : ""}
    <div class="cmp-name">${place.name}</div>
    <div class="cmp-row">${icon(c.weather_code, c.is_day)}<div class="cmp-temp">${r0(c.temperature_2m)}°</div></div>
    <div class="cmp-cond">${m.label}</div>
    <div class="cmp-stats">
      <span>Feels ${r0(c.apparent_temperature)}°</span>
      <span>💧 ${r0(c.relative_humidity_2m)}%</span>
      <span>🌬 ${wv(c.wind_speed_10m)} ${windU()}</span>
      <span>AQI ${aq.us_aqi != null ? r0(aq.us_aqi) : (aq.european_aqi != null ? r0(aq.european_aqi) : "–")}</span>
    </div></div>`;
}

// --- Desktop notifications ------------------------------------------------
let lastNotified = "";
function setupNotifications() {
  const btn = $("notifyBtn");
  if (!btn) return;
  const sync = () => {
    const granted = "Notification" in window && Notification.permission === "granted";
    btn.textContent = granted ? "🔔 Alerts on" : "🔕 Alerts";
    btn.classList.toggle("active", granted);
  };
  btn.onclick = async () => {
    if (!("Notification" in window)) { alert("This browser doesn't support notifications."); return; }
    if (Notification.permission !== "granted") await Notification.requestPermission();
    sync();
  };
  sync();
}

function maybeNotify(place, f, alerts) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const fire = (title, body, tag) => {
    if (lastNotified === tag) return;
    lastNotified = tag;
    try { new Notification(title, { body, tag }); } catch (e) {}
  };
  // Severe-weather alert.
  if (alerts && alerts.length) {
    fire(`⚠ ${alerts[0].event} — ${place.name}`, alerts[0].headline || "", "alert:" + (alerts[0].event || "") + place.name);
    return;
  }
  // Imminent rain from the 15-min nowcast.
  const m = f.minutely_15;
  if (m && m.precipitation) {
    const now = Date.now();
    let i0 = m.time.findIndex((t) => new Date(t).getTime() >= now);
    if (i0 >= 0) {
      const thr = state.units === "imperial" ? 0.004 : 0.1;
      const dryNow = !(m.precipitation[i0] > thr);
      for (let k = i0; k < Math.min(m.time.length, i0 + 8); k++) {
        if (dryNow && m.precipitation[k] > thr) {
          const mins = Math.round((new Date(m.time[k]).getTime() - now) / 60000);
          fire(`🌧️ Rain soon — ${place.name}`, `Precipitation starting in about ${mins} min.`, `rain:${place.name}:${m.time[k]}`);
          break;
        }
      }
    }
  }
}

// --- Auto-refresh ---------------------------------------------------------
// Brief, self-dismissing status message (reuses the "Updated" pill).
function toast(msg, ms = 2600) {
  const t = $("updateToast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

function pulseUpdated() {
  toast(`Updated ${clk(new Date())}`, 2200);
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (state.place && !document.hidden) loadWeather(state.place, true); }, 10 * 60 * 1000);
}

// Manual refresh button. Works identically on the web and in the installed PWA
// (which has no browser reload). Silently re-pulls the current location so the
// last-good data stays on screen if the refresh fails, spins the icon for
// feedback, shows the "Updated" toast, and resets the auto-refresh timer.
let refreshing = false;
async function doRefresh() {
  if (refreshing || !state.place) return;
  refreshing = true;
  const btn = $("refreshBtn");
  btn?.classList.add("spinning");
  favCache.clear();                       // re-pull favorite-chip temps too
  try {
    await loadWeather(state.place, true);
    scheduleRefresh();                    // next auto-refresh is a full interval away
  } finally {
    refreshing = false;
    btn?.classList.remove("spinning");
  }
}

boot();
