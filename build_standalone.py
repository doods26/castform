#!/usr/bin/env python3
"""
Build a single self-contained standalone.html from the app sources.

The output runs with NO backend: a fetch shim (standalone-api.js) answers the
app's /api/* calls directly from the browser. Chart.js + Leaflet load from CDN;
everything else (our CSS + JS) is inlined. Paste it into an omg.lol page, host
it as a static file, or open it from disk.

Usage:  python build_standalone.py   ->   standalone.html
"""

import re
from pathlib import Path

ROOT = Path(__file__).parent
PUB = ROOT / "public"


def read(rel):
    return (PUB / rel).read_text(encoding="utf-8")


def bundle_module(src, is_entry):
    """Convert an ES module to an IIFE that shares exports via a __NS__ object."""
    # Collect imported names (only the entry module imports).
    imported = []
    for grp in re.findall(r'import\s*\{([^}]*)\}\s*from\s*["\'][^"\']+["\'];?', src):
        imported += [n.strip() for n in grp.split(",") if n.strip()]
    src = re.sub(r'import\s*\{[^}]*\}\s*from\s*["\'][^"\']+["\'];?\n?', "", src)

    # Collect exported names.
    exports = set()
    for m in re.finditer(r'export\s+(?:async\s+)?function\s+(\w+)', src):
        exports.add(m.group(1))
    for m in re.finditer(r'export\s+(?:const|let|var|class)\s+(\w+)', src):
        exports.add(m.group(1))
    for m in re.finditer(r'export\s*\{([^}]*)\}', src):
        for n in m.group(1).split(","):
            n = n.strip().split(" as ")[0].strip()
            if n:
                exports.add(n)
    # Strip the export keyword.
    src = re.sub(r'export\s+(async\s+function|function|const|let|var|class)', r"\1", src)
    src = re.sub(r'export\s*\{[^}]*\};?\n?', "", src)

    pre = f"const {{ {', '.join(imported)} }} = __NS__;\n" if imported else ""
    post = f"\nObject.assign(__NS__, {{ {', '.join(sorted(exports))} }});" if exports else ""
    return f"(function(){{\n{pre}{src}{post}\n}})();"


def main():
    css = read("css/styles.css")
    shim = read("js/standalone-api.js")

    # Order matters: dependencies before the entry (app.js).
    libs = ["js/wmo.js", "js/gauge.js", "js/effects.js", "js/radar.js", "js/prayer.js"]
    parts = ["const __NS__ = {};", shim]
    for rel in libs:
        parts.append(bundle_module(read(rel), is_entry=False))
    parts.append(bundle_module(read("js/app.js"), is_entry=True))
    js = "\n".join(parts)

    # Pull the <body> markup out of index.html, minus its <script> tags.
    html = read("index.html")
    body = re.search(r"<body[^>]*>(.*)</body>", html, re.S).group(1)
    body = re.sub(r"<script\b[^>]*>.*?</script>", "", body, flags=re.S).strip()

    out = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Castform · weather, evolved</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='46' fill='%23fff' stroke='%23111' stroke-width='6'/%3E%3Cpath d='M4 50a46 46 0 0 1 92 0z' fill='%23ff4d4d'/%3E%3Cline x1='4' y1='50' x2='96' y2='50' stroke='%23111' stroke-width='6'/%3E%3Ccircle cx='50' cy='50' r='13' fill='%23fff' stroke='%23111' stroke-width='6'/%3E%3C/svg%3E" />
  <link rel="manifest" href="manifest.json" />
  <meta name="theme-color" content="#16233f" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Castform" />
  <link rel="apple-touch-icon" href="apple-touch-icon.png" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
{css}
  </style>
</head>
<body data-theme="cloudy">
{body}
  <script>
{js}
  </script>
</body>
</html>
"""
    # Markdown-safety: Markdown/CommonMark renderers (like omg.lol's weblog) keep
    # a raw-HTML block intact only until the first BLANK line — after which they
    # resume Markdown parsing and turn indented HTML into a literal code block.
    # Removing every blank line makes the whole document one continuous raw-HTML
    # block, so it pastes into a weblog page untouched. (Blank lines are
    # meaningless to HTML/CSS/JS, so this changes nothing functionally.)
    out = "\n".join(line for line in out.splitlines() if line.strip() != "")

    (ROOT / "standalone.html").write_text(out, encoding="utf-8")
    # Also drop a copy in public/ so it can be served/tested via the dev server.
    (PUB / "standalone.html").write_text(out, encoding="utf-8")
    kb = round(len(out.encode("utf-8")) / 1024, 1)
    print(f"Wrote standalone.html ({kb} KB, blank-line-free for weblog paste)")

    # Markdown-proof embed: the whole app inside ONE <iframe srcdoc="...">.
    # A single HTML tag the weblog can't mangle; the iframe is CSS-isolated from
    # the weblog template; and because srcdoc shares the page's origin,
    # localStorage (favorites/units) still works.
    esc = out.replace("&", "&amp;").replace('"', "&quot;")
    embed = ('<iframe title="Castform" srcdoc="' + esc + '" '
             'style="width:100%;height:100vh;min-height:920px;border:0;display:block"></iframe>')
    (ROOT / "standalone-embed.html").write_text(embed, encoding="utf-8")
    (PUB / "standalone-embed.html").write_text(embed, encoding="utf-8")
    print(f"Wrote standalone-embed.html ({round(len(embed.encode('utf-8'))/1024,1)} KB, iframe wrapper for weblog)")


if __name__ == "__main__":
    main()
