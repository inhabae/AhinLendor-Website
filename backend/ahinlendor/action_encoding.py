from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_ACTION_ENCODING_PATH = Path(__file__).resolve().parents[2] / "shared" / "action_encoding.json"

with _ACTION_ENCODING_PATH.open("r", encoding="utf-8") as _handle:
    _ACTION_ENCODING: dict[str, Any] = json.load(_handle)

BUY_FACEUP_RANGE = tuple(_ACTION_ENCODING["buyFaceup"])
BUY_RESERVED_RANGE = tuple(_ACTION_ENCODING["buyReserved"])
RESERVE_FACEUP_RANGE = tuple(_ACTION_ENCODING["reserveFaceup"])
RESERVE_DECK_RANGE = tuple(_ACTION_ENCODING["reserveDeck"])
TAKE3_RANGE = tuple(_ACTION_ENCODING["take3"])
TAKE2_SAME_RANGE = tuple(_ACTION_ENCODING["take2Same"])
TAKE2_RANGE = tuple(_ACTION_ENCODING["take2"])
TAKE1_RANGE = tuple(_ACTION_ENCODING["take1"])
PASS_RANGE = tuple(_ACTION_ENCODING["pass"])
RETURN_RANGE = tuple(_ACTION_ENCODING["return"])
NOBLE_RANGE = tuple(_ACTION_ENCODING["noble"])
CONTINUATION_RANGE = tuple(_ACTION_ENCODING["continuation"])

TAKE3_TRIPLETS: tuple[tuple[int, int, int], ...] = tuple(tuple(item) for item in _ACTION_ENCODING["take3Triplets"])
TAKE2_PAIRS: tuple[tuple[int, int], ...] = tuple(tuple(item) for item in _ACTION_ENCODING["take2Pairs"])


def _in_range(action_idx: int, action_range: tuple[int, int]) -> bool:
    return action_range[0] <= int(action_idx) <= action_range[1]


def is_buy_faceup_action(action_idx: int) -> bool:
    return _in_range(action_idx, BUY_FACEUP_RANGE)


def is_buy_reserved_action(action_idx: int) -> bool:
    return _in_range(action_idx, BUY_RESERVED_RANGE)


def is_reserve_faceup_action(action_idx: int) -> bool:
    return _in_range(action_idx, RESERVE_FACEUP_RANGE)


def is_reserve_deck_action(action_idx: int) -> bool:
    return _in_range(action_idx, RESERVE_DECK_RANGE)


def is_take3_action(action_idx: int) -> bool:
    return _in_range(action_idx, TAKE3_RANGE)


def is_take2_same_action(action_idx: int) -> bool:
    return _in_range(action_idx, TAKE2_SAME_RANGE)


def is_take2_action(action_idx: int) -> bool:
    return _in_range(action_idx, TAKE2_RANGE)


def is_take1_action(action_idx: int) -> bool:
    return _in_range(action_idx, TAKE1_RANGE)


def is_pass_action(action_idx: int) -> bool:
    return _in_range(action_idx, PASS_RANGE)


def is_return_action(action_idx: int) -> bool:
    return _in_range(action_idx, RETURN_RANGE)


def is_noble_action(action_idx: int) -> bool:
    return _in_range(action_idx, NOBLE_RANGE)


def is_continuation_action(action_idx: int) -> bool:
    return _in_range(action_idx, CONTINUATION_RANGE)
