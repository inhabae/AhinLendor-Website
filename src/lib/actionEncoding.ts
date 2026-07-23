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
  const idx = action.action_idx;
  if (isTake3Action(idx)) {
    for (const colorIdx of TAKE3_TRIPLETS[idx - ACTION_RANGES.take3[0]]) {
      out.add(COLOR_ORDER[colorIdx]);
    }
    return out;
  }
  if (isTake2SameAction(idx)) {
    out.add(COLOR_ORDER[idx - ACTION_RANGES.take2Same[0]]);
    return out;
  }
  if (isTake2Action(idx)) {
    for (const colorIdx of TAKE2_PAIRS[idx - ACTION_RANGES.take2[0]]) {
      out.add(COLOR_ORDER[colorIdx]);
    }
    return out;
  }
  if (isTake1Action(idx)) {
    out.add(COLOR_ORDER[idx - ACTION_RANGES.take1[0]]);
    return out;
  }
  if (isReturnAction(idx)) {
    out.add(COLOR_ORDER[idx - ACTION_RANGES.return[0]]);
    return out;
  }
  if (action.placement_hint.zone === 'bank_token' && action.placement_hint.color) {
    out.add(action.placement_hint.color as ActionColor);
  }
  return out;
}