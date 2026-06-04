// WMO weather-code interpretation + a self-contained animated SVG icon set.
// Open-Meteo returns WMO codes (https://open-meteo.com/en/docs). We map each
// to a label, a theme key (drives the page background), and an icon.

export const WMO = {
  0:  { label: "Clear sky",            theme: "clear" },
  1:  { label: "Mainly clear",         theme: "clear" },
  2:  { label: "Partly cloudy",        theme: "partly" },
  3:  { label: "Overcast",             theme: "cloudy" },
  45: { label: "Fog",                  theme: "fog" },
  48: { label: "Depositing rime fog",  theme: "fog" },
  51: { label: "Light drizzle",        theme: "rain" },
  53: { label: "Moderate drizzle",     theme: "rain" },
  55: { label: "Dense drizzle",        theme: "rain" },
  56: { label: "Freezing drizzle",     theme: "rain" },
  57: { label: "Freezing drizzle",     theme: "rain" },
  61: { label: "Light rain",           theme: "rain" },
  63: { label: "Moderate rain",        theme: "rain" },
  65: { label: "Heavy rain",           theme: "rain" },
  66: { label: "Freezing rain",        theme: "rain" },
  67: { label: "Freezing rain",        theme: "rain" },
  71: { label: "Light snow",           theme: "snow" },
  73: { label: "Moderate snow",        theme: "snow" },
  75: { label: "Heavy snow",           theme: "snow" },
  77: { label: "Snow grains",          theme: "snow" },
  80: { label: "Light showers",        theme: "rain" },
  81: { label: "Moderate showers",     theme: "rain" },
  82: { label: "Violent showers",      theme: "rain" },
  85: { label: "Snow showers",         theme: "snow" },
  86: { label: "Heavy snow showers",   theme: "snow" },
  95: { label: "Thunderstorm",         theme: "storm" },
  96: { label: "Thunderstorm + hail",  theme: "storm" },
  99: { label: "Severe thunderstorm",  theme: "storm" },
};

export function describe(code) {
  return WMO[code] || { label: "Unknown", theme: "cloudy" };
}

// --- SVG icon primitives ---------------------------------------------------
const sun = (c = "#ffd45e") => `
  <circle cx="22" cy="22" r="9" fill="${c}"/>
  <g stroke="${c}" stroke-width="2.4" stroke-linecap="round">
    ${Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4;
      const x1 = 22 + Math.cos(a) * 13, y1 = 22 + Math.sin(a) * 13;
      const x2 = 22 + Math.cos(a) * 17, y2 = 22 + Math.sin(a) * 17;
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }).join("")}
  </g>`;

const moon = (c = "#dfe7ff") => `
  <path d="M30 24a10 10 0 1 1-9.5-13 8 8 0 0 0 9.5 13z" fill="${c}"/>`;

const cloud = (c = "#e8eefc", x = 0, y = 0, s = 1) => `
  <g transform="translate(${x} ${y}) scale(${s})">
    <path d="M16 40a9 9 0 0 1 .6-17.9A13 13 0 0 1 41 23a8 8 0 0 1-1 17z" fill="${c}"/>
  </g>`;

const drops = (c = "#5fa8ff", n = 3) =>
  Array.from({ length: n }, (_, i) => {
    const x = 16 + i * 8;
    return `<line class="rain-drop" style="--d:${i * 0.2}s" x1="${x}" y1="40" x2="${x - 2}" y2="48" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`;
  }).join("");

const flakes = (c = "#dff1ff", n = 3) =>
  Array.from({ length: n }, (_, i) => {
    const x = 16 + i * 8;
    return `<circle class="snow-flake" style="--d:${i * 0.25}s" cx="${x}" cy="44" r="1.8" fill="${c}"/>`;
  }).join("");

const bolt = (c = "#ffd45e") =>
  `<path class="bolt" d="M26 38l-6 8h6l-3 8 10-12h-6l4-4z" fill="${c}"/>`;

const fogLines = (c = "#cfd8ec") =>
  Array.from({ length: 3 }, (_, i) =>
    `<line x1="12" y1="${36 + i * 5}" x2="${36 - i * 2}" y2="${36 + i * 5}" stroke="${c}" stroke-width="2.6" stroke-linecap="round" opacity="0.8"/>`
  ).join("");

function svg(inner, cls = "") {
  return `<svg class="wxicon ${cls}" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
}

// --- Icon selector ---------------------------------------------------------
// isDay: 1 (day) / 0 (night). Returns an SVG string.
export function icon(code, isDay = 1) {
  const day = isDay !== 0;
  const lum = day ? sun() : moon();
  switch (describe(code).theme) {
    case "clear":
      return svg(`<g class="spin-slow">${day ? sun() : ""}</g>${day ? "" : moon()}`);
    case "partly":
      return svg(`${day ? `<g transform="translate(-4 -4) scale(0.8)">${sun()}</g>` : `<g transform="translate(-2 -3) scale(0.8)">${moon()}</g>`}${cloud("#f1f5ff", 6, 6, 0.85)}`);
    case "cloudy":
      return svg(`${cloud("#cfd9ef", -2, -2, 0.7)}${cloud("#eef3ff", 4, 2, 1)}`);
    case "fog":
      return svg(`${cloud("#dde4f4", 2, -4, 0.9)}${fogLines()}`);
    case "rain":
      return svg(`${cloud("#cdd8ef", 2, -4, 0.95)}${drops()}`);
    case "snow":
      return svg(`${cloud("#dce7fb", 2, -4, 0.95)}${flakes()}`);
    case "storm":
      return svg(`${cloud("#aab6d6", 2, -4, 0.95)}${bolt()}`);
    default:
      return svg(cloud());
  }
}

// Compass label from degrees.
export function compass(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}
