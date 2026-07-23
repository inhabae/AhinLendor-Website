import type { GameSnapshotDTO, MoveLogEntryDTO, SearchType, Seat } from '../types';

export type HomeView = 'HOME' | 'QUICK' | 'ANALYSIS' | 'ABOUT';

export const VIEW_PATHS: Record<HomeView, string> = {
  HOME: '/',
  QUICK: '/quick',
  ANALYSIS: '/analysis',
  ABOUT: '/about',
};

export function analysisPublishInterval(totalSimulations: number): number {
  const normalized = Number.isInteger(totalSimulations) && totalSimulations >= 1 ? totalSimulations : 1;
  return Math.max(64, Math.min(2000, Math.floor(normalized / 20) || 1));
}

export function winnerLabel(snapshot: GameSnapshotDTO | null): string | null {
  if (!snapshot || snapshot.winner < 0) {
    return null;
  }
  const winnerSeat: Seat = snapshot.winner === 0 ? 'P0' : 'P1';
  return snapshot.board_state?.players.find((player) => player.seat === winnerSeat)?.display_name ?? null;
}

export function homeViewFromPath(pathname: string): HomeView {
  if (pathname.startsWith('/quick')) return 'QUICK';
  if (pathname.startsWith('/analysis')) return 'ANALYSIS';
  if (pathname.startsWith('/about')) return 'ABOUT';
  return 'HOME';
}

export function moveAnalysisKey(move: Pick<MoveLogEntryDTO, 'result_snapshot_index' | 'turn_index' | 'actor' | 'action_idx'>): string {
  return `${move.result_snapshot_index}:${move.turn_index}:${move.actor}:${move.action_idx}`;
}

export function searchTypeLabel(searchType: SearchType): string {
  if (searchType === 'mcts_gpu') {
    return 'MCTS (GPU batched)';
  }
  if (searchType === 'mcts_bootstrap') {
    return 'MCTS Bootstrap';
  }
  if (searchType === 'ismcts') {
    return 'ISMCTS';
  }
  if (searchType === 'alphabeta') {
    return 'Alpha-Beta';
  }
  if (searchType === 'forced_child') {
    return 'Forced Search';
  }
  return 'MCTS';
}

export function continuationSuffix(index: number): string {
  if (index <= 0) {
    return '';
  }
  let out = '';
  let value = index;
  while (value > 0) {
    const rem = (value - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

export function topMoveEvalClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) {
    return 'neutral';
  }
  return value > 0 ? 'white-side' : 'black-side';
}

export function formatTopMoveEval(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  const magnitude = Math.abs(value).toFixed(2);
  return value > 0 ? `+${magnitude}` : `-${magnitude}`;
}

export function formatEvalBarValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  return Math.abs(value).toFixed(2);
}

export function p1WinningEval(value: number | null | undefined, playerToMove: Seat | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || playerToMove == null) {
    return null;
  }
  return playerToMove === 'P1' ? value : -value;
}

export function p0WinningEval(value: number | null | undefined, playerToMove: Seat | null | undefined): number | null {
  const p1Value = p1WinningEval(value, playerToMove);
  return p1Value == null ? null : -p1Value;
}
