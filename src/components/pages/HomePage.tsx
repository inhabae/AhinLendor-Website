import { UiIcon } from '../UiIcon';

export function HomePage({
  onOpenAbout,
  onOpenAnalysis,
  onOpenQuick,
}: {
  onOpenAbout: () => void;
  onOpenAnalysis: () => void;
  onOpenQuick: () => void;
}) {
  return (
    <section className="home-landing">
      <div className="home-hero">
        <h2>AhinLendor</h2>
      </div>
      <div className="home-mode-grid">
        <button type="button" className="home-mode-card" onClick={onOpenQuick}>
          <UiIcon name="play" />
          <strong>Quick Game</strong>
          <span>Engine vs human from a random opening.</span>
        </button>
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
