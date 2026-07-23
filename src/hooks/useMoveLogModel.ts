import { useMemo } from 'react';
import type { GameSnapshotDTO, MoveLogEntryDTO } from '../types';
import { isContinuationAction } from '../lib/actionEncoding';
import { continuationSuffix } from '../lib/gameUi';
import type {
  HighlightedMove,
  HighlightedVariation,
  MoveLogDisplayEntry,
  MoveLogRow,
  MoveToken,
  VariationBranch,
} from '../lib/appModels';

export function useMoveLogModel({
  loadedMoveLog,
  snapshot,
  variationBranches,
  activeVariationSelection,
  loadedHistoricalMainlineLength,
  loadedHistoricalMainlineTailSnapshot,
}: {
  loadedMoveLog: MoveLogEntryDTO[] | null;
  snapshot: GameSnapshotDTO | null;
  variationBranches: VariationBranch[];
  activeVariationSelection: HighlightedVariation | null;
  loadedHistoricalMainlineLength: number;
  loadedHistoricalMainlineTailSnapshot: number;
}) {
  const moveLogEntries = useMemo<MoveLogEntryDTO[]>(() => {
    if (loadedMoveLog && loadedMoveLog.length > 0) {
      return loadedMoveLog;
    }
    return snapshot?.move_log ?? [];
  }, [loadedMoveLog, snapshot?.move_log]);

  const moveLogDisplayEntries = useMemo<MoveLogDisplayEntry[]>(() => {
    let fullMoveNumber = 0;
    let continuationIndex = 0;

    return moveLogEntries.map((move) => {
      const isContinuation = isContinuationAction(move.action_idx);
      const displayActor = move.actor;

      if (isContinuation) {
        continuationIndex += 1;
      } else {
        continuationIndex = 0;
        if (displayActor === 'P0') {
          fullMoveNumber += 1;
        } else if (fullMoveNumber <= 0) {
          fullMoveNumber = 1;
        }
      }

      const suffix = continuationSuffix(continuationIndex);
      const base = `${fullMoveNumber}${suffix}`;
      const notation = displayActor === 'P0' ? `${base}.` : `${base}...`;

      return {
        ...move,
        actor: displayActor,
        notation,
        turnLabel: base,
        fullMoveNumber,
        continuationIndex,
      };
    });
  }, [moveLogEntries]);

  const moveLogRows = useMemo<MoveLogRow[]>(() => {
    const rows: MoveLogRow[] = [];
    const rowByLabel = new Map<string, number>();
    for (const move of moveLogDisplayEntries) {
      const moveNumberLabel = move.turnLabel;
      const existingIdx = rowByLabel.get(move.turnLabel);
      if (existingIdx != null) {
        const existing = rows[existingIdx];
        if (move.actor === 'P0') {
          if (existing.p0 == null) {
            existing.p0 = move;
          } else {
            rows.push({ moveNumber: move.fullMoveNumber, moveNumberLabel, p0: move });
          }
        } else if (existing.p1 == null) {
          existing.p1 = move;
        } else {
          rows.push({ moveNumber: move.fullMoveNumber, moveNumberLabel, p1: move });
        }
      } else {
        rows.push(
          move.actor === 'P0'
            ? { moveNumber: move.fullMoveNumber, moveNumberLabel, p0: move }
            : { moveNumber: move.fullMoveNumber, moveNumberLabel, p1: move }
        );
        rowByLabel.set(move.turnLabel, rows.length - 1);
      }
    }
    return rows;
  }, [moveLogDisplayEntries]);

  const mainlineMoveNumberBySnapshot = useMemo<Map<number, number>>(() => {
    const out = new Map<number, number>();
    for (const row of moveLogRows) {
      if (row.p0?.result_snapshot_index != null) {
        out.set(row.p0.result_snapshot_index, row.moveNumber);
      }
      if (row.p1?.result_snapshot_index != null) {
        out.set(row.p1.result_snapshot_index, row.moveNumber);
      }
    }
    return out;
  }, [moveLogRows]);

  const variationBranchByAnchor = useMemo<Map<number, VariationBranch[]>>(() => {
    const out = new Map<number, VariationBranch[]>();
    for (const branch of variationBranches) {
      const existing = out.get(branch.anchorSnapshotIndex);
      if (existing) {
        existing.push(branch);
      } else {
        out.set(branch.anchorSnapshotIndex, [branch]);
      }
    }
    return out;
  }, [variationBranches]);

  const moveLogTokens = useMemo<MoveToken[]>(() => {
    const tokens: MoveToken[] = [];
    for (let rowIdx = 0; rowIdx < moveLogRows.length; rowIdx++) {
      const row = moveLogRows[rowIdx];
      tokens.push({ kind: 'mainline_row', row, rowIdx });
      const p0Snap = row.p0?.result_snapshot_index ?? null;
      const p1Snap = row.p1?.result_snapshot_index ?? null;
      const anchors: number[] = [];
      if (p0Snap != null) anchors.push(p0Snap);
      if (p1Snap != null && p1Snap !== p0Snap) anchors.push(p1Snap);
      for (const snap of anchors) {
        for (const branch of (variationBranchByAnchor.get(snap) ?? [])) {
          tokens.push({ kind: 'deviation_block', branch });
        }
      }
    }
    const preGame = variationBranchByAnchor.get(0) ?? [];
    if (preGame.length > 0) {
      tokens.unshift(...preGame.map((branch) => ({ kind: 'deviation_block' as const, branch })));
    }
    return tokens;
  }, [moveLogRows, variationBranchByAnchor]);

  const currentSnapshotIndex = useMemo<number>(() => {
    if (!snapshot) {
      return 0;
    }
    if (snapshot.current_snapshot_index != null) {
      return Number(snapshot.current_snapshot_index);
    }
    if (moveLogEntries.length === 0) {
      return 0;
    }
    let bestSnapshotIndex = 0;
    for (const move of moveLogEntries) {
      if (move.result_turn_index > snapshot.turn_index) {
        continue;
      }
      if (move.result_snapshot_index > bestSnapshotIndex) {
        bestSnapshotIndex = move.result_snapshot_index;
      }
    }
    return bestSnapshotIndex;
  }, [snapshot, moveLogEntries]);

  const mainlineMoveSnapshotIndices = useMemo<number[]>(() => {
    const indices = moveLogEntries
      .map((move) => move.result_snapshot_index)
      .filter((value) => Number.isFinite(value) && value > 0);
    return [0, ...Array.from(new Set(indices))];
  }, [moveLogEntries]);

  const mainlineMoveTurnIndices = useMemo<number[]>(() => {
    const indices = moveLogEntries
      .map((move) => move.result_turn_index)
      .filter((value) => Number.isFinite(value) && value > 0);
    return [0, ...Array.from(new Set(indices))];
  }, [moveLogEntries]);

  const isLoadedMainlineExtensionState = useMemo<boolean>(() => {
    return Boolean(
      snapshot &&
      loadedHistoricalMainlineLength > 0 &&
      snapshot.current_snapshot_index == null &&
      currentSnapshotIndex > loadedHistoricalMainlineTailSnapshot
    );
  }, [snapshot, currentSnapshotIndex, loadedHistoricalMainlineLength, loadedHistoricalMainlineTailSnapshot]);

  const useTurnNavigationForVisibleMainline = Boolean(snapshot?.current_snapshot_index == null && !isLoadedMainlineExtensionState);
  const visibleMainlineTargets = useMemo<number[]>(() => {
    return useTurnNavigationForVisibleMainline ? mainlineMoveTurnIndices : mainlineMoveSnapshotIndices;
  }, [useTurnNavigationForVisibleMainline, mainlineMoveTurnIndices, mainlineMoveSnapshotIndices]);
  const visibleMainlinePosition = useMemo<number>(() => {
    if (!snapshot) {
      return 0;
    }
    return useTurnNavigationForVisibleMainline ? snapshot.turn_index : currentSnapshotIndex;
  }, [snapshot, useTurnNavigationForVisibleMainline, currentSnapshotIndex]);
  const canStepVisibleMainlineBackward = useMemo<boolean>(() => {
    return visibleMainlineTargets.some((target) => target < visibleMainlinePosition);
  }, [visibleMainlineTargets, visibleMainlinePosition]);
  const canStepVisibleMainlineForward = useMemo<boolean>(() => {
    return visibleMainlineTargets.some((target) => target > visibleMainlinePosition);
  }, [visibleMainlineTargets, visibleMainlinePosition]);

  const highlightedMove = useMemo<HighlightedMove | null>(() => {
    if (moveLogDisplayEntries.length === 0 || currentSnapshotIndex <= 0) {
      return null;
    }
    let best: MoveLogDisplayEntry | null = null;
    for (const move of moveLogDisplayEntries) {
      if (move.result_snapshot_index > currentSnapshotIndex) {
        continue;
      }
      if (!best || move.result_snapshot_index > best.result_snapshot_index) {
        best = move;
      }
    }
    if (!best) {
      return null;
    }
    return {
      actor: best.actor,
      resultTurnIndex: best.result_turn_index,
      resultSnapshotIndex: best.result_snapshot_index,
    };
  }, [moveLogDisplayEntries, currentSnapshotIndex]);

  const highlightedVariation = useMemo<HighlightedVariation | null>(() => {
    if (!activeVariationSelection) {
      return null;
    }
    const branch = variationBranches.find((item) => item.id === activeVariationSelection.branchId) ?? null;
    if (!branch || activeVariationSelection.moveIndex < 0 || activeVariationSelection.moveIndex >= branch.moves.length) {
      return null;
    }
    return activeVariationSelection;
  }, [activeVariationSelection, variationBranches]);

  return {
    moveLogEntries,
    moveLogDisplayEntries,
    moveLogRows,
    mainlineMoveNumberBySnapshot,
    variationBranchByAnchor,
    moveLogTokens,
    currentSnapshotIndex,
    mainlineMoveSnapshotIndices,
    mainlineMoveTurnIndices,
    isLoadedMainlineExtensionState,
    visibleMainlineTargets,
    visibleMainlinePosition,
    canStepVisibleMainlineBackward,
    canStepVisibleMainlineForward,
    highlightedMove,
    highlightedVariation,
  };
}
