import { ReactNode } from 'react';

export function BoardViewport({
  showEvaluation,
  evalBarTopHeight,
  evalBarBottomHeight,
  evalLabel,
  evalSide,
  evalUnresolved = false,
  children,
}: {
  showEvaluation: boolean;
  evalBarTopHeight: number;
  evalBarBottomHeight: number;
  evalLabel?: string | null;
  evalSide?: 'white' | 'black' | 'neutral';
  evalUnresolved?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="board-analysis-shell">
      <div
        className={`eval-bar-wrap ${showEvaluation ? '' : 'hidden'} ${evalUnresolved ? 'unresolved' : ''}`}
        aria-label="Evaluation bar"
        aria-hidden={!showEvaluation}
      >
        {showEvaluation && (
          <div className="eval-bar">
            <div className="eval-bar-top" style={{ height: `${evalBarTopHeight}%` }}>
              {evalLabel && evalSide !== 'black' && (
                <span className="eval-bar-label eval-bar-label-white">{evalLabel}</span>
              )}
            </div>
            <div className="eval-bar-bottom" style={{ height: `${evalBarBottomHeight}%` }}>
              {evalLabel && evalSide === 'black' && (
                <span className="eval-bar-label eval-bar-label-black">{evalLabel}</span>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="board-stage">
        {children}
      </div>
    </div>
  );
}
