# The SAME critical visual journeys, run on WebKit — Apple's engine, what
# Safari and every iOS browser use. This file exists because Chromium passed
# while the real iPhone (WebKit) clipped the settings sheet: engine parity is the
# only way to catch that class of bug before a tester does.
#
# Scope is deliberately the layout-sensitive journeys (settings sheet on phone
# sizes, hide-a-card). The data/logic journeys don't need a second engine.

import unittest
from journey import JourneyTest


class WebKitVisualJourneys(JourneyTest):
    ENGINE = "webkit"

    def test_settings_usable_iphone(self):
        page = self.boot(viewport={"width": 390, "height": 844})   # iPhone 12/13/14
        self.open_settings(page)
        self.assert_settings_usable(page)

    def test_settings_usable_iphone_se(self):
        page = self.boot(viewport={"width": 375, "height": 667})   # smallest common phone
        self.open_settings(page)
        self.assert_settings_usable(page)

    def test_settings_usable_desktop(self):
        page = self.boot(viewport={"width": 1100, "height": 900})
        self.open_settings(page)
        self.assert_settings_usable(page)

    def test_hide_conditions_card_actually_hides(self):
        # The cond-card specificity fix, verified on WebKit too.
        page = self.boot(viewport={"width": 390, "height": 844})
        card = page.locator('section[data-card="conditions"]')
        self.assertTrue(card.is_visible())
        self.open_settings(page)
        page.click('[data-act="editlayout"]')
        page.wait_for_selector("body.editing-layout", timeout=5000)
        page.click('section[data-card="conditions"] [data-hide]')
        page.click("#layoutDone")
        page.wait_for_selector("body:not(.editing-layout)", timeout=5000)
        self.assertFalse(card.is_visible(), "conditions card still visible after Done (WebKit)")


if __name__ == "__main__":
    unittest.main()
