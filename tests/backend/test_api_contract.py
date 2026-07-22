from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from ahinlendor import api


def live_payload() -> dict:
    return {
        "version": 2,
        "saved_at": "2026-07-21T00:00:00+00:00",
        "game_id": "live-test",
        "config": {
            "checkpoint_id": "champion",
            "checkpoint_path": "/data/checkpoints/champion.pt",
            "num_simulations": 32,
            "player_seat": "P0",
            "seed": 1,
            "manual_reveal_mode": False,
            "analysis_mode": True,
        },
        "snapshots": [],
        "current_index": 0,
    }


def test_healthz() -> None:
    client = TestClient(api.app)
    assert client.get("/healthz").json() == {"ok": True}


def test_catalogs_and_spa_fallback() -> None:
    client = TestClient(api.app)
    assert len(client.get("/api/cards").json()) == 90
    assert len(client.get("/api/nobles").json()) == 10
    response = client.get("/analysis")
    assert response.status_code == 200
    assert "AhinLendor" in response.text


def test_live_ingest_requires_bearer_token(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(api, "LIVE_INGEST_TOKEN", "correct-token")
    monkeypatch.setattr(api, "SPENDEE_LIVE_SAVE_PATH", tmp_path / "current.json")
    client = TestClient(api.app)

    response = client.put("/api/live-saves/current", json=live_payload())
    assert response.status_code == 401
    assert not (tmp_path / "current.json").exists()


def test_live_ingest_is_atomic_and_status_compatible(tmp_path: Path, monkeypatch) -> None:
    live_path = tmp_path / "current.json"
    monkeypatch.setattr(api, "LIVE_INGEST_TOKEN", "correct-token")
    monkeypatch.setattr(api, "SPENDEE_LIVE_SAVE_PATH", live_path)
    client = TestClient(api.app)

    response = client.put(
        "/api/live-saves/current",
        headers={"Authorization": "Bearer correct-token"},
        json=live_payload(),
    )
    assert response.status_code == 200
    assert response.json()["exists"] is True
    assert json.loads(live_path.read_text())["game_id"] == "live-test"
    assert client.get("/api/game/live-save/status").json()["exists"] is True
    assert not list(tmp_path.glob("*.tmp"))
