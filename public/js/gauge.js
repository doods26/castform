// Modern circular gauge component (SVG). A 270° "speedometer" arc with a
// gradient fill, soft glow, animated sweep, center value + unit, and label.
// Inspired by the WeeWX Neowx-Material console, elevated with gradients/glow.

let uid = 0;

function polar(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * Math.PI / 180; // 0° = top, clockwise
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx, cy, r, startAngle, endAngle) {
  const s = polar(cx, cy, r, startAngle);
  const e = polar(cx, cy, r, endAngle);
  const large = (endAngle - startAngle) % 360 > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

const SWEEP = 270, START = -135;

// opts: { value, min, max, unit, label, color | colors[], decimals, sub }
export function gauge(opts) {
  const {
    value, min = 0, max = 100, unit = "", label = "", sub = "",
    color = "#ffa62b", colors = null, decimals = 0,
  } = opts;
  const id = "gg" + (++uid);
  const cx = 70, cy = 70, r = 56;
  const has = value != null && !Number.isNaN(value);
  const frac = has ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const off = (100 - frac * 100).toFixed(2);

  const track = arcPath(cx, cy, r, START, START + SWEEP);
  const stops = colors
    ? colors.map((c, i) => `<stop offset="${(i / (colors.length - 1) * 100).toFixed(0)}%" stop-color="${c}"/>`).join("")
    : `<stop offset="0%" stop-color="${color}" stop-opacity="0.65"/><stop offset="100%" stop-color="${color}"/>`;
  const thumb = polar(cx, cy, r, START + SWEEP * frac);
  const valStr = has ? Number(value).toFixed(decimals) : "–";

  return `
  <svg class="gauge" viewBox="0 0 140 140" role="img" aria-label="${label} ${valStr}${unit}">
    <defs>
      <linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0">${stops}</linearGradient>
      <filter id="${id}f" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <path d="${track}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="11" stroke-linecap="round"/>
    <path d="${track}" fill="none" stroke="url(#${id})" stroke-width="11" stroke-linecap="round"
      pathLength="100" stroke-dasharray="100" filter="url(#${id}f)"
      class="gauge-arc" style="--target:${off}"/>
    ${has ? `<circle cx="${thumb.x.toFixed(2)}" cy="${thumb.y.toFixed(2)}" r="5.5" fill="#fff" class="gauge-thumb" style="--target:${off}"/>` : ""}
    <text x="70" y="68" text-anchor="middle" class="gauge-val">${valStr}<tspan class="gauge-unit" dx="1" dy="-9">${unit}</tspan></text>
    ${sub ? `<text x="70" y="86" text-anchor="middle" class="gauge-sub">${sub}</text>` : ""}
    <text x="70" y="${sub ? 104 : 98}" text-anchor="middle" class="gauge-label">${label}</text>
  </svg>`;
}

// A compass gauge for wind direction — needle + cardinal ticks.
export function compassGauge(deg, speed, unit, gust) {
  const cx = 70, cy = 70, r = 54;
  const ticks = [["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(([t, a]) => {
    const p = polar(cx, cy, r + 9, a);
    return `<text x="${p.x.toFixed(1)}" y="${(p.y + 3).toFixed(1)}" text-anchor="middle" class="compass-tick">${t}</text>`;
  }).join("");
  const minor = Array.from({ length: 12 }, (_, i) => {
    const a = i * 30; const o = polar(cx, cy, r, a); const inn = polar(cx, cy, r - 6, a);
    return `<line x1="${o.x.toFixed(1)}" y1="${o.y.toFixed(1)}" x2="${inn.x.toFixed(1)}" y2="${inn.y.toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/>`;
  }).join("");
  const has = deg != null;
  return `
  <svg class="gauge" viewBox="0 0 140 140" role="img" aria-label="Wind ${speed}${unit}">
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="2"/>
    ${minor}${ticks}
    ${has ? `<g class="compass-needle" style="transform-origin:70px 70px;transform:rotate(${deg}deg)">
      <path d="M70 24 L76 72 L70 66 L64 72 Z" fill="#ff6b6b"/>
      <path d="M70 116 L76 68 L70 74 L64 68 Z" fill="rgba(255,255,255,0.55)"/>
    </g>` : ""}
    <circle cx="70" cy="70" r="4" fill="#fff"/>
    <text x="70" y="60" text-anchor="middle" class="gauge-val" style="font-size:22px">${speed != null ? Math.round(speed) : "–"}<tspan class="gauge-unit" dx="1" dy="-7">${unit}</tspan></text>
    <text x="70" y="98" text-anchor="middle" class="gauge-sub">${gust != null ? "gust " + Math.round(gust) : ""}</text>
  </svg>`;
}
