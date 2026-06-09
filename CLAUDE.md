# Castform — project guide for Claude

A zero-dependency weather dashboard: Python stdlib server (`server.py`) + a
no-build ES-module frontend (`public/`), plus a self-contained `standalone.html`
build for static hosting (GitHub Pages).

## Regression testing is part of every code change

This is a hard rule, not a suggestion:

1. **Run the suite before and after any change:**
   ```
   python -m unittest discover -s tests -v
   ```
2. **Every code change adds or updates a test.** Touch server logic → add/extend
   a `tests/test_server.py` case. Touch the build pipeline, `index.html`,
   manifest, or service worker → add/extend `tests/test_build.py`.
3. **Never commit or open a PR with the suite red.** CI runs it on every push and
   PR (`.github/workflows/tests.yml`), and it gates the Pages deploy
   (`pages.yml`). A red suite blocks the deploy.
4. Keep tests **offline and dependency-free** — stdlib `unittest` only, mock the
   network (see `FakeResp` / `mock.patch` usage in `tests/test_server.py`). The
   whole project's value is that it needs no pip installs.
5. **Test the user journey, not just wiring.** Frontend logic with branches or
   time/locale edge cases (e.g. the prayer current/next state through a full day,
   including the sunrise→Dhuhr gap and past-midnight wrap) must be a *pure,
   exported* function in its module and exercised under Node — see
   `PrayerJourneyTests` / `PrayerMathTests` in `tests/test_build.py`, which run
   `node` against the real `.js` (GitHub's runners ship Node). Cover the boundary
   cases, not only the happy path.
6. **When you fix a bug, add the regression test that would have caught it** — and
   if a guard's premise flips (e.g. `dvh` went from "use it" to "never use it,
   collapses to 0 in the iOS PWA"), invert the test rather than deleting it.
7. **Interactive / visual journeys go in the browser suite.** Anything that
   depends on COMPUTED CSS, layout geometry, or click→render flow (a panel is
   actually visible, a hidden card actually disappears, a drag resizes a tile)
   must be a Playwright journey in `tests/test_journey_*.py` — logic tests and
   even jsdom can't see computed layout, which is exactly how the settings-sheet
   collapse shipped twice. Device-only flows (iOS A2HS, Android install, live
   compass) live in `tests/MANUAL_CHECKLIST.md`.
8. **iOS bugs need WebKit, not Chromium.** The app's biggest audience is iPhone,
   and Chromium ≠ WebKit — the settings sheet passed every Chromium test while a
   real iPhone clipped its header off-screen. Layout-sensitive journeys must also
   run on WebKit (`ENGINE = "webkit"`, see `tests/test_journey_webkit.py`) at
   phone sizes (390×844 and 375×667). And assert the panel is *usable*, not just
   present: check the header's top is on-screen (≥0), not merely `height>0` — an
   overflowing sheet can be tall yet center-clipped beyond reach.

### Browser journey harness (Playwright)

- `tests/journey.py` is the base `JourneyTest`: it boots the real `server.py` on
  a free port, launches a headless browser (`ENGINE`, default Chromium; set
  `"webkit"` for the iOS-engine subclass), **mocks every `/api/*` from
  `tests/fixtures/*.json`** (no network), and **freezes the clock + timezone**
  (`2026-06-08` noon Asia/Dubai) so "now"-relative rendering is reproducible.
  Animations/transitions are disabled in-test for stable geometry. Use
  `self.settle(page)` (not `page.clock.run_for`) to flush — it falls back to a
  real wait on WebKit, where Playwright's fake clock may not attach.
- The whole layer **skips cleanly when Playwright isn't installed**, so the base
  `python -m unittest discover -s tests` stays green locally without it. To run
  the journeys: `pip install -r tests/requirements-dev.txt && python -m
  playwright install chromium`. CI installs them and runs the journeys (they
  gate the Pages deploy).
- Gotchas baked into the harness/tests: advance the frozen clock
  (`page.clock.run_for(...)`) to flush JS count-up animations and to fire
  `setTimeout` debounces (search); don't `wait_for_selector` on a `display:none`
  element to become "visible" (assert the class via `wait_for_function`);
  `scroll_into_view_if_needed()` before a manual mouse-drag (resize handles sit
  below the fold).
- Re-capture fixtures only if the API shape changes: run `server.py` and curl the
  `/api/*` endpoints into `tests/fixtures/` (keep the 2026-06-08 capture date so
  the frozen clock stays aligned).

### When the suites run (cadence)

- **Every push & PR** → fast logic/build tests (`tests.yml` `logic` job; browser
  journeys auto-skip without Playwright). ~1s.
- **Pull requests** → browser journeys (`tests.yml` `journeys` job). Gates merge.
- **Deploy to main** → browser journeys again (`pages.yml`). Gates the Pages
  publish — this is the backstop that blocks a broken layout from shipping.
- **Local pre-push** → the FULL suite via `.githooks/pre-push`. Activate once per
  clone with `git config core.hooksPath .githooks` (already set in this clone).
  Bypass in a pinch with `git push --no-verify`. Install the browser deps so the
  journeys actually run locally: `pip install -r tests/requirements-dev.txt &&
  python -m playwright install chromium`.

## Workflow for changes

- Work on a branch, not `main`.
- Add/adjust tests, get the suite green, then open a PR.
- After editing anything under `public/`, the standalone build is regenerated by
  `python build_standalone.py` (CI does this on deploy). Bump the `?b=N`
  cache-bust on **both** `styles.css` and `app.js` in `index.html` together — a
  test asserts they stay in sync.

## Constraints (carried from prior work — still in effect)

- `config.json` (optional Google Pollen key) is gitignored and must **never** be
  committed or pushed.
- Do not force-push without explicit approval.
- MeteoAlarm (Europe alerts) has no CORS headers → server-side only; it does not
  work on the static Pages build. NWS (US) alerts work everywhere.
