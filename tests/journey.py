# Browser-driven customer-journey harness (Playwright + Chromium).
#
# Why this exists: our Python/Node tests check logic and static wiring, but they
# cannot see COMPUTED CSS or layout — so bugs like "the settings sheet collapses
# to 0 height" or "a hidden card doesn't actually disappear" sailed through green
# suites. These tests drive the REAL app in a real browser and assert on rendered
# geometry/visibility, which is the only thing that catches that class of bug.
#
# Determinism: the real server.py serves the static app, but every /api/* call is
# intercepted and answered from tests/fixtures/*.json (no network, stable data).
# The browser clock is frozen and the timezone pinned so "now"-relative rendering
# (current hour, prayer current/next, "Updated" stamp) is reproducible forever.
#
# The whole module skips cleanly when Playwright isn't installed, so the existing
# `python -m unittest` run stays green on machines/CI without it. CI installs it
# explicitly (see .github/workflows/tests.yml).

import json
import os
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"

try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT = True
except Exception:  # pragma: no cover - environment without playwright
    PLAYWRIGHT = False

# The fixtures were captured for 2026-06-08 in Asia/Dubai (+04:00). Freezing the
# browser to noon-Dubai that day lands "now" in the middle of the data window, so
# the current hour, daily "Today", and prayer current/next all resolve sensibly.
TZ = "Asia/Dubai"
FROZEN_UTC = "2026-06-08T08:00:00Z"          # 12:00 in Asia/Dubai
DUBAI = {"name": "Dubai", "admin1": "Dubai", "country": "United Arab Emirates",
         "country_code": "AE", "lat": 25.2, "lon": 55.27}


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@unittest.skipUnless(PLAYWRIGHT, "playwright not installed (pip install playwright; playwright install chromium)")
class JourneyTest(unittest.TestCase):
    """Base class: one server + one browser for the whole class; fresh page per test."""

    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        env = {**os.environ, "WEATHER_PORT": str(cls.port)}
        cls.server = subprocess.Popen(
            [sys.executable, "server.py"], cwd=str(ROOT), env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls._wait_for_server()
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch()
        # Pre-load fixtures once.
        cls.fx = {
            "weather": _load("weather.json"),
            "weather_metric": _load("weather_metric.json"),
            "weather_compact": _load("weather_compact.json"),
            "geocode": _load("geocode.json"),
            "reverse": _load("reverse.json"),
            "history": _load("history.json"),
        }

    @classmethod
    def _wait_for_server(cls):
        import urllib.request
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + "/", timeout=1).read()
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("server.py did not come up on the test port")

    @classmethod
    def tearDownClass(cls):
        try:
            cls.browser.close()
            cls._pw.stop()
        finally:
            cls.server.terminate()
            try:
                cls.server.wait(timeout=5)
            except Exception:
                cls.server.kill()

    # --- per-test page ----------------------------------------------------
    def new_page(self, viewport=None, place=DUBAI, geo=None, storage=None):
        """A page with frozen clock, pinned tz, /api/* mocked, and (optionally) a
        seeded last-place so the app boots straight into a loaded dashboard.
        `geo`, if given as (lat, lon), makes navigator.geolocation succeed.
        `storage` seeds arbitrary localStorage keys (values JSON-encoded)."""
        vp = viewport or {"width": 1100, "height": 900}
        ctx = self.browser.new_context(viewport=vp, timezone_id=TZ)
        self.addCleanup(ctx.close)
        self._route(ctx)
        # Kill CSS animations/transitions in tests. The frozen clock freezes CSS
        # entry animations at their FIRST keyframe (e.g. the settings overlay's
        # fadeIn starts at translateY(8px)/opacity 0), which shifts geometry and
        # breaks hit-testing. Forcing them to their end state makes layout stable.
        ctx.add_init_script(
            "const s=document.createElement('style');"
            "s.textContent='*,*::before,*::after{animation:none!important;"
            "transition:none!important;scroll-behavior:auto!important}';"
            "(document.head||document.documentElement).appendChild(s);"
        )
        seed = dict(storage or {})
        if place is not None:
            seed.setdefault("place", place)
        for k, v in seed.items():
            val = v if isinstance(v, str) else json.dumps(v)
            ctx.add_init_script(f"try{{localStorage.setItem({json.dumps(k)}, {json.dumps(val)})}}catch(e){{}}")
        if geo is not None:
            lat, lon = geo
            ctx.add_init_script(
                "navigator.geolocation.getCurrentPosition = (ok) => ok({coords:{latitude:%f,longitude:%f}});" % (lat, lon)
            )
        page = ctx.new_page()
        page.clock.install(time=FROZEN_UTC)
        return page

    def _route(self, ctx):
        fx = self.fx

        def handler(route):
            url = route.request.url
            try:
                if "/api/weather" in url:
                    if "compact=1" in url:
                        body = fx["weather_compact"]
                    elif "units=metric" in url:
                        body = fx["weather_metric"]
                    else:
                        body = fx["weather"]
                elif "/api/geocode" in url:
                    body = fx["geocode"]
                elif "/api/reverse" in url:
                    body = fx["reverse"]
                elif "/api/history" in url:
                    body = fx["history"]
                else:
                    body = {}                      # radar / aqi / anything else → empty 200
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps(body))
            except Exception:
                route.fulfill(status=200, content_type="application/json", body="{}")

        # Mock same-origin API + any cross-origin data/tiles so tests never touch
        # the network (map tiles just render blank, which is fine for assertions).
        ctx.route("**/api/**", handler)
        ctx.route("**/*.png", lambda r: r.fulfill(status=200, content_type="image/png", body=b""))

    def boot(self, **kw):
        """Open the app and wait until the dashboard has rendered (not the spinner).
        Advances the frozen clock a beat so number-count-up animations (which use
        requestAnimationFrame / performance.now, both faked by the frozen clock)
        settle to their final values before we assert on them."""
        page = self.new_page(**kw)
        page.goto(self.base + "/", wait_until="domcontentloaded")
        # #content visible (loading screen hidden) means a forecast rendered.
        page.wait_for_selector("#content:not(.hidden)", timeout=8000)
        page.clock.run_for(1500)
        return page

    # --- small assertion helpers -----------------------------------------
    def visible_box(self, page, selector):
        """Bounding box of a selector, or None if absent/zero-area."""
        return page.locator(selector).first.bounding_box()
