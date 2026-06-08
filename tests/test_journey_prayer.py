# P2 prayer-feature journeys. The current/next/gap/wrap MATH is covered under
# Node in test_build.py; here we cover the UI wiring: enabling it swaps the Sun
# card, the summary renders, the full list expands, and Qibla is present.

import unittest
from journey import JourneyTest


class PrayerJourneys(JourneyTest):
    def _enable_prayer(self, page):
        page.click("#settingsBtn")
        page.wait_for_selector("#settingsOverlay:not(.hidden)")
        page.click('[data-toggle="prayer"]')
        page.keyboard.press("Escape")
        page.wait_for_function(
            "document.getElementById('settingsOverlay').classList.contains('hidden')")

    def test_enabling_prayer_replaces_sun_card(self):
        page = self.boot()
        self.assertTrue(page.locator("#sunSection").is_visible())
        self._enable_prayer(page)
        self.assertFalse(page.locator("#sunSection").is_visible(), "Sun card should be hidden")
        self.assertTrue(page.locator("#praySection").is_visible(), "Prayer card should show")
        self.assertEqual(page.evaluate("localStorage.getItem('prayerTimes')"), "1")

    def test_prayer_summary_renders_a_prayer(self):
        page = self.boot()
        self._enable_prayer(page)
        text = page.locator("#praySummary").inner_text()
        self.assertRegex(text, r"(Fajr|Dhuhr|Asr|Maghrib|Isha|No prayer)")
        # Method label is shown (auto-detected for the country).
        self.assertTrue(page.locator(".pray-method").inner_text().strip())

    def test_expand_full_prayer_list(self):
        page = self.boot()
        self._enable_prayer(page)
        card = page.locator("#prayerCard")
        more = page.locator("#prayerCard .pray-more")
        self.assertLess(more.bounding_box()["height"], 5, "list should start collapsed")
        page.click("#praySummary")
        page.wait_for_timeout(450)   # CSS max-height transition
        self.assertGreater(more.bounding_box()["height"], 40, "full list did not expand")
        # All five daily prayers are listed (Arabic names included).
        body = card.inner_text()
        for name in ("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"):
            self.assertIn(name, body)

    def test_qibla_compass_present(self):
        page = self.boot()
        self._enable_prayer(page)
        page.click("#praySummary")
        page.wait_for_timeout(450)
        self.assertEqual(page.locator("#qiblaNeedle").count(), 1, "Qibla needle missing")


if __name__ == "__main__":
    unittest.main()
