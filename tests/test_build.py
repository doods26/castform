"""Regression tests for the frontend build pipeline & static-asset integrity.

These guard the things that silently break a static deploy: an ES `import`
surviving into the inlined standalone bundle, a cache-bust version drifting
between CSS and JS, a manifest/service-worker referencing a missing file.

Offline & side-effect-free: the standalone bundle is assembled in memory
(the real bundler functions) without writing the committed artifacts.
"""
import json
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"
sys.path.insert(0, str(ROOT))

import build_standalone as bs  # noqa: E402


class BundleModuleTests(unittest.TestCase):
    def test_strips_import_statement(self):
        src = 'import { a, b } from "./x.js";\nconst y = a + b;\n'
        out = bs.bundle_module(src, is_entry=True)
        self.assertNotIn("import {", out)
        self.assertIn("const { a, b } = __NS__;", out)

    def test_strips_export_keyword_and_publishes_ns(self):
        src = "export function foo(){}\nexport const bar = 1;\n"
        out = bs.bundle_module(src, is_entry=False)
        self.assertNotIn("export ", out)
        self.assertIn("function foo()", out)
        self.assertIn("Object.assign(__NS__,", out)
        self.assertIn("bar", out)
        self.assertIn("foo", out)

    def test_wrapped_in_iife(self):
        out = bs.bundle_module("const x = 1;", is_entry=False)
        self.assertTrue(out.strip().startswith("(function(){"))
        self.assertTrue(out.strip().endswith("})();"))


class StandaloneBundleTests(unittest.TestCase):
    """Reproduce main()'s JS assembly in memory and assert the invariants."""

    def _assemble_js(self):
        libs = ["js/wmo.js", "js/gauge.js", "js/effects.js", "js/radar.js", "js/prayer.js"]
        parts = ["const __NS__ = {};", bs.read("js/standalone-api.js")]
        for rel in libs:
            parts.append(bs.bundle_module(bs.read(rel), is_entry=False))
        parts.append(bs.bundle_module(bs.read("js/app.js"), is_entry=True))
        return "\n".join(parts)

    def test_no_es_imports_survive(self):
        js = self._assemble_js()
        # A surviving bare `import {...} from` would throw in a <script> tag.
        self.assertFalse(re.search(r'^\s*import\s*\{', js, re.M),
                         "an ES import survived into the inlined bundle")

    def test_no_bare_export_survives(self):
        js = self._assemble_js()
        self.assertFalse(re.search(r'^\s*export\s', js, re.M),
                         "a bare export survived into the inlined bundle")

    def test_bundle_is_substantial(self):
        # Guards against a silently-empty read producing a broken build.
        self.assertGreater(len(self._assemble_js()), 20_000)


class IndexAssetVersionTests(unittest.TestCase):
    def test_css_and_js_cache_bust_match(self):
        html = (PUB / "index.html").read_text(encoding="utf-8")
        css = re.search(r'styles\.css\?b=(\d+)', html)
        app = re.search(r'app\.js\?b=(\d+)', html)
        self.assertIsNotNone(css, "styles.css cache-bust marker missing")
        self.assertIsNotNone(app, "app.js cache-bust marker missing")
        self.assertEqual(css.group(1), app.group(1),
                         "styles.css and app.js cache-bust versions drifted apart")
        # The footer "build N" stamp must equal the cache-bust, so the number a
        # user reads on screen identifies exactly which assets they're running.
        build = re.search(r"const BUILD\s*=\s*(\d+)", (PUB / "js" / "app.js").read_text(encoding="utf-8"))
        self.assertIsNotNone(build, "BUILD constant missing from app.js")
        self.assertEqual(build.group(1), css.group(1),
                         "BUILD number is out of sync with the ?b= cache-bust")


class ManifestTests(unittest.TestCase):
    def test_manifest_is_valid_and_complete(self):
        m = json.loads((PUB / "manifest.json").read_text(encoding="utf-8"))
        for key in ("name", "start_url", "display", "icons"):
            self.assertIn(key, m)
        self.assertTrue(m["icons"])

    def test_manifest_icons_exist(self):
        m = json.loads((PUB / "manifest.json").read_text(encoding="utf-8"))
        for icon in m["icons"]:
            self.assertTrue((PUB / icon["src"]).is_file(),
                            f"manifest icon missing: {icon['src']}")


class ServiceWorkerTests(unittest.TestCase):
    def test_precached_shell_files_exist(self):
        sw = (PUB / "sw.js").read_text(encoding="utf-8")
        shell = re.search(r"const SHELL = \[(.*?)\]", sw, re.S).group(1)
        refs = re.findall(r'"\./([^"]*)"', shell)
        for ref in refs:
            if ref in ("", "index.html"):
                continue  # "./" and root are served, not files on disk per se
            # icons are generated at build time; only assert source files here.
            if ref.endswith(".png"):
                continue
            self.assertTrue((PUB / ref).is_file(), f"sw.js precaches missing file: {ref}")


class ReferencedModulesExistTests(unittest.TestCase):
    def test_all_index_scripts_and_styles_exist(self):
        html = (PUB / "index.html").read_text(encoding="utf-8")
        for rel in re.findall(r'(?:src|href)="/([^"?]+)"', html):
            # Skip vendored/CDN and generated paths; check our own js/css.
            if rel.startswith(("js/", "css/")):
                self.assertTrue((PUB / rel).is_file(), f"index.html references missing: {rel}")


class MobilePwaTests(unittest.TestCase):
    """Guard the iPhone/PWA mobile optimizations from silently regressing."""

    def _html(self):
        return (PUB / "index.html").read_text(encoding="utf-8")

    def _css(self):
        return (PUB / "css" / "styles.css").read_text(encoding="utf-8")

    def test_viewport_opts_into_safe_area(self):
        # viewport-fit=cover is what lets env(safe-area-inset-*) report real
        # values on notched iPhones; without it the insets are always 0.
        self.assertIn("viewport-fit=cover", self._html())

    def test_apple_pwa_meta_present(self):
        html = self._html()
        for needle in ('name="apple-mobile-web-app-capable"',
                       'rel="apple-touch-icon"',
                       'rel="manifest"'):
            self.assertIn(needle, html, f"missing PWA meta/link: {needle}")

    def test_css_respects_safe_area_insets(self):
        # The notch / Dynamic Island / home-indicator handling. If someone
        # strips these, content slides under the iPhone status bar again.
        css = self._css()
        self.assertIn("env(safe-area-inset-top)", css)
        self.assertIn("env(safe-area-inset-bottom)", css)

    def test_avoids_dvh_units(self):
        # REGRESSION GUARD: `dvh` can resolve to ~0 in an iOS standalone PWA,
        # collapsing the element to zero height (it broke the settings sheet —
        # the backdrop showed but the panel was invisible). Stick to vh.
        self.assertNotIn("dvh", self._css(),
                         "avoid dvh — it collapses to 0 in the iOS standalone PWA")

    def test_mobile_inputs_avoid_ios_focus_zoom(self):
        # iOS zooms the whole page when focusing an input rendered under 16px.
        # The phones breakpoint pins the search inputs to 16px to prevent it.
        css = self._css()
        block = re.search(r"@media \(max-width: 600px\) \{(.*?)\n\}", css, re.S)
        self.assertIsNotNone(block, "phones (max-width:600px) breakpoint missing")
        self.assertRegex(block.group(1), r"\.search input\s*\{[^}]*font-size:\s*16px")


class ActivityHintTests(unittest.TestCase):
    """Guard the forward-looking activity-outlook banner wiring."""

    def _app_js(self):
        return (PUB / "js" / "app.js").read_text(encoding="utf-8")

    def test_banner_element_present(self):
        html = (PUB / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="activityHint"', html)

    def test_render_and_decision_functions_defined(self):
        js = self._app_js()
        self.assertRegex(js, r"function renderActivityHint\(")
        self.assertRegex(js, r"function activityOutlook\(")

    def test_hint_rendered_on_both_paths(self):
        # Must fire on initial render AND on a unit-only rerender, or the banner
        # goes stale (e.g. shows °F thresholds after switching to °C).
        js = self._app_js()
        self.assertGreaterEqual(len(re.findall(r"renderActivityHint\(f\)", js)), 2,
                                "renderActivityHint must run on both render and rerender")

    def test_outlook_bundled_into_standalone(self):
        # The decision logic must survive into the inlined static build.
        bundle = (ROOT / "standalone.html").read_text(encoding="utf-8")
        self.assertIn("activityOutlook", bundle)


class SettingsSheetTests(unittest.TestCase):
    """Guard the iOS-PWA settings-sheet fixes (scroll-lock + reachable rows)."""

    def test_background_scroll_locked_when_open(self):
        css = (PUB / "css" / "styles.css").read_text(encoding="utf-8")
        self.assertRegex(css, r"body\.settings-open\s*\{[^}]*overflow:\s*hidden")

    def test_settings_scroll_is_contained(self):
        # overscroll-behavior keeps touch scroll from chaining to the page. The
        # overlay is now the scroll container, so containment lives there.
        css = (PUB / "css" / "styles.css").read_text(encoding="utf-8")
        self.assertRegex(css, r"\.settings-overlay\s*\{[^}]*overscroll-behavior:\s*contain")

    def test_settings_sheet_cannot_collapse_to_zero(self):
        # REGRESSION (twice-bitten): the settings sheet kept vanishing in the iOS
        # standalone PWA — only the dimmed backdrop showed. Root cause: its height
        # was bounded by a value that resolves to ~0 in that webview (first dvh,
        # then vh; even max-height:100% shares the failure mode if the parent's
        # height resolves to 0). The fix removes ALL height bounds from the panel
        # and makes the OVERLAY the scroll container. The overlay is
        # position:fixed; inset:0 — pinned to the real viewport, never zero — so:
        #   1. the panel must NOT bound its height (no max-height at all), and
        #   2. the overlay must scroll (overflow-y:auto) and stay fixed/inset:0.
        css = (PUB / "css" / "styles.css").read_text(encoding="utf-8")
        for m in re.finditer(r"\.settings-panel\s*\{([^}]*)\}", css):
            self.assertNotRegex(
                m.group(1), r"max-height",
                "the settings panel must not bound its height — let the overlay scroll")
        overlay = re.search(r"\.settings-overlay\s*\{([^}]*)\}", css)
        self.assertIsNotNone(overlay, ".settings-overlay rule missing")
        body = overlay.group(1)
        self.assertRegex(body, r"position:\s*fixed")
        self.assertRegex(body, r"inset:\s*0")
        self.assertRegex(body, r"overflow-y:\s*auto",
                         "overlay must scroll so a tall panel is reachable")

    def test_js_toggles_scroll_lock_class(self):
        js = (PUB / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn('classList.add("settings-open")', js)
        self.assertIn('classList.remove("settings-open")', js)

    def test_sw_serves_html_network_first(self):
        # Otherwise the installed PWA serves a stale index.html and never picks
        # up new cache-busted CSS/JS — the reason updates didn't reach the app.
        sw = (PUB / "sw.js").read_text(encoding="utf-8")
        self.assertIn('req.mode === "navigate"', sw)


class PrayerCardTests(unittest.TestCase):
    """Static wiring for the prayer-times card, Qibla, and install button."""

    def test_prayer_module_exports(self):
        js = (PUB / "js" / "prayer.js").read_text(encoding="utf-8")
        for fn in ("prayerTimes", "qiblaBearing", "qiblaDistanceKm",
                   "compass16", "methodForCountry", "currentAndNext", "METHODS"):
            self.assertRegex(js, rf"export\s+(?:function\s+|const\s+){fn}\b",
                             f"prayer.js must export {fn}")

    def test_app_handles_sunrise_gap(self):
        # The card must use currentAndNext and render a "no prayer" state during
        # the sunrise→Dhuhr gap rather than claiming Fajr is current.
        js = (PUB / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("currentAndNext", js)
        self.assertIn("No prayer", js)

    def test_index_has_prayer_and_install_hooks(self):
        html = (PUB / "index.html").read_text(encoding="utf-8")
        for needle in ('id="sunSection"', 'id="praySection"', 'id="prayerCard"', 'id="installBtn"'):
            self.assertIn(needle, html, f"index.html missing {needle}")

    def test_app_wires_prayer_and_install(self):
        js = (PUB / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn('from "./prayer.js"', js)
        self.assertGreaterEqual(len(re.findall(r"renderPrayer\(f\)", js)), 2,
                                "renderPrayer must run on both render and rerender")
        self.assertIn("function setupInstall", js)
        self.assertIn("beforeinstallprompt", js)
        self.assertIn('data-toggle="prayer"', js)

    def test_prayer_bundled_into_standalone(self):
        bundle = (ROOT / "standalone.html").read_text(encoding="utf-8")
        self.assertIn("qiblaBearing", bundle)
        self.assertIn("prayerTimes", bundle)

    def test_build_includes_prayer_module(self):
        build = (ROOT / "build_standalone.py").read_text(encoding="utf-8")
        self.assertIn("js/prayer.js", build)


class LayoutEditorTests(unittest.TestCase):
    """Guard the hide/reorder dashboard-layout editor."""

    EXPECTED_CARDS = {"current", "conditions", "radar", "hourly", "daily", "history",
                      "marine", "aqi", "sun", "prayer", "lifestyle", "compare"}

    def test_all_cards_keyed(self):
        html = (PUB / "index.html").read_text(encoding="utf-8")
        keys = set(re.findall(r'<section[^>]*\bdata-card="([a-z]+)"', html))
        self.assertEqual(keys, self.EXPECTED_CARDS,
                         "every #content card must carry a stable data-card key")

    def test_app_wires_layout_editor(self):
        js = (PUB / "js" / "app.js").read_text(encoding="utf-8")
        for fn in ("function applyCardLayout", "function moveCard",
                   "function toggleCardHidden", "function enterLayoutEdit",
                   "function resetLayout"):
            self.assertIn(fn, js, f"app.js missing {fn}")
        self.assertIn("applyCardLayout()", js)            # applied on boot
        self.assertIn('data-act="editlayout"', js)        # settings entry point

    def test_app_wires_card_resize(self):
        js = (PUB / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function attachResize", js)
        self.assertIn("cardSpans", js)
        self.assertIn("function gridColumnUnit", js)
        # Width: column span clamped to the grid so a card can't overflow.
        self.assertRegex(js, r"Math\.max\(MIN_SPAN,\s*Math\.min\(GRID_COLS")
        # Height: a fixed pixel size, clamped between MIN_H and MAX_H.
        self.assertRegex(js, r"Math\.max\(MIN_H,\s*Math\.min\(MAX_H")
        self.assertIn("function applyOneCard", js)
        self.assertIn("function cardCfg", js)

    def test_layout_css_present(self):
        css = (PUB / "css" / "styles.css").read_text(encoding="utf-8")
        self.assertRegex(css, r"\.lay-hidden\s*\{[^}]*display:\s*none")
        self.assertIn("editing-layout", css)
        self.assertIn(".layout-bar", css)
        self.assertIn(".card-resize", css)

    def test_layout_in_standalone_bundle(self):
        bundle = (ROOT / "standalone.html").read_text(encoding="utf-8")
        self.assertIn('data-card="current"', bundle)
        self.assertIn("applyCardLayout", bundle)


NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node not available — skipping prayer-math validation")
class PrayerMathTests(unittest.TestCase):
    """Validate the actual prayer/Qibla math by running prayer.js under Node.
    (GitHub's ubuntu runners ship Node, so this runs in CI too.)"""

    def _run(self, body):
        uri = (PUB / "js" / "prayer.js").as_uri()
        script = (f"import('{uri}').then(m => {{ {body} }})"
                  f".catch(e => {{ console.error(e); process.exit(2); }});")
        p = subprocess.run([NODE, "--input-type=module", "-e", script],
                           capture_output=True, text=True, timeout=25)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout.strip())

    def test_dubai_times_and_qibla(self):
        r = self._run(
            "const t=m.prayerTimes({year:2026,month:6,day:5,lat:25.2,lon:55.27,"
            "tzOffset:4,method:m.methodForCountry('AE'),asr:'standard'});"
            "console.log(JSON.stringify({sunrise:t.sunrise,maghrib:t.maghrib,isha:t.isha,"
            "qb:m.qiblaBearing(25.2,55.27),qd:m.qiblaDistanceKm(25.2,55.27),"
            "dir:m.compass16(m.qiblaBearing(25.2,55.27))}));")
        # Sunrise 05:28 — matches Open-Meteo's published sunrise for that date.
        self.assertAlmostEqual(r["sunrise"], 5 + 28 / 60, delta=0.05)
        # Umm al-Qura / Gulf: Isha is exactly Maghrib + 90 min.
        self.assertAlmostEqual(r["isha"], r["maghrib"] + 1.5, delta=0.02)
        # Qibla from Dubai points WSW (~258°), ~1631 km to the Kaaba.
        self.assertAlmostEqual(r["qb"], 258.2, delta=1.5)
        self.assertEqual(r["dir"], "WSW")
        self.assertAlmostEqual(r["qd"], 1631, delta=25)

    def test_method_autodetect(self):
        r = self._run("console.log(JSON.stringify({sa:m.methodForCountry('SA'),"
                      "us:m.methodForCountry('US'),pk:m.methodForCountry('PK'),"
                      "fr:m.methodForCountry('FR')}));")
        self.assertEqual(r, {"sa": "Makkah", "us": "ISNA", "pk": "Karachi", "fr": "MWL"})

    def test_high_latitude_fallback_never_null(self):
        # Helsinki (~60°N) on the solstice: the sun still rises/sets, but the
        # 18° Fajr/Isha twilight angle is never reached. The NightMiddle
        # fallback must still yield real times (not null) bounded to the night.
        r = self._run(
            "const t=m.prayerTimes({year:2026,month:6,day:21,lat:60.17,lon:24.94,"
            "tzOffset:3,method:'MWL',asr:'standard'});"
            "console.log(JSON.stringify({fajr:t.fajr,isha:t.isha,sunrise:t.sunrise}));")
        self.assertIsNotNone(r["sunrise"])
        self.assertIsNotNone(r["fajr"])
        self.assertIsNotNone(r["isha"])


@unittest.skipUnless(NODE, "node not available — skipping prayer-journey tests")
class PrayerJourneyTests(unittest.TestCase):
    """Walk current/next through a day under Node: the sunrise gap (no prayer
    between sunrise and Dhuhr) and past-midnight Isha/Fajr wrap."""

    def _journey(self, times_js, tz, date_js, points_js):
        uri = (PUB / "js" / "prayer.js").as_uri()
        body = (
            f"const T={times_js}, tz={tz}, D={date_js};"
            "const at=(h,dd)=>Date.UTC(D.y,D.mo-1,D.da+dd)+(h-tz)*3600000;"
            f"const out={points_js}.map(p=>{{const r=m.currentAndNext(T,at(p.h,p.dd||0),D,tz);"
            "return {h:p.h,current:r.current,gap:r.gap,next:r.next};});"
            "console.log(JSON.stringify(out));"
        )
        script = (f"import('{uri}').then(m => {{ {body} }})"
                  ".catch(e => { console.error(e); process.exit(2); });")
        p = subprocess.run([NODE, "--input-type=module", "-e", script],
                           capture_output=True, text=True, timeout=25)
        self.assertEqual(p.returncode, 0, p.stderr)
        return {x["h"]: x for x in json.loads(p.stdout.strip())}

    def test_dubai_day_progression(self):
        T = "{fajr:3.85,sunrise:5.47,dhuhr:12.3,asr:15.68,maghrib:19.1,isha:20.6}"
        pts = "[{h:4.4},{h:6},{h:10},{h:13},{h:17},{h:19.3},{h:22},{h:1.5}]"
        b = self._journey(T, 4, "{y:2026,mo:6,da:5}", pts)
        # Fajr window (before sunrise): Fajr is current.
        self.assertEqual(b[4.4]["current"], "fajr"); self.assertFalse(b[4.4]["gap"])
        # THE FIX — after sunrise, before Dhuhr → no active prayer, next is Dhuhr.
        self.assertIsNone(b[6]["current"]); self.assertTrue(b[6]["gap"]); self.assertEqual(b[6]["next"], "dhuhr")
        self.assertIsNone(b[10]["current"]); self.assertTrue(b[10]["gap"])
        self.assertEqual(b[13]["current"], "dhuhr")
        self.assertEqual(b[17]["current"], "asr")
        self.assertEqual(b[19.3]["current"], "maghrib")
        self.assertEqual(b[22]["current"], "isha"); self.assertEqual(b[22]["next"], "fajr")
        self.assertEqual(b[1.5]["current"], "isha")   # past midnight, before Fajr

    def test_fajr_not_current_after_sunrise(self):
        # The reported bug, isolated: at noon, Fajr must NOT be "now".
        T = "{fajr:5,sunrise:6.5,dhuhr:13,asr:16.5,maghrib:20,isha:21.5}"
        b = self._journey(T, 0, "{y:2026,mo:6,da:5}", "[{h:12}]")
        self.assertIsNone(b[12]["current"])
        self.assertTrue(b[12]["gap"])
        self.assertEqual(b[12]["next"], "dhuhr")

    def test_high_latitude_wrap(self):
        # Isha 00:30, Fajr 01:30. Just after Maghrib (23:30) the current prayer
        # must be Maghrib and next Isha — not the naive cur=Isha / next=Fajr.
        T = "{fajr:1.5,sunrise:3.0,dhuhr:12,asr:16,maghrib:23.0,isha:0.5}"
        b = self._journey(T, 2, "{y:2026,mo:6,da:21}", "[{h:23.5},{h:0.2},{h:2}]")
        self.assertEqual(b[23.5]["current"], "maghrib"); self.assertEqual(b[23.5]["next"], "isha")
        self.assertEqual(b[0.2]["current"], "maghrib"); self.assertEqual(b[0.2]["next"], "isha")
        self.assertEqual(b[2]["current"], "fajr")     # after Fajr, before sunrise


class RefreshButtonTests(unittest.TestCase):
    """Guard the manual refresh button (works on web + installed PWA)."""

    def test_button_present(self):
        html = (PUB / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="refreshBtn"', html)

    def test_app_wires_refresh(self):
        js = (PUB / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn('$("refreshBtn").onclick = doRefresh', js)
        self.assertIn("async function doRefresh", js)
        # Re-pulls the current place silently (keeps last-good data on failure).
        self.assertRegex(js, r"loadWeather\(state\.place,\s*true\)")

    def test_refresh_in_standalone_bundle(self):
        bundle = (ROOT / "standalone.html").read_text(encoding="utf-8")
        self.assertIn('id="refreshBtn"', bundle)
        self.assertIn("doRefresh", bundle)


if __name__ == "__main__":
    unittest.main()
