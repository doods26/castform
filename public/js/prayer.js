// Islamic prayer times + Qibla — pure, dependency-free calculation.
//
// Prayer times use the standard astronomical algorithm popularised by
// PrayTimes.org (computing each prayer from the sun's altitude angle).
// Everything here is deterministic math from latitude / longitude / date /
// UTC-offset — no network, no API key, matching the project's ethos.
//
// Times are returned as decimal hours in the LOCATION's local clock
// (e.g. 5.5 = 5:30 AM), or null when the sun never reaches the required
// angle and the high-latitude fallback can't be applied.

// --- degree-based trig helpers -------------------------------------------
const dtr = (d) => (d * Math.PI) / 180;
const rtd = (r) => (r * 180) / Math.PI;
const sin = (d) => Math.sin(dtr(d));
const cos = (d) => Math.cos(dtr(d));
const tan = (d) => Math.tan(dtr(d));
const arcsin = (x) => rtd(Math.asin(x));
const arccos = (x) => rtd(Math.acos(x));
const arctan2 = (y, x) => rtd(Math.atan2(y, x));
const arccot = (x) => rtd(Math.atan(1 / x));
const fixAngle = (a) => { a %= 360; return a < 0 ? a + 360 : a; };
const fixHour = (h) => { h %= 24; return h < 0 ? h + 24 : h; };

// Calculation conventions. fajr/isha are twilight angles (degrees below the
// horizon). ishaMin = fixed minutes after Maghrib instead of an angle.
// maghrib defaults to the 0.833° sunset angle unless a method overrides it.
export const METHODS = {
  MWL:     { label: "Muslim World League",      fajr: 18,   isha: 17 },
  ISNA:    { label: "ISNA (North America)",     fajr: 15,   isha: 15 },
  Egypt:   { label: "Egyptian Authority",       fajr: 19.5, isha: 17.5 },
  Makkah:  { label: "Umm al-Qura (Makkah)",     fajr: 18.5, ishaMin: 90 },
  Gulf:    { label: "Gulf Region",              fajr: 19.5, ishaMin: 90 },
  Karachi: { label: "University of Karachi",    fajr: 18,   isha: 18 },
  Tehran:  { label: "Tehran (Geophysics)",      fajr: 17.7, isha: 14, maghrib: 4.5 },
  Jafari:  { label: "Shia Ja'fari",             fajr: 16,   isha: 14, maghrib: 4 },
  Turkey:  { label: "Diyanet (Turkey)",         fajr: 18,   isha: 17 },
};

// Pick a sensible default method from the place's ISO country code.
const COUNTRY_METHOD = {
  SA: "Makkah", YE: "Makkah",
  AE: "Gulf", KW: "Gulf", QA: "Gulf", BH: "Gulf", OM: "Gulf",
  US: "ISNA", CA: "ISNA", MX: "ISNA",
  PK: "Karachi", IN: "Karachi", BD: "Karachi", AF: "Karachi", LK: "Karachi",
  EG: "Egypt", SD: "Egypt", LY: "Egypt", DZ: "Egypt", MA: "Egypt", TN: "Egypt",
  SY: "Egypt", JO: "Egypt", IQ: "Egypt",
  IR: "Tehran",
  TR: "Turkey",
};
export function methodForCountry(cc) {
  return COUNTRY_METHOD[(cc || "").toUpperCase()] || "MWL";
}

// --- solar geometry ------------------------------------------------------
function julian(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}
function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fixAngle(357.529 + 0.98560028 * D);
  const q = fixAngle(280.459 + 0.98564736 * D);
  const L = fixAngle(q + 1.915 * sin(g) + 0.020 * sin(2 * g));
  const e = 23.439 - 0.00000036 * D;
  const declination = arcsin(sin(e) * sin(L));
  const RA = arctan2(cos(e) * sin(L), cos(L)) / 15;
  const equation = q / 15 - fixHour(RA);
  return { declination, equation };
}
function midDay(jDate, t) {
  return fixHour(12 - sunPosition(jDate + t).equation);
}
// Time (in hours) when the sun sits `angle` degrees below the horizon.
function sunAngleTime(jDate, angle, t, lat, dir) {
  const decl = sunPosition(jDate + t).declination;
  const noon = midDay(jDate, t);
  const x = (-sin(angle) - sin(decl) * sin(lat)) / (cos(decl) * cos(lat));
  if (x < -1 || x > 1) return NaN;            // sun never reaches this angle
  const T = arccos(x) / 15;
  return noon + (dir === "ccw" ? -T : T);
}
function asrTime(jDate, factor, t, lat) {
  const decl = sunPosition(jDate + t).declination;
  const angle = -arccot(factor + tan(Math.abs(lat - decl)));
  return sunAngleTime(jDate, angle, t, lat, "cw");
}

// High-latitude fallback (NightMiddle): when Fajr/Isha can't be reached by
// angle, bound them to half the night either side of sunrise/sunset.
function highLatAdjust(times, method) {
  const night = fixHour(times.sunrise - times.sunset);
  const half = night / 2;
  if (isNaN(times.fajr) || fixHour(times.sunrise - times.fajr) > half) {
    times.fajr = times.sunrise - half;
  }
  if (method.isha != null && (isNaN(times.isha) || fixHour(times.isha - times.sunset) > half)) {
    times.isha = times.sunset + half;
  }
}

// --- public API ----------------------------------------------------------
// opts: { year, month(1-12), day, lat, lon, tzOffset(hours), method, asr }
// returns { fajr, sunrise, dhuhr, asr, maghrib, isha, sunset, methodLabel }
export function prayerTimes(opts) {
  const method = METHODS[opts.method] || METHODS.MWL;
  const lat = opts.lat, lon = opts.lon;
  const asrFactor = opts.asr === "hanafi" ? 2 : 1;
  const jDate = julian(opts.year, opts.month, opts.day) - lon / (15 * 24);

  let times = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, sunset: 18, maghrib: 18, isha: 18 };
  for (let iter = 0; iter < 3; iter++) {
    const t = {};
    for (const k in times) t[k] = times[k] / 24;
    times = {
      fajr:    sunAngleTime(jDate, method.fajr, t.fajr, lat, "ccw"),
      sunrise: sunAngleTime(jDate, 0.833, t.sunrise, lat, "ccw"),
      dhuhr:   midDay(jDate, t.dhuhr),
      asr:     asrTime(jDate, asrFactor, t.asr, lat),
      sunset:  sunAngleTime(jDate, 0.833, t.sunset, lat, "cw"),
      maghrib: sunAngleTime(jDate, method.maghrib != null ? method.maghrib : 0.833, t.maghrib, lat, "cw"),
      isha:    method.isha != null ? sunAngleTime(jDate, method.isha, t.isha, lat, "cw") : 18,
    };
  }
  // Shift from astronomical time to the location's local clock.
  const adj = opts.tzOffset - lon / 15;
  for (const k in times) times[k] += adj;
  // Interval-based Isha (e.g. Umm al-Qura: 90 min after Maghrib).
  if (method.ishaMin != null) times.isha = times.maghrib + method.ishaMin / 60;
  highLatAdjust(times, method);

  const out = { methodLabel: method.label };
  for (const k of ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha", "sunset"]) {
    out[k] = isNaN(times[k]) ? null : fixHour(times[k]);
  }
  return out;
}

// --- Qibla ---------------------------------------------------------------
const KAABA_LAT = 21.4225, KAABA_LON = 39.8262;

// Great-circle initial bearing (degrees from true north) toward the Kaaba.
export function qiblaBearing(lat, lon) {
  const dLon = dtr(KAABA_LON - lon);
  const y = Math.sin(dLon);
  const x = cos(lat) * tan(KAABA_LAT) - sin(lat) * Math.cos(dLon);
  return fixAngle(rtd(Math.atan2(y, x)));
}
// Great-circle distance to the Kaaba in km.
export function qiblaDistanceKm(lat, lon) {
  const R = 6371;
  const dLat = dtr(KAABA_LAT - lat), dLon = dtr(KAABA_LON - lon);
  const a = Math.sin(dLat / 2) ** 2 + cos(lat) * cos(KAABA_LAT) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compass16(bearing) {
  return COMPASS16[Math.round(fixAngle(bearing) / 22.5) % 16];
}

// --- Current / next prayer ----------------------------------------------
// Pick the current and next of the five daily prayers from their local-clock
// hours, the current epoch-ms, the LOCATION's local date, and its UTC offset.
//
// Two things this gets right:
//  1. Wrap past midnight — at higher latitudes (and mid-latitudes in summer)
//     Isha/Fajr land in the small hours, so each prayer's instant is
//     materialised for yesterday/today/tomorrow and the timeline is sorted.
//  2. The sunrise gap — Fajr's window ENDS at sunrise. Between sunrise and
//     Dhuhr no obligatory prayer is active, so we must NOT report "Fajr" then.
//     `gap: true` flags that window (Now = none, Next = Dhuhr).
//
// times: { fajr, dhuhr, asr, maghrib, isha, sunrise } in decimal hours (or null)
// returns { current, currentAt, next, nextAt, gap, gapFrom }
const DAILY_ORDER = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
function instantAt(date, dayOffset, hours, tzOffset) {
  return Date.UTC(date.y, date.mo - 1, date.da + dayOffset) + (hours - tzOffset) * 3600000;
}
export function currentAndNext(times, nowMs, date, tzOffset) {
  const events = [];
  for (const dd of [-1, 0, 1]) {
    for (const key of DAILY_ORDER) {
      if (times[key] == null) continue;
      events.push({ key, inst: instantAt(date, dd, times[key], tzOffset) });
    }
  }
  events.sort((a, b) => a.inst - b.inst);

  const next = events.find((e) => e.inst > nowMs) || null;
  let current = null;
  for (const e of events) { if (e.inst <= nowMs) current = e; else break; }

  // Fajr ends at sunrise → if we're past the sunrise that ends the current
  // Fajr (and Dhuhr hasn't begun), there's no active prayer: the morning gap.
  let gap = false, gapFrom = null;
  if (current && current.key === "fajr" && times.sunrise != null) {
    let sr = null;
    for (const dd of [-1, 0, 1]) {
      const s = instantAt(date, dd, times.sunrise, tzOffset);
      if (s >= current.inst && (sr == null || s < sr)) sr = s;   // sunrise ending THIS Fajr
    }
    if (sr != null && nowMs >= sr) { gap = true; gapFrom = sr; }
  }
  return {
    current: gap || !current ? null : current.key,
    currentAt: gap || !current ? null : current.inst,
    next: next ? next.key : null,
    nextAt: next ? next.inst : null,
    gap,
    gapFrom,
  };
}
