# P1 journeys: favorites (add / remove / switch / persist) and the location pin
# (success + every error toast — the silent-fallback fix we just shipped).

import unittest
from journey import JourneyTest, DUBAI

LONDON = {"name": "London", "admin1": "England", "country": "United Kingdom",
          "country_code": "GB", "lat": 51.5074, "lon": -0.1278}


class FavoriteJourneys(JourneyTest):
    def test_remove_favorite_hides_bar(self):
        page = self.boot(storage={"favorites": [DUBAI]})
        self.assertEqual(page.locator(".fav-chip").count(), 1)
        page.click(".fav-chip .fav-x")
        page.wait_for_function("document.querySelectorAll('.fav-chip').length === 0")
        self.assertEqual(page.locator(".fav-chip").count(), 0)
        self.assertEqual(page.evaluate("localStorage.getItem('favorites')"), "[]")

    def test_switch_to_another_favorite(self):
        page = self.boot(place=DUBAI, storage={"favorites": [DUBAI, LONDON]})
        self.assertEqual(page.locator(".fav-chip").count(), 2)
        # Tap the London chip (the non-active one).
        page.click('.fav-chip:has-text("London")')
        page.wait_for_timeout(200)
        page.clock.run_for(1500)
        self.assertIn("London", page.evaluate("localStorage.getItem('place')"))

    def test_favorites_persist_across_reload(self):
        page = self.boot()
        page.click("#starBtn")
        page.wait_for_selector(".fav-chip")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#content:not(.hidden)")
        self.assertEqual(page.locator(".fav-chip").count(), 1)


class GeolocationJourneys(JourneyTest):
    def test_use_my_location_success(self):
        # navigator.geolocation.getCurrentPosition resolves to London's coords;
        # /api/reverse is mocked to return London.
        page = self.boot(geo=(51.5074, -0.1278))
        page.click("#geoBtn")
        page.wait_for_timeout(200)
        page.clock.run_for(1500)
        self.assertIn("London", page.evaluate("localStorage.getItem('place') || ''"))

    def _force_geo_error(self, page, code):
        page.evaluate(
            "(c)=>{navigator.geolocation.getCurrentPosition=(ok,err)=>err("
            "{code:c,PERMISSION_DENIED:1,POSITION_UNAVAILABLE:2,TIMEOUT:3});}", code)

    def test_permission_denied_shows_toast_not_silent(self):
        page = self.boot()
        self._force_geo_error(page, 1)
        page.click("#geoBtn")
        page.wait_for_selector("#updateToast.show", timeout=4000)
        self.assertRegex(page.locator("#updateToast").inner_text(), r"(blocked|allow|denied)")

    def test_timeout_shows_toast(self):
        page = self.boot()
        self._force_geo_error(page, 3)
        page.click("#geoBtn")
        page.wait_for_selector("#updateToast.show", timeout=4000)
        self.assertRegex(page.locator("#updateToast").inner_text(), r"(time|again)")

    def test_unavailable_shows_toast(self):
        page = self.boot()
        self._force_geo_error(page, 2)
        page.click("#geoBtn")
        page.wait_for_selector("#updateToast.show", timeout=4000)
        self.assertRegex(page.locator("#updateToast").inner_text(), r"(unavailable|search)")


if __name__ == "__main__":
    unittest.main()
