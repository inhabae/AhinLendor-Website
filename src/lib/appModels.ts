import type { ActionDisplayDTO, EngineJobStatusDTO, MoveLogEntryDTO, Seat } from '../types';

export type UiStatus = 'IDLE' | 'WAITING_ENGINE' | 'WAITING_PLAYER' | 'WAITING_REVEAL' | 'GAME_OVER';

export interface MoveLogRow {
  moveNumber: number;
  moveNumberLabel: string;
  p0?: MoveLogDisplayEntry;
  p1?: MoveLogDisplayEntry;
}

export type MoveLogDisplayEntry = MoveLogEntryDTO & {
  notation: string;
  turnLabel: string;
  fullMoveNumber: number;
  continuationIndex: number;
};

export interface HighlightedMove {
  actor: Seat;
  resultTurnIndex: number;
  resultSnapshotIndex: number;
}

export interface HighlightedVariation {
  branchId: number;
  moveIndex: number;
}

export interface VariationMove {
  kind: 'move' | 'edit_faceup' | 'edit_reserved' | 'edit_noble';
  actor: Seat;
  actionIdx: number;
  replayActionIdxList?: number[];
  label: string;
  display?: ActionDisplayDTO | null;
  fullMoveNumber: number;
  targetSnapshotIndex: number;
  targetTurnIndex: number;
  jumpBySnapshot: boolean;
  tier?: number;
  slot?: number;
  seat?: Seat;
  cardId?: number;
  nobleId?: number;
}

export interface VariationBranch {
  id: number;
  anchorSnapshotIndex: number;
  moves: VariationMove[];
}

export type MoveToken =
  | { kind: 'mainline_row'; row: MoveLogRow; rowIdx: number }
  | { kind: 'deviation_block'; branch: VariationBranch };

export type DeepAnalysisCategory = 'Best' | 'Good' | 'Mistake' | 'Blunder' | 'Unknown';
export type MoveGroupKey = 'buy' | 'reserve' | 'take' | 'return' | 'noble' | 'other';

export interface DeepAnalysisEntry {
  category: DeepAnalysisCategory;
  playedActionIdx: number;
  bestActionIdx: number | null;
  playedQ: number | null;
  bestQ: number | null;
  qLoss: number | null;
}

export type DeepAnalysisSearchResult = NonNullable<EngineJobStatusDTO['result']>;
