"""Regression tests for the frontend build pipeline & static-asset integrity.

These guard the things that silently break a static deploy: an ES `import`
surviving into the inlined standalone bundle, a cache-bust version drifting
between CSS and JS, a manifest/service-worker referencing a missing file.

Offline & side-effect-free: the standalone bundle is assembled in memory
(the real bundler functions) without writing the committed artifacts.
"""
import json
import re
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
        libs = ["js/wmo.js", "js/gauge.js", "js/effects.js", "js/radar.js"]
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

    def test_css_uses_dynamic_viewport_height(self):
        # 100dvh tracks iOS Safari's collapsing toolbar; 100vh overshoots it.
        self.assertIn("100dvh", self._css())

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

    def test_panel_scroll_is_contained(self):
        # overscroll-behavior keeps touch scroll from chaining to the page.
        css = (PUB / "css" / "styles.css").read_text(encoding="utf-8")
        self.assertRegex(css, r"\.settings-panel\s*\{[^}]*overscroll-behavior:\s*contain")

    def test_panel_uses_dynamic_viewport(self):
        # dvh (not vh) so the sheet's lower rows clear the iOS home indicator.
        css = (PUB / "css" / "styles.css").read_text(encoding="utf-8")
        self.assertNotRegex(css, r"\.settings-panel[^{]*\{[^}]*max-height:\s*\d+vh")
        self.assertIn("88dvh", css)

    def test_js_toggles_scroll_lock_class(self):
        js = (PUB / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn('classList.add("settings-open")', js)
        self.assertIn('classList.remove("settings-open")', js)

    def test_sw_serves_html_network_first(self):
        # Otherwise the installed PWA serves a stale index.html and never picks
        # up new cache-busted CSS/JS — the reason updates didn't reach the app.
        sw = (PUB / "sw.js").read_text(encoding="utf-8")
        self.assertIn('req.mode === "navigate"', sw)


if __name__ == "__main__":
    unittest.main()
