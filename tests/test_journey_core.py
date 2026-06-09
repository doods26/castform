# P0 core journeys + the two regressions that motivated this suite, driven in a
# real browser so COMPUTED layout/visibility is actually asserted.
#
# Journeys covered here:
#   1. Boot -> dashboard renders (not stuck on the spinner)
#   2. Open settings -> the panel is actually VISIBLE (the collapse regression)
#   3. ...also visible on a phone-sized viewport (where it kept breaking)
#   4. Hide a card -> after Done it actually disappears (the hide regression)
#   5. Show a hidden card -> it comes back
#   6. Star a location -> a favorite chip appears
#   7. Toggle units -> rendered temperatures change
#   8. Search a city -> selecting a result loads it

import unittest
from journey import JourneyTest


class CoreJourneys(JourneyTest):
    def test_boot_renders_dashboard(self):
        page = self.boot()
        # The current-conditions card rendered with a temperature.
        self.assertTrue(page.locator("#currentCard").is_visible())
        self.assertRegex(page.locator("#currentCard").inner_text(), r"\d")
        # Footer build stamp is present (our cache-diagnostic).
        self.assertIn("build", page.locator("#foot").inner_text())

    # --- the settings-collapse regression --------------------------------
    def _open_settings(self, page):
        page.click("#settingsBtn")
        page.wait_for_selector("#settingsOverlay:not(.hidden)", timeout=4000)
        return page.locator(".settings-panel")

    def test_settings_panel_opens_and_is_visible_desktop(self):
        page = self.boot()
        panel = self._open_settings(page)
        box = panel.bounding_box()
        self.assertIsNotNone(box, "settings panel has no box")
        # The bug rendered the panel at ~0–40px tall with only the backdrop showing.
        self.assertGreater(box["height"], 300,
                           f"settings panel collapsed (height={box['height']})")
        # Its first real control must be visible and on-screen.
        self.assertTrue(page.get_by_text("Temperature", exact=True).is_visible())

    def test_settings_panel_opens_and_is_visible_mobile(self):
        # On a phone the panel is TALLER than the screen — the regression was that
        # it got center-clipped with its header pushed off the top. Assert the
        # header is actually on-screen and reachable, not just that height>0.
        page = self.boot(viewport={"width": 390, "height": 844})
        self.open_settings(page)
        self.assert_settings_usable(page)

    def test_settings_panel_usable_on_small_phone(self):
        # iPhone SE height — the tightest case where the panel overflows most.
        page = self.boot(viewport={"width": 375, "height": 667})
        self.open_settings(page)
        self.assert_settings_usable(page)

    # --- the hide-card regression ----------------------------------------
    def _enter_layout_edit(self, page):
        self._open_settings(page)
        page.click('[data-act="editlayout"]')
        page.wait_for_selector("body.editing-layout", timeout=4000)

    def test_hide_card_actually_hides_after_done(self):
        page = self.boot()
        card = page.locator('section[data-card="hourly"]')
        self.assertTrue(card.is_visible(), "hourly card should start visible")
        self._enter_layout_edit(page)
        page.click('section[data-card="hourly"] [data-hide]')
        page.click("#layoutDone")
        page.wait_for_selector("body:not(.editing-layout)", timeout=4000)
        # The whole point: after leaving edit mode the hidden card is GONE.
        self.assertFalse(card.is_visible(), "hidden card is still visible after Done")

    def test_show_hidden_card_restores_it(self):
        page = self.boot()
        card = page.locator('section[data-card="hourly"]')
        # Hide it.
        self._enter_layout_edit(page)
        page.click('section[data-card="hourly"] [data-hide]')
        page.click("#layoutDone")
        page.wait_for_selector("body:not(.editing-layout)", timeout=4000)
        self.assertFalse(card.is_visible())
        # Re-enter edit (hidden cards are revealed there) and Show it again.
        self._enter_layout_edit(page)
        page.click('section[data-card="hourly"] [data-hide]')   # toggles back to "Hide"
        page.click("#layoutDone")
        page.wait_for_selector("body:not(.editing-layout)", timeout=4000)
        self.assertTrue(card.is_visible(), "card did not come back after Show")

    # --- favorites -------------------------------------------------------
    def test_star_adds_favorite_chip(self):
        page = self.boot()
        self.assertEqual(page.locator(".fav-chip").count(), 0)
        page.click("#starBtn")
        page.wait_for_selector(".fav-chip", timeout=4000)
        self.assertEqual(page.locator(".fav-chip").count(), 1)
        self.assertIn("Dubai", page.locator(".fav-bar").inner_text())
        # Star reflects the saved state.
        self.assertEqual(page.locator("#starBtn").inner_text().strip(), "★")

    # --- units -----------------------------------------------------------
    def test_units_toggle_changes_temperature(self):
        page = self.boot()
        before = page.locator("#currentCard").inner_text()
        page.click("#settingsBtn")
        page.wait_for_selector("#settingsOverlay:not(.hidden)")
        page.click('.set-seg[data-seg="units"] button:has-text("°C")')
        # Refetch + rerender; let it settle.
        page.wait_for_timeout(300)
        self.settle(page, 1500)
        after = page.locator("#currentCard").inner_text()
        self.assertNotEqual(before, after, "temperature did not change on unit switch")

    # --- search ----------------------------------------------------------
    def test_search_loads_city(self):
        page = self.boot()
        page.fill("#searchInput", "Dubai")
        # The dropdown is debounced with setTimeout — advance time to fire it.
        self.settle(page, 600)
        page.wait_for_selector("#searchResults button", timeout=4000)
        page.locator("#searchResults button").first.click()
        page.wait_for_selector("#content:not(.hidden)")
        self.settle(page, 1500)
        self.assertRegex(page.locator("#currentCard").inner_text(), r"\d")


if __name__ == "__main__":
    unittest.main()
