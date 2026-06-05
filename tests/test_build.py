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


if __name__ == "__main__":
    unittest.main()
