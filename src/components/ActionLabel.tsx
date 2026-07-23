import {
  classifyAction,
} from '../lib/actionEncoding';
import type { ReactElement } from 'react';
import { ActionDisplayDTO, BoardStateDTO, CardDTO, NobleDTO } from '../types';

const COLOR_ORDER = ['white', 'blue', 'green', 'red', 'black'] as const;

function faceupCard(board: BoardStateDTO | null | undefined, tier: number, slot: number): CardDTO | null {
  const row = board?.tiers.find((item) => item.tier === tier);
  if (!row) {
    return null;
  }
  return row.cards.find((card) => card.slot === slot) ?? null;
}

function reservedCard(board: BoardStateDTO | null | undefined, slot: number): CardDTO | null {
  const seatToMove = board?.meta.player_to_move;
  const player = board?.players.find((item) => item.seat === seatToMove) ?? board?.players[0];
  if (!player) {
    return null;
  }
  return player.reserved_public.find((card) => card.slot === slot) ?? null;
}

function nobleBySlot(board: BoardStateDTO | null | undefined, slot: number): NobleDTO | null {
  return board?.nobles.find((noble) => noble.slot === slot) ?? null;
}

function costEntries(card: CardDTO): Array<{ color: (typeof COLOR_ORDER)[number]; count: number }> {
  return COLOR_ORDER.filter((color) => card.cost[color] > 0).map((color) => ({
    color,
    count: card.cost[color],
  }));
}

function GemChip({ color, count }: { color: (typeof COLOR_ORDER)[number]; count?: number }) {
  return (
    <span className={`action-gem-chip token-${color}`} aria-hidden={count == null ? 'true' : undefined}>
      {count != null ? <span>{count}</span> : null}
    </span>
  );
}

function SquareGemChip({ color }: { color: (typeof COLOR_ORDER)[number] }) {
  return <span className={`action-gem-chip action-gem-chip-square token-${color}`} aria-hidden="true" />;
}

function CardActionLabel({ verb, card, hideVerb = false }: { verb: 'BUY' | 'RESERVE'; card: CardDTO | null; hideVerb?: boolean }) {
  if (!card) {
    return hideVerb ? null : <span className="action-verb">{verb}</span>;
  }
  const toneClass = `token-${card.bonus_color}`;
  const entries = costEntries(card);
  return (
    <>
      {!hideVerb && <span className="action-verb">{verb}</span>}
      <span className={`action-card-chip action-card-chip-${card.bonus_color} ${entries.length >= 4 ? 'action-card-chip-dense' : ''}`} aria-label={`${card.bonus_color} card`}>
        <span className="action-card-points">{card.points}</span>
        <span className={`action-group action-group-card-reqs ${toneClass}`}>
        {entries.map(({ color, count }) => (
          <span key={`${verb}-${color}-${count}`} className="action-cost">
            <GemChip color={color} count={count} />
          </span>
        ))}
        {entries.length === 0 && <span className="action-card-free">free</span>}
      </span>
      </span>
    </>
  );
}

function TakeLabel({ verb, colors, duplicate = 1, hideVerb = false }: { verb: 'TAKE' | 'RETURN'; colors: readonly number[]; duplicate?: number; hideVerb?: boolean }) {
  return (
    <span className="action-group action-group-take">
      {!hideVerb && <span className="action-verb">{verb}</span>}
      {colors.map((colorIdx, idx) => {
        const color = COLOR_ORDER[colorIdx];
        return (
          <span key={`${verb}-${color}-${idx}`} className="action-gem">
            <GemChip color={color} />
            {duplicate > 1 && idx === 0 ? <span className="action-mult">x{duplicate}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

function DeckReserveLabel({ tier, hideVerb = false }: { tier: 1 | 2 | 3; hideVerb?: boolean }) {
  return (
    <>
      {!hideVerb && <span className="action-verb">RESERVE</span>}
      {!hideVerb && <span className="action-meta">from</span>}
      <span className={`action-deck-chip action-deck-chip-${tier}`}>T{tier}</span>
    </>
  );
}

function NobleActionLabel({ noble, slot }: { noble: NobleDTO | null; slot: number | null | undefined }) {
  if (!noble) {
    return (
      <>
        <span className="action-verb">NOBLE</span>
        <span className="action-meta">#{slot ?? 0}</span>
      </>
    );
  }
  const reqs = COLOR_ORDER.filter((color) => noble.requirements[color] > 0);
  return (
    <>
      <span className="action-verb">NOBLE</span>
      <span className="action-group action-group-card-reqs">
        {reqs.map((color) => (
          <span key={`noble-${slot ?? 0}-${color}`} className="action-cost">
            <SquareGemChip color={color} />
            <span>{noble.requirements[color]}</span>
          </span>
        ))}
      </span>
    </>
  );
}

export function ActionLabel({
  actionIdx,
  board,
  display,
  showPlayed = false,
  hideVerb = false,
}: {
  actionIdx: number;
  board?: BoardStateDTO | null;
  display?: ActionDisplayDTO | null;
  showPlayed?: boolean;
  hideVerb?: boolean;
}) {
  let content: ReactElement | ReactElement[] = <span className="action-verb">UNKNOWN</span>;

  if (display) {
    if (display.kind === 'card') {
      content = <CardActionLabel verb={display.verb as 'BUY' | 'RESERVE'} card={display.card ?? null} hideVerb={hideVerb} />;
    } else if (display.kind === 'deck' && display.tier != null) {
      content = <DeckReserveLabel tier={display.tier as 1 | 2 | 3} hideVerb={hideVerb} />;
    } else if (display.kind === 'tokens') {
      const colors = (display.token_colors ?? [])
        .map((color) => COLOR_ORDER.indexOf(color))
        .filter((idx) => idx >= 0);
      content = <TakeLabel verb={display.verb as 'TAKE' | 'RETURN'} colors={colors} duplicate={display.token_duplicate ?? 1} hideVerb={hideVerb} />;
    } else if (display.kind === 'pass') {
      content = <span className="action-verb">PASS</span>;
    } else if (display.kind === 'noble') {
      content = <NobleActionLabel noble={display.noble ?? nobleBySlot(board, display.noble_slot ?? -1)} slot={display.noble_slot} />;
    }
  } else {
    const classified = classifyAction(actionIdx);
    if (classified.kind === 'buyFaceup') {
      content = <CardActionLabel verb="BUY" card={faceupCard(board, classified.tier, classified.slot)} hideVerb={hideVerb} />;
    } else if (classified.kind === 'buyReserved') {
      content = <CardActionLabel verb="BUY" card={reservedCard(board, classified.slot)} hideVerb={hideVerb} />;
    } else if (classified.kind === 'reserveFaceup') {
      content = <CardActionLabel verb="RESERVE" card={faceupCard(board, classified.tier, classified.slot)} hideVerb={hideVerb} />;
    } else if (classified.kind === 'reserveDeck') {
      content = <DeckReserveLabel tier={classified.tier} hideVerb={hideVerb} />;
    } else if (classified.kind === 'take3') {
      content = <TakeLabel verb="TAKE" colors={classified.colorIndexes} hideVerb={hideVerb} />;
    } else if (classified.kind === 'take2Same') {
      content = <TakeLabel verb="TAKE" colors={[classified.colorIndex]} duplicate={2} hideVerb={hideVerb} />;
    } else if (classified.kind === 'take2') {
      content = <TakeLabel verb="TAKE" colors={classified.colorIndexes} hideVerb={hideVerb} />;
    } else if (classified.kind === 'take1') {
      content = <TakeLabel verb="TAKE" colors={[classified.colorIndex]} hideVerb={hideVerb} />;
    } else if (classified.kind === 'pass') {
      content = <span className="action-verb">PASS</span>;
    } else if (classified.kind === 'return') {
      content = <TakeLabel verb="RETURN" colors={[classified.colorIndex]} hideVerb={hideVerb} />;
    } else if (classified.kind === 'noble') {
      content = <NobleActionLabel noble={nobleBySlot(board, classified.slot)} slot={classified.slot} />;
    }
  }

  return (
    <span className="action-label">
      {content}
      {showPlayed ? <span className="action-state-pill">Played</span> : null}
    </span>
  );
}
