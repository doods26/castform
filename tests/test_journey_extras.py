# P3 journeys: refresh, forward-looking hints, detail cards rendering or hiding
# gracefully, the build stamp, and platform affordances that CAN be asserted in
# a headless browser. (Truly device-only flows — iOS A2HS, Android install
# prompt, live device-orientation compass — are in tests/MANUAL_CHECKLIST.md.)

import unittest
from journey import JourneyTest

CARDS = ["current", "conditions", "hourly", "daily", "aqi", "lifestyle",
         "sun", "prayer", "radar", "marine", "history", "compare"]


class ExtraJourneys(JourneyTest):
    def test_refresh_button_shows_updated_toast(self):
        page = self.boot()
        page.click("#refreshBtn")
        page.wait_for_selector("#updateToast.show", timeout=4000)
        page.clock.run_for(1500)
        self.assertIn("Updated", page.locator("#updateToast").inner_text())

    def test_build_stamp_visible_in_footer(self):
        page = self.boot()
        self.assertRegex(page.locator("#foot").inner_text(), r"build \d+")

    def test_every_card_either_renders_or_is_cleanly_hidden(self):
        # The core guarantee against "dead" cards: a card is shown ONLY if it has
        # real content; otherwise it must be hidden (feature gate / lay-hidden) —
        # never a visible empty box.
        page = self.boot()
        for key in CARDS:
            loc = page.locator(f'section[data-card="{key}"]')
            if loc.count() == 0:
                continue
            if loc.is_visible():
                box = loc.bounding_box()
                self.assertGreater(box["height"], 10, f"card '{key}' is visible but empty")
                self.assertTrue(loc.inner_text().strip() != "" or loc.locator("canvas,svg,.leaflet-container").count() > 0,
                                f"card '{key}' is visible but has no content")

    def test_nowcast_and_activity_hint_exist_without_error(self):
        page = self.boot()
        # They may be hidden (dry forecast) but must be present and not throw.
        self.assertEqual(page.locator("#nowcast").count(), 1)
        self.assertEqual(page.locator("#activityHint").count(), 1)

    def test_fullscreen_button_present_and_clickable(self):
        page = self.boot()
        btn = page.locator("#fullscreenBtn")
        self.assertEqual(btn.count(), 1)
        # Clicking must not throw (fullscreen request may be refused headless —
        # that's fine, we only assert it doesn't break the page).
        btn.click()
        self.assertTrue(page.locator("#content").is_visible())

    def test_service_worker_registers(self):
        page = self.boot()
        reg = page.evaluate("""async () => {
            if (!('serviceWorker' in navigator)) return 'no-sw-api';
            const r = await navigator.serviceWorker.getRegistration();
            return r ? 'registered' : 'none';
        }""")
        self.assertIn(reg, ("registered", "no-sw-api"))

    def test_no_console_errors_on_load(self):
        # A blanket guard: booting the dashboard must not log any console error.
        errors = []
        page = self.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(self.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#content:not(.hidden)")
        page.clock.run_for(1500)
        self.assertEqual(errors, [], f"console errors on load: {errors}")


if __name__ == "__main__":
    unittest.main()
