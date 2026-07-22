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
