// Standalone (serverless) API shim.
// Intercepts the app's fetch('/api/...') calls and answers them directly from
// the browser using the same free, keyless, CORS-enabled APIs the Python
// server uses. This lets the EXACT same app run with no backend — e.g. pasted
// into an omg.lol page or hosted as a static file.
//
// Differences vs the server: global pollen (Google, needs a key) is disabled;
// Europe pollen still comes through the air-quality feed.
(function () {
  const FORECAST = "https://api.open-meteo.com/v1/forecast";
  const AQI = "https://air-quality-api.open-meteo.com/v1/air-quality";
  const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
  const REVERSE = "https://api.bigdatacloud.net/data/reverse-geocode-client";
  const NWS = "https://api.weather.gov/alerts/active";
  const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";

  const CURRENT = ["temperature_2m", "relative_humidity_2m", "apparent_temperature", "is_day",
    "precipitation", "rain", "showers", "snowfall", "weather_code", "cloud_cover", "pressure_msl",
    "surface_pressure", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "dew_point_2m"].join(",");
  const HOURLY = ["temperature_2m", "apparent_temperature", "precipitation_probability", "precipitation",
    "weather_code", "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "relative_humidity_2m",
    "uv_index", "visibility", "is_day"].join(",");
  const DAILY = ["weather_code", "temperature_2m_max", "temperature_2m_min", "apparent_temperature_max",
    "apparent_temperature_min", "sunrise", "sunset", "uv_index_max", "precipitation_sum", "rain_sum",
    "showers_sum", "snowfall_sum", "precipitation_probability_max", "wind_speed_10m_max",
    "wind_gusts_10m_max", "wind_direction_10m_dominant"].join(",");
  const AQI_CUR = ["us_aqi", "european_aqi", "pm10", "pm2_5", "carbon_monoxide", "nitrogen_dioxide",
    "sulphur_dioxide", "ozone", "dust", "uv_index", "alder_pollen", "birch_pollen", "grass_pollen",
    "mugwort_pollen", "olive_pollen", "ragweed_pollen"].join(",");
  const AQI_HR = "us_aqi,european_aqi,pm2_5,pm10,ozone";
  const MARINE_CUR = ["wave_height", "wave_direction", "wave_period", "wind_wave_height",
    "swell_wave_height", "swell_wave_period", "swell_wave_direction", "sea_surface_temperature"].join(",");
  const MARINE = "https://marine-api.open-meteo.com/v1/marine";

  const realFetch = window.fetch.bind(window);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Open-Meteo is load-balanced: a 502/503 usually means one unhealthy node, so
  // an immediate retry lands on a good one. Retry on 5xx/429 and network errors.
  async function j(url, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await realFetch(url);
        if (r.ok) return await r.json();
        if (r.status >= 500 || r.status === 429) lastErr = new Error("HTTP " + r.status);
        else return await r.json();  // 4xx: return the body (may carry an error message)
      } catch (e) { lastErr = e; }
      if (i < tries - 1) await sleep(500 * (i + 1));
    }
    throw lastErr;
  }

  function units(u) {
    const imp = (u || "imperial") === "imperial";
    return { tu: imp ? "fahrenheit" : "celsius", wu: imp ? "mph" : "kmh", pu: imp ? "inch" : "mm" };
  }

  async function getAir(lat, lon) {
    try {
      return await j(`${AQI}?latitude=${lat}&longitude=${lon}&current=${AQI_CUR}&hourly=${AQI_HR}&timezone=auto&forecast_days=2`);
    } catch (e) { return {}; }
  }

  async function getMarine(lat, lon, tu) {
    try {
      const d = await j(`${MARINE}?latitude=${lat}&longitude=${lon}&current=${MARINE_CUR}&timezone=auto&temperature_unit=${tu}`);
      const c = d.current || {};
      if (c.wave_height == null && c.sea_surface_temperature == null) return { available: false };
      return { available: true, current: c, units: d.current_units || {} };
    } catch (e) { return { available: false }; }
  }

  async function getAlerts(lat, lon) {
    try {
      const d = await j(`${NWS}?point=${lat},${lon}`);
      return (d.features || []).map((f) => {
        const p = f.properties || {};
        return { event: p.event, severity: p.severity, urgency: p.urgency, certainty: p.certainty,
          headline: p.headline, description: p.description, instruction: p.instruction,
          sender: p.senderName, effective: p.effective, expires: p.expires };
      });
    } catch (e) { return []; }
  }

  async function getReverse(lat, lon) {
    try {
      const d = await j(`${REVERSE}?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      return { name: d.city || d.locality || d.principalSubdivision, admin1: d.principalSubdivision,
        country: d.countryName, country_code: d.countryCode };
    } catch (e) { return { name: null }; }
  }

  async function getWeather(q) {
    const lat = q.get("lat"), lon = q.get("lon");
    const { tu, wu, pu } = units(q.get("units"));
    const cc = (q.get("country_code") || "").toUpperCase();
    if (q.get("compact") === "1") {
      const f = await j(`${FORECAST}?latitude=${lat}&longitude=${lon}&current=${CURRENT}&timezone=auto&forecast_days=1&temperature_unit=${tu}&wind_speed_unit=${wu}&precipitation_unit=${pu}`);
      return { forecast: f, air_quality: await getAir(lat, lon), units: { temp: tu, wind: wu, precip: pu }, fetched_at: Math.floor(Date.now() / 1000) };
    }
    const [forecast, air, alerts, marine] = await Promise.all([
      j(`${FORECAST}?latitude=${lat}&longitude=${lon}&current=${CURRENT}&hourly=${HOURLY}&daily=${DAILY}&minutely_15=precipitation&timezone=auto&forecast_days=7&past_days=1&temperature_unit=${tu}&wind_speed_unit=${wu}&precipitation_unit=${pu}`),
      getAir(lat, lon),
      (cc === "US" || cc === "") ? getAlerts(lat, lon) : Promise.resolve([]),
      getMarine(lat, lon, tu),
    ]);
    return { forecast, air_quality: air, alerts, marine, pollen: { enabled: false },
      units: { temp: tu, wind: wu, precip: pu }, fetched_at: Math.floor(Date.now() / 1000) };
  }

  const doy = (dt) => Math.floor((dt - new Date(dt.getFullYear(), 0, 0)) / 86400000);

  async function getHistory(lat, lon, tu, pu) {
    const now = new Date(), y = now.getFullYear();
    const arc = await j(`${ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${y - 11}-01-01&end_date=${y - 1}-12-31&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&temperature_unit=${tu}&precipitation_unit=${pu}`);
    const d = arc.daily || {}, t = d.time || [], tmax = d.temperature_2m_max || [], tmin = d.temperature_2m_min || [], prec = d.precipitation_sum || [];
    const target = doy(now);
    const highs = [], lows = [];
    let rh = null, rl = null, rw = null; const exact = {};
    for (let i = 0; i < t.length; i++) {
      const dd = new Date(t[i] + "T12:00:00");
      const dist = Math.min(Math.abs(doy(dd) - target), 365 - Math.abs(doy(dd) - target));
      if (dist > 3) continue;
      const hi = tmax[i], lo = tmin[i], pr = prec[i];
      if (dd.getMonth() === now.getMonth() && dd.getDate() === now.getDate()) exact[dd.getFullYear()] = { high: hi, low: lo };
      if (hi != null) { highs.push(hi); if (!rh || hi > rh[0]) rh = [hi, dd.getFullYear()]; }
      if (lo != null) { lows.push(lo); if (!rl || lo < rl[0]) rl = [lo, dd.getFullYear()]; }
      if (pr != null && (!rw || pr > rw[0])) rw = [pr, dd.getFullYear()];
    }
    const mean = (a) => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length * 10) / 10 : null;
    const ly = exact[y - 1];
    const normals = { high: mean(highs), low: mean(lows),
      record_high: rh ? rh[0] : null, record_high_year: rh ? rh[1] : null,
      record_low: rl ? rl[0] : null, record_low_year: rl ? rl[1] : null,
      wettest: rw ? Math.round(rw[0] * 10) / 10 : null, wettest_year: rw ? rw[1] : null,
      last_year_high: ly ? ly.high : null, last_year_low: ly ? ly.low : null, years: 10 };
    const rec = await j(`${FORECAST}?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&past_days=35&forecast_days=1&timezone=auto&temperature_unit=${tu}&precipitation_unit=${pu}`);
    const rd = rec.daily || {};
    return { normals, recent: { time: rd.time || [], tmax: rd.temperature_2m_max || [], tmin: rd.temperature_2m_min || [], precip: rd.precipitation_sum || [] },
      units: { temp: (arc.daily_units || {}).temperature_2m_max || "" } };
  }

  async function handleApi(url) {
    // Fixed base — inside a srcdoc iframe (e.g. embedded in a weblog page)
    // location.origin is "null", which would break URL parsing. We only need
    // the path + query, so any valid absolute base works.
    const u = new URL(url, "http://castform.local"), p = u.pathname, q = u.searchParams;
    try {
      if (p === "/api/geocode") {
        const name = (q.get("q") || "").trim();
        if (!name) return { results: [] };
        return await j(`${GEOCODE}?name=${encodeURIComponent(name)}&count=8&language=en&format=json`);
      }
      if (p === "/api/reverse") return await getReverse(q.get("lat"), q.get("lon"));
      if (p === "/api/radar") return await j(RAINVIEWER);
      if (p === "/api/history") {
        const { tu, pu } = units(q.get("units"));
        return await getHistory(q.get("lat"), q.get("lon"), tu, pu);
      }
      if (p === "/api/weather") return await getWeather(q);
    } catch (e) { return { error: "client", detail: String(e) }; }
    return { error: "not found" };
  }

  // Patch fetch: route /api/* to the client-side handlers, pass everything else through.
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url);
    if (url && url.indexOf("/api/") === 0) {
      return handleApi(url).then((data) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return realFetch(input, init);
  };
})();
