# Manual journey checklist (device-only)

Most customer journeys are automated in `tests/test_journey_*.py` (Playwright +
headless Chromium). A handful depend on real device hardware, OS install flows,
or app-store-style surfaces that a headless browser can't faithfully reproduce.
Run these by hand after any change that touches the PWA shell, the install
buttons, the service worker, or the live compass.

## iOS (Safari + installed PWA)
- [ ] **Add to Home Screen**: Share → Add to Home Screen creates the icon; the
      installed app opens standalone (no Safari chrome), status bar translucent.
- [ ] **Settings sheet** opens and is fully visible in the installed PWA (this is
      the bug that shipped twice — confirm against the footer `build N` stamp so
      you know you're on fresh code).
- [ ] **Safe-area**: nothing hides under the notch or home indicator.
- [ ] **Live Qibla compass**: enabling it prompts for motion/orientation access
      once; granting it makes the needle track as you rotate the phone.
- [ ] **Geolocation prompt**: tapping the 📍 pin asks for location; allowing it
      loads your city; denying it shows the "blocked — allow it in settings"
      toast (not a silent jump to a default city).
- [ ] **Service-worker update**: after a deploy, a fresh launch picks up the new
      `build N`; if not, deleting + re-adding the PWA does.

## Android (Chrome + installed PWA)
- [ ] **Install prompt**: the in-app Install button appears (beforeinstallprompt)
      and installing it adds the app.
- [ ] **Live Qibla compass** streams without a permission prompt on HTTPS.
- [ ] **Geolocation** prompt + allow/deny toasts behave as on iOS.

## Cross-device
- [ ] **Offline launch**: with the app installed, going offline and reopening
      shows the last forecast (served from the service-worker cache).
- [ ] **Kiosk/fullscreen** actually enters fullscreen (headless can't verify the
      real fullscreen transition).
- [ ] **Compare two cities** via tapping the radar map picks a second location
      and renders the side-by-side panel.
