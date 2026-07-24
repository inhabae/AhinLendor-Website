from __future__ import annotations

import time

from fastapi.testclient import TestClient

from ahinlendor import api
from nn.checkpoints import save_checkpoint
from nn.model import MaskedPolicyValueNet


def test_native_game_search_save_and_replay(tmp_path, monkeypatch) -> None:
    checkpoint_dir = tmp_path / "checkpoints"
    checkpoint = save_checkpoint(
        MaskedPolicyValueNet(hidden_dim=16),
        output_dir=checkpoint_dir,
        run_id="smoke",
        cycle_idx=0,
        metadata={"seed": 1, "collector_policy": "smoke", "mcts_sims": 2},
    )
    monkeypatch.setattr(api, "CHECKPOINT_DIR", checkpoint_dir)
    monkeypatch.setattr(api, "manager", api.GameManager())
    client = TestClient(api.app)

    response = client.post(
        "/api/game/new",
        json={
            "num_simulations": 2,
            "player_seat": "P0",
            "seed": 1,
            "manual_reveal_mode": False,
            "analysis_mode": True,
        },
    )
    assert response.status_code == 200, response.text
    snapshot = response.json()
    assert snapshot["board_state"] is not None
    assert snapshot["legal_actions"]

    think = client.post("/api/game/engine-think", json={"search_type": "mcts", "num_simulations": 2})
    assert think.status_code == 200, think.text
    job_id = think.json()["job_id"]
    for _ in range(200):
        job = client.get(f"/api/game/engine-job/{job_id}").json()
        if job["status"] in {"DONE", "FAILED", "CANCELLED"}:
            break
        time.sleep(0.01)
    assert job["status"] == "DONE", job
    assert job["result"]["action_idx"] in snapshot["legal_actions"]

    move = client.post("/api/game/player-move", json={"action_idx": snapshot["legal_actions"][0]})
    assert move.status_code == 200, move.text
    assert move.json()["snapshot"]["turn_index"] >= 1
    assert client.post("/api/game/undo-to-start").status_code == 200
    assert client.post("/api/game/redo-to-end").status_code == 200


def test_sgr_replay_export_and_load_does_not_store_deck_order(tmp_path, monkeypatch) -> None:
    checkpoint_dir = tmp_path / "checkpoints"
    save_checkpoint(
        MaskedPolicyValueNet(hidden_dim=16),
        output_dir=checkpoint_dir,
        run_id="smoke",
        cycle_idx=0,
        metadata={"seed": 1, "collector_policy": "smoke", "mcts_sims": 2},
    )
    monkeypatch.setattr(api, "CHECKPOINT_DIR", checkpoint_dir)
    monkeypatch.setattr(api, "manager", api.GameManager())
    client = TestClient(api.app)

    response = client.post(
        "/api/game/new",
        json={
            "num_simulations": 2,
            "player_seat": "P0",
            "seed": 1,
            "manual_reveal_mode": True,
            "analysis_mode": True,
        },
    )
    assert response.status_code == 200, response.text

    for tier in (1, 2, 3):
        for slot in range(4):
            current = client.get("/api/game/state").json()
            card_id = current["hidden_faceup_reveal_candidates"][f"{tier}:{slot}"][0]
            reveal = client.post("/api/game/reveal-card", json={"tier": tier, "slot": slot, "card_id": card_id})
            assert reveal.status_code == 200, reveal.text

    for slot, noble in enumerate(api.list_standard_nobles()[:3]):
        reveal = client.post("/api/game/reveal-noble", json={"slot": slot, "noble_id": int(noble["id"])})
        assert reveal.status_code == 200, reveal.text

    snapshot = client.get("/api/game/state").json()
    assert snapshot["pending_reveals"] == []
    move = client.post("/api/game/player-move", json={"action_idx": snapshot["legal_actions"][0]})
    assert move.status_code == 200, move.text

    replay_response = client.get("/api/game/replay")
    assert replay_response.status_code == 200, replay_response.text
    replay = replay_response.json()
    assert replay["format"] == "sgr"
    assert replay["version"] == 1
    assert replay["catalog_version"] == "standard-90-card-10-noble-v1"
    assert set(replay["setup"]) == {"faceup_cards", "nobles"}
    assert "deck_card_ids_by_tier" not in replay
    assert "snapshots" not in replay
    assert replay["events"] == [{"k": "m", "a": snapshot["legal_actions"][0]}]

    monkeypatch.setattr(api, "manager", api.GameManager())
    loaded = client.post("/api/game/replay/load", json=replay)
    assert loaded.status_code == 200, loaded.text
    loaded_snapshot = loaded.json()
    assert loaded_snapshot["game_id"] == replay["game_id"]
    assert loaded_snapshot["turn_index"] == 1
    assert loaded_snapshot["move_log"][0]["action_idx"] == snapshot["legal_actions"][0]
