// Animated precipitation radar (RainViewer) on a dark Leaflet map.
// Shows ~2h of past radar plus any available short-term forecast frames,
// played back as a time-lapse so you can watch weather move into the area.

let map = null;          // Leaflet map instance (created once)
let marker = null;       // location marker
let baseLayer = null;
let frames = [];         // [{time, url, kind}]
let layers = [];         // Leaflet tileLayers, parallel to frames (lazy)
let current = -1;
let timer = null;
let playing = false;
const SPEEDS = [1, 2, 0.5];
let speedIdx = 0;
let host = null;

let mode = "radar";      // "radar" | "satellite"
let rawData = null;
let onPick = null;       // callback(lat, lon) for map clicks
const RADAR_TILE = { color: 4, opt: "1_1" }; // RainViewer: green→red, smoothed
// NASA GIBS true-color (free, no key). EPSG:3857, daily global imagery.
const GIBS_LAYER = "VIIRS_NOAA20_CorrectedReflectance_TrueColor";

const $ = (id) => document.getElementById(id);

function tileUrl(frame) {
  if (mode === "satellite") {
    // GIBS WMTS REST: .../{layer}/default/{date}/{tms}/{z}/{y}/{x}.jpg
    return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_LAYER}` +
      `/default/${frame.date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
  }
  return `${host}${frame.url}/256/{z}/{x}/{y}/${RADAR_TILE.color}/${RADAR_TILE.opt}.png`;
}

function fmtFrameLabel(frame) {
  if (mode === "satellite") {
    return `${frame.date} · daily true-color`;
  }
  const now = Date.now() / 1000;
  const delta = Math.round((frame.time - now) / 60); // minutes
  const clock = new Date(frame.time * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  let rel;
  if (frame.kind === "forecast") rel = `+${Math.abs(delta)} min · forecast`;
  else if (delta >= -2 && delta <= 2) rel = "Now";
  else rel = `${delta} min`;
  return `${rel} · ${clock}`;
}

function ensureLayer(i) {
  if (layers[i]) return layers[i];
  const opts = {
    opacity: 0, tileSize: 256, zIndex: 10 + i, crossOrigin: true,
    className: "radar-tiles",
  };
  if (mode === "satellite") { opts.maxNativeZoom = 8; opts.bounds = [[-85, -180], [85, 180]]; }
  const layer = L.tileLayer(tileUrl(frames[i]), opts);
  layer.addTo(map);
  layers[i] = layer;
  return layer;
}

function showFrame(i, fade = true) {
  if (!frames.length) return;
  i = (i + frames.length) % frames.length;
  const prev = current;
  ensureLayer(i);
  // Preload the next frame so playback is smooth.
  ensureLayer((i + 1) % frames.length);
  // Crossfade: bring target up, ease others down.
  layers.forEach((layer, idx) => {
    if (!layer) return;
    layer.setOpacity(idx === i ? 0.82 : (idx === prev && fade ? 0.25 : 0));
  });
  current = i;
  $("radarScrub").value = i;
  const f = frames[i];
  const lbl = $("radarFrameLabel");
  lbl.textContent = fmtFrameLabel(f);
  lbl.className = "radar-frame-label" + (f.kind === "forecast" ? " is-forecast" : "");
}

function stepInterval() {
  return 520 / SPEEDS[speedIdx];
}

function tick() {
  let next = current + 1;
  // Pause a beat at the final frame before looping.
  if (next >= frames.length) {
    next = 0;
    clearInterval(timer);
    timer = setTimeout(() => { if (playing) { showFrame(0); schedule(); } }, 900);
    return;
  }
  showFrame(next);
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(tick, stepInterval());
}

function play() {
  if (!frames.length) return;
  playing = true;
  $("radarPlay").textContent = "❚❚";
  // If we're at the end, restart from the beginning.
  if (current >= frames.length - 1) showFrame(0);
  schedule();
}

function pause() {
  playing = false;
  $("radarPlay").textContent = "▶";
  clearInterval(timer);
  clearTimeout(timer);
}

function togglePlay() { playing ? pause() : play(); }

function cycleSpeed() {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  $("radarSpeed").textContent = `${SPEEDS[speedIdx]}×`;
  if (playing) schedule();
}

function wireControls() {
  $("radarPlay").onclick = togglePlay;
  $("radarSpeed").onclick = cycleSpeed;
  $("radarScrub").oninput = (e) => { pause(); showFrame(+e.target.value, false); };
  document.querySelectorAll("#radarMode button").forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });
}

function startFromNow() {
  if (!frames.length) return;
  let s = 0;
  for (let i = 0; i < frames.length; i++) if (frames[i].kind === "past") s = i;
  showFrame(s, false);
  play();
}

function setMode(m) {
  if (m === mode || !rawData) return;
  mode = m;
  document.querySelectorAll("#radarMode button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === m));
  pause();
  buildFramesForMode();
  if (frames.length) startFromNow();
  else $("radarFrameLabel").textContent =
    m === "satellite" ? "Satellite imagery unavailable here." : "No radar data.";
}

function buildFramesForMode() {
  const r = rawData.radar || {};
  if (mode === "satellite") {
    // NASA GIBS true-color: one global image per day. Build the last 6 days
    // (skip "today" — that day's swath is usually not processed yet).
    frames = [];
    for (let d = 6; d >= 1; d--) {
      const dt = new Date(Date.now() - d * 86400000);
      const date = dt.toISOString().slice(0, 10);
      frames.push({ date, time: dt.getTime() / 1000, kind: "past" });
    }
  } else {
    frames = [
      ...((r.past) || []).map((f) => ({ time: f.time, url: f.path, kind: "past" })),
      ...((r.nowcast) || []).map((f) => ({ time: f.time, url: f.path, kind: "forecast" })),
    ];
  }
  // Reset layers (paths/params differ).
  layers.forEach((l) => l && map.removeLayer(l));
  layers = [];
  current = -1;
  $("radarScrub").max = Math.max(0, frames.length - 1);
}

async function loadFrames() {
  const res = await fetch("/api/radar");
  rawData = await res.json();
  host = rawData.host;
  buildFramesForMode();
}

// Public: (re)point the radar at a location. Creates the map on first call.
export async function initRadar(lat, lon, label, pickCb) {
  onPick = pickCb || onPick;
  const loadingEl = $("radarLoading");
  if (loadingEl) loadingEl.classList.remove("hidden");

  if (!map) {
    map = L.map("radarMap", {
      center: [lat, lon], zoom: 7, zoomControl: true,
      attributionControl: true, scrollWheelZoom: false,
    });
    baseLayer = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      { subdomains: "abcd", maxZoom: 19,
        attribution: '&copy; OpenStreetMap &copy; CARTO · Radar &copy; RainViewer · Satellite &copy; NASA GIBS' }
    ).addTo(map);
    wireControls();
    // Click anywhere to load weather for that point.
    map.on("click", (e) => { if (onPick) onPick(+e.latlng.lat.toFixed(4), +e.latlng.lng.toFixed(4)); });
  }

  map.setView([lat, lon], map.getZoom() || 7, { animate: true });

  // Pulsing location marker.
  if (marker) map.removeLayer(marker);
  marker = L.marker([lat, lon], {
    icon: L.divIcon({ className: "radar-pin", html: '<span class="pin-dot"></span><span class="pin-pulse"></span>', iconSize: [18, 18] }),
  }).addTo(map);
  if (label) marker.bindPopup(label);

  try {
    await loadFrames();
    if (frames.length) {
      // Start at "now" — the most recent past frame — then autoplay.
      let startIdx = 0;
      for (let i = 0; i < frames.length; i++) if (frames[i].kind === "past") startIdx = i;
      showFrame(startIdx, false);
      play();
    } else {
      $("radarFrameLabel").textContent = "No radar data available here right now.";
    }
  } catch (e) {
    $("radarFrameLabel").textContent = "Radar unavailable.";
  } finally {
    if (loadingEl) loadingEl.classList.add("hidden");
    setTimeout(() => map.invalidateSize(), 200);
  }
}
