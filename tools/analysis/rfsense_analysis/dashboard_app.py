"""Dashboard entrypoint that extends the core server with modular frontend assets."""

from __future__ import annotations

import mimetypes
from urllib.parse import urlparse

from . import dashboard

_BASE_MAKE_HANDLER = dashboard._make_handler
_EXTRA_ASSETS = {"boot.js", "controls.js", "d3.js", "main.js", "stream.js", "ui.js"}


def _make_handler(holder, history, trainer, markers, interval):
    base = _BASE_MAKE_HANDLER(holder, history, trainer, markers, interval)

    class Handler(base):
        def do_GET(self) -> None:  # noqa: N802
            relative = urlparse(self.path).path.removeprefix("/")
            if relative in _EXTRA_ASSETS:
                target = dashboard.WEB_ROOT / relative
                if not target.is_file():
                    self._send(404, "text/plain; charset=utf-8", b"dashboard asset not found")
                    return
                ctype = mimetypes.guess_type(target.name)[0] or "application/javascript"
                self._send(
                    200,
                    f"{ctype}; charset=utf-8",
                    target.read_bytes(),
                    cache="public, max-age=300",
                )
                return
            super().do_GET()

    return Handler


def main(argv: list[str] | None = None) -> int:
    original = dashboard._make_handler
    dashboard._make_handler = _make_handler
    try:
        return dashboard.main(argv)
    finally:
        dashboard._make_handler = original
