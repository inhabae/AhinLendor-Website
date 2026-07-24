import { UiIcon } from '../UiIcon';
import type { Seat } from '../../types';

export function HomePage({
  onOpenAbout,
  onOpenAnalysis,
  onStartQuick,
}: {
  onOpenAbout: () => void;
  onOpenAnalysis: () => void;
  onStartQuick: (seat: Seat) => void;
}) {
  return (
    <section className="home-landing">
      <section className="home-github-intro">
        <h2>AhinLendor</h2>
        <p>
          AhinLendor is a superhuman AlphaZero-style Splendor AI that reached Rank 1 on the Spendee leaderboard
          and won exhibition matches against top-ranked human players.
        </p>
        <a href="https://github.com/inhabae/AhinLendor" target="_blank" rel="noreferrer">
          View the project on GitHub
        </a>
      </section>
      <div className="home-mode-grid">
        <section className="home-mode-card home-mode-card-static">
          <UiIcon name="play" />
          <strong>Quick Game</strong>
          <span>Play vs AhinLendor from a random opening.</span>
          <div className="analysis-entry-actions home-mode-actions quick-seat-actions">
            <button type="button" className="quick-seat-button" onClick={() => onStartQuick('P0')}>
              Play as Player 1
            </button>
            <button type="button" className="quick-seat-button" onClick={() => onStartQuick('P1')}>
              Play as Player 2
            </button>
          </div>
        </section>
        <button type="button" className="home-mode-card" onClick={onOpenAnalysis}>
          <UiIcon name="analysis" />
          <strong>Analysis</strong>
          <span>Manual setup with continuous analysis.</span>
        </button>
        <button type="button" className="home-mode-card" onClick={onOpenAbout}>
          <UiIcon name="about" />
          <strong>About</strong>
          <span>Development notes, engine features, and project background.</span>
        </button>
      </div>
    </section>
  );
}
