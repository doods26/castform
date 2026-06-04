// Weather-reactive ambient effects: lightning flashes, snow, cloud drift,
// and a fullscreen (kiosk) toggle. All driven by the current theme.

let lightningTimer = null;
let snowBuilt = false;
let cloudsBuilt = false;

const $ = (id) => document.getElementById(id);

function buildSnow() {
  const el = $("snowFx");
  if (!el || snowBuilt) return;
  let html = "";
  for (let i = 0; i < 80; i++) {
    const left = Math.random() * 100;
    const size = 2 + Math.random() * 4;
    const dur = 5 + Math.random() * 8;
    const delay = Math.random() * 8;
    const drift = (Math.random() * 40 - 20).toFixed(0);
    html += `<i style="left:${left}%;width:${size}px;height:${size}px;--dur:${dur}s;--delay:${delay}s;--drift:${drift}px"></i>`;
  }
  el.innerHTML = html;
  snowBuilt = true;
}

function buildClouds() {
  const el = $("cloudFx");
  if (!el || cloudsBuilt) return;
  let html = "";
  for (let i = 0; i < 5; i++) {
    const top = 5 + Math.random() * 40;
    const scale = 0.6 + Math.random() * 1.1;
    const dur = 60 + Math.random() * 80;
    const delay = -Math.random() * 120;
    const op = 0.05 + Math.random() * 0.08;
    html += `<span style="top:${top}%;--scale:${scale};--dur:${dur}s;--delay:${delay}s;opacity:${op}">
      <svg viewBox="0 0 200 100"><path d="M40 80a26 26 0 0 1 2-52 38 38 0 0 1 72 4 24 24 0 0 1-4 48z" fill="#fff"/></svg></span>`;
  }
  el.innerHTML = html;
  cloudsBuilt = true;
}

function startLightning() {
  if (lightningTimer) return;
  const flash = () => {
    const el = $("lightning");
    if (el) {
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 180 + Math.random() * 120);
    }
    lightningTimer = setTimeout(flash, 4000 + Math.random() * 9000);
  };
  lightningTimer = setTimeout(flash, 2500);
}

function stopLightning() {
  if (lightningTimer) { clearTimeout(lightningTimer); lightningTimer = null; }
}

// Called on each render with the active theme + current conditions.
export function applyEffects(theme, cur) {
  const snowOn = theme === "snow";
  const cloudOn = theme === "cloudy" || theme === "partly" || theme === "fog";
  const stormOn = theme === "storm";

  if (snowOn) buildSnow();
  $("snowFx")?.classList.toggle("on", snowOn);

  if (cloudOn) buildClouds();
  $("cloudFx")?.classList.toggle("on", cloudOn);

  if (stormOn) startLightning(); else stopLightning();
}

// Fullscreen / kiosk toggle for wall displays and the Raspberry Pi.
export function wireFullscreen(btn) {
  if (!btn) return;
  const sync = () => { btn.textContent = document.fullscreenElement ? "✕ Exit" : "⛶ Kiosk"; };
  btn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  document.addEventListener("fullscreenchange", sync);
  sync();
}
