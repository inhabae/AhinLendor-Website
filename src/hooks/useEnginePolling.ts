import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { fetchJSON } from '../lib/apiClient';
import type {
  EngineJobStatusDTO,
  EngineThinkRequest,
  EngineThinkResponse,
  GameSnapshotDTO,
} from '../types';
import type { UiStatus } from '../lib/appModels';

const POLL_MS = 400;

export function useEnginePolling({
  buildEngineThinkRequest,
  handleSnapshotUpdate,
  snapshotRef,
  setError,
  setJobStatus,
  setUiStatus,
}: {
  buildEngineThinkRequest: (options?: {
    searchTypeOverride?: EngineThinkRequest['search_type'];
    snapshotOverride?: GameSnapshotDTO | null;
  }) => EngineThinkRequest;
  handleSnapshotUpdate: (nextSnapshot: GameSnapshotDTO, engineShouldMove?: boolean) => Promise<void>;
  snapshotRef: MutableRefObject<GameSnapshotDTO | null>;
  setError: Dispatch<SetStateAction<string | null>>;
  setJobStatus: Dispatch<SetStateAction<EngineJobStatusDTO | null>>;
  setUiStatus: Dispatch<SetStateAction<UiStatus>>;
}) {
  const pollRef = useRef<number | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  function clearPolling(): void {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    activeJobIdRef.current = null;
  }

  async function pollEngineJob(nextJobId: string): Promise<void> {
    try {
      const status = await fetchJSON<EngineJobStatusDTO>(`/api/game/engine-job/${nextJobId}`);
      if (activeJobIdRef.current !== nextJobId) {
        return;
      }
      setJobStatus(status);
      if (status.status === 'DONE') {
        clearPolling();
        const currentSnapshot = snapshotRef.current;
        const shouldApplyEngineMove = Boolean(
          currentSnapshot
          && currentSnapshot.status === 'IN_PROGRESS'
          && !currentSnapshot.config?.analysis_mode
          && currentSnapshot.player_to_move !== currentSnapshot.config?.player_seat,
        );
        if (shouldApplyEngineMove) {
          const nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/engine-apply', {
            method: 'POST',
            body: JSON.stringify({ job_id: nextJobId }),
          });
          const engineStillOwnsTurn = Boolean(
            nextSnapshot.status === 'IN_PROGRESS'
            && !nextSnapshot.config?.analysis_mode
            && nextSnapshot.player_to_move !== nextSnapshot.config?.player_seat,
          );
          await handleSnapshotUpdate(nextSnapshot, engineStillOwnsTurn);
        } else {
          setUiStatus(currentSnapshot?.status === 'IN_PROGRESS' ? 'WAITING_PLAYER' : 'GAME_OVER');
        }
      } else if (status.status === 'FAILED' || status.status === 'CANCELLED') {
        clearPolling();
        setUiStatus('WAITING_PLAYER');
      }
    } catch (err) {
      clearPolling();
      setError((err as Error).message);
      setUiStatus('WAITING_PLAYER');
    }
  }

  async function startEngineThink(options?: {
    searchTypeOverride?: EngineThinkRequest['search_type'];
    snapshotOverride?: GameSnapshotDTO | null;
  }): Promise<void> {
    setError(null);
    const think = await fetchJSON<EngineThinkResponse>('/api/game/engine-think', {
      method: 'POST',
      body: JSON.stringify(buildEngineThinkRequest(options)),
    });
    setUiStatus('WAITING_ENGINE');
    clearPolling();
    activeJobIdRef.current = think.job_id;

    pollRef.current = window.setInterval(() => {
      void pollEngineJob(think.job_id);
    }, POLL_MS);
  }

  useEffect(() => clearPolling, []);

  return { clearPolling, startEngineThink };
}
