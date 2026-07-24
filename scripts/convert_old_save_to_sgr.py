#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SPLENDOR_ZERO_ROOT = REPO_ROOT.parent / "Splendor-Zero"
for import_path in (REPO_ROOT / "backend", SPLENDOR_ZERO_ROOT):
    if import_path.exists():
        sys.path.insert(0, str(import_path))

from ahinlendor import api  # noqa: E402


CATALOG_VERSION = "standard-90-card-10-noble-v1"


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("Old save root must be a JSON object")
    return data


def _state(snapshot: dict[str, Any]) -> dict[str, Any]:
    state = snapshot.get("exported_state")
    if not isinstance(state, dict):
        raise ValueError("Snapshot is missing exported_state")
    return state


def _setup_from_state(state: dict[str, Any]) -> dict[str, Any]:
    faceup = state.get("faceup_card_ids")
    nobles = state.get("available_noble_ids")
    if (
        not isinstance(faceup, list)
        or len(faceup) != 3
        or any(not isinstance(row, list) or len(row) != 4 for row in faceup)
    ):
        raise ValueError("Initial snapshot must contain 3 tiers of 4 face-up cards")
    if not isinstance(nobles, list) or len(nobles) != 3:
        raise ValueError("Initial snapshot must contain exactly 3 nobles")
    return {
        "faceup_cards": {
            str(tier): [int(card_id) for card_id in faceup[tier - 1]]
            for tier in (1, 2, 3)
        },
        "nobles": [int(noble_id) for noble_id in nobles],
    }


def _faceup_reveal_events(start: dict[str, Any], end: dict[str, Any]) -> list[dict[str, int | str]]:
    start_rows = start.get("faceup_card_ids")
    end_rows = end.get("faceup_card_ids")
    if not isinstance(start_rows, list) or not isinstance(end_rows, list):
        return []
    events: list[dict[str, int | str]] = []
    for tier_idx, (start_row, end_row) in enumerate(zip(start_rows, end_rows), start=1):
        if not isinstance(start_row, list) or not isinstance(end_row, list):
            continue
        for slot, (before, after) in enumerate(zip(start_row, end_row)):
            if before != after and isinstance(after, int) and int(after) > 0:
                events.append({"k": "rc", "t": tier_idx, "s": slot, "c": int(after)})
    return events


def _reserved_by_slot(state: dict[str, Any], player_index: int) -> dict[int, dict[str, Any]]:
    players = state.get("players")
    if not isinstance(players, list) or player_index >= len(players):
        return {}
    player = players[player_index]
    if not isinstance(player, dict):
        return {}
    reserved = player.get("reserved")
    if not isinstance(reserved, list):
        return {}
    out: dict[int, dict[str, Any]] = {}
    for idx, item in enumerate(reserved):
        if isinstance(item, dict):
            out[int(item.get("slot", idx))] = item
    return out


def _purchased_delta(before: dict[str, Any], after: dict[str, Any], player_index: int) -> list[int]:
    players_before = before.get("players")
    players_after = after.get("players")
    if not isinstance(players_before, list) or not isinstance(players_after, list):
        return []
    if player_index >= len(players_before) or player_index >= len(players_after):
        return []
    purchased_before = players_before[player_index].get("purchased_card_ids", [])
    purchased_after = players_after[player_index].get("purchased_card_ids", [])
    if not isinstance(purchased_before, list) or not isinstance(purchased_after, list):
        return []
    remaining = [int(card_id) for card_id in purchased_after if isinstance(card_id, int)]
    for card_id in purchased_before:
        if isinstance(card_id, int) and int(card_id) in remaining:
            remaining.remove(int(card_id))
    return remaining


def _lookahead_hidden_reserved_card_id(
    snapshots: list[dict[str, Any]],
    *,
    start_snapshot_idx: int,
    player_index: int,
    slot: int,
    fallback_card_id: int,
) -> int:
    for idx in range(start_snapshot_idx + 1, len(snapshots)):
        before = _state(snapshots[idx - 1])
        after = _state(snapshots[idx])
        before_slots = _reserved_by_slot(before, player_index)
        after_slots = _reserved_by_slot(after, player_index)
        if slot in before_slots and slot not in after_slots:
            delta = _purchased_delta(before, after, player_index)
            if len(delta) == 1:
                return int(delta[0])
            return int(fallback_card_id)
        if slot not in after_slots:
            return int(fallback_card_id)
    return int(fallback_card_id)


def _reserved_reveal_event(
    snapshots: list[dict[str, Any]],
    snapshot_idx: int,
    start: dict[str, Any],
    end: dict[str, Any],
    action_idx: int,
) -> dict[str, int | str] | None:
    if not api.is_reserve_deck_action(action_idx):
        return None
    actor_index = int(start.get("current_player", 0))
    actor = "P0" if actor_index == 0 else "P1"
    start_slots = _reserved_by_slot(start, actor_index)
    end_slots = _reserved_by_slot(end, actor_index)
    for slot, item in sorted(end_slots.items()):
        before = start_slots.get(slot)
        if before is not None and before.get("card_id") == item.get("card_id"):
            continue
        card_id = item.get("card_id")
        if isinstance(card_id, int) and int(card_id) > 0:
            actual_card_id = _lookahead_hidden_reserved_card_id(
                snapshots,
                start_snapshot_idx=snapshot_idx,
                player_index=actor_index,
                slot=int(slot),
                fallback_card_id=int(card_id),
            )
            return {"k": "rr", "p": actor, "t": int(action_idx) - 26, "s": int(slot), "c": int(actual_card_id)}
    return None


def _result_from_last_state(last_state: dict[str, Any], final_turn_index: int) -> dict[str, Any]:
    status = "COMPLETED" if api._bridge_snapshot_indicates_finished(last_state) else "ABANDONED"
    winner_int = api._winner_from_saved_state(last_state) if status == "COMPLETED" else -1
    winner = "P0" if winner_int == 0 else "P1" if winner_int == 1 else None
    return {
        "status": status,
        "winner": winner,
        "final_turn_index": int(final_turn_index),
    }


def _validated_result(replay: dict[str, Any]) -> dict[str, Any]:
    manager = api.GameManager()
    snapshot = manager.load_replay(api.GameReplayDTO(**replay))
    if snapshot.status != "IN_PROGRESS":
        winner = "P0" if int(snapshot.winner) == 0 else "P1" if int(snapshot.winner) == 1 else None
        return {
            "status": "COMPLETED",
            "winner": winner,
            "final_turn_index": int(snapshot.turn_index),
        }
    return replay["result"]


def convert_old_save(data: dict[str, Any]) -> dict[str, Any]:
    raw_snapshots = data.get("snapshots")
    if not isinstance(raw_snapshots, list) or not raw_snapshots:
        raise ValueError("Old save must contain at least one snapshot")
    snapshots = [
        saved.model_dump()
        for saved in api._normalize_saved_snapshots_hidden_reserved_cards(
            [api.SavedStateDTO(**snapshot) for snapshot in raw_snapshots]
        )
    ]

    first_state = _state(snapshots[0])
    env = api.SplendorNativeEnv()
    env.reset(seed=0)
    events: list[dict[str, Any]] = []
    final_turn_index = 0

    for idx in range(1, len(snapshots)):
        start = _state(snapshots[idx - 1])
        end = _state(snapshots[idx])
        inferred = api._infer_actions_between_snapshots(env, start, end)
        if inferred is None:
            raise ValueError(f"Could not infer action delta between snapshots {idx - 1} and {idx}")
        for action_idx in inferred:
            action_idx = int(action_idx)
            events.append({"k": "m", "a": action_idx})
            final_turn_index += 1
            reserved_event = _reserved_reveal_event(snapshots, idx, start, end, action_idx)
            if reserved_event is not None:
                events.append(reserved_event)
        events.extend(_faceup_reveal_events(start, end))

    saved_at = str(data.get("saved_at") or "")
    try:
        created_at = datetime.fromisoformat(saved_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        created_at = datetime.now(timezone.utc)

    game_id = str(data.get("game_id") or uuid.uuid4())
    replay = {
        "format": "sgr",
        "version": 1,
        "game_id": game_id,
        "created_at": created_at.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "catalog_version": CATALOG_VERSION,
        "players": {
            "P0": {"name": "Player 1"},
            "P1": {"name": "Player 2"},
        },
        "rules": {
            "target_points": 15,
            "num_players": 2,
        },
        "setup": _setup_from_state(first_state),
        "events": events,
        "result": _result_from_last_state(_state(snapshots[-1]), final_turn_index),
    }
    replay["result"] = _validated_result(replay)
    return replay


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert old AhinLendor snapshot saves to deckless SGR replay JSON.")
    parser.add_argument("input", type=Path)
    parser.add_argument("-o", "--output", type=Path)
    args = parser.parse_args()

    output = args.output
    if output is None:
        output = args.input.with_name(f"{args.input.stem}.sgr.json")

    replay = convert_old_save(_load_json(args.input))
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        json.dump(replay, handle, indent=2)
        handle.write("\n")
    print(f"wrote {output}")
    print(f"events={len(replay['events'])} final_turn_index={replay['result']['final_turn_index']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
