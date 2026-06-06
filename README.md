# 🌥 Castform — *weather, evolved*

> Named after the Pokémon that changes form with the weather (whose signature ability is **Forecast**) — fitting, since this dashboard re-themes itself to match the conditions.

A fancy, all-you-want-to-know weather dashboard built on free, keyless,
government-grade weather APIs. Runs locally in Chrome today; designed to run
on a Raspberry Pi in kiosk mode later. **Zero dependencies** — just Python.

![status](https://img.shields.io/badge/deps-none-brightgreen) ![python](https://img.shields.io/badge/python-3.8%2B-blue)

---

## What it shows

- **Current conditions** — temperature, feels-like, condition + animated icon, today's high/low,
  and a **comfort read** (heat index / wind chill + "muggy / crisp / comfortable" descriptor)
- **Metric tiles** — wind (speed, direction, gusts), humidity, **dew point**, UV index, pressure,
  cloud cover, visibility, current precipitation, air quality, PM2.5
- **Saved locations** — star any city into a favorites bar; switch between them in one click
- **Compare two cities** — side-by-side current conditions for any second city
- **Marine & surf** (coastal locations) — wave height, swell + period, wind waves, sea-surface temp
- **Desktop notifications** — opt-in alerts for imminent rain and NWS warnings
- **Customizable dashboard** — Settings → *Customize* to **hide, reorder, and resize cards**
  (drag to reorder or ↑↓; drag a card's corner to set its **width and height** — width snaps to the
  12-column grid, height is free; Hide/Show), remembered between visits; one-tap Reset restores the
  default. Heights stay content-driven until you change them, and on phones the grid is single-column
  so overrides are ignored — the layout stays clean with no dead space
- **Auto-refresh** every 10 minutes with an "updated" toast; **fullscreen kiosk** button for wall displays
- **Animated radar time-lapse** — live precipitation radar on a dark map (RainViewer + Leaflet)
  with play/pause, a scrubber, and speed control, so you can watch storms move into the area.
  Includes short-term forecast frames, crossfades, **click-anywhere-to-load** that point's weather,
  and a **Radar / Satellite** toggle. Satellite uses **NASA GIBS** true-color imagery (last 6 days
  as a daily time-lapse).
- **"Rain starting in ~X min" nowcast banner** — scans Open-Meteo's 15-minute precipitation to
  tell you when rain is about to start, ease, or stop in the next 2 hours.
- **Historical reference** — today's high vs. the **climate normal** for this date, record
  high/low (from ~10 years of ERA5 reanalysis), **this-day-in-history** facts (one year ago,
  hottest ever, wettest on record), and a 35-day trend chart against the normal band.
- **Lively ambient effects** — weather-reactive sky themes, drifting clouds, falling snow,
  lightning flashes in thunderstorms, twinkling stars at night, and a rain overlay.
- **Next 48 hours** — interactive temperature curve + precipitation-probability bars (Chart.js),
  plus a scrollable hourly icon strip
- **7-day forecast** — high/low temperature bars, precip %, wind, UV per day
- **Air quality** — US AQI (or European AQI outside the US) with a colored dial, category &
  health guidance, and a full pollutant breakdown (PM2.5, PM10, O₃, NO₂, SO₂, CO).
  Pollen is shown automatically where available (Europe).
- **Sun & daylight** — animated sun-arc with sunrise, sunset, day length, **golden-hour** window,
  **moon phase** + illumination, and **daylight gained/lost** vs yesterday
- **Severe-weather alerts** — official NWS watches/warnings overlay (US locations)
- **Islamic prayer times** *(optional, enable in Settings)* — the five daily prayers + sunrise
  with a "now / next" countdown, computed offline from solar geometry (calculation method
  auto-detected by region, Standard Asr). Replaces the Sun card when on, folding the sun/moon
  details back in, plus a **Qibla compass** (bearing + distance to the Kaaba) with an optional
  live needle that rotates with your phone.
- **Anywhere on Earth** — search any city; the page theme + background animate to match
  the weather (sun, clouds, rain overlay, snow, storm) and day/night.

## Data sources (all free, no API key)

| Source | Used for | Coverage |
|--------|----------|----------|
| [Open-Meteo](https://open-meteo.com) | current / hourly / daily forecast | Global |
| [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) | AQI, pollutants, pollen | Global |
| [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) | city search | Global |
| [RainViewer](https://www.rainviewer.com/api.html) | animated precipitation radar + satellite tiles | Global |
| [Open-Meteo Archive (ERA5)](https://open-meteo.com/en/docs/historical-weather-api) | climate normals, records, trend | Global, 1940→ |
| [Open-Meteo Marine](https://open-meteo.com/en/docs/marine-weather-api) | waves, swell, sea-surface temp | Global oceans/coasts |
| [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) | true-color satellite imagery | Global |
| Google Pollen *(optional, keyed)* | global pollen index | Global |
| [NWS / weather.gov](https://www.weather.gov/documentation/services-web-api) | severe-weather alerts | United States |
| BigDataCloud | reverse-geocode "my location" | Global |

The browser only ever talks to **localhost** — the Python server proxies and
caches the upstream APIs.

---

## Run it

```sh
python server.py
```

Then open **http://localhost:8787** in Chrome.

That's it — no `pip install`, no build step, no Node. Requires Python 3.8+.

- Search any city in the top bar, or click **📍**.
- Star a city (**☆**) to pin it to the favorites bar.
- Toggle **°F / °C** (units, wind speed, and precipitation switch together).
- Your last city, favorites, and unit choice are remembered between visits.

### View it on your phone (same Wi-Fi)

By default the server is **localhost-only** — nothing else on your network can reach it.
To open it on a phone or tablet on the same Wi-Fi, start it in LAN mode:

```sh
python server.py --lan
```

It prints the exact address to type on your phone, e.g. `http://192.168.1.42:8787`.

**Security model** (LAN mode stays safe):
- **Private-network only.** Even in `--lan` mode the server refuses any client that isn't on
  a private/LAN IP range. If your laptop later joins public Wi-Fi, the dashboard is unreachable
  to strangers — no extra step needed.
- **Optional access code.** Add a shared password so only people who know it can view it:
  ```sh
  python server.py --lan --token YOURCODE
  ```
  First visit on the phone uses `http://<ip>:8787/?key=YOURCODE`; it sets a cookie and you won't
  retype it. (You can also set `access_token` in `config.json`.)
- **Path-traversal hardened** static file serving; the browser only talks to your own machine.

**Two notes:**
- **Windows Firewall** may prompt the first time — allow Python on **Private** networks. If you
  dismissed it, re-run the prompt or add a rule: *Windows Security → Firewall → Allow an app*.
- **"📍 My location" needs HTTPS**, so it's disabled over plain `http://` on the phone — just
  search your city instead (it's remembered after that). Everything else works normally.

Config keys: `host`/`WEATHER_HOST`, `weather_port`/`WEATHER_PORT`, `access_token`/`ACCESS_TOKEN`.

### Optional: global pollen

Pollen everywhere needs a free Google **Pollen API** key (Europe pollen works without it).
To enable it, create a `config.json` next to `server.py`:

```json
{ "google_pollen_key": "YOUR_KEY_HERE" }
```

…or set the `GOOGLE_POLLEN_KEY` environment variable. Without it, the dashboard simply
shows Europe pollen (from Open-Meteo) where available and skips the global panel.

---

## How it's built

```
weather/
├── server.py            # zero-dependency Python stdlib server: API proxy + cache + static host
└── public/
    ├── index.html
    ├── css/styles.css   # glassmorphism UI, animated sky themes
    └── js/
        ├── app.js       # fetch + render everything
        ├── wmo.js       # WMO weather-code → label/theme + self-contained SVG icons
        ├── prayer.js    # offline prayer-time + Qibla calculation (no deps)
        └── chart.umd.min.js   # vendored Chart.js (no CDN)
```

Responses are cached in-memory (weather 10 min, air quality 30 min, alerts 5 min,
geocoding 24 h) so it's gentle on the upstream APIs and snappy to use.

---

## Tests

A zero-dependency regression suite (Python standard-library `unittest`, fully
offline — no network calls) guards the logic that's easy to break silently:
the LAN security gate, the TTL cache, `fetch_json` retry/back-off behaviour,
MeteoAlarm point-in-polygon matching, and the frontend build pipeline (no ES
`import` leaks into the inlined standalone bundle, cache-bust versions stay in
sync, the manifest/service-worker only reference files that exist).

```bash
python -m unittest discover -s tests -v
```

Tests run automatically in CI on every push and pull request
(`.github/workflows/tests.yml`), and a passing run **gates the Pages deploy**
(`pages.yml` runs the suite before building). **Every code change should add or
update a test and run the suite green before committing.**

---

## Roadmap → Raspberry Pi

The web app already runs unchanged on a full **Raspberry Pi (3/4/5)** — Python and
Chromium are preinstalled on Raspberry Pi OS:

1. Copy this folder to the Pi.
2. `python server.py`
3. Launch Chromium in kiosk mode pointed at the dashboard:
   ```sh
   chromium-browser --kiosk --incognito http://localhost:8787
   ```
4. (Optional) Add a `systemd` service so it starts on boot.

> **Note on the Raspberry Pi _Pico_:** the Pico is a microcontroller — it can't run a
> browser or this server. If you want the Pico specifically, that's a separate, stripped-down
> build (e.g. MicroPython fetching a couple of Open-Meteo fields and driving a small e-ink/LCD
> display). The dashboard here targets a full Pi; we can branch a Pico version when you're ready.

## Ideas for later

- Hourly satellite/IR loop (GIBS GOES/Himawari) for a faster-than-daily cloud time-lapse
- Lightning-strike data overlay; storm-cell tracking
- Weather-history explorer (pick any past date/range)
- Per-location notification rules (e.g. "warn me only above 90°F" or specific alert types)
- Webcam / sky-camera embeds for saved locations
