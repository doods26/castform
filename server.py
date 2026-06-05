#!/usr/bin/env python3
"""
Weather Dashboard — local server.

A zero-dependency aggregator + static file server built on the Python
standard library. It proxies and caches free, keyless government-grade
weather APIs so the browser talks only to localhost.

Data sources
------------
* Open-Meteo  forecast        (global, keyless) — current/hourly/daily weather
* Open-Meteo  air-quality     (global, keyless) — US AQI, EU AQI, pollutants, pollen (EU)
* Open-Meteo  geocoding       (global, keyless) — city search
* NWS / weather.gov           (US only, keyless) — active severe-weather alerts
* BigDataCloud reverse-geocode (keyless)        — name a lat/lon for "my location"

Run:  python server.py   then open http://localhost:8787
"""

import json
import time
import socket
import ipaddress
import threading
import urllib.parse
import urllib.request
import urllib.error
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"   # overridden below by config/env/--lan
PORT = 8787          # overridden below by config/env (WEATHER_PORT)
PUBLIC_DIR = Path(__file__).parent / "public"

# NWS requires a descriptive User-Agent with contact info.
USER_AGENT = "WeatherDashboard/1.0 (local personal use)"

# Optional config (e.g. a Google Pollen API key). Looks at the environment first,
# then a config.json next to this file. Everything works without it.
import os

CONFIG = {}
_cfg_path = Path(__file__).parent / "config.json"
if _cfg_path.is_file():
    try:
        CONFIG = json.loads(_cfg_path.read_text("utf-8"))
    except Exception:
        CONFIG = {}


def config_get(key):
    return os.environ.get(key.upper()) or CONFIG.get(key)


# ---------------------------------------------------------------------------
# Network binding + security
# ---------------------------------------------------------------------------
# Resolve the bind host. Default is loopback-only (safest). LAN access is
# strictly opt-in via `--lan`, WEATHER_HOST=0.0.0.0, or config {"host": ...}.
def resolve_host():
    import sys
    if "--lan" in sys.argv:
        return "0.0.0.0"
    return config_get("weather_host") or "127.0.0.1"


def resolve_token():
    import sys
    # `--token VALUE` on the command line, else env/config.
    if "--token" in sys.argv:
        i = sys.argv.index("--token")
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return config_get("access_token")


ACCESS_TOKEN = resolve_token()

try:
    PORT = int(config_get("weather_port") or PORT)
except (TypeError, ValueError):
    pass


def is_private_client(addr):
    """True if the connecting client is on a loopback/private/link-local network.
    This is the core safeguard: even bound to 0.0.0.0, we only serve LAN peers."""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_private or ip.is_link_local


def lan_ips():
    """Best-effort list of this machine's LAN IPv4 addresses (for the startup banner)."""
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no packets actually sent; picks the primary iface
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:
        pass
    return sorted(ips)


# ---------------------------------------------------------------------------
# Tiny in-memory TTL cache (thread-safe enough for a single-user local app)
# ---------------------------------------------------------------------------
_cache = {}
_cache_lock = threading.Lock()


def cache_get(key):
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry[0] > time.time():
            return entry[1]
        if entry:
            _cache.pop(key, None)
    return None


def cache_set(key, value, ttl):
    with _cache_lock:
        _cache[key] = (time.time() + ttl, value)


def fetch_json(url, ttl=600, headers=None, tries=3):
    """GET a URL and parse JSON, with caching by URL.

    Open-Meteo is load-balanced, so a transient 502/503 usually means a single
    unhealthy node — retry a couple times (also on network errors) so brief
    blips self-heal instead of bubbling up as a failed load.
    """
    cached = cache_get(url)
    if cached is not None:
        return cached
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    last_err = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            cache_set(url, data, ttl)
            return data
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code < 500 and e.code != 429:
                raise  # 4xx: a real client error, don't retry
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_err = e
        if i < tries - 1:
            time.sleep(0.5 * (i + 1))
    raise last_err


# ---------------------------------------------------------------------------
# Upstream API builders
# ---------------------------------------------------------------------------
FORECAST_BASE = "https://api.open-meteo.com/v1/forecast"
AQI_BASE = "https://air-quality-api.open-meteo.com/v1/air-quality"
GEOCODE_BASE = "https://geocoding-api.open-meteo.com/v1/search"
REVERSE_BASE = "https://api.bigdatacloud.net/data/reverse-geocode-client"
NWS_ALERTS = "https://api.weather.gov/alerts/active"
# MeteoAlarm (free CAP feeds, Europe). No CORS headers, so this only works
# server-side — the browser-only standalone build can't call it directly.
METEOALARM_BASE = "https://feeds.meteoalarm.org/api/v1/warnings/feeds-"
METEOALARM_SLUGS = {
    "AT": "austria", "BE": "belgium", "BA": "bosnia-herzegovina", "BG": "bulgaria",
    "HR": "croatia", "CY": "cyprus", "CZ": "czechia", "DK": "denmark", "EE": "estonia",
    "FI": "finland", "FR": "france", "DE": "germany", "GR": "greece", "HU": "hungary",
    "IS": "iceland", "IE": "ireland", "IL": "israel", "IT": "italy", "LV": "latvia",
    "LT": "lithuania", "LU": "luxembourg", "MT": "malta", "MD": "moldova",
    "ME": "montenegro", "NL": "netherlands", "MK": "north-macedonia", "NO": "norway",
    "PL": "poland", "PT": "portugal", "RO": "romania", "RS": "serbia", "SK": "slovakia",
    "SI": "slovenia", "ES": "spain", "SE": "sweden", "CH": "switzerland",
    "GB": "united-kingdom",
}
RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json"

CURRENT_FIELDS = ",".join([
    "temperature_2m", "relative_humidity_2m", "apparent_temperature", "is_day",
    "precipitation", "rain", "showers", "snowfall", "weather_code", "cloud_cover",
    "pressure_msl", "surface_pressure", "wind_speed_10m", "wind_direction_10m",
    "wind_gusts_10m", "dew_point_2m",
])
HOURLY_FIELDS = ",".join([
    "temperature_2m", "apparent_temperature", "precipitation_probability",
    "precipitation", "weather_code", "wind_speed_10m", "wind_gusts_10m",
    "wind_direction_10m", "relative_humidity_2m", "uv_index", "visibility",
    "is_day",
])
DAILY_FIELDS = ",".join([
    "weather_code", "temperature_2m_max", "temperature_2m_min",
    "apparent_temperature_max", "apparent_temperature_min", "sunrise", "sunset",
    "uv_index_max", "precipitation_sum", "rain_sum", "showers_sum",
    "snowfall_sum", "precipitation_probability_max", "wind_speed_10m_max",
    "wind_gusts_10m_max", "wind_direction_10m_dominant",
])
AQI_CURRENT = ",".join([
    "us_aqi", "european_aqi", "pm10", "pm2_5", "carbon_monoxide",
    "nitrogen_dioxide", "sulphur_dioxide", "ozone", "dust", "uv_index",
    "alder_pollen", "birch_pollen", "grass_pollen", "mugwort_pollen",
    "olive_pollen", "ragweed_pollen",
])
AQI_HOURLY = ",".join(["us_aqi", "european_aqi", "pm2_5", "pm10", "ozone"])


ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive"


def get_forecast(lat, lon, temp_unit, wind_unit, precip_unit):
    params = {
        "latitude": lat, "longitude": lon,
        "current": CURRENT_FIELDS, "hourly": HOURLY_FIELDS, "daily": DAILY_FIELDS,
        "minutely_15": "precipitation",
        "timezone": "auto", "forecast_days": 7, "past_days": 1,
        "temperature_unit": temp_unit, "wind_speed_unit": wind_unit,
        "precipitation_unit": precip_unit,
    }
    return fetch_json(f"{FORECAST_BASE}?{urllib.parse.urlencode(params)}", ttl=600)


def get_history(lat, lon, temp_unit, precip_unit):
    """Climate normals + records for today's date (from completed years) plus a
    recent ~35-day daily trend. All from Open-Meteo's free ERA5 archive."""
    today = date.today()
    start = date(today.year - 11, 1, 1)
    end = date(today.year - 1, 12, 31)
    arc_params = {
        "latitude": lat, "longitude": lon,
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
        "timezone": "auto", "temperature_unit": temp_unit, "precipitation_unit": precip_unit,
    }
    arc = fetch_json(f"{ARCHIVE_BASE}?{urllib.parse.urlencode(arc_params)}", ttl=86400)

    # Build climate stats for the current month/day within a +/-3 day window.
    d = arc.get("daily", {})
    times = d.get("time", [])
    tmax, tmin = d.get("temperature_2m_max", []), d.get("temperature_2m_min", [])
    prec = d.get("precipitation_sum", [])
    target_doy = today.timetuple().tm_yday
    highs, lows = [], []
    rec_high = rec_low = rec_wet = None
    exact = {}  # year -> {high, low} for the exact calendar date
    for i, ts in enumerate(times):
        try:
            dd = date.fromisoformat(ts)
        except ValueError:
            continue
        doy = dd.timetuple().tm_yday
        dist = min(abs(doy - target_doy), 365 - abs(doy - target_doy))
        if dist > 3:
            continue
        hi, lo = tmax[i], tmin[i]
        pr = prec[i] if i < len(prec) else None
        if dd.month == today.month and dd.day == today.day:
            exact[dd.year] = {"high": hi, "low": lo, "precip": pr}
        if hi is not None:
            highs.append(hi)
            if rec_high is None or hi > rec_high[0]:
                rec_high = (hi, dd.year)
        if lo is not None:
            lows.append(lo)
            if rec_low is None or lo < rec_low[0]:
                rec_low = (lo, dd.year)
        if pr is not None and (rec_wet is None or pr > rec_wet[0]):
            rec_wet = (pr, dd.year)

    def mean(xs):
        return round(sum(xs) / len(xs), 1) if xs else None

    last_year = exact.get(today.year - 1)
    normals = {
        "high": mean(highs), "low": mean(lows),
        "record_high": rec_high[0] if rec_high else None,
        "record_high_year": rec_high[1] if rec_high else None,
        "record_low": rec_low[0] if rec_low else None,
        "record_low_year": rec_low[1] if rec_low else None,
        "wettest": round(rec_wet[0], 1) if rec_wet else None,
        "wettest_year": rec_wet[1] if rec_wet else None,
        "last_year_high": last_year["high"] if last_year else None,
        "last_year_low": last_year["low"] if last_year else None,
        "years": today.year - 1 - (today.year - 11),
    }

    # Recent ~35-day daily actuals for the trend chart.
    rec_params = {
        "latitude": lat, "longitude": lon,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
        "past_days": 35, "forecast_days": 1, "timezone": "auto",
        "temperature_unit": temp_unit, "precipitation_unit": precip_unit,
    }
    rec = fetch_json(f"{FORECAST_BASE}?{urllib.parse.urlencode(rec_params)}", ttl=3600)
    rd = rec.get("daily", {})
    recent = {
        "time": rd.get("time", []),
        "tmax": rd.get("temperature_2m_max", []),
        "tmin": rd.get("temperature_2m_min", []),
        "precip": rd.get("precipitation_sum", []),
    }
    return {"normals": normals, "recent": recent,
            "units": {"temp": arc.get("daily_units", {}).get("temperature_2m_max", "")}}


MARINE_BASE = "https://marine-api.open-meteo.com/v1/marine"
POLLEN_BASE = "https://pollen.googleapis.com/v1/forecast:lookup"

MARINE_CURRENT = ",".join([
    "wave_height", "wave_direction", "wave_period", "wind_wave_height",
    "swell_wave_height", "swell_wave_period", "swell_wave_direction",
    "sea_surface_temperature",
])


def get_marine(lat, lon, temp_unit):
    """Wave/swell/sea-temp from Open-Meteo Marine API. Returns
    {available: False} for inland points (no marine grid coverage)."""
    params = {
        "latitude": lat, "longitude": lon, "current": MARINE_CURRENT,
        "timezone": "auto", "temperature_unit": temp_unit,
    }
    try:
        data = fetch_json(f"{MARINE_BASE}?{urllib.parse.urlencode(params)}", ttl=1800)
    except Exception:
        return {"available": False}
    cur = data.get("current", {})
    if cur.get("wave_height") is None and cur.get("sea_surface_temperature") is None:
        return {"available": False}
    return {"available": True, "current": cur, "units": data.get("current_units", {})}


def get_pollen(lat, lon):
    """Global pollen via Google Pollen API — only if a key is configured.
    Returns {enabled: False} otherwise (Europe pollen still comes from AQI)."""
    key = config_get("google_pollen_key")
    if not key:
        return {"enabled": False}
    params = {
        "key": key, "location.latitude": lat, "location.longitude": lon,
        "days": 1, "plantsDescription": "false",
    }
    try:
        data = fetch_json(f"{POLLEN_BASE}?{urllib.parse.urlencode(params)}", ttl=3600)
    except Exception as e:
        return {"enabled": True, "error": str(e)}
    out = []
    daily = (data.get("dailyInfo") or [{}])[0]
    for p in daily.get("pollenTypeInfo", []):
        idx = p.get("indexInfo") or {}
        out.append({
            "code": p.get("code"), "name": p.get("displayName"),
            "in_season": p.get("inSeason"),
            "value": idx.get("value"), "category": idx.get("category"),
            "color": idx.get("color"),
        })
    return {"enabled": True, "types": out}


def get_air_quality(lat, lon):
    params = {
        "latitude": lat, "longitude": lon,
        "current": AQI_CURRENT, "hourly": AQI_HOURLY,
        "timezone": "auto", "forecast_days": 2,
    }
    return fetch_json(f"{AQI_BASE}?{urllib.parse.urlencode(params)}", ttl=1800)


def get_alerts(lat, lon):
    """US-only severe-weather alerts. Returns simplified list, [] on failure."""
    try:
        url = f"{NWS_ALERTS}?{urllib.parse.urlencode({'point': f'{lat},{lon}'})}"
        data = fetch_json(url, ttl=300)
    except Exception:
        return []
    out = []
    for feat in data.get("features", []):
        p = feat.get("properties", {})
        out.append({
            "event": p.get("event"), "severity": p.get("severity"),
            "urgency": p.get("urgency"), "certainty": p.get("certainty"),
            "headline": p.get("headline"), "description": p.get("description"),
            "instruction": p.get("instruction"), "sender": p.get("senderName"),
            "effective": p.get("effective"), "expires": p.get("expires"),
        })
    return out


def _point_in_polygon(px, py, poly_str):
    """Ray-casting test. poly_str is space-separated 'lat,lon' pairs."""
    pts = []
    for tok in poly_str.split():
        if "," not in tok:
            continue
        a, b = tok.split(",")[:2]
        try:
            pts.append((float(b), float(a)))  # (lon, lat) -> (x, y)
        except ValueError:
            continue
    n = len(pts)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _area_name_match(area_desc, admin1):
    """Best-effort match for warnings that carry a region name but no polygon
    (e.g. NUTS-coded countries). Conservative: only matches on a clear overlap."""
    if not area_desc or not admin1:
        return False
    a, b = area_desc.strip().lower(), admin1.strip().lower()
    return len(a) >= 3 and len(b) >= 3 and (a in b or b in a)


def meteoalarm_alerts(lat, lon, cc, admin1=None):
    """European severe-weather warnings (MeteoAlarm) for the point. [] if none.

    Precise where the feed provides polygons (point-in-polygon); for feeds that
    only carry region names (NUTS), falls back to a conservative name match so
    it never raises a false alarm — it just stays silent when it can't be sure.
    """
    slug = METEOALARM_SLUGS.get(cc)
    if not slug:
        return []
    try:
        data = fetch_json(METEOALARM_BASE + slug, ttl=600)
        px, py = float(lon), float(lat)
    except Exception:
        return []
    out, seen = [], set()
    for w in data.get("warnings", []):
        alert = w.get("alert") or {}
        infos = alert.get("info") or []
        eng = [i for i in infos if str(i.get("language", "")).lower().startswith("en")]
        for info in (eng or infos):
            areas = info.get("area") or []
            hit = any(_point_in_polygon(px, py, poly)
                      for a in areas for poly in (a.get("polygon") or []))
            if not hit:
                hit = any(_area_name_match(a.get("areaDesc"), admin1)
                          for a in areas if not a.get("polygon"))
            if not hit:
                continue
            event = info.get("event") or alert.get("incidents")
            key = (event, info.get("onset"), info.get("expires"))
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "event": event,
                "severity": (info.get("severity") or "").title() or None,
                "urgency": info.get("urgency"), "certainty": info.get("certainty"),
                "headline": info.get("headline") or (info.get("description") or "")[:140],
                "description": info.get("description"), "instruction": info.get("instruction"),
                "sender": info.get("senderName") or "MeteoAlarm",
                "effective": info.get("effective") or info.get("onset"),
                "expires": info.get("expires"),
            })
    return out


def reverse_geocode(lat, lon, lang="en"):
    try:
        params = {"latitude": lat, "longitude": lon, "localityLanguage": lang}
        d = fetch_json(f"{REVERSE_BASE}?{urllib.parse.urlencode(params)}", ttl=86400)
        return {
            "name": d.get("city") or d.get("locality") or d.get("principalSubdivision"),
            "admin1": d.get("principalSubdivision"),
            "country": d.get("countryName"),
            "country_code": d.get("countryCode"),
        }
    except Exception:
        return {"name": None}


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".json": "application/json",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter console
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path):
        if not path.is_file():
            self.send_error(404, "Not found")
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        # Dev server: don't let the browser cache app assets (ES modules cache
        # by URL, which otherwise serves stale JS after an edit). The service
        # worker still handles caching for the deployed/standalone build.
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    # --- Security ---------------------------------------------------------
    def _client_ip(self):
        return self.client_address[0] if self.client_address else ""

    def _has_valid_cookie(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "wt" and v == ACCESS_TOKEN:
                return True
        return False

    def _security_gate(self, parsed, q):
        """Returns True to proceed. Otherwise it has already written a response."""
        # 1) Only ever serve loopback/private-network clients.
        if not is_private_client(self._client_ip()):
            self.send_error(403, "Forbidden (this dashboard only serves local-network clients)")
            return False
        # 2) Optional shared token.
        if ACCESS_TOKEN:
            if q.get("key", [None])[0] == ACCESS_TOKEN:
                # Valid key in the URL: set a cookie and redirect to a clean URL.
                self.send_response(302)
                self.send_header("Location", parsed.path or "/")
                self.send_header("Set-Cookie", f"wt={ACCESS_TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return False
            if not self._has_valid_cookie():
                self._send_login()
                return False
        return True

    def _send_login(self):
        html = (
            "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            "<title>Weather — sign in</title>"
            "<style>body{font-family:system-ui;background:#0e1730;color:#eef2fb;display:grid;"
            "place-items:center;height:100vh;margin:0}form{background:rgba(255,255,255,.08);"
            "padding:28px;border-radius:18px;border:1px solid rgba(255,255,255,.15);text-align:center}"
            "input{padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.2);"
            "background:rgba(255,255,255,.06);color:#fff;font-size:1rem;width:200px}"
            "button{margin-top:12px;padding:12px 20px;border-radius:10px;border:0;background:#6fb7ff;"
            "color:#06203f;font-weight:700;cursor:pointer;width:100%}h2{margin:0 0 14px}</style>"
            "<form method=get action=/><h2>🌤 Weather</h2>"
            "<input name=key type=password placeholder='Access code' autofocus>"
            "<button>Enter</button></form>"
        ).encode("utf-8")
        self.send_response(401)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        q = urllib.parse.parse_qs(parsed.query)

        def arg(name, default=None):
            return q.get(name, [default])[0]

        if not self._security_gate(parsed, q):
            return

        try:
            if route == "/api/geocode":
                name = arg("q", "").strip()
                if not name:
                    return self._send_json({"results": []})
                lang = (arg("lang", "en") or "en")[:2].lower()
                params = {"name": name, "count": 8, "language": lang, "format": "json"}
                data = fetch_json(f"{GEOCODE_BASE}?{urllib.parse.urlencode(params)}", ttl=86400)
                return self._send_json(data)

            if route == "/api/reverse":
                return self._send_json(reverse_geocode(arg("lat"), arg("lon"), (arg("lang", "en") or "en")[:2].lower()))

            if route == "/api/radar":
                # RainViewer: past (~2h) + nowcast (~30min) radar frames for the
                # whole globe. The frontend builds tile layers from host+path.
                data = fetch_json(RAINVIEWER, ttl=240)
                return self._send_json(data)

            if route == "/api/history":
                lat, lon = arg("lat"), arg("lon")
                if lat is None or lon is None:
                    return self._send_json({"error": "lat and lon required"}, 400)
                imp = arg("units", "imperial") == "imperial"
                return self._send_json(get_history(
                    lat, lon,
                    "fahrenheit" if imp else "celsius",
                    "inch" if imp else "mm",
                ))

            if route == "/api/weather":
                lat, lon = arg("lat"), arg("lon")
                if lat is None or lon is None:
                    return self._send_json({"error": "lat and lon required"}, 400)
                temp_unit = "fahrenheit" if arg("units", "imperial") == "imperial" else "celsius"
                wind_unit = "mph" if arg("units", "imperial") == "imperial" else "kmh"
                precip_unit = "inch" if arg("units", "imperial") == "imperial" else "mm"
                cc = (arg("country_code") or "").upper()

                # Compact mode (used by the city comparison) — just current
                # conditions + AQI, skipping the heavy hourly/daily/marine/pollen
                # so it returns in one fast round-trip.
                if arg("compact") == "1":
                    cparams = {
                        "latitude": lat, "longitude": lon, "current": CURRENT_FIELDS,
                        "timezone": "auto", "forecast_days": 1,
                        "temperature_unit": temp_unit, "wind_speed_unit": wind_unit,
                        "precipitation_unit": precip_unit,
                    }
                    forecast = fetch_json(f"{FORECAST_BASE}?{urllib.parse.urlencode(cparams)}", ttl=600)
                    return self._send_json({
                        "forecast": forecast, "air_quality": get_air_quality(lat, lon),
                        "units": {"temp": temp_unit, "wind": wind_unit, "precip": precip_unit},
                        "fetched_at": int(time.time()),
                    })

                forecast = get_forecast(lat, lon, temp_unit, wind_unit, precip_unit)
                air = get_air_quality(lat, lon)
                alerts = get_alerts(lat, lon) if cc in ("US", "") else []
                if not alerts and cc not in ("US", ""):
                    alerts = meteoalarm_alerts(lat, lon, cc, arg("admin1"))
                marine = get_marine(lat, lon, temp_unit)
                pollen = get_pollen(lat, lon)

                return self._send_json({
                    "forecast": forecast, "air_quality": air, "alerts": alerts,
                    "marine": marine, "pollen": pollen,
                    "units": {"temp": temp_unit, "wind": wind_unit, "precip": precip_unit},
                    "fetched_at": int(time.time()),
                })

            # ---- static files ----
            rel = route.lstrip("/") or "index.html"
            base = PUBLIC_DIR.resolve()
            target = (base / rel).resolve()
            # Strict containment check — block any path traversal outside public/.
            if not target.is_relative_to(base):
                return self.send_error(403, "Forbidden")
            return self._send_file(target)

        except urllib.error.HTTPError as e:
            self._send_json({"error": f"upstream {e.code}", "detail": str(e)}, 502)
        except Exception as e:  # noqa
            self._send_json({"error": "server error", "detail": str(e)}, 500)


def main():
    host = resolve_host()
    lan = host == "0.0.0.0"
    server = ThreadingHTTPServer((host, PORT), Handler)

    print(f"\n  Weather Dashboard")
    print(f"  ----------------")
    print(f"  On this computer:   http://localhost:{PORT}")
    if lan:
        ips = lan_ips()
        if ips:
            print(f"\n  On your phone/tablet (same Wi-Fi):")
            for ip in ips:
                suffix = f"/?key={ACCESS_TOKEN}" if ACCESS_TOKEN else ""
                print(f"      http://{ip}:{PORT}{suffix}")
        print(f"\n  LAN mode: only private-network devices can connect.")
        if ACCESS_TOKEN:
            print(f"  Access code required (set). First visit must include /?key=...")
        else:
            print(f"  No access code set. Anyone on your Wi-Fi can view it.")
            print(f"  To require a code:  python server.py --lan --token YOURCODE")
        print(f"\n  Windows: if the phone can't connect, allow Python through the")
        print(f"  firewall on Private networks (one-time prompt, or see README).")
    else:
        print(f"\n  Localhost only (secure default). For phone access on your Wi-Fi:")
        print(f"      python server.py --lan")
    print(f"\n  Press Ctrl+C to stop.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.\n")
        server.shutdown()


if __name__ == "__main__":
    main()
