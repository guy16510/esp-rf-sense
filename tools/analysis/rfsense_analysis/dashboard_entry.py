"""Production-facing dashboard entrypoint with compact timeline history."""

from __future__ import annotations

from typing import Any

from . import dashboard, dashboard_app


class CompactHistoryHolder(dashboard.HistoryHolder):
    """Store only fields required by the rolling browser timeline."""

    def append(self, state: dict[str, Any]) -> None:
        scene = state.get("scene") or {}
        compact = {
            "ts": state.get("ts"),
            "state": state.get("state"),
            "confidence": state.get("confidence", 0.0),
            "motion": state.get("motion", 0.0),
            "scene": {"audience": scene.get("audience") or {}},
        }
        super().append(compact)


def main(argv: list[str] | None = None) -> int:
    original = dashboard.HistoryHolder
    dashboard.HistoryHolder = CompactHistoryHolder
    try:
        return dashboard_app.main(argv)
    finally:
        dashboard.HistoryHolder = original
