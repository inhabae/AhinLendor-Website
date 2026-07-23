import { ActionVizDTO, BoardStateDTO, TokenCountsDTO } from '../../types';
import { getActionBankColors } from '../../lib/actionEncoding';
import { NobleView } from './NobleView';
import { PlayerStrip } from './PlayerStrip';
import { TierDeckBadge, TierRow } from './TierRow';
import { TokenPill } from './TokenPill';

const TOKEN_ORDER: Array<keyof TokenCountsDTO> = ['gold', 'white', 'blue', 'green', 'red', 'black'];

function actionBankColors(action: ActionVizDTO | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const color of getActionBankColors(action)) {
    out.add(color);
  }
  if (action?.placement_hint.zone === 'bank_token' && action.placement_hint.color) {
    out.add(action.placement_hint.color);
  }
  return out;
}

export function GameBoard({
  board,
  isTerminal = false,
  mctsTopAction = null,
  modelTopAction = null,
  onCardClick,
  onNobleClick,
  onReservedCardClick,
}: {
  board: BoardStateDTO;
  isTerminal?: boolean;
  mctsTopAction?: ActionVizDTO | null;
  modelTopAction?: ActionVizDTO | null;
  onCardClick?: (tier: number, slot: number) => void;
  onNobleClick?: (slot: number) => void;
  onReservedCardClick?: (seat: 'P0' | 'P1', slot: number) => void;
}) {
  const mctsBankColors = actionBankColors(mctsTopAction);
  const modelBankColors = actionBankColors(modelTopAction);
  const nobleBySlot = new Map((board.nobles ?? []).map((noble) => [noble.slot ?? -1, noble]));
  return (
    <section className="board-surface">
      <section className="board-main">
        <aside className="board-left">
          <PlayerStrip player={board.players[0]} seat="P0" isTerminal={isTerminal} mctsTopAction={mctsTopAction} modelTopAction={modelTopAction} onReservedCardClick={onReservedCardClick} />
          <PlayerStrip player={board.players[1]} seat="P1" isTerminal={isTerminal} mctsTopAction={mctsTopAction} modelTopAction={modelTopAction} onReservedCardClick={onReservedCardClick} />
        </aside>

        <section className="board-right">
          <div className="board-play-shell">
            <div className="nobles-row">
              <div className="nobles-grid">
                {board.nobles.length === 0 && <div className="empty-note">No nobles available</div>}
                {Array.from({ length: 3 }, (_, slot) => {
                  const noble = nobleBySlot.get(slot);
                  if (!noble) {
                    return <div key={`noble-empty-${slot}`} className="noble-slot-empty" aria-hidden="true" />;
                  }
                  return (
                    <NobleView
                      key={`noble-${slot}`}
                      noble={noble}
                      onClick={noble.slot != null ? () => onNobleClick?.(noble.slot as number) : undefined}
                    />
                  );
                })}
              </div>
            </div>
            <div className="bank-row">
              <div className="bank-row-inline">
                {TOKEN_ORDER.map((color) => (
                  <TokenPill
                    key={`bank-${color}`}
                    color={color}
                    count={board.bank[color]}
                    showMcts={mctsBankColors.has(color)}
                    showModel={modelBankColors.has(color)}
                  />
                ))}
              </div>
            </div>
            <div className="board-cards-shell">
              {board.tiers.map((tier) => (
                <div key={`board-cards-row-${tier.tier}`} className="board-cards-row">
                  <div className="tier-decks-slot" aria-label={`Tier ${tier.tier} deck`}>
                    <TierDeckBadge tier={tier} />
                  </div>
                  <TierRow
                    key={`tier-row-${tier.tier}`}
                    tier={tier}
                    mctsTopAction={mctsTopAction}
                    modelTopAction={modelTopAction}
                    onCardClick={onCardClick}
                    showDeck={false}
                  />
                </div>
              ))}
            </div>
          </div>
        </section>
      </section>
    </section>
  );
}
