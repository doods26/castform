# P1–P2 settings journeys: every control in the settings sheet, plus closing it
# and persistence across reload.

import unittest
from journey import JourneyTest


class SettingsJourneys(JourneyTest):
    def _settings(self, page):
        page.click("#settingsBtn")
        page.wait_for_selector("#settingsOverlay:not(.hidden)", timeout=4000)

    def test_theme_light_then_dark(self):
        page = self.boot()
        self._settings(page)
        page.click('.set-seg[data-seg="themeMode"] button:has-text("Light")')
        self.assertTrue(page.evaluate("document.body.classList.contains('light')"))
        page.click('.set-seg[data-seg="themeMode"] button:has-text("Dark")')
        self.assertFalse(page.evaluate("document.body.classList.contains('light')"))

    def test_accent_color_applies(self):
        page = self.boot()
        self._settings(page)
        swatches = page.locator("[data-accent]")
        target = swatches.nth(2)
        want = target.get_attribute("data-accent")
        target.click()
        got = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")
        self.assertEqual(got.lower(), want.lower())

    def test_language_persists(self):
        page = self.boot()
        self._settings(page)
        page.select_option("#langSelect", "fr")
        self.assertEqual(page.evaluate("localStorage.getItem('lang')"), "fr")

    def test_time_format_toggle_persists_and_marks_active(self):
        page = self.boot()
        self._settings(page)
        page.click('.set-seg[data-seg="timeFormat"] button:has-text("24-hour")')
        self.assertEqual(page.evaluate("localStorage.getItem('timeFormat')"), "24")
        active = page.locator('.set-seg[data-seg="timeFormat"] button.active').inner_text()
        self.assertIn("24", active)

    def test_wind_unit_persists(self):
        page = self.boot()
        self._settings(page)
        page.click('.set-seg[data-seg="windUnit"] button:has-text("km/h")')
        self.assertEqual(page.evaluate("localStorage.getItem('windUnit')"), "kmh")

    def test_pressure_unit_persists(self):
        page = self.boot()
        self._settings(page)
        page.click('.set-seg[data-seg="pressureUnit"] button:has-text("inHg")')
        self.assertEqual(page.evaluate("localStorage.getItem('pressureUnit')"), "inHg")

    def test_reduce_motion_toggles_body_class(self):
        page = self.boot()
        self._settings(page)
        page.click('[data-toggle="reduceMotion"]')
        self.assertTrue(page.evaluate("document.body.classList.contains('reduce-motion')"))
        self.assertEqual(page.evaluate("localStorage.getItem('reduceMotion')"), "1")

    def test_startup_location_pin_and_reset(self):
        page = self.boot()
        self._settings(page)
        page.click('[data-act="setdefault"]')
        self.assertIn("Dubai", page.evaluate("localStorage.getItem('defaultPlace') || ''"))
        # The Reset button appears once a default is pinned.
        page.click('[data-act="cleardefault"]')
        self.assertIsNone(page.evaluate("localStorage.getItem('defaultPlace')"))

    def test_close_with_escape(self):
        page = self.boot()
        self._settings(page)
        page.keyboard.press("Escape")
        self.assertTrue(page.evaluate("document.getElementById('settingsOverlay').classList.contains('hidden')"))

    def test_close_by_tapping_backdrop(self):
        page = self.boot()
        self._settings(page)
        # A tap on the backdrop dispatches a click whose target is the overlay
        # itself (not the panel) — that's what the close handler keys off. Drive
        # it directly to avoid headless pixel hit-testing quirks.
        page.eval_on_selector("#settingsOverlay", "el => el.click()")
        self.assertTrue(page.evaluate("document.getElementById('settingsOverlay').classList.contains('hidden')"))

    def test_units_persist_across_reload(self):
        page = self.boot()
        self._settings(page)
        page.click('.set-seg[data-seg="units"] button:has-text("°C")')
        page.wait_for_timeout(200)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#content:not(.hidden)")
        self.assertEqual(page.evaluate("localStorage.getItem('units')"), "metric")


if __name__ == "__main__":
    unittest.main()
