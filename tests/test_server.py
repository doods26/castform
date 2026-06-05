"""Regression tests for server.py pure logic.

Zero-dependency, offline, deterministic. No real network calls are ever made:
fetch_json is exercised against a fake urlopen. Run with:

    python -m unittest discover -s tests -v
"""
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

# Make the repo root importable regardless of where the runner is invoked from.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


class FakeResp:
    """Minimal stand-in for the urlopen context-manager response."""

    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class IsPrivateClientTests(unittest.TestCase):
    def test_loopback_v4(self):
        self.assertTrue(server.is_private_client("127.0.0.1"))

    def test_private_ranges(self):
        for ip in ("10.0.0.5", "192.168.1.10", "172.16.4.4"):
            self.assertTrue(server.is_private_client(ip), ip)

    def test_link_local(self):
        self.assertTrue(server.is_private_client("169.254.1.1"))

    def test_public_is_rejected(self):
        # Note: documentation ranges (e.g. 203.0.113.0/24) count as non-global
        # in Python's ipaddress, so use genuinely public addresses here.
        for ip in ("8.8.8.8", "1.1.1.1", "9.9.9.9"):
            self.assertFalse(server.is_private_client(ip), ip)

    def test_ipv6_loopback_and_mapped(self):
        self.assertTrue(server.is_private_client("::1"))
        # IPv4-mapped private address must be unwrapped and accepted.
        self.assertTrue(server.is_private_client("::ffff:192.168.0.1"))
        # IPv4-mapped public address must be rejected.
        self.assertFalse(server.is_private_client("::ffff:8.8.8.8"))

    def test_garbage_is_rejected(self):
        self.assertFalse(server.is_private_client("not-an-ip"))
        self.assertFalse(server.is_private_client(""))


class CacheTests(unittest.TestCase):
    def setUp(self):
        server._cache.clear()

    def test_set_then_get(self):
        server.cache_set("k", {"v": 1}, ttl=60)
        self.assertEqual(server.cache_get("k"), {"v": 1})

    def test_miss_returns_none(self):
        self.assertIsNone(server.cache_get("absent"))

    def test_expiry_evicts(self):
        server.cache_set("k", "v", ttl=60)
        # Jump the clock forward past the TTL.
        with mock.patch.object(server.time, "time", return_value=server.time.time() + 999):
            self.assertIsNone(server.cache_get("k"))
        # Expired entry is purged, not just hidden.
        self.assertNotIn("k", server._cache)


class FetchJsonTests(unittest.TestCase):
    def setUp(self):
        server._cache.clear()

    def test_success_caches_by_url(self):
        url = "https://example.test/a"
        with mock.patch.object(server.urllib.request, "urlopen",
                               return_value=FakeResp({"ok": True})) as uo:
            self.assertEqual(server.fetch_json(url), {"ok": True})
            # Second call is served from cache — urlopen not called again.
            self.assertEqual(server.fetch_json(url), {"ok": True})
        self.assertEqual(uo.call_count, 1)

    def test_4xx_fails_fast_no_retry(self):
        err = urllib.error.HTTPError("u", 404, "nope", {}, io.BytesIO(b""))
        with mock.patch.object(server.urllib.request, "urlopen", side_effect=err) as uo:
            with self.assertRaises(urllib.error.HTTPError):
                server.fetch_json("https://example.test/missing", tries=3)
        self.assertEqual(uo.call_count, 1)  # no retries on a real client error

    def test_5xx_retries_then_succeeds(self):
        err = urllib.error.HTTPError("u", 503, "busy", {}, io.BytesIO(b""))
        seq = [err, err, FakeResp({"ok": 1})]
        with mock.patch.object(server.urllib.request, "urlopen", side_effect=seq) as uo, \
                mock.patch.object(server.time, "sleep"):
            self.assertEqual(server.fetch_json("https://example.test/flaky", tries=3), {"ok": 1})
        self.assertEqual(uo.call_count, 3)

    def test_429_is_retried(self):
        err = urllib.error.HTTPError("u", 429, "slow down", {}, io.BytesIO(b""))
        with mock.patch.object(server.urllib.request, "urlopen", side_effect=err) as uo, \
                mock.patch.object(server.time, "sleep"):
            with self.assertRaises(urllib.error.HTTPError):
                server.fetch_json("https://example.test/throttled", tries=3)
        self.assertEqual(uo.call_count, 3)

    def test_network_error_retries(self):
        err = urllib.error.URLError("down")
        with mock.patch.object(server.urllib.request, "urlopen", side_effect=err) as uo, \
                mock.patch.object(server.time, "sleep"):
            with self.assertRaises(urllib.error.URLError):
                server.fetch_json("https://example.test/offline", tries=2)
        self.assertEqual(uo.call_count, 2)


class PointInPolygonTests(unittest.TestCase):
    # A unit square from (lat,lon) corners 0,0 -> 0,10 -> 10,10 -> 10,0.
    SQUARE = "0,0 0,10 10,10 10,0"

    def test_inside(self):
        self.assertTrue(server._point_in_polygon(5.0, 5.0, self.SQUARE))

    def test_outside(self):
        self.assertFalse(server._point_in_polygon(20.0, 20.0, self.SQUARE))
        self.assertFalse(server._point_in_polygon(-1.0, 5.0, self.SQUARE))

    def test_degenerate_polygon_is_false(self):
        self.assertFalse(server._point_in_polygon(1.0, 1.0, "0,0 1,1"))
        self.assertFalse(server._point_in_polygon(1.0, 1.0, ""))

    def test_malformed_tokens_are_skipped(self):
        # Tokens without a comma / non-numeric coords are ignored, not fatal.
        self.assertTrue(server._point_in_polygon(5.0, 5.0, "0,0 junk 0,10 x,y 10,10 10,0"))


class AreaNameMatchTests(unittest.TestCase):
    def test_substring_both_directions(self):
        self.assertTrue(server._area_name_match("Bavaria", "Bavaria, Germany"))
        self.assertTrue(server._area_name_match("Greater London region", "London"))

    def test_no_overlap(self):
        self.assertFalse(server._area_name_match("Bavaria", "Catalonia"))

    def test_too_short_or_empty_is_false(self):
        self.assertFalse(server._area_name_match("", "London"))
        self.assertFalse(server._area_name_match("London", ""))
        self.assertFalse(server._area_name_match("NW", "NW England"))  # < 3 chars
        self.assertFalse(server._area_name_match(None, "London"))


class MeteoalarmSlugTests(unittest.TestCase):
    def test_slugs_are_sane(self):
        self.assertGreaterEqual(len(server.METEOALARM_SLUGS), 30)
        for cc, slug in server.METEOALARM_SLUGS.items():
            self.assertEqual(cc, cc.upper())
            self.assertEqual(len(cc), 2)
            self.assertTrue(slug and slug == slug.lower())
            self.assertNotIn(" ", slug)

    def test_unknown_country_returns_empty(self):
        # No slug -> no fetch, empty list (US handled by NWS elsewhere).
        self.assertEqual(server.meteoalarm_alerts(51.0, -3.0, "US"), [])
        self.assertEqual(server.meteoalarm_alerts(51.0, -3.0, ""), [])


class MeteoalarmMatchTests(unittest.TestCase):
    def setUp(self):
        server._cache.clear()

    def _feed(self, polygon=None, area_desc=None, event="Thunderstorm"):
        area = {}
        if polygon is not None:
            area["polygon"] = [polygon]
        if area_desc is not None:
            area["areaDesc"] = area_desc
        return {"warnings": [{"alert": {"info": [{
            "language": "en-GB", "event": event, "severity": "moderate",
            "headline": "Yellow thunderstorm warning", "area": [area],
            "onset": "T0", "expires": "T1",
        }]}}]}

    def test_polygon_hit(self):
        feed = self._feed(polygon="50,-4 50,-2 53,-2 53,-4")
        with mock.patch.object(server, "fetch_json", return_value=feed):
            out = server.meteoalarm_alerts(51.5, -3.0, "GB")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["event"], "Thunderstorm")
        self.assertEqual(out[0]["severity"], "Moderate")

    def test_polygon_miss(self):
        feed = self._feed(polygon="50,-4 50,-2 53,-2 53,-4")
        with mock.patch.object(server, "fetch_json", return_value=feed):
            out = server.meteoalarm_alerts(10.0, 10.0, "GB")
        self.assertEqual(out, [])

    def test_name_fallback_when_no_polygon(self):
        feed = self._feed(polygon=None, area_desc="Bavaria")
        with mock.patch.object(server, "fetch_json", return_value=feed):
            out = server.meteoalarm_alerts(48.0, 11.0, "DE", admin1="Bavaria")
        self.assertEqual(len(out), 1)

    def test_name_fallback_no_admin1_stays_silent(self):
        feed = self._feed(polygon=None, area_desc="Bavaria")
        with mock.patch.object(server, "fetch_json", return_value=feed):
            out = server.meteoalarm_alerts(48.0, 11.0, "DE", admin1=None)
        self.assertEqual(out, [])

    def test_fetch_failure_is_swallowed(self):
        with mock.patch.object(server, "fetch_json", side_effect=Exception("boom")):
            self.assertEqual(server.meteoalarm_alerts(51.5, -3.0, "GB"), [])


if __name__ == "__main__":
    unittest.main()
