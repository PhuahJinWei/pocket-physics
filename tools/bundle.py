#!/usr/bin/env python3
"""Inline the app into one self-contained HTML file.

Motion sensors only work on a secure origin, so testing on a real phone means
serving over https. A single file drops onto any static host (or into a Claude
artifact) with no build step, no bundler, and no node_modules.

    python tools/bundle.py

Writes:
    dist/silt.html           standalone document, open it or upload it anywhere
    dist/silt.artifact.html  same page as a fragment (no <html>/<head>/<body>),
                             for hosts that supply their own document shell

The module graph is resolved by reading `import ... from './x.js'` lines,
topologically sorting, then stripping the import/export keywords and
concatenating. That is enough for this project because every module uses named
exports with unique top-level names and there are no circular imports; anything
it cannot parse raises rather than silently emitting a broken bundle.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
ENTRY = SRC / "main.js"
HTML = ROOT / "index.html"
DIST = ROOT / "dist"

IMPORT_RE = re.compile(
    r"""^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?['"](?P<path>[^'"]+)['"]\s*;?\s*$"""
)
EXPORT_PREFIX_RE = re.compile(r"^(\s*)export\s+(?=(?:const|let|var|function|class|async)\b)")
BARE_IMPORT_RE = re.compile(r"^\s*import\b")
EXPORT_OTHER_RE = re.compile(r"^\s*export\s*[{*]")


def resolve(spec: str, importer: Path) -> Path:
    target = (importer.parent / spec).resolve()
    if not target.exists():
        raise SystemExit(f"{importer.name}: cannot resolve import {spec!r}")
    return target


def collect(entry: Path) -> list[Path]:
    """Depth-first post-order walk, so dependencies land before dependents."""
    order: list[Path] = []
    visiting: set[Path] = set()
    done: set[Path] = set()

    def visit(path: Path) -> None:
        if path in done:
            return
        if path in visiting:
            raise SystemExit(f"circular import involving {path.name}")
        visiting.add(path)
        for line in path.read_text(encoding="utf-8").splitlines():
            match = IMPORT_RE.match(line)
            if match:
                visit(resolve(match.group("path"), path))
            elif BARE_IMPORT_RE.match(line):
                raise SystemExit(
                    f"{path.name}: unsupported import form (keep imports on one line):\n  {line.strip()}"
                )
        visiting.discard(path)
        done.add(path)
        order.append(path)

    visit(entry)
    return order


def strip_module_syntax(path: Path) -> str:
    out: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if IMPORT_RE.match(line):
            continue
        if EXPORT_OTHER_RE.match(line):
            raise SystemExit(
                f"{path.name}: only `export <decl>` is supported, not re-exports:\n  {line.strip()}"
            )
        out.append(EXPORT_PREFIX_RE.sub(r"\1", line))
    return "\n".join(out).strip("\n")


def build_script(modules: list[Path]) -> str:
    parts = [f"// ---- {m.relative_to(ROOT).as_posix()} ----\n{strip_module_syntax(m)}" for m in modules]
    body = "\n\n".join(parts)
    # Wrapped so the concatenated top-level names stay off `window`.
    return "(function () {\n'use strict';\n\n" + body + "\n\n})();"


def main() -> int:
    html = HTML.read_text(encoding="utf-8")
    css = (ROOT / "styles" / "app.css").read_text(encoding="utf-8")
    script = build_script(collect(ENTRY))

    page = re.sub(
        r'\s*<link rel="stylesheet"[^>]*>',
        f"\n<style>\n{css}\n</style>",
        html,
        count=1,
    )
    if "<style>" not in page:
        raise SystemExit("index.html: no <link rel=\"stylesheet\"> to replace")

    page, n = re.subn(
        r'\s*<script type="module"[^>]*></script>',
        f"\n<script>\n{script}\n</script>",
        page,
        count=1,
    )
    if not n:
        raise SystemExit("index.html: no <script type=\"module\"> to replace")

    DIST.mkdir(exist_ok=True)
    standalone = DIST / "silt.html"
    standalone.write_text(page, encoding="utf-8")

    # Fragment form: keep <title> (hosts use it to name the page) but drop the
    # document scaffolding they provide themselves. The stylesheet lives in the
    # head, so it has to be carried across explicitly or the page ships unstyled.
    body = re.search(r"<body>(.*)</body>", page, re.S)
    title = re.search(r"<title>(.*?)</title>", page, re.S)
    style = re.search(r"<style>.*?</style>", page, re.S)
    if not body:
        raise SystemExit("index.html: no <body> found")
    if not style:
        raise SystemExit("bundle: inlined <style> block went missing")
    fragment = (
        f"<title>{title.group(1) if title else 'Silt'}</title>\n"
        f"{style.group(0)}\n"
        f"{body.group(1).strip()}\n"
    )
    artifact = DIST / "silt.artifact.html"
    artifact.write_text(fragment, encoding="utf-8")

    for path in (standalone, artifact):
        print(f"{path.relative_to(ROOT).as_posix():28} {path.stat().st_size / 1024:6.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
