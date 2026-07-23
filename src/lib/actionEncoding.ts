import actionEncoding from '../../shared/action_encoding.json';
import type { ActionVizDTO } from '../types';

export type ActionColor = 'white' | 'blue' | 'green' | 'red' | 'black' | 'gold';

type ActionRange = readonly [number, number];

const COLOR_ORDER: readonly ActionColor[] = ['white', 'blue', 'green', 'red', 'black'];

export const ACTION_RANGES = actionEncoding as unknown as {
  buyFaceup: ActionRange;
  buyReserved: ActionRange;
  reserveFaceup: ActionRange;
  reserveDeck: ActionRange;
  take3: ActionRange;
  take2Same: ActionRange;
  take2: ActionRange;
  take1: ActionRange;
  pass: ActionRange;
  return: ActionRange;
  noble: ActionRange;
  continuation: ActionRange;
};

export const TAKE3_TRIPLETS = actionEncoding.take3Triplets as unknown as readonly (readonly [number, number, number])[];
export const TAKE2_PAIRS = actionEncoding.take2Pairs as unknown as readonly (readonly [number, number])[];

function isActionInRange(actionIdx: number, range: ActionRange): boolean {
  return range[0] <= actionIdx && actionIdx <= range[1];
}

export type ClassifiedAction =
  | { kind: 'buyFaceup'; tier: number; slot: number }
  | { kind: 'buyReserved'; slot: number }
  | { kind: 'reserveFaceup'; tier: number; slot: number }
  | { kind: 'reserveDeck'; tier: 1 | 2 | 3 }
  | { kind: 'take3'; colorIndexes: readonly [number, number, number] }
  | { kind: 'take2Same'; colorIndex: number }
  | { kind: 'take2'; colorIndexes: readonly [number, number] }
  | { kind: 'take1'; colorIndex: number }
  | { kind: 'pass' }
  | { kind: 'return'; colorIndex: number }
  | { kind: 'noble'; slot: number }
  | { kind: 'continuation' }
  | { kind: 'unknown' };

export function classifyAction(actionIdx: number): ClassifiedAction {
  if (isActionInRange(actionIdx, ACTION_RANGES.buyFaceup)) {
    const rel = actionIdx - ACTION_RANGES.buyFaceup[0];
    return { kind: 'buyFaceup', tier: Math.floor(rel / 4) + 1, slot: rel % 4 };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.buyReserved)) {
    return { kind: 'buyReserved', slot: actionIdx - ACTION_RANGES.buyReserved[0] };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.reserveFaceup)) {
    const rel = actionIdx - ACTION_RANGES.reserveFaceup[0];
    return { kind: 'reserveFaceup', tier: Math.floor(rel / 4) + 1, slot: rel % 4 };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.reserveDeck)) {
    return { kind: 'reserveDeck', tier: (actionIdx - ACTION_RANGES.reserveDeck[0] + 1) as 1 | 2 | 3 };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.take3)) {
    return { kind: 'take3', colorIndexes: TAKE3_TRIPLETS[actionIdx - ACTION_RANGES.take3[0]] };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.take2Same)) {
    return { kind: 'take2Same', colorIndex: actionIdx - ACTION_RANGES.take2Same[0] };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.take2)) {
    return { kind: 'take2', colorIndexes: TAKE2_PAIRS[actionIdx - ACTION_RANGES.take2[0]] };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.take1)) {
    return { kind: 'take1', colorIndex: actionIdx - ACTION_RANGES.take1[0] };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.pass)) {
    return { kind: 'pass' };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.return)) {
    return { kind: 'return', colorIndex: actionIdx - ACTION_RANGES.return[0] };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.noble)) {
    return { kind: 'noble', slot: actionIdx - ACTION_RANGES.noble[0] };
  }
  if (isActionInRange(actionIdx, ACTION_RANGES.continuation)) {
    return { kind: 'continuation' };
  }
  return { kind: 'unknown' };
}

export const isBuyFaceupAction = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.buyFaceup);
export const isBuyReservedAction = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.buyReserved);
export const isReserveFaceupAction = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.reserveFaceup);
export const isReserveDeckAction = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.reserveDeck);
export const isTake3Action = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.take3);
export const isTake2SameAction = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.take2Same);
export const isTake2Action = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.take2);
export const isTake1Action = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.take1);
export const isPassAction = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.pass);
export const isReturnAction = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.return);
export const isNobleAction = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.noble);
export const isContinuationAction = (actionIdx: number): boolean => isActionInRange(actionIdx, ACTION_RANGES.continuation);

export function getActionBankColors(action: Pick<ActionVizDTO, 'action_idx' | 'placement_hint'> | null | undefined): Set<ActionColor> {
  const out = new Set<ActionColor>();
  if (!action) {
    return out;
  }
  const classified = classifyAction(action.action_idx);
  if (classified.kind === 'take3') {
    for (const colorIdx of classified.colorIndexes) {
      out.add(COLOR_ORDER[colorIdx]);
    }
    return out;
  }
  if (classified.kind === 'take2Same') {
    out.add(COLOR_ORDER[classified.colorIndex]);
    return out;
  }
  if (classified.kind === 'take2') {
    for (const colorIdx of classified.colorIndexes) {
      out.add(COLOR_ORDER[colorIdx]);
    }
    return out;
  }
  if (classified.kind === 'take1') {
    out.add(COLOR_ORDER[classified.colorIndex]);
    return out;
  }
  if (classified.kind === 'return') {
    out.add(COLOR_ORDER[classified.colorIndex]);
    return out;
  }
  if (action.placement_hint.zone === 'bank_token' && action.placement_hint.color) {
    out.add(action.placement_hint.color as ActionColor);
  }
  return out;
}
