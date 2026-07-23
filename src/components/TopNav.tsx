import type { HomeView } from '../lib/gameUi';
import type { SearchType } from '../types';
import { UiIcon } from './UiIcon';

export function TopNav({
  alphabetaDepth,
  deepAnalysisBootstrapSimulationsPerAction,
  deepAnalysisProgress,
  deepAnalysisSimulations,
  homeView,
  isDeepAnalysisRunning,
  canRunDeepAnalysis,
  moveCount,
  onOpenAbout,
  onOpenAnalysis,
  onOpenHome,
  onOpenQuick,
  onRunDeepAnalysis,
  searchType,
  snapshotPresent,
}: {
  alphabetaDepth: number;
  deepAnalysisBootstrapSimulationsPerAction: number;
  deepAnalysisProgress: { done: number; total: number } | null;
  deepAnalysisSimulations: number;
  homeView: HomeView;
  isDeepAnalysisRunning: boolean;
  canRunDeepAnalysis: boolean;
  moveCount: number;
  onOpenAbout: () => void;
  onOpenAnalysis: () => void;
  onOpenHome: () => void;
  onOpenQuick: () => void;
  onRunDeepAnalysis: () => void;
  searchType: SearchType;
  snapshotPresent: boolean;
}) {
  const deepAnalysisTitle = searchType === 'alphabeta'
    ? `Run deep analysis across all logged moves (depth ${alphabetaDepth})`
    : searchType === 'forced_child'
      ? `Run deep analysis across all logged moves (${deepAnalysisSimulations.toLocaleString()} per-action sims)`
      : searchType === 'mcts_bootstrap'
        ? `Run deep analysis across all logged moves (${deepAnalysisSimulations.toLocaleString()} total sims, bootstrap ${deepAnalysisBootstrapSimulationsPerAction.toLocaleString()} per action)`
        : `Run deep analysis across all logged moves (${deepAnalysisSimulations.toLocaleString()} sims per move)`;

  return (
    <header className="top-nav">
      <button type="button" className="brand-link" onClick={onOpenHome} aria-label="AhinLendor home">
        <img src="/ahin.svg" alt="" className="brand-mark" />
        <span className="brand-wordmark">AhinLendor</span>
      </button>
      <nav className="nav-links" aria-label="Primary navigation">
        <button
          type="button"
          className={`nav-link ${homeView === 'HOME' ? 'nav-link-active' : ''}`}
          onClick={onOpenHome}
        >
          <UiIcon name="home" />
          <span>Home</span>
        </button>
        <button
          type="button"
          className={`nav-link ${homeView === 'QUICK' ? 'nav-link-active' : ''}`}
          onClick={onOpenQuick}
        >
          <UiIcon name="play" />
          <span>Quick Game</span>
        </button>
        <button
          type="button"
          className={`nav-link ${homeView === 'ANALYSIS' ? 'nav-link-active' : ''}`}
          onClick={onOpenAnalysis}
        >
          <UiIcon name="analysis" />
          <span>Analysis</span>
        </button>
        <button
          type="button"
          className={`nav-link ${homeView === 'ABOUT' ? 'nav-link-active' : ''}`}
          onClick={onOpenAbout}
        >
          <UiIcon name="about" />
          <span>About</span>
        </button>
      </nav>
      <div className="header-actions auth-nav">
        {homeView === 'ANALYSIS' && snapshotPresent && (
          <>
            <button
              type="button"
              onClick={onRunDeepAnalysis}
              disabled={isDeepAnalysisRunning || moveCount === 0 || !canRunDeepAnalysis}
              title={deepAnalysisTitle}
            >
              {isDeepAnalysisRunning ? 'Running Deep Analysis...' : 'Run Deep Analysis'}
            </button>
            {deepAnalysisProgress && (
              <span className="header-inline-status">
                {deepAnalysisProgress.done} / {deepAnalysisProgress.total}
              </span>
            )}
          </>
        )}
      </div>
    </header>
  );
}
