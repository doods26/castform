# P2 dashboard-layout journeys: reorder, resize width, resize height, reset.
# These need real geometry (drag math, grid spans) so they belong in the browser.

import unittest
from journey import JourneyTest


class LayoutJourneys(JourneyTest):
    def _edit(self, page):
        page.click("#settingsBtn")
        page.wait_for_selector("#settingsOverlay:not(.hidden)")
        page.click('[data-act="editlayout"]')
        page.wait_for_selector("body.editing-layout", timeout=4000)

    def _order(self, page):
        return page.evaluate(
            "[...document.querySelectorAll('#content > section[data-card]')].map(s=>s.dataset.card)")

    def test_reorder_move_card_down_persists(self):
        page = self.boot()
        before = self._order(page)
        first = before[0]
        self._edit(page)
        page.click(f'section[data-card="{first}"] [data-mv="down"]')
        page.click("#layoutDone")
        after = self._order(page)
        self.assertNotEqual(before, after, "card order did not change")
        self.assertGreater(after.index(first), 0, "card did not move down")
        # Persisted to localStorage in the new order.
        saved = page.evaluate("JSON.parse(localStorage.getItem('cardOrder')||'[]')")
        self.assertEqual(saved[: len(after)], after)

    def test_hiding_every_visible_card_actually_hides_it(self):
        # The real report: hide several cards, click Done, and ONE stays visible.
        # Cause was CSS specificity — e.g. `#content > .cond-card{display:flex}`
        # outranks `.lay-hidden{display:none}`. Hide every hideable card and prove
        # each one truly disappears.
        page = self.boot()
        self._edit(page)
        keys = page.eval_on_selector_all(
            '#content > section[data-card] [data-hide]',
            "els => els.map(e => e.closest('section').dataset.card)")
        self.assertGreater(len(keys), 3, "expected several hideable cards")
        for k in keys:
            page.click(f'section[data-card="{k}"] [data-hide]')
        page.click("#layoutDone")
        page.wait_for_selector("body:not(.editing-layout)")
        still_visible = [k for k in keys
                         if page.locator(f'section[data-card="{k}"]').is_visible()]
        self.assertEqual(still_visible, [],
                         f"these cards refused to hide: {still_visible}")

    def _resize_handle_drag(self, page, key, dx, dy):
        handle = page.locator(f'section[data-card="{key}"] .card-resize')
        handle.scroll_into_view_if_needed()      # cards are tall; handle is below the fold
        box = handle.bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + dx, cy + dy, steps=8)
        page.mouse.up()

    def test_resize_width_changes_span(self):
        page = self.boot()
        self._edit(page)
        key = "daily"
        before = page.evaluate(
            f"(()=>{{const s=document.querySelector('section[data-card=\"{key}\"]');"
            "return s.getBoundingClientRect().width})()")
        # Drag the corner left by ~a third of the content width to shrink the span.
        content_w = page.evaluate("document.getElementById('content').clientWidth")
        self._resize_handle_drag(page, key, -content_w / 3, 0)
        page.click("#layoutDone")
        cfg = page.evaluate("JSON.parse(localStorage.getItem('cardSpans')||'{}')")
        self.assertIn(key, cfg, "width drag was not persisted")
        self.assertIn("c", cfg[key], "column span not stored")
        after = page.evaluate(
            f"document.querySelector('section[data-card=\"{key}\"]').getBoundingClientRect().width")
        self.assertLess(after, before, "card did not get narrower")

    def test_resize_height_sets_fixed_height(self):
        page = self.boot()
        self._edit(page)
        key = "hourly"
        self._resize_handle_drag(page, key, 0, 160)
        page.click("#layoutDone")
        cfg = page.evaluate("JSON.parse(localStorage.getItem('cardSpans')||'{}')")
        self.assertIn(key, cfg)
        self.assertIn("h", cfg[key], "fixed height not stored")
        self.assertTrue(page.evaluate(
            f"document.querySelector('section[data-card=\"{key}\"]').classList.contains('lay-sized')"))

    def test_reset_layout_clears_customization(self):
        page = self.boot()
        # Customize: hide a card + resize one.
        self._edit(page)
        page.click('section[data-card="marine"] [data-hide]') if page.locator(
            'section[data-card="marine"] [data-hide]').count() else None
        self._resize_handle_drag(page, "daily", 0, 120)
        page.click("#layoutReset")
        page.click("#layoutDone")
        self.assertEqual(page.evaluate("localStorage.getItem('cardHidden')"), "[]")
        self.assertIsNone(page.evaluate("localStorage.getItem('cardSpans')"))

    def test_layout_persists_across_reload(self):
        page = self.boot()
        before = self._order(page)
        first = before[0]
        self._edit(page)
        page.click(f'section[data-card="{first}"] [data-mv="down"]')
        page.click("#layoutDone")
        moved = self._order(page)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#content:not(.hidden)")
        self.assertEqual(self._order(page), moved, "layout order not restored after reload")


if __name__ == "__main__":
    unittest.main()
