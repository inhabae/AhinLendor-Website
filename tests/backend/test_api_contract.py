from __future__ import annotations

from fastapi.testclient import TestClient

from ahinlendor import api


class FakeEnv:
    def __init__(self, state: dict) -> None:
        self.state = state

    def export_state(self) -> dict:
        return self.state

    def load_state(self, state: dict) -> None:
        self.state = state


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


def test_force_set_hidden_reserved_card_swaps_with_hidden_deck_pool() -> None:
    tier = 1
    previous_card_id, selected_card_id = list(api._STANDARD_CARD_TIER_BY_ID)[:2]
    for first_id, first_tier in api._STANDARD_CARD_TIER_BY_ID.items():
        if first_tier != tier:
            continue
        for second_id, second_tier in api._STANDARD_CARD_TIER_BY_ID.items():
            if second_id != first_id and second_tier == tier:
                previous_card_id = first_id
                selected_card_id = second_id
                break
        else:
            continue
        break
    state = {
        "faceup_card_ids": [[], [], []],
        "deck_card_ids_by_tier": [[selected_card_id], [], []],
        "players": [
            {"purchased_card_ids": [], "reserved": []},
            {
                "purchased_card_ids": [],
                "reserved": [
                    {"slot": 0, "card_id": previous_card_id, "is_public": False},
                ],
            },
        ],
    }
    env = FakeEnv(state)

    assert api._force_set_hidden_reserved_card(env, player_idx=1, slot=0, card_id=selected_card_id)

    reserved = env.state["players"][1]["reserved"][0]
    assert reserved["card_id"] == selected_card_id
    assert reserved["is_public"] is True
    assert selected_card_id not in env.state["deck_card_ids_by_tier"][0]
    assert previous_card_id in env.state["deck_card_ids_by_tier"][0]


def test_resolve_checkpoint_uses_requested_checkpoint(monkeypatch) -> None:
    first = api.CheckpointDTO(
        id="/tmp/first.pt",
        name="first.pt",
        path="/tmp/first.pt",
        created_at="2026-01-01T00:00:00+00:00",
        size_bytes=1,
    )
    second = api.CheckpointDTO(
        id="/tmp/second.pt",
        name="second.pt",
        path="/tmp/second.pt",
        created_at="2026-01-02T00:00:00+00:00",
        size_bytes=1,
    )
    monkeypatch.setattr(api, "_scan_checkpoints", lambda: [first, second])

    manager = api.GameManager()

    assert manager._resolve_checkpoint(second.id) == api.Path(second.path)
    assert manager._resolve_checkpoint("first.pt") == api.Path(first.path)


def test_save_load_routes_are_exposed() -> None:
    route_paths = {
        getattr(route, "path", None)
        for route in api.app.routes
    }

    assert "/api/game/save" in route_paths
    assert "/api/game/load" in route_paths
    assert "/api/game/replay" in route_paths
    assert "/api/game/replay/load" in route_paths
