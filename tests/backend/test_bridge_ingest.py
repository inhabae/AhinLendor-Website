from __future__ import annotations

import json
from types import SimpleNamespace

import spendee.runner as runner_module
from spendee.runner import SpendeeBridgeRunner


def test_bridge_pushes_bearer_authenticated_snapshot(monkeypatch) -> None:
    received: dict[str, object] = {}

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args: object) -> None:
            return None

    def urlopen(request, *, timeout: float):
        received["authorization"] = request.get_header("Authorization")
        received["payload"] = json.loads(request.data)
        received["timeout"] = timeout
        return Response()

    monkeypatch.setattr(runner_module.urllib.request, "urlopen", urlopen)
    runner = SpendeeBridgeRunner.__new__(SpendeeBridgeRunner)
    runner.config = SimpleNamespace(
        live_ingest_url="https://ahinlendor.example/api/live-saves/current",
        live_ingest_token="bridge-secret",
        live_ingest_timeout_sec=1.0,
    )
    runner.logger = SimpleNamespace(write_json=lambda *_args, **_kwargs: None)
    runner._push_live_save({"game_id": "bridge-smoke"})

    assert received == {
        "authorization": "Bearer bridge-secret",
        "payload": {"game_id": "bridge-smoke"},
        "timeout": 1.0,
    }
