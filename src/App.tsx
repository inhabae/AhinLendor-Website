import { ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionInfoDTO,
  CatalogCardDTO,
  BoardStateDTO,
  EngineJobStatusDTO,
  EngineThinkRequest,
  EngineThinkResponse,
  GameReplayDTO,
  GameSnapshotDTO,
  MoveLogEntryDTO,
  PlayerMoveResponse,
  RevealCardResponse,
  SearchType,
  Seat,
} from './types';
import { GameBoard } from './components/board/GameBoard';
import { ActionLabel } from './components/ActionLabel';
import { CardView } from './components/board/CardView';
import { NobleView } from './components/board/NobleView';
import { BoardViewport } from './components/board/BoardViewport';
import { TopNav } from './components/TopNav';
import { HomePage } from './components/pages/HomePage';
import { AboutPage } from './components/pages/AboutPage';
import { fetchJSON } from './lib/apiClient';
import {
  HomeView,
  analysisPublishInterval,
  formatEvalBarValue,
  formatTopMoveEval,
  moveAnalysisKey,
  p0WinningEval,
  searchTypeLabel,
  topMoveEvalClass,
  winnerLabel,
} from './lib/gameUi';
import type {
  DeepAnalysisCategory,
  DeepAnalysisEntry,
  DeepAnalysisSearchResult,
  HighlightedVariation,
  MoveGroupKey,
  MoveLogDisplayEntry,
  UiStatus,
  VariationBranch,
  VariationMove,
} from './lib/appModels';
import { useMoveLogModel } from './hooks/useMoveLogModel';
import { useHomeView } from './hooks/useHomeView';
import { useCatalogData } from './hooks/useCatalogData';
import { useAnimatedEval } from './hooks/useAnimatedEval';
import { useCatalogIndex } from './hooks/useCatalogIndex';
import { useEnginePolling } from './hooks/useEnginePolling';
import {
  classifyAction,
  isBuyReservedAction,
  isNobleAction,
  isReturnAction,
  isTake1Action,
  isTake2Action,
  isTake2SameAction,
  isTake3Action,
} from './lib/actionEncoding';

type AnalysisPanelTab = 'ANALYSIS' | 'MOVES';
const COLOR_ORDER: CatalogCardDTO['bonus_color'][] = ['white', 'blue', 'green', 'red', 'black'];

const DEFAULT_DEEP_ANALYSIS_SIMULATIONS = 50_000;
const DEFAULT_GPU_EVAL_BATCH_SIZE = 64;
const MAX_EVAL_BATCH_SIZE = 64;
const DEFAULT_ALPHABETA_DEPTH = 3;
const DEFAULT_SEARCH_SIMULATIONS = 200_000;
const DEFAULT_BOOTSTRAP_SIMULATIONS_PER_ACTION = 20_000;
const MAX_SEARCH_SIMULATIONS = 5_000_000;

const MOVE_GROUP_LABELS: Record<MoveGroupKey, string> = {
  buy: 'Buy',
  reserve: 'Reserve',
  take: 'Take',
  return: 'Return',
  noble: 'Noble',
  other: 'Other',
};

type AnalysisMoveGroup = {
  key: string;
  label: string;
  moves?: ActionInfoDTO[];
  columns?: Array<{ key: string; label: string; moves: ActionInfoDTO[] }>;
  hideVerb: boolean;
};

function isBlockingPendingReveal(reveal: GameSnapshotDTO['pending_reveals'][number]): boolean {
  return reveal.zone !== 'reserved_card';
}

function parseRevealKey(key: string): { zone: 'faceup_card' | 'reserved_card' | 'noble'; tier: number; slot: number; seat?: Seat } | null {
  const [zone, tier, slot, seat] = key.split('-');
  if ((zone !== 'faceup_card' && zone !== 'reserved_card' && zone !== 'noble') || tier == null || slot == null) {
    return null;
  }
  if (zone === 'reserved_card' && seat !== 'P0' && seat !== 'P1') {
    return null;
  }
  return {
    zone,
    tier: Number(tier),
    slot: Number(slot),
    seat: zone === 'reserved_card' ? (seat as Seat) : undefined,
  };
}

export function App() {
  const numSimulations = 400;
  const [searchSimulations, setSearchSimulations] = useState(DEFAULT_SEARCH_SIMULATIONS);
  const deepAnalysisSimulations = DEFAULT_DEEP_ANALYSIS_SIMULATIONS;
  const [searchBootstrapSimulationsPerAction, setSearchBootstrapSimulationsPerAction] = useState(
    DEFAULT_BOOTSTRAP_SIMULATIONS_PER_ACTION,
  );
  const deepAnalysisBootstrapSimulationsPerAction = DEFAULT_BOOTSTRAP_SIMULATIONS_PER_ACTION;
  const searchEvalBatchSize = DEFAULT_GPU_EVAL_BATCH_SIZE;
  const deepAnalysisEvalBatchSize = DEFAULT_GPU_EVAL_BATCH_SIZE;
  const searchType: SearchType = 'mcts_bootstrap';
  const alphabetaDepth = DEFAULT_ALPHABETA_DEPTH;
  const playerSeat: Seat = 'P0';
  const seed = '';
  const { homeView, setHomeView } = useHomeView();
  const [revealSelections, setRevealSelections] = useState<Record<string, string>>({});
  const [activeRevealKey, setActiveRevealKey] = useState<string | null>(null);
  const [showBoardAnalysis, setShowBoardAnalysis] = useState(true);
  const [showAnalysisSettings, setShowAnalysisSettings] = useState(false);
  const [hideAllExceptBoard, setHideAllExceptBoard] = useState(false);

  const [snapshot, setSnapshot] = useState<GameSnapshotDTO | null>(null);
  const snapshotRef = useRef<GameSnapshotDTO | null>(null);
  const [loadedMoveLog, setLoadedMoveLog] = useState<MoveLogEntryDTO[] | null>(null);
  const [loadedPlayerNames, setLoadedPlayerNames] = useState<Record<Seat, string> | null>(null);
  const [variationBranches, setVariationBranches] = useState<VariationBranch[]>([]);
  const [jobStatus, setJobStatus] = useState<EngineJobStatusDTO | null>(null);
  const [uiStatus, setUiStatus] = useState<UiStatus>('IDLE');
  const [analysisPanelTab, setAnalysisPanelTab] = useState<AnalysisPanelTab>('ANALYSIS');
  const [deepAnalysisBySnapshot, setDeepAnalysisBySnapshot] = useState<Record<string, DeepAnalysisEntry>>({});
  const [deepAnalysisSearchBySnapshot, setDeepAnalysisSearchBySnapshot] = useState<Record<string, DeepAnalysisSearchResult>>({});
  const analysisSearchByPositionRef = useRef<Record<string, NonNullable<EngineJobStatusDTO['result']>>>({});
  const [isLoadedPostAnalysisGame, setIsLoadedPostAnalysisGame] = useState(false);
  const [isDeepAnalysisRunning, setIsDeepAnalysisRunning] = useState(false);
  const [isAutoStartingGame, setIsAutoStartingGame] = useState(false);
  const [quickEntryPromptDone, setQuickEntryPromptDone] = useState(false);
  const [analysisEntryPromptDone, setAnalysisEntryPromptDone] = useState(false);
  const [isReplayLoading, setIsReplayLoading] = useState(false);
  const [isReplaySaving, setIsReplaySaving] = useState(false);
  const [deepAnalysisProgress, setDeepAnalysisProgress] = useState<{ done: number; total: number } | null>(null);
  const [activeVariationSelection, setActiveVariationSelection] = useState<HighlightedVariation | null>(null);

  const [error, setError] = useState<string | null>(null);
  const { catalogCards, catalogNobles } = useCatalogData(setError);
  const {
    cardsByTier,
    cardsByTierAndColor,
    groupedCatalogNobles,
    cardOptionLabel,
    nobleOptionLabel,
    findCatalogCard,
    findCatalogCardId,
    findCatalogNobleId,
  } = useCatalogIndex(catalogCards, catalogNobles);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const activeVariationBranchIdRef = useRef<number | null>(null);
  const variationBranchIdCounterRef = useRef<number>(1);
  const loadedHistoricalMainlineLengthRef = useRef<number>(0);
  const loadedHistoricalMainlineTailSnapshotRef = useRef<number>(0);

  function clearActiveVariationSelection(): void {
    activeVariationBranchIdRef.current = null;
    setActiveVariationSelection(null);
  }

  function selectVariationMove(branchId: number, moveIndex: number): void {
    activeVariationBranchIdRef.current = branchId;
    setActiveVariationSelection({ branchId, moveIndex });
  }
  const analysisSettingsRef = useRef<HTMLDivElement | null>(null);
  const replayFileInputRef = useRef<HTMLInputElement | null>(null);
  const moveLogGridRef = useRef<HTMLDivElement | null>(null);
  const autoStartViewRef = useRef<HomeView | null>(null);
  const isSetupLikeView = homeView === 'ANALYSIS';
  const isQuickGameView = homeView === 'QUICK';
  const showAnalysisUi = !isQuickGameView;
  const activePanelTab: AnalysisPanelTab = showAnalysisUi ? analysisPanelTab : 'MOVES';
  const lastAutoAnalyzeKeyRef = useRef<string | null>(null);
  const lastSnapshotSearchKeyRef = useRef<string | null>(null);
  const autoAnalyzeOnNavigation = showBoardAnalysis;

  const {
    moveLogEntries,
    moveLogRows,
    mainlineMoveNumberBySnapshot,
    variationBranchByAnchor,
    moveLogTokens,
    currentSnapshotIndex,
    mainlineMoveSnapshotIndices,
    mainlineMoveTurnIndices,
    isLoadedMainlineExtensionState,
    canStepVisibleMainlineBackward,
    canStepVisibleMainlineForward,
    highlightedMove,
    highlightedVariation,
  } = useMoveLogModel({
    loadedMoveLog,
    snapshot,
    variationBranches,
    activeVariationSelection,
    loadedHistoricalMainlineLength: loadedHistoricalMainlineLengthRef.current,
    loadedHistoricalMainlineTailSnapshot: loadedHistoricalMainlineTailSnapshotRef.current,
  });

  function isHighlightedMainlineMove(move: MoveLogDisplayEntry | null | undefined): boolean {
    if (!move || highlightedVariation != null || highlightedMove == null) {
      return false;
    }
    if (snapshot?.current_snapshot_index != null) {
      return (
        move.actor === highlightedMove.actor
        && move.result_snapshot_index === highlightedMove.resultSnapshotIndex
      );
    }
    return (
      move.actor === highlightedMove.actor
      && move.result_turn_index === highlightedMove.resultTurnIndex
    );
  }

  useEffect(() => {
    if (!snapshot?.pending_reveals.length) {
      return;
    }
    setRevealSelections((prev) => {
      const next = { ...prev };
      for (const reveal of snapshot.pending_reveals) {
        const key = revealKey(reveal.zone, reveal.tier, reveal.slot, reveal.actor ?? undefined);
        if (!(key in next)) {
          if (reveal.zone === 'noble') {
            next[key] = catalogNobles[0] ? String(catalogNobles[0].id) : '';
          } else {
            next[key] = cardsByTier[reveal.tier]?.[0] ? String(cardsByTier[reveal.tier][0].id) : '';
          }
        }
      }
      return next;
    });
  }, [snapshot, cardsByTier, catalogNobles]);

  useEffect(() => {
    if (!snapshot?.pending_reveals.length) {
      setActiveRevealKey(null);
      return;
    }
    setActiveRevealKey((prev) => {
      if (prev && snapshot.pending_reveals.some((reveal) => revealKey(reveal.zone, reveal.tier, reveal.slot, reveal.actor ?? undefined) === prev)) {
        return prev;
      }
      const firstBlocking = snapshot.pending_reveals.find((reveal) => isBlockingPendingReveal(reveal));
      if (!firstBlocking) {
        return null;
      }
      return revealKey(firstBlocking.zone, firstBlocking.tier, firstBlocking.slot, firstBlocking.actor ?? undefined);
    });
  }, [snapshot]);

  function deriveUiStatus(nextSnapshot: GameSnapshotDTO): UiStatus {
    if (nextSnapshot.status !== 'IN_PROGRESS') {
      return 'GAME_OVER';
    }
    if (nextSnapshot.pending_reveals.some((reveal) => isBlockingPendingReveal(reveal))) {
      return 'WAITING_REVEAL';
    }
    return 'WAITING_PLAYER';
  }

  function revealKey(zone: 'faceup_card' | 'reserved_card' | 'noble', tier: number, slot: number, seat?: Seat): string {
    return zone === 'reserved_card' ? `${zone}-${tier}-${slot}-${seat ?? 'P0'}` : `${zone}-${tier}-${slot}`;
  }

  function nextRevealKeyInSameGroup(
    nextSnapshot: GameSnapshotDTO,
    current: { zone: 'faceup_card' | 'reserved_card' | 'noble'; tier: number; slot: number; seat?: Seat },
  ): string | null {
    const blocking = nextSnapshot.pending_reveals.filter((reveal) => isBlockingPendingReveal(reveal));
    if (blocking.length === 0) {
      return null;
    }
    const sameGroup = blocking
      .filter((reveal) => (
        reveal.zone === current.zone &&
        (current.zone !== 'faceup_card' || reveal.tier === current.tier) &&
        (current.zone !== 'reserved_card' || reveal.actor === current.seat)
      ))
      .sort((a, b) => (a.tier - b.tier) || (a.slot - b.slot));
    const afterCurrent = sameGroup.find((reveal) => reveal.slot > current.slot);
    const next = afterCurrent ?? sameGroup[0] ?? blocking[0];
    return revealKey(next.zone, next.tier, next.slot, next.actor ?? undefined);
  }

  function shouldAutoAnalyze(nextSnapshot: GameSnapshotDTO | null): boolean {
    if (!nextSnapshot || !nextSnapshot.config?.analysis_mode) {
      return false;
    }
    if (nextSnapshot.status !== 'IN_PROGRESS') {
      return false;
    }
    return !(nextSnapshot.pending_reveals?.some((reveal) => isBlockingPendingReveal(reveal)) ?? false);
  }

  function canSubmitPlayerMove(nextSnapshot: GameSnapshotDTO | null): boolean {
    if (!nextSnapshot || nextSnapshot.status !== 'IN_PROGRESS') {
      return false;
    }
    if (nextSnapshot.pending_reveals.some((reveal) => isBlockingPendingReveal(reveal))) {
      return false;
    }
    return Boolean(nextSnapshot.config?.analysis_mode || nextSnapshot.player_to_move === nextSnapshot.config?.player_seat);
  }

  function autoAnalyzeKey(nextSnapshot: GameSnapshotDTO): string {
    return [
      nextSnapshot.game_id,
      nextSnapshot.move_log.length,
      snapshotSearchKey(nextSnapshot),
    ].join(':');
  }

  function snapshotSearchKey(nextSnapshot: GameSnapshotDTO): string {
    return JSON.stringify({
      status: nextSnapshot.status,
      winner: nextSnapshot.winner,
      turnIndex: nextSnapshot.turn_index,
      playerToMove: nextSnapshot.player_to_move,
      boardState: nextSnapshot.board_state ?? null,
      legalActions: nextSnapshot.legal_actions,
      pendingReveals: nextSnapshot.pending_reveals.map((reveal) => ({
        zone: reveal.zone,
        tier: reveal.tier,
        slot: reveal.slot,
        actor: reveal.actor ?? null,
        reason: reveal.reason,
        actionIdx: reveal.action_idx ?? null,
      })),
    });
  }

  async function handleSnapshotUpdate(
    nextSnapshot: GameSnapshotDTO,
    engineShouldMove = false,
    deepSearchOverride: Record<string, DeepAnalysisSearchResult> | null = null,
    suppressAutoAnalyze = false,
    preserveActiveSearch = false,
    preserveLoadedMoveLog = false,
  ): Promise<void> {
    if (!preserveActiveSearch) {
      clearPolling();
    }
    const snapshotIndex = nextSnapshot.current_snapshot_index != null
      ? Number(nextSnapshot.current_snapshot_index)
      : null;
    const searchSource = deepSearchOverride ?? deepAnalysisSearchBySnapshot;
    const deepResult = snapshotIndex != null ? (searchSource[snapshotIndex] ?? null) : null;
    const positionSearchKey = snapshotSearchKey(nextSnapshot);
    const cachedSearchResult = nextSnapshot.config?.analysis_mode ? (analysisSearchByPositionRef.current[positionSearchKey] ?? null) : null;
    const restoredSearchResult = deepResult ?? cachedSearchResult;
    if (restoredSearchResult || !preserveActiveSearch) {
      setJobStatus(
        restoredSearchResult
          ? {
              job_id: deepResult ? `deep-${snapshotIndex}` : `cached-${positionSearchKey}`,
              status: 'DONE',
              result: restoredSearchResult,
              error: null,
            }
          : null,
      );
    }
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
    if (nextSnapshot.config?.analysis_mode) {
      setLoadedMoveLog((prev) => {
        const incoming = nextSnapshot.move_log ?? [];
        // Never overwrite a loaded mainline with a snapshot from a deviation or mainline
        // jump that the backend returned with a shorter/diverged move_log.
        if (preserveLoadedMoveLog && prev && prev.length > 0) {
          return prev;
        }
        const preserveLoadedMainline = activeVariationBranchIdRef.current != null;
        if (preserveLoadedMainline && prev && prev.length > 0) {
          return prev;
        }
        const loadedHistoricalLength = loadedHistoricalMainlineLengthRef.current;
        const loadedHistoricalTailSnapshot = loadedHistoricalMainlineTailSnapshotRef.current;
        const extendingLoadedMainline =
          activeVariationBranchIdRef.current == null
          && nextSnapshot.current_snapshot_index == null
          && loadedHistoricalLength > 0
          && incoming.length >= loadedHistoricalLength;
        if (extendingLoadedMainline) {
          const prefix = incoming.slice(0, loadedHistoricalLength);
          const suffix = incoming.slice(loadedHistoricalLength).map((move, idx) => ({
            ...move,
            result_snapshot_index: loadedHistoricalTailSnapshot + idx + 1,
          }));
          return [...prefix, ...suffix];
        }
        if (!prev || prev.length === 0) {
          return incoming;
        }
        if (incoming.length >= prev.length) {
          return incoming;
        }
        const isIncomingPrefix = incoming.every((move, idx) => {
          const prior = prev[idx];
          return prior
            && prior.result_turn_index === move.result_turn_index
            && prior.result_snapshot_index === move.result_snapshot_index
            && prior.action_idx === move.action_idx
            && prior.actor === move.actor;
        });
        return isIncomingPrefix ? prev : incoming;
      });
    }
    lastSnapshotSearchKeyRef.current = positionSearchKey;
    setUiStatus(deriveUiStatus(nextSnapshot));
    const nextAutoAnalyzeKey = autoAnalyzeKey(nextSnapshot);
    const shouldStartSearch =
      !restoredSearchResult
      && (
        engineShouldMove
        || (!suppressAutoAnalyze && shouldAutoAnalyze(nextSnapshot) && lastAutoAnalyzeKeyRef.current !== nextAutoAnalyzeKey)
      );
    if (shouldStartSearch) {
      lastAutoAnalyzeKeyRef.current = nextAutoAnalyzeKey;
      await startEngineThink({ snapshotOverride: nextSnapshot });
    }
  }

  function revealTaskLabel(reveal: GameSnapshotDTO['pending_reveals'][number]): string {
    const tierLabel = reveal.zone === 'faceup_card' || reveal.zone === 'reserved_card' ? ` · Tier ${reveal.tier}` : '';
    if (reveal.reason === 'replacement_after_buy') return `Select replacement${tierLabel}`;
    if (reveal.reason === 'replacement_after_reserve') return `Select refill${tierLabel}`;
    if (reveal.reason === 'reserved_from_deck') return 'Identify reserved card';
    if (reveal.reason === 'initial_noble_setup') return 'Set noble';
    if (reveal.reason === 'initial_setup') return `Set board card${tierLabel}`;
    if (reveal.zone === 'noble') return 'Set noble';
    if (reveal.zone === 'reserved_card') return `Set reserved card${tierLabel}`;
    return `Set card${tierLabel}`;
  }

  function buildEngineThinkRequest(options?: {
    searchTypeOverride?: SearchType;
    snapshotOverride?: GameSnapshotDTO | null;
    simulationsOverride?: number;
    evalBatchSizeOverride?: number;
    bootstrapSimulationsPerActionOverride?: number;
    forcedRootActionIdx?: number;
  }): EngineThinkRequest {
    const activeSearchType = options?.searchTypeOverride ?? searchType;
    const baseSnapshot = options?.snapshotOverride ?? snapshot;
    const fallback = baseSnapshot?.config?.num_simulations ?? numSimulations;
    const requestedSimulations = options?.simulationsOverride ?? searchSimulations;
    const requestedEvalBatchSize = options?.evalBatchSizeOverride ?? searchEvalBatchSize;
    const requestedBootstrapSimulationsPerAction =
      options?.bootstrapSimulationsPerActionOverride ?? searchBootstrapSimulationsPerAction;
    const nextNumSimulations =
      Number.isInteger(requestedSimulations) && requestedSimulations >= 1
        ? requestedSimulations
        : fallback;
    const nextEvalBatchSize =
      Number.isInteger(requestedEvalBatchSize) && requestedEvalBatchSize >= 1
        ? requestedEvalBatchSize
        : DEFAULT_GPU_EVAL_BATCH_SIZE;
    const nextBootstrapSimulationsPerAction =
      Number.isInteger(requestedBootstrapSimulationsPerAction) && requestedBootstrapSimulationsPerAction >= 1
        ? requestedBootstrapSimulationsPerAction
        : DEFAULT_BOOTSTRAP_SIMULATIONS_PER_ACTION;
    const supportsProgressiveTreeUpdates =
      activeSearchType === 'mcts' || activeSearchType === 'mcts_gpu' || activeSearchType === 'mcts_bootstrap';
    const useProgressiveSearch = supportsProgressiveTreeUpdates && homeView === 'ANALYSIS';
    const totalSearchBudget = nextNumSimulations;
    const publishInterval = analysisPublishInterval(nextNumSimulations);

    if (activeSearchType === 'alphabeta') {
      return {
        search_type: activeSearchType,
        continuous_until_cancel: false,
        alphabeta_depth: alphabetaDepth,
        ...(options?.forcedRootActionIdx != null ? { forced_root_action_idx: options.forcedRootActionIdx } : {}),
      };
    }

    if (activeSearchType === 'forced_child') {
      return {
        search_type: activeSearchType,
        continuous_until_cancel: false,
        forced_child_simulations_per_action: nextNumSimulations,
        ...(options?.forcedRootActionIdx != null ? { forced_root_action_idx: options.forcedRootActionIdx } : {}),
      };
    }

    return {
      num_simulations: useProgressiveSearch ? publishInterval : nextNumSimulations,
      search_type: activeSearchType,
      continuous_until_cancel: useProgressiveSearch,
      max_total_simulations: useProgressiveSearch ? totalSearchBudget : nextNumSimulations,
      ...((activeSearchType === 'mcts_gpu' || activeSearchType === 'mcts_bootstrap')
        ? { eval_batch_size: nextEvalBatchSize }
        : {}),
      ...(activeSearchType === 'mcts_bootstrap'
        ? { bootstrap_simulations_per_action: nextBootstrapSimulationsPerAction }
        : {}),
      ...(options?.forcedRootActionIdx != null ? { forced_root_action_idx: options.forcedRootActionIdx } : {}),
    };
  }

  const { clearPolling, startEngineThink } = useEnginePolling({
    buildEngineThinkRequest,
    handleSnapshotUpdate,
    snapshotRef,
    setError,
    setJobStatus,
    setUiStatus,
  });

  useEffect(() => {
    if (!snapshot?.config?.analysis_mode || jobStatus?.status !== 'DONE' || !jobStatus.result) {
      return;
    }
    const completedResult = jobStatus.result;
    const positionSearchKey = snapshotSearchKey(snapshot);
    if (analysisSearchByPositionRef.current[positionSearchKey] !== completedResult) {
      analysisSearchByPositionRef.current = {
        ...analysisSearchByPositionRef.current,
        [positionSearchKey]: completedResult,
      };
    }
  }, [jobStatus, snapshot]);

  async function startGame(manualRevealMode: boolean, playerSeatOverride?: Seat, analysisModeOverride?: boolean): Promise<void> {
    setError(null);
    clearPolling();
    setJobStatus(null);
    setRevealSelections({});
    setActiveRevealKey(null);
    setLoadedMoveLog(null);
    loadedHistoricalMainlineLengthRef.current = 0;
    loadedHistoricalMainlineTailSnapshotRef.current = 0;
    setLoadedPlayerNames(null);
    setVariationBranches([]);
    setDeepAnalysisBySnapshot({});
    setDeepAnalysisSearchBySnapshot({});
    analysisSearchByPositionRef.current = {};
    setIsLoadedPostAnalysisGame(false);
    setDeepAnalysisProgress(null);
    setIsDeepAnalysisRunning(false);
    clearActiveVariationSelection();
    lastAutoAnalyzeKeyRef.current = null;

    const payload = {
      num_simulations: Number(numSimulations),
      player_seat: playerSeatOverride ?? playerSeat,
      manual_reveal_mode: manualRevealMode,
      analysis_mode: analysisModeOverride ?? true,
      ...(seed.trim().length > 0 ? { seed: Number(seed) } : {}),
    };

    const nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/new', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const shouldEngineMove = Boolean(
      !nextSnapshot.config?.analysis_mode
      && nextSnapshot.status === 'IN_PROGRESS'
      && nextSnapshot.player_to_move !== nextSnapshot.config?.player_seat,
    );
    await handleSnapshotUpdate(nextSnapshot, shouldEngineMove);
  }

  async function startQuickGame(playerSeatOverride: Seat = playerSeat): Promise<void> {
    setQuickEntryPromptDone(true);
    setAnalysisPanelTab('MOVES');
    await startGame(false, playerSeatOverride, false);
  }

  async function startAnalysisGame(): Promise<void> {
    setAnalysisEntryPromptDone(true);
    await startGame(true, playerSeat, true);
  }

  function resetGameViewState(): void {
    setError(null);
    clearPolling();
    setJobStatus(null);
    setSnapshot(null);
    setLoadedMoveLog(null);
    loadedHistoricalMainlineLengthRef.current = 0;
    loadedHistoricalMainlineTailSnapshotRef.current = 0;
    setLoadedPlayerNames(null);
    setVariationBranches([]);
    setDeepAnalysisBySnapshot({});
    setDeepAnalysisSearchBySnapshot({});
    analysisSearchByPositionRef.current = {};
    setIsLoadedPostAnalysisGame(false);
    setDeepAnalysisProgress(null);
    setIsDeepAnalysisRunning(false);
    setIsAutoStartingGame(false);
    setQuickEntryPromptDone(false);
    setIsReplayLoading(false);
    setIsReplaySaving(false);
    clearActiveVariationSelection();
    lastAutoAnalyzeKeyRef.current = null;
  }

  function onOpenQuickView(): void {
    if (homeView === 'QUICK') {
      return;
    }
    resetGameViewState();
    setQuickEntryPromptDone(false);
    setHomeView('QUICK');
  }

  function onOpenManualView(): void {
    if (homeView === 'ANALYSIS') {
      return;
    }
    resetGameViewState();
    setAnalysisEntryPromptDone(false);
    setHomeView('ANALYSIS');
  }

  function onOpenAboutView(): void {
    if (homeView === 'ABOUT') {
      return;
    }
    resetGameViewState();
    setRevealSelections({});
    setActiveRevealKey(null);
    setHomeView('ABOUT');
  }

  function onOpenHomeView(): void {
    if (homeView === 'HOME') {
      return;
    }
    setHomeView('HOME');
  }

  async function onStartQuickFromHome(seat: Seat): Promise<void> {
    resetGameViewState();
    setHomeView('QUICK');
    await startQuickGame(seat);
  }

  useEffect(() => {
    if (homeView !== 'QUICK' && homeView !== 'ANALYSIS') {
      autoStartViewRef.current = null;
      setIsAutoStartingGame(false);
      return;
    }
    if (homeView === 'QUICK') {
      autoStartViewRef.current = null;
      setIsAutoStartingGame(false);
      return;
    }
    if (homeView === 'ANALYSIS' && !analysisEntryPromptDone) {
      autoStartViewRef.current = null;
      setIsAutoStartingGame(false);
      return;
    }
    if (snapshot || isAutoStartingGame || autoStartViewRef.current === homeView) {
      return;
    }

    autoStartViewRef.current = homeView;
    setIsAutoStartingGame(true);
    void (async () => {
      try {
        await startAnalysisGame();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsAutoStartingGame(false);
      }
    })();
  }, [homeView, isAutoStartingGame, playerSeat, snapshot, analysisEntryPromptDone, quickEntryPromptDone]);

  async function waitMs(durationMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, durationMs);
    });
  }

  function classifyDeepAnalysisFromSearch(
    playedActionIdx: number,
    bestActionIdx: number | null,
    bestQ: number | null,
    playedQ: number | null,
  ): DeepAnalysisEntry {
    if (
      bestActionIdx == null
      || bestQ == null
      || !Number.isFinite(bestQ)
      || playedQ == null
      || !Number.isFinite(playedQ)
    ) {
      return {
        category: 'Unknown',
        playedActionIdx,
        bestActionIdx,
        playedQ,
        bestQ,
        qLoss: null,
      };
    }

    const qLoss = Math.max(0, bestQ - playedQ);
    let category: DeepAnalysisCategory;
    if (playedActionIdx === bestActionIdx) {
      category = 'Best';
    } else if (qLoss < 0.1) {
      category = 'Good';
    } else if (qLoss < 0.3) {
      category = 'Mistake';
    } else {
      category = 'Blunder';
    }

    return {
      category,
      playedActionIdx,
      bestActionIdx,
      playedQ,
      bestQ,
      qLoss,
    };
  }

  function deepAnalysisBadgeSymbol(entry: DeepAnalysisEntry): string {
    return entry.category === 'Blunder' ? '??' : '?';
  }

  function shouldShowDeepAnalysisBadge(entry: DeepAnalysisEntry): boolean {
    return entry.category === 'Mistake' || entry.category === 'Blunder';
  }

  async function runSingleDeepAnalysis(
    simulations: number,
    forcedRootActionIdx?: number,
    searchTypeOverride?: SearchType,
    evalBatchSizeOverride?: number,
    bootstrapSimulationsPerActionOverride?: number,
  ): Promise<EngineJobStatusDTO> {
    const think = await fetchJSON<EngineThinkResponse>('/api/game/engine-think', {
      method: 'POST',
      body: JSON.stringify(buildEngineThinkRequest({
        searchTypeOverride,
        simulationsOverride: simulations,
        evalBatchSizeOverride,
        bootstrapSimulationsPerActionOverride,
        forcedRootActionIdx,
      })),
    });
    for (;;) {
      await waitMs(200);
      const status = await fetchJSON<EngineJobStatusDTO>(`/api/game/engine-job/${think.job_id}`);
      if (status.status === 'DONE') {
        return status;
      }
      if (status.status === 'FAILED' || status.status === 'CANCELLED') {
        throw new Error(status.error ?? `Deep analysis job ${status.status.toLowerCase()}`);
      }
    }
  }

  async function restoreSnapshotForDeepAnalysis(targetSnapshotIndex: number): Promise<GameSnapshotDTO> {
    return fetchJSON<GameSnapshotDTO>('/api/game/jump-to-snapshot', {
      method: 'POST',
      body: JSON.stringify({ snapshot_index: targetSnapshotIndex }),
    });
  }

  async function onRunDeepAnalysis(): Promise<void> {
    if (!snapshot || moveLogEntries.length === 0 || isDeepAnalysisRunning || !canRunDeepAnalysisForCurrentSearch) {
      return;
    }

    const startSnapshotIndex = currentSnapshotIndex;
    const targets = moveLogEntries.filter((move) => move.result_snapshot_index > 0);
    if (targets.length === 0) {
      return;
    }

    setError(null);
    clearPolling();
    setJobStatus(null);
    setIsDeepAnalysisRunning(true);
    setDeepAnalysisProgress({ done: 0, total: targets.length });
    setDeepAnalysisBySnapshot({});
    setDeepAnalysisSearchBySnapshot({});

    try {
      for (let idx = 0; idx < targets.length; idx += 1) {
        const move = targets[idx];
        const moveKey = moveAnalysisKey(move);
        const beforeSnapshotIndex = Math.max(0, move.result_snapshot_index - 1);
        await restoreSnapshotForDeepAnalysis(beforeSnapshotIndex);
        const prerequisiteMoves = targets.slice(0, idx).filter((candidate) =>
          candidate.result_snapshot_index === move.result_snapshot_index,
        );
        for (const prerequisite of prerequisiteMoves) {
          await fetchJSON<PlayerMoveResponse>('/api/game/player-move', {
            method: 'POST',
            body: JSON.stringify({ action_idx: prerequisite.action_idx }),
          });
        }
        const status = await runSingleDeepAnalysis(
          deepAnalysisSimulations,
          undefined,
          searchType,
          searchType === 'mcts_gpu' ? deepAnalysisEvalBatchSize : undefined,
          searchType === 'mcts_bootstrap' ? deepAnalysisBootstrapSimulationsPerAction : undefined,
        );
        const regularResult = status.result;
        const bestActionIdx = regularResult?.action_idx ?? null;
        const bestQ = regularResult?.selected_action_q ?? null;
        const regularPlayedQ = regularResult?.action_details.find((detail) => detail.action_idx === move.action_idx)?.q_value ?? null;
        let playedQ = regularPlayedQ;
        if (bestActionIdx == null || bestQ == null) {
          playedQ = null;
        } else if (move.action_idx === bestActionIdx) {
          playedQ = regularPlayedQ ?? bestQ;
        } else {
          const forcedStatus = await runSingleDeepAnalysis(
            deepAnalysisSimulations,
            move.action_idx,
            searchType,
            searchType === 'mcts_gpu' ? deepAnalysisEvalBatchSize : undefined,
            searchType === 'mcts_bootstrap' ? deepAnalysisBootstrapSimulationsPerAction : undefined,
          );
          playedQ = forcedStatus.result?.selected_action_q ?? null;
        }
        const classified = classifyDeepAnalysisFromSearch(move.action_idx, bestActionIdx, bestQ, playedQ);
        setDeepAnalysisBySnapshot((prev) => ({ ...prev, [moveKey]: classified }));
        if (regularResult != null) {
          setDeepAnalysisSearchBySnapshot((prev) => {
            const result = regularResult as DeepAnalysisSearchResult;
            const next = {
              ...prev,
              [moveKey]: result,
            };
            if (!Object.prototype.hasOwnProperty.call(next, String(beforeSnapshotIndex))) {
              next[String(beforeSnapshotIndex)] = result;
            }
            return next;
          });
        }
        setDeepAnalysisProgress({ done: idx + 1, total: targets.length });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      try {
        const restoredSnapshot = await restoreSnapshotForDeepAnalysis(startSnapshotIndex);
        await handleSnapshotUpdate(restoredSnapshot);
      } catch {
        // Keep current state if restore fails.
      }
      setIsDeepAnalysisRunning(false);
      setDeepAnalysisProgress(null);
    }
  }

  function deriveVariationContext(beforeSnapshot: GameSnapshotDTO, beforeSnapshotIndex: number, actor: Seat): {
    expectedMainlineMove: MoveLogEntryDTO | null;
    isFromHistoricalMainline: boolean;
    isOnMainlineSnapshot: boolean;
    baseFullMoveNumber: number;
  } | null {
    if (!loadedMoveLog || loadedMoveLog.length === 0) {
      return null;
    }
    const expectedMainlineMove = loadedMoveLog
      .filter((move) => move.result_snapshot_index > beforeSnapshotIndex)
      .sort((a, b) => a.result_snapshot_index - b.result_snapshot_index)[0] ?? null;
    const mainlineTailSnapshotIndex = loadedMoveLog[loadedMoveLog.length - 1].result_snapshot_index;
    const isFromHistoricalMainline = beforeSnapshot.current_snapshot_index != null
      && beforeSnapshot.current_snapshot_index < mainlineTailSnapshotIndex;
    const isOnMainlineSnapshot = beforeSnapshot.current_snapshot_index != null;
    const anchorMainlineMove = loadedMoveLog.find((move) => move.result_snapshot_index === beforeSnapshotIndex) ?? null;
    const anchorMainlineMoveNumber = anchorMainlineMove == null
      ? null
      : (moveLogRows.find((row) =>
          row.p0?.result_snapshot_index === anchorMainlineMove.result_snapshot_index
          || row.p1?.result_snapshot_index === anchorMainlineMove.result_snapshot_index
        )?.moveNumber ?? null);
    const lastRow = moveLogRows.length > 0 ? moveLogRows[moveLogRows.length - 1] : null;
    const fallbackBaseMoveNumber = (() => {
      if (!lastRow) return 1;
      if (actor === 'P0') {
        return lastRow.p1 != null ? lastRow.moveNumber + 1 : lastRow.moveNumber;
      }
      return lastRow.moveNumber;
    })();
    const baseFullMoveNumber = (() => {
      if (anchorMainlineMove != null && anchorMainlineMoveNumber != null) {
        return anchorMainlineMove.actor === 'P0'
          ? anchorMainlineMoveNumber
          : anchorMainlineMoveNumber + 1;
      }
      if (expectedMainlineMove) {
        return mainlineMoveNumberBySnapshot.get(expectedMainlineMove.result_snapshot_index) ?? fallbackBaseMoveNumber;
      }
      return fallbackBaseMoveNumber;
    })();
    return {
      expectedMainlineMove,
      isFromHistoricalMainline,
      isOnMainlineSnapshot,
      baseFullMoveNumber,
    };
  }

  async function onPlayerMove(
    actionIdx: number,
    options?: {
      suppressAutoAnalyze?: boolean;
      analyzeWithSearchType?: SearchType | null;
    },
  ): Promise<void> {
    const beforeSnapshot = snapshot;
    const beforeSnapshotIndex = currentSnapshotIndex;
    setError(null);
    clearPolling();
    setJobStatus(null);
    setUiStatus('WAITING_PLAYER');
    try {
      const result = await fetchJSON<PlayerMoveResponse>('/api/game/player-move', {
        method: 'POST',
        body: JSON.stringify({ action_idx: actionIdx }),
      });

      if (beforeSnapshot) {
        const actor = beforeSnapshot.player_to_move;
        const actionInfo = beforeSnapshot.legal_action_details.find((item) => item.action_idx === actionIdx) ?? null;
        const label = actionInfo?.label ?? `Action ${actionIdx}`;
        const display = actionInfo?.display ?? null;
        const variationCtx = deriveVariationContext(beforeSnapshot, beforeSnapshotIndex, actor);
        const expectedMainlineMove = variationCtx?.expectedMainlineMove ?? null;
        const isOnMainlineSnapshot = variationCtx?.isOnMainlineSnapshot ?? false;
        const shouldStartNewBranch = activeVariationBranchIdRef.current == null && isOnMainlineSnapshot && expectedMainlineMove != null && expectedMainlineMove.action_idx !== actionIdx;

        appendVariationNode(
          beforeSnapshot,
          beforeSnapshotIndex,
          actor,
          shouldStartNewBranch,
          (fullMoveNumber) => ({
            kind: 'move',
            actor,
            actionIdx,
            replayActionIdxList: [actionIdx],
            label,
            display,
            fullMoveNumber,
            targetSnapshotIndex: result.snapshot.current_snapshot_index ?? -1,
            targetTurnIndex: result.snapshot.turn_index,
            jumpBySnapshot: result.snapshot.current_snapshot_index != null,
          }),
        );
      }

      const forcedSearchType = options?.analyzeWithSearchType ?? null;
      const shouldSuppressAutoAnalyze = options?.suppressAutoAnalyze ?? false;
      const shouldSuppressInHandle = shouldSuppressAutoAnalyze || forcedSearchType != null || isLoadedPostAnalysisGame;
      if (shouldSuppressInHandle) {
        lastAutoAnalyzeKeyRef.current = autoAnalyzeKey(result.snapshot);
      }
      await handleSnapshotUpdate(
        result.snapshot,
        !shouldSuppressInHandle && result.engine_should_move,
        null,
        shouldSuppressInHandle,
      );
      if (forcedSearchType && shouldAutoAnalyze(result.snapshot)) {
        await startEngineThink({
          searchTypeOverride: forcedSearchType,
          snapshotOverride: result.snapshot,
        });
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function onSelectQuickAction(actionIdx: number): Promise<void> {
    if (!snapshot) {
      return;
    }
    if (!canSubmitPlayerMove(snapshot)) {
      return;
    }
    await onPlayerMove(actionIdx);
  }

  async function onSelectAnalysisAction(actionIdx: number): Promise<void> {
    if (!snapshot) {
      return;
    }
    if (!canSubmitPlayerMove(snapshot)) {
      return;
    }
    const actor = snapshot.player_to_move;
    const variationCtx = deriveVariationContext(snapshot, currentSnapshotIndex, actor);
    const mainlineMove = variationCtx?.expectedMainlineMove ?? null;
    if (mainlineMove && mainlineMove.action_idx === actionIdx && activeVariationBranchIdRef.current == null) {
      await onJumpToSnapshot(mainlineMove.result_snapshot_index, false, !autoAnalyzeOnNavigation, false);
      return;
    }

    if (highlightedVariation) {
      const activeBranch = variationBranches.find((branch) => branch.id === highlightedVariation.branchId) ?? null;
      const nextMove = activeBranch?.moves[highlightedVariation.moveIndex + 1] ?? null;
      if (activeBranch && nextMove?.kind === 'move' && nextMove.actionIdx === actionIdx) {
        await onJumpToVariationMove(activeBranch, highlightedVariation.moveIndex + 1, !autoAnalyzeOnNavigation);
        return;
      }
    }

    const anchoredBranch = (variationBranchByAnchor.get(currentSnapshotIndex) ?? []).find((branch) => {
      const firstMove = branch.moves[0];
      return firstMove?.kind === 'move' && firstMove.actionIdx === actionIdx;
    }) ?? null;
    if (anchoredBranch) {
      await onJumpToVariationMove(anchoredBranch, 0, !autoAnalyzeOnNavigation);
      return;
    }

    await onPlayerMove(actionIdx, {
      suppressAutoAnalyze: true,
      analyzeWithSearchType: 'mcts',
    });
  }

  async function onSelectModeAction(actionIdx: number): Promise<void> {
    if (homeView === 'QUICK') {
      await onSelectQuickAction(actionIdx);
      return;
    }
    if (homeView === 'ANALYSIS') {
      await onSelectAnalysisAction(actionIdx);
    }
  }

  async function onUndoToStart(suppressAutoAnalyze = false): Promise<void> {
    setError(null);
    clearPolling();
    setJobStatus(null);
    try {
      const nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/undo-to-start', {
        method: 'POST',
        body: '{}',
      });
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze;
      if (shouldSuppressAutoAnalyze) {
        lastAutoAnalyzeKeyRef.current = autoAnalyzeKey(nextSnapshot);
      }
      await handleSnapshotUpdate(
        nextSnapshot,
        !shouldSuppressAutoAnalyze && shouldAutoAnalyze(nextSnapshot),
        null,
        shouldSuppressAutoAnalyze,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onRedoToEnd(suppressAutoAnalyze = false): Promise<void> {
    setError(null);
    clearPolling();
    setJobStatus(null);
    try {
      const nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/redo-to-end', {
        method: 'POST',
        body: '{}',
      });
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze;
      if (shouldSuppressAutoAnalyze) {
        lastAutoAnalyzeKeyRef.current = autoAnalyzeKey(nextSnapshot);
      }
      await handleSnapshotUpdate(
        nextSnapshot,
        !shouldSuppressAutoAnalyze && shouldAutoAnalyze(nextSnapshot),
        null,
        shouldSuppressAutoAnalyze,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onJumpToTurn(
    turnIndex: number,
    keepActiveVariationBranch = false,
    suppressAutoAnalyze = false,
  ): Promise<void> {
    if (!snapshot || turnIndex === snapshot.turn_index) {
      return;
    }
    setError(null);
    clearPolling();
    setJobStatus(null);
    if (!keepActiveVariationBranch) {
      clearActiveVariationSelection();
    }
    try {
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze;
      const nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/jump-to-turn', {
        method: 'POST',
        body: JSON.stringify({ turn_index: turnIndex }),
      });
      if (shouldSuppressAutoAnalyze) {
        lastAutoAnalyzeKeyRef.current = autoAnalyzeKey(nextSnapshot);
      }
      await handleSnapshotUpdate(
        nextSnapshot,
        !shouldSuppressAutoAnalyze && shouldAutoAnalyze(nextSnapshot),
        null,
        shouldSuppressAutoAnalyze,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onJumpToSnapshot(
    snapshotIndex: number,
    keepActiveVariationBranch = false,
    suppressAutoAnalyze = false,
    fallbackToTurn = true,
  ): Promise<void> {
    if (!snapshot) {
      return;
    }
    setError(null);
    clearPolling();
    setJobStatus(null);
    if (!keepActiveVariationBranch) {
      clearActiveVariationSelection();
    }
    // Preserve the loaded mainline whenever we jump to a historical snapshot,
    // because the server's move_log on the returned snapshot reflects only
    // moves up to that position and would overwrite the full recorded mainline.
    const shouldPreserveLog = loadedHistoricalMainlineLengthRef.current > 0;
    try {
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze;
      const nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/jump-to-snapshot', {
        method: 'POST',
        body: JSON.stringify({ snapshot_index: snapshotIndex }),
      });
      if (shouldSuppressAutoAnalyze) {
        lastAutoAnalyzeKeyRef.current = autoAnalyzeKey(nextSnapshot);
      }
      await handleSnapshotUpdate(
        nextSnapshot,
        !shouldSuppressAutoAnalyze && shouldAutoAnalyze(nextSnapshot),
        null,
        shouldSuppressAutoAnalyze,
        false,
        shouldPreserveLog,
      );
    } catch {
      if (!fallbackToTurn) {
        return;
      }
      const fallbackTurnIndex = (() => {
        if (snapshotIndex <= 0) {
          return 0;
        }
        let bestSnapshotIndex = -1;
        let bestTurnIndex: number | null = null;
        for (const move of moveLogEntries) {
          if (move.result_snapshot_index > snapshotIndex) {
            continue;
          }
          if (bestTurnIndex == null || move.result_snapshot_index > bestSnapshotIndex) {
            bestSnapshotIndex = move.result_snapshot_index;
            bestTurnIndex = move.result_turn_index;
          }
        }
        return bestTurnIndex ?? 0;
      })();
      // Fallback for non-snapshot sessions.
      await onJumpToTurn(fallbackTurnIndex, false, suppressAutoAnalyze);
    }
  }

  async function onJumpToVisibleMainlineStart(suppressAutoAnalyze = false): Promise<void> {
    if (loadedHistoricalMainlineLengthRef.current > 0) {
      await onJumpToSnapshot(0, false, suppressAutoAnalyze, false);
      return;
    }
    await onUndoToStart(suppressAutoAnalyze);
  }

  async function onJumpToVisibleMainlineEnd(suppressAutoAnalyze = false): Promise<void> {
    const finalSnapshotIndex = mainlineMoveSnapshotIndices.length > 0
      ? mainlineMoveSnapshotIndices[mainlineMoveSnapshotIndices.length - 1]
      : 0;
    if (loadedHistoricalMainlineLengthRef.current > 0) {
      if (finalSnapshotIndex > loadedHistoricalMainlineTailSnapshotRef.current) {
        await onJumpToLoadedMainlineExtension(finalSnapshotIndex, suppressAutoAnalyze);
        return;
      }
      await onJumpToSnapshot(finalSnapshotIndex, false, suppressAutoAnalyze, false);
      return;
    }
    await onRedoToEnd(suppressAutoAnalyze);
  }

  async function onJumpToLoadedMainlineExtension(
    snapshotIndex: number,
    suppressAutoAnalyze = false,
  ): Promise<void> {
    if (!snapshot) {
      return;
    }
    const historicalLength = loadedHistoricalMainlineLengthRef.current;
    const historicalTailSnapshot = loadedHistoricalMainlineTailSnapshotRef.current;
    if (historicalLength <= 0 || snapshotIndex <= historicalTailSnapshot) {
      await onJumpToSnapshot(snapshotIndex, false, suppressAutoAnalyze, true);
      return;
    }
    const extensionMoves = moveLogEntries.slice(historicalLength);
    const extensionCount = snapshotIndex - historicalTailSnapshot;
    if (extensionCount <= 0 || extensionCount > extensionMoves.length) {
      setError(`Snapshot ${snapshotIndex} is out of bounds for the loaded mainline extension`);
      return;
    }

    setError(null);
    clearPolling();
    setJobStatus(null);
    clearActiveVariationSelection();

    try {
      // Appended post-load mainline moves now exist in backend snapshot history,
      // so prefer a direct snapshot jump instead of replaying from the tail.
      const directSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/jump-to-snapshot', {
        method: 'POST',
        body: JSON.stringify({ snapshot_index: snapshotIndex }),
      });
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze;
      if (shouldSuppressAutoAnalyze) {
        lastAutoAnalyzeKeyRef.current = autoAnalyzeKey(directSnapshot);
      }
      await handleSnapshotUpdate(directSnapshot, false, null, shouldSuppressAutoAnalyze);
      return;
    } catch {
      // Older sessions can still require replaying the extension from the
      // loaded historical tail. Fall back to that slower path only if a
      // direct snapshot jump is unavailable.
    }

    try {
      let nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/jump-to-snapshot', {
        method: 'POST',
        body: JSON.stringify({ snapshot_index: historicalTailSnapshot }),
      });
      for (let idx = 0; idx < extensionCount; idx += 1) {
        const item = extensionMoves[idx];
        const result = await fetchJSON<PlayerMoveResponse>('/api/game/player-move', {
          method: 'POST',
          body: JSON.stringify({ action_idx: item.action_idx }),
        });
        nextSnapshot = result.snapshot;
      }
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze;
      if (shouldSuppressAutoAnalyze) {
        lastAutoAnalyzeKeyRef.current = autoAnalyzeKey(nextSnapshot);
      }
      await handleSnapshotUpdate(nextSnapshot, false, null, shouldSuppressAutoAnalyze);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onStepMainline(delta: -1 | 1, suppressAutoAnalyze = true): Promise<void> {
    if (!snapshot || mainlineMoveSnapshotIndices.length === 0) {
      return;
    }

    // Stepping the mainline always exits any active deviation.
    clearActiveVariationSelection();

    const useTurnNavigation = snapshot.current_snapshot_index == null && !isLoadedMainlineExtensionState;
    const navigationTargets = useTurnNavigation ? mainlineMoveTurnIndices : mainlineMoveSnapshotIndices;
    // When coming from a deviation, currentSnapshotIndex may not be in
    // mainlineMoveSnapshotIndices. Find the latest mainline position that is
    // <= the deviation's anchor so the step lands on the correct next mainline move.
    const activeSnapshotIndex = useTurnNavigation ? snapshot.turn_index : currentSnapshotIndex;
    let baseIdx = 0;
    for (let i = 0; i < navigationTargets.length; i += 1) {
      if (navigationTargets[i] <= activeSnapshotIndex) {
        baseIdx = i;
      }
    }

    const nextPos = baseIdx + delta;
    if (nextPos < 0 || nextPos >= navigationTargets.length) {
      return;
    }

    const nextSnapshotIndex = navigationTargets[nextPos];
    if (nextSnapshotIndex === activeSnapshotIndex) {
      return;
    }

    if (useTurnNavigation) {
      await onJumpToTurn(nextSnapshotIndex, false, suppressAutoAnalyze);
      return;
    }
    if (
      loadedHistoricalMainlineLengthRef.current > 0 &&
      nextSnapshotIndex > loadedHistoricalMainlineTailSnapshotRef.current
    ) {
      await onJumpToLoadedMainlineExtension(nextSnapshotIndex, suppressAutoAnalyze);
      return;
    }
    await onJumpToSnapshot(nextSnapshotIndex, false, suppressAutoAnalyze, false);
  }

  async function onJumpToVariationMove(
    branch: VariationBranch,
    moveIndex: number,
    suppressAutoAnalyze = false,
  ): Promise<void> {
    if (!snapshot || moveIndex < 0 || moveIndex >= branch.moves.length) {
      return;
    }
    setError(null);
    clearPolling();
    setJobStatus(null);
    selectVariationMove(branch.id, moveIndex);

    try {
      // Always rebuild branch state from its anchor snapshot to avoid
      // accidentally resolving turn jumps on the loaded mainline.
      let nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/jump-to-snapshot', {
        method: 'POST',
        body: JSON.stringify({ snapshot_index: branch.anchorSnapshotIndex }),
      });
      for (let idx = 0; idx <= moveIndex; idx += 1) {
        const item = branch.moves[idx];
        if (item.kind === 'move') {
          const actionsToReplay = item.replayActionIdxList && item.replayActionIdxList.length > 0
            ? item.replayActionIdxList
            : [item.actionIdx];
          for (const replayActionIdx of actionsToReplay) {
            const result = await fetchJSON<PlayerMoveResponse>('/api/game/player-move', {
              method: 'POST',
              body: JSON.stringify({ action_idx: replayActionIdx }),
            });
            nextSnapshot = result.snapshot;
          }
          continue;
        }
        if (item.kind === 'edit_faceup') {
          const result = await fetchJSON<RevealCardResponse>('/api/game/reveal-card', {
            method: 'POST',
            body: JSON.stringify({ tier: item.tier, slot: item.slot, card_id: item.cardId }),
          });
          nextSnapshot = result.snapshot;
          continue;
        }
        if (item.kind === 'edit_reserved') {
          const result = await fetchJSON<RevealCardResponse>('/api/game/reveal-reserved-card', {
            method: 'POST',
            body: JSON.stringify({ seat: item.seat, slot: item.slot, card_id: item.cardId }),
          });
          nextSnapshot = result.snapshot;
          continue;
        }
        if (item.kind === 'edit_noble') {
          const result = await fetchJSON<RevealCardResponse>('/api/game/reveal-noble', {
            method: 'POST',
            body: JSON.stringify({ slot: item.slot, noble_id: item.nobleId }),
          });
          nextSnapshot = result.snapshot;
        }
      }
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze || isLoadedPostAnalysisGame;
      if (shouldSuppressAutoAnalyze) {
        lastAutoAnalyzeKeyRef.current = autoAnalyzeKey(nextSnapshot);
      }
      await handleSnapshotUpdate(nextSnapshot, false, null, shouldSuppressAutoAnalyze, false, true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function renderVariationMove(move: VariationMove): ReactElement {
    if (move.kind !== 'move') {
      return (
        <span className="action-label move-log-edit-label">
          <span className="move-log-edit-icon">✎</span>
          {' '}{move.label}
        </span>
      );
    }
    const moveNumber = Math.max(1, move.fullMoveNumber);
    const prefix = move.actor === 'P0' ? `${moveNumber}.` : `${moveNumber}...`;
    return (
      <span className="action-label">
        <span className="move-log-deviation-num">{prefix}{' '}</span>
        <ActionLabel
          actionIdx={move.actionIdx}
          display={move.display ?? null}
          board={snapshot?.board_state ?? null}
        />
      </span>
    );
  }

  function appendVariationNode(
    beforeSnapshot: GameSnapshotDTO,
    beforeSnapshotIndex: number,
    actor: Seat,
    shouldStartNewBranch: boolean,
    buildEntry: (fullMoveNumber: number) => VariationMove,
  ): void {
    const variationCtx = deriveVariationContext(beforeSnapshot, beforeSnapshotIndex, actor);
    const isOnMainlineSnapshot = variationCtx?.isOnMainlineSnapshot ?? false;
    const baseFullMoveNumber = variationCtx?.baseFullMoveNumber ?? 1;

    if (activeVariationBranchIdRef.current == null) {
      if (!shouldStartNewBranch || !isOnMainlineSnapshot) {
        return;
      }
      const branchId = variationBranchIdCounterRef.current++;
      selectVariationMove(branchId, 0);
      setVariationBranches((prev) => [
        ...prev,
        {
          id: branchId,
          anchorSnapshotIndex: beforeSnapshotIndex,
          moves: [buildEntry(baseFullMoveNumber)],
        },
      ]);
      return;
    }

    const activeId = activeVariationBranchIdRef.current;
    const selectedMoveIndex = activeVariationSelection?.branchId === activeId
      ? activeVariationSelection.moveIndex
      : null;
    setVariationBranches((prev) => prev.map((branch) => {
      if (branch.id !== activeId) {
        return branch;
      }
      const preservedMoves = selectedMoveIndex != null
        ? branch.moves.slice(0, selectedMoveIndex + 1)
        : branch.moves;
      const last = preservedMoves[preservedMoves.length - 1];
      const fullMoveNumber = !last
        ? baseFullMoveNumber
        : (last.actor === 'P1' && actor === 'P0' ? last.fullMoveNumber + 1 : last.fullMoveNumber);
      return {
        ...branch,
        moves: [...preservedMoves, buildEntry(fullMoveNumber)],
      };
    }));
    if (activeId != null) {
      selectVariationMove(activeId, (selectedMoveIndex ?? -1) + 1);
    }
  }

  function appendVariationEditNode(
    beforeSnapshot: GameSnapshotDTO,
    beforeSnapshotIndex: number,
    actor: Seat,
    label: string,
    resultSnapshot: GameSnapshotDTO,
    kind: 'edit_faceup' | 'edit_reserved' | 'edit_noble',
    payload: { tier?: number; slot?: number; seat?: Seat; cardId?: number; nobleId?: number },
  ): void {
    appendVariationNode(
      beforeSnapshot,
      beforeSnapshotIndex,
      actor,
      true,
      (fullMoveNumber) => ({
        kind,
        actor,
        actionIdx: -1,
        label,
        fullMoveNumber,
        targetSnapshotIndex: resultSnapshot.current_snapshot_index ?? -1,
        targetTurnIndex: resultSnapshot.turn_index,
        jumpBySnapshot: resultSnapshot.current_snapshot_index != null,
        ...payload,
      }),
    );
  }

  function truncateMoveHistoryAfterSnapshot(snapshotIndex: number): void {
    setLoadedMoveLog((prev) => {
      if (!prev) {
        return prev;
      }
      return prev.filter((move) => move.result_snapshot_index <= snapshotIndex);
    });
    loadedHistoricalMainlineLengthRef.current = Math.min(
      loadedHistoricalMainlineLengthRef.current,
      Math.max(0, snapshotIndex),
    );
    loadedHistoricalMainlineTailSnapshotRef.current = Math.min(
      loadedHistoricalMainlineTailSnapshotRef.current,
      Math.max(0, snapshotIndex),
    );
    setVariationBranches((prev) => prev.filter((branch) => branch.anchorSnapshotIndex <= snapshotIndex));
  }

  async function onRevealCardWithId(tier: number, slot: number, cardId?: number): Promise<void> {
    const beforeSnapshot = snapshot;
    const beforeSnapshotIndex = currentSnapshotIndex;
    setError(null);
    clearPolling();
    setJobStatus(null);
    const key = revealKey('faceup_card', tier, slot);
    const selected = cardId != null ? String(cardId) : revealSelections[key];
    if (!selected) {
      setError(`Choose a card for tier ${tier} slot ${slot}`);
      return;
    }

    try {
      const result = await fetchJSON<RevealCardResponse>('/api/game/reveal-card', {
        method: 'POST',
        body: JSON.stringify({ tier, slot, card_id: Number(selected) }),
      });
      if (beforeSnapshot) {
        const tierRow = beforeSnapshot.board_state?.tiers.find((item) => item.tier === tier);
        const prior = tierRow?.cards.find((item) => item.slot === slot);
        const priorId = prior ? findCatalogCardId(prior) : null;
        const label = `[Edit] T${tier}S${slot}: #${priorId ?? '?'} -> #${Number(selected)}`;
        appendVariationEditNode(
          beforeSnapshot,
          beforeSnapshotIndex,
          beforeSnapshot.player_to_move,
          label,
          result.snapshot,
          'edit_faceup',
          { tier, slot, cardId: Number(selected) },
        );
      }
      setRevealSelections((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setActiveRevealKey(nextRevealKeyInSameGroup(result.snapshot, { zone: 'faceup_card', tier, slot }));
      truncateMoveHistoryAfterSnapshot(beforeSnapshotIndex);
      await handleSnapshotUpdate(result.snapshot, result.engine_should_move);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onRevealReservedCardWithId(seat: Seat, tier: number, slot: number, cardId?: number): Promise<void> {
    const beforeSnapshot = snapshot;
    const beforeSnapshotIndex = currentSnapshotIndex;
    setError(null);
    clearPolling();
    setJobStatus(null);
    const key = revealKey('reserved_card', tier, slot, seat);
    const selected = cardId != null ? String(cardId) : revealSelections[key];
    if (!selected) {
      setError(`Choose a card for ${seat} reserved slot ${slot}`);
      return;
    }

    try {
      const result = await fetchJSON<RevealCardResponse>('/api/game/reveal-reserved-card', {
        method: 'POST',
        body: JSON.stringify({ seat, slot, card_id: Number(selected) }),
      });
      if (beforeSnapshot) {
        const player = beforeSnapshot.board_state?.players.find((item) => item.seat === seat);
        const prior = player?.reserved_public.find((item) => item.slot === slot);
        const priorId = prior ? findCatalogCardId(prior) : null;
        const label = `[Edit] ${seat}R${slot}: #${priorId ?? '?'} -> #${Number(selected)}`;
        appendVariationEditNode(
          beforeSnapshot,
          beforeSnapshotIndex,
          beforeSnapshot.player_to_move,
          label,
          result.snapshot,
          'edit_reserved',
          { seat, tier, slot, cardId: Number(selected) },
        );
      }
      setRevealSelections((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setActiveRevealKey(nextRevealKeyInSameGroup(result.snapshot, { zone: 'reserved_card', tier, slot, seat }));
      truncateMoveHistoryAfterSnapshot(beforeSnapshotIndex);
      await handleSnapshotUpdate(
        result.snapshot,
        result.engine_should_move || Boolean(result.snapshot.config?.analysis_mode),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onRevealNobleWithId(slot: number, nobleId?: number): Promise<void> {
    const beforeSnapshot = snapshot;
    const beforeSnapshotIndex = currentSnapshotIndex;
    setError(null);
    clearPolling();
    setJobStatus(null);
    const key = revealKey('noble', 0, slot);
    const selected = nobleId != null ? String(nobleId) : revealSelections[key];
    if (!selected) {
      setError(`Choose a noble for slot ${slot}`);
      return;
    }

    try {
      const result = await fetchJSON<RevealCardResponse>('/api/game/reveal-noble', {
        method: 'POST',
        body: JSON.stringify({ slot, noble_id: Number(selected) }),
      });
      if (beforeSnapshot) {
        const prior = beforeSnapshot.board_state?.nobles.find((item) => item.slot === slot);
        const priorId = prior ? findCatalogNobleId(prior) : null;
        const label = `[Edit] N${slot}: #${priorId ?? '?'} -> #${Number(selected)}`;
        appendVariationEditNode(
          beforeSnapshot,
          beforeSnapshotIndex,
          beforeSnapshot.player_to_move,
          label,
          result.snapshot,
          'edit_noble',
          { slot, nobleId: Number(selected) },
        );
      }
      setRevealSelections((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setActiveRevealKey(nextRevealKeyInSameGroup(result.snapshot, { zone: 'noble', tier: 0, slot }));
      truncateMoveHistoryAfterSnapshot(beforeSnapshotIndex);
      await handleSnapshotUpdate(result.snapshot, result.engine_should_move);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function openReveal(zone: 'faceup_card' | 'reserved_card' | 'noble', tier: number, slot: number, seat?: Seat): void {
    const key = revealKey(zone, tier, slot, seat);
    const hasPending = snapshot?.pending_reveals.some((reveal) => revealKey(reveal.zone, reveal.tier, reveal.slot, reveal.actor ?? undefined) === key) ?? false;
    const setupEditable =
      isSetupLikeView &&
      snapshot?.pending_reveals.some((reveal) => reveal.reason === 'initial_setup' || reveal.reason === 'initial_noble_setup') &&
      (zone === 'faceup_card' || zone === 'noble');
    const manualRevealEditable = Boolean(snapshot?.config?.manual_reveal_mode) && (zone === 'faceup_card' || zone === 'reserved_card' || zone === 'noble');
    const freeEditEnabled = Boolean(snapshot) && (zone === 'faceup_card' || zone === 'reserved_card' || zone === 'noble');
    if (!hasPending && !setupEditable && !manualRevealEditable && !freeEditEnabled) {
      return;
    }
    if ((setupEditable || manualRevealEditable || freeEditEnabled) && snapshot?.board_state) {
      if (zone === 'faceup_card') {
        const row = snapshot.board_state.tiers.find((item) => item.tier === tier);
        const current = row?.cards.find((card) => card.slot === slot);
        if (current && !current.is_placeholder) {
          const cardId = findCatalogCardId(current);
          if (cardId != null) {
            setRevealSelections((prev) => ({ ...prev, [key]: String(cardId) }));
          }
        }
      } else if (zone === 'reserved_card' && seat) {
        const player = snapshot.board_state.players.find((item) => item.seat === seat);
        const current = player?.reserved_public.find((card) => card.slot === slot);
        if (current && !current.is_placeholder) {
          const cardId = findCatalogCardId(current);
          if (cardId != null) {
            setRevealSelections((prev) => ({ ...prev, [key]: String(cardId) }));
          }
        }
      } else if (zone === 'noble') {
        const current = snapshot.board_state.nobles.find((noble) => noble.slot === slot);
        if (current && !current.is_placeholder) {
          const nobleId = findCatalogNobleId(current);
          if (nobleId != null) {
            setRevealSelections((prev) => ({ ...prev, [key]: String(nobleId) }));
          }
        }
      }
    }
    setActiveRevealKey(key);
  }

  function onModeBoardCardClick(tier: number, slot: number): void {
    if (homeView === 'ANALYSIS') {
      openReveal('faceup_card', tier, slot);
    }
  }

  function onModeBoardNobleClick(slot: number): void {
    if (homeView === 'ANALYSIS') {
      openReveal('noble', 0, slot);
    }
  }

  function onModeReservedCardClick(seat: Seat, slot: number): void {
    if (homeView !== 'ANALYSIS') {
      return;
    }
    const player = displayBoard?.players.find((item) => item.seat === seat);
    const card = player?.reserved_public.find((item) => item.slot === slot);
    const inferredTier = card ? (findCatalogCard(card)?.tier ?? null) : null;
    const candidateTier = (() => {
      const candidates = snapshot?.hidden_reserved_reveal_candidates[`${seat}:${slot}`] ?? [];
      for (const cardId of candidates) {
        const tier = catalogCards.find((item) => item.id === cardId)?.tier;
        if (tier != null) {
          return tier;
        }
      }
      return null;
    })();
    const tier = card?.tier
      ?? inferredTier
      ?? candidateTier
      ?? snapshot?.pending_reveals.find((item) => item.zone === 'reserved_card' && item.actor === seat && item.slot === slot)?.tier;
    if (tier != null) {
      openReveal('reserved_card', tier, slot, seat);
    }
  }

  const canRunCurrentSearch =
    searchSimulations >= 1 &&
    searchBootstrapSimulationsPerAction >= 1 &&
    searchEvalBatchSize >= 1 &&
    searchEvalBatchSize <= MAX_EVAL_BATCH_SIZE;
  const canRunDeepAnalysisForCurrentSearch =
    deepAnalysisSimulations >= 1 &&
    deepAnalysisBootstrapSimulationsPerAction >= 1 &&
    deepAnalysisEvalBatchSize >= 1 &&
    deepAnalysisEvalBatchSize <= MAX_EVAL_BATCH_SIZE;
  const searchSettingsSummary =
    `${searchTypeLabel('mcts_bootstrap')} | ${searchSimulations.toLocaleString()} MCTS sims | `
    + `${searchBootstrapSimulationsPerAction.toLocaleString()} bootstrap sims/action | `
    + `publish every ${analysisPublishInterval(searchSimulations).toLocaleString()} sims`;
  const activeReveal = useMemo(() => {
    if (!snapshot || !activeRevealKey) {
      return null;
    }
    const pending = snapshot.pending_reveals.find(
      (reveal) => revealKey(reveal.zone, reveal.tier, reveal.slot, reveal.actor ?? undefined) === activeRevealKey,
    );
    if (pending) {
      return pending;
    }
    const parsed = parseRevealKey(activeRevealKey);
    if (
      parsed &&
      isSetupLikeView &&
      snapshot.pending_reveals.some((reveal) => reveal.reason === 'initial_setup' || reveal.reason === 'initial_noble_setup')
    ) {
      return {
        zone: parsed.zone,
        tier: parsed.tier,
        slot: parsed.slot,
        actor: parsed.seat ?? null,
        reason: (parsed.zone === 'noble' ? 'initial_noble_setup' : 'initial_setup') as 'initial_noble_setup' | 'initial_setup',
        action_idx: null,
      };
    }
    if (parsed && parsed.zone === 'faceup_card' && snapshot.config?.manual_reveal_mode) {
      return {
        zone: parsed.zone,
        tier: parsed.tier,
        slot: parsed.slot,
        actor: null,
        reason: 'replacement_after_buy' as const,
        action_idx: null,
      };
    }
    if (parsed && parsed.zone === 'reserved_card' && parsed.seat && snapshot.config?.manual_reveal_mode) {
      return {
        zone: parsed.zone,
        tier: parsed.tier,
        slot: parsed.slot,
        actor: parsed.seat,
        reason: 'reserved_from_deck' as const,
        action_idx: null,
      };
    }
    if (parsed && parsed.zone === 'noble' && snapshot.config?.manual_reveal_mode) {
      return {
        zone: parsed.zone,
        tier: parsed.tier,
        slot: parsed.slot,
        actor: null,
        reason: 'initial_noble_setup' as const,
        action_idx: null,
      };
    }
    if (parsed && parsed.zone === 'faceup_card') {
      return {
        zone: parsed.zone,
        tier: parsed.tier,
        slot: parsed.slot,
        actor: null,
        reason: 'replacement_after_buy' as const,
        action_idx: null,
      };
    }
    if (parsed && parsed.zone === 'reserved_card' && parsed.seat) {
      return {
        zone: parsed.zone,
        tier: parsed.tier,
        slot: parsed.slot,
        actor: parsed.seat,
        reason: 'reserved_from_deck' as const,
        action_idx: null,
      };
    }
    if (parsed && parsed.zone === 'noble') {
      return {
        zone: parsed.zone,
        tier: parsed.tier,
        slot: parsed.slot,
        actor: null,
        reason: 'initial_noble_setup' as const,
        action_idx: null,
      };
    }
    return null;
  }, [snapshot, activeRevealKey, isSetupLikeView]);
  const currentMainlineMove = useMemo(() => {
    let nextMove: MoveLogEntryDTO | null = null;
    for (const move of moveLogEntries) {
      if (move.result_snapshot_index <= currentSnapshotIndex) {
        continue;
      }
      if (nextMove == null || move.result_snapshot_index < nextMove.result_snapshot_index) {
        nextMove = move;
      }
    }
    return nextMove;
  }, [moveLogEntries, currentSnapshotIndex]);
  const currentDeepAnalysisEntry = useMemo(() => {
    if (!currentMainlineMove) {
      return null;
    }
    return deepAnalysisBySnapshot[moveAnalysisKey(currentMainlineMove)]
      ?? deepAnalysisBySnapshot[String(currentMainlineMove.result_snapshot_index)]
      ?? null;
  }, [currentMainlineMove, deepAnalysisBySnapshot]);
  const currentDeepAnalysisSearch = useMemo(() => {
    return deepAnalysisSearchBySnapshot[String(currentSnapshotIndex)] ?? null;
  }, [currentSnapshotIndex, deepAnalysisSearchBySnapshot]);
  const preferredAnalysisResult = useMemo<DeepAnalysisSearchResult | EngineJobStatusDTO['result'] | null>(() => {
    return jobStatus?.result ?? currentDeepAnalysisSearch ?? null;
  }, [jobStatus, currentDeepAnalysisSearch]);
  const isBootstrapAnalysisPhase = jobStatus?.result?.search_type === 'mcts_bootstrap'
    && jobStatus.result.search_phase === 'bootstrap';
  const displayedAnalysisResult = isBootstrapAnalysisPhase ? null : preferredAnalysisResult;
  const analysisSimulationCount = jobStatus?.result?.total_simulations ?? preferredAnalysisResult?.total_simulations ?? null;
  const totalBootstrapSimulationBudget = searchBootstrapSimulationsPerAction * Math.max(1, snapshot?.legal_actions.length ?? 1);
  const displayedMctsSimulationCount = analysisSimulationCount == null
    ? searchSimulations
    : Math.max(0, analysisSimulationCount - totalBootstrapSimulationBudget);
  const analysisSimsLabel = `${searchBootstrapSimulationsPerAction.toLocaleString()} each + ${displayedMctsSimulationCount.toLocaleString()} sims`;
  const analysisEvalValue = useMemo<number | null>(() => {
    if (homeView === 'ANALYSIS') {
      return displayedAnalysisResult?.selected_action_q
        ?? displayedAnalysisResult?.root_value
        ?? currentDeepAnalysisEntry?.bestQ
        ?? null;
    }
    return jobStatus?.result?.root_value ?? null;
  }, [homeView, currentDeepAnalysisEntry, displayedAnalysisResult, jobStatus]);
  const p0EvalValue = useMemo<number | null>(() => {
    if (snapshot && snapshot.status !== 'IN_PROGRESS' && snapshot.winner >= 0) {
      return snapshot.winner === 0 ? 1 : -1;
    }
    return p0WinningEval(analysisEvalValue, snapshot?.player_to_move ?? null);
  }, [analysisEvalValue, snapshot]);
  const hasDisplayedEval = Boolean(
    snapshot
    && (
      (snapshot.status !== 'IN_PROGRESS' && snapshot.winner >= 0)
      || displayedAnalysisResult
      || (homeView === 'ANALYSIS' && currentDeepAnalysisEntry)
    ),
  );
  const displayedP0EvalValue = useAnimatedEval(p0EvalValue);
  const evalBarTopHeight = useMemo<number>(() => {
    if (displayedP0EvalValue == null || !Number.isFinite(displayedP0EvalValue)) {
      return 50;
    }
    return Math.max(0, Math.min(100, ((displayedP0EvalValue + 1) / 2) * 100));
  }, [displayedP0EvalValue]);
  const evalBarBottomHeight = 100 - evalBarTopHeight;
  const evalBarLabel = useMemo(() => formatEvalBarValue(displayedP0EvalValue), [displayedP0EvalValue]);
  const evalBarSide = useMemo<'white' | 'black' | 'neutral'>(() => {
    if (displayedP0EvalValue == null || !Number.isFinite(displayedP0EvalValue) || displayedP0EvalValue === 0) {
      return 'neutral';
    }
    return displayedP0EvalValue > 0 ? 'white' : 'black';
  }, [displayedP0EvalValue]);
  const topAnalysisMoves = useMemo(() => {
    if (snapshot?.status !== 'IN_PROGRESS') {
      return [];
    }
    const details = displayedAnalysisResult?.action_details ?? [];
    return details
      .filter((detail) => !detail.masked)
      .slice()
      .sort((a, b) => {
        if (b.policy_prob !== a.policy_prob) return b.policy_prob - a.policy_prob;
        return a.action_idx - b.action_idx;
      });
  }, [displayedAnalysisResult, snapshot?.status]);
  const playedAnalysisMove = useMemo(() => {
    if (!currentDeepAnalysisEntry) {
      return null;
    }
    const details = displayedAnalysisResult?.action_details ?? [];
    return details.find((detail) => detail.action_idx === currentDeepAnalysisEntry.playedActionIdx) ?? null;
  }, [currentDeepAnalysisEntry, displayedAnalysisResult]);
  const allAnalysisMoves = useMemo(() => {
    if (uiStatus === 'WAITING_REVEAL') {
      return [];
    }
    const legalDetails = snapshot?.legal_action_details ?? [];
    if (!showBoardAnalysis) {
      return legalDetails
        .slice()
        .sort((a, b) => a.action_idx - b.action_idx);
    }

    const rankedDetails = displayedAnalysisResult?.action_details ?? [];
    const scoreByAction = new Map<number, number>();
    rankedDetails.forEach((detail) => {
      if (!detail.masked) {
        scoreByAction.set(detail.action_idx, detail.policy_prob);
      }
    });

    return legalDetails
      .slice()
      .sort((a, b) => {
        const scoreA = scoreByAction.get(a.action_idx);
        const scoreB = scoreByAction.get(b.action_idx);
        if (scoreA != null && scoreB != null && scoreA !== scoreB) {
          return scoreB - scoreA;
        }
        if (scoreA != null) {
          return -1;
        }
        if (scoreB != null) {
          return 1;
        }
        return a.action_idx - b.action_idx;
      });
  }, [displayedAnalysisResult, showBoardAnalysis, snapshot, uiStatus]);
  const groupedAnalysisMoves = useMemo<AnalysisMoveGroup[]>(() => {
    const groups: Record<string, ActionInfoDTO[]> = {
      buy_t1: [],
      buy_t2: [],
      buy_t3: [],
      buy_reserved: [],
      reserve_t1: [],
      reserve_t2: [],
      reserve_t3: [],
      take: [],
      return: [],
      noble: [],
      other: [],
    };
    for (const detail of allAnalysisMoves) {
      const idx = detail.action_idx;
      const classified = classifyAction(idx);
      if (classified.kind === 'buyFaceup') {
        groups[`buy_t${classified.tier}`].push(detail);
      } else if (isBuyReservedAction(idx)) {
        groups.buy_reserved.push(detail);
      } else if (classified.kind === 'reserveFaceup') {
        groups[`reserve_t${classified.tier}`].push(detail);
      } else if (classified.kind === 'reserveDeck') {
        groups[`reserve_t${classified.tier}`].push(detail);
      } else if (isTake3Action(idx) || isTake2SameAction(idx) || isTake2Action(idx) || isTake1Action(idx)) {
        groups.take.push(detail);
      } else if (isReturnAction(idx)) {
        groups.return.push(detail);
      } else if (isNobleAction(idx)) {
        groups.noble.push(detail);
      } else {
        groups.other.push(detail);
      }
    }
    const moveRank = (detail: ActionInfoDTO): number => {
      const classified = classifyAction(detail.action_idx);
      if (classified.kind === 'buyFaceup' || classified.kind === 'reserveFaceup') {
        return classified.slot;
      }
      if (classified.kind === 'reserveDeck') {
        return 4;
      }
      if (classified.kind === 'buyReserved') {
        return classified.slot;
      }
      return detail.action_idx;
    };
    Object.values(groups).forEach((moves) => {
      moves.sort((a, b) => moveRank(a) - moveRank(b) || a.action_idx - b.action_idx);
    });
    return [
      {
        key: 'buy',
        label: MOVE_GROUP_LABELS.buy,
        hideVerb: true,
        columns: [
          { key: 'buy_t1', label: 'Tier 1', moves: groups.buy_t1 },
          { key: 'buy_t2', label: 'Tier 2', moves: groups.buy_t2 },
          { key: 'buy_t3', label: 'Tier 3', moves: groups.buy_t3 },
          { key: 'buy_reserved', label: 'Reserved', moves: groups.buy_reserved },
        ],
      },
      {
        key: 'reserve',
        label: MOVE_GROUP_LABELS.reserve,
        hideVerb: true,
        columns: [
          { key: 'reserve_t1', label: 'Tier 1', moves: groups.reserve_t1 },
          { key: 'reserve_t2', label: 'Tier 2', moves: groups.reserve_t2 },
          { key: 'reserve_t3', label: 'Tier 3', moves: groups.reserve_t3 },
        ],
      },
      { key: 'take', label: MOVE_GROUP_LABELS.take, moves: groups.take, hideVerb: true },
      { key: 'return', label: MOVE_GROUP_LABELS.return, moves: groups.return, hideVerb: true },
      { key: 'noble', label: MOVE_GROUP_LABELS.noble, moves: groups.noble, hideVerb: true },
      { key: 'other', label: MOVE_GROUP_LABELS.other, moves: groups.other, hideVerb: false },
    ]
      .map((group) => group.columns
        ? { ...group, columns: group.columns.filter((column) => column.moves.length > 0) }
        : group)
      .filter((group) => group.columns ? group.columns.length > 0 : (group.moves?.length ?? 0) > 0);
  }, [allAnalysisMoves]);
  const movesEmptyMessage = useMemo(() => {
    if (snapshot?.status !== 'IN_PROGRESS') {
      const winner = winnerLabel(snapshot);
      return winner ? `Game over · ${winner} is victorious` : 'Game over';
    }
    if (uiStatus === 'WAITING_REVEAL' || snapshot.pending_reveals.some((reveal) => isBlockingPendingReveal(reveal))) {
      return 'Waiting for setup...';
    }
    return 'Waiting for search...';
  }, [snapshot, uiStatus]);
  const isMovesGameOverMessage = snapshot?.status !== 'IN_PROGRESS';
  const isQuickBotThinking = homeView === 'QUICK' && uiStatus === 'WAITING_ENGINE';
  const displayBoard = useMemo(() => {
    if (!snapshot?.board_state) {
      return null;
    }
    const board: BoardStateDTO = structuredClone(snapshot.board_state);
    const pendingByKey = new Set(snapshot.pending_reveals.map((reveal) => revealKey(reveal.zone, reveal.tier, reveal.slot)));

    board.players = board.players.map((player) => {
      if (snapshot.config && !snapshot.config.analysis_mode) {
        return {
          ...player,
          display_name: player.seat === snapshot.config.player_seat ? 'You' : 'AhinLendor',
          role_label: player.display_name,
        };
      }
      const overrideName = loadedPlayerNames?.[player.seat];
      if (!overrideName) {
        return player;
      }
      return {
        ...player,
        display_name: overrideName,
      };
    }) as BoardStateDTO['players'];

    board.tiers = board.tiers.map((tier) => {
      const bySlot = new Map(tier.cards.map((card) => [card.slot ?? -1, card]));
      const cards = Array.from({ length: 4 }, (_, slot) => {
        const key = revealKey('faceup_card', tier.tier, slot);
        if (pendingByKey.has(key)) {
          return {
            points: 0,
            bonus_color: 'white',
            cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
            source: 'faceup' as const,
            tier: tier.tier,
            slot,
            is_placeholder: true,
          };
        }
        return bySlot.get(slot) ?? {
          points: 0,
          bonus_color: 'white',
          cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
          source: 'faceup' as const,
          tier: tier.tier,
          slot,
          is_placeholder: true,
        };
      });
      return { ...tier, cards };
    }) as BoardStateDTO['tiers'];

    const nobleBySlot = new Map((board.nobles ?? []).map((noble) => [noble.slot ?? -1, noble]));
    board.nobles = Array.from({ length: 3 }, (_, slot) => {
      const key = revealKey('noble', 0, slot);
      if (pendingByKey.has(key)) {
        return {
          points: 0,
          requirements: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
          slot,
          is_placeholder: true,
        };
      }
      return nobleBySlot.get(slot) ?? null;
    }).filter((noble): noble is NonNullable<typeof noble> => noble != null) as BoardStateDTO['nobles'];

    return board;
  }, [snapshot, activeRevealKey, loadedPlayerNames]);
  const activeTierBoardCards = useMemo(() => {
    if (!activeReveal || activeReveal.zone !== 'faceup_card' || !displayBoard) {
      return [] as BoardStateDTO['tiers'][number]['cards'];
    }
    return displayBoard.tiers.find((tier) => tier.tier === activeReveal.tier)?.cards ?? [];
  }, [activeReveal, displayBoard]);
  const activeBoardNobles = useMemo(() => {
    if (!activeReveal || activeReveal.zone !== 'noble' || !displayBoard) {
      return [] as BoardStateDTO['nobles'];
    }
    return displayBoard.nobles ?? [];
  }, [activeReveal, displayBoard]);
  const setupUnavailableCardIds = useMemo(() => {
    if (!activeReveal || activeReveal.zone !== 'faceup_card' || !isSetupLikeView || activeReveal.reason !== 'initial_setup' || !displayBoard) {
      return new Set<number>();
    }
    const ids = new Set<number>();
    const cards = displayBoard.tiers.find((tier) => tier.tier === activeReveal.tier)?.cards ?? [];
    for (const card of cards) {
      if (card.is_placeholder) {
        continue;
      }
      const id = findCatalogCardId(card);
      if (id != null) {
        ids.add(id);
      }
    }
    return ids;
  }, [activeReveal, isSetupLikeView, displayBoard, catalogCards]);
  const occupiedBoardCardIds = useMemo(() => {
    if (!activeReveal || activeReveal.zone !== 'faceup_card' || !displayBoard) {
      return new Set<number>();
    }
    const ids = new Set<number>();
    const cards = displayBoard.tiers.find((tier) => tier.tier === activeReveal.tier)?.cards ?? [];
    for (const card of cards) {
      if (card.is_placeholder) {
        continue;
      }
      const id = findCatalogCardId(card);
      if (id != null) {
        ids.add(id);
      }
    }
    return ids;
  }, [activeReveal, displayBoard, catalogCards]);
  const setupUnavailableNobleIds = useMemo(() => {
    if (!activeReveal || activeReveal.zone !== 'noble' || !isSetupLikeView || activeReveal.reason !== 'initial_noble_setup' || !displayBoard) {
      return new Set<number>();
    }
    const ids = new Set<number>();
    for (const noble of displayBoard.nobles) {
      if (noble.is_placeholder) {
        continue;
      }
      const id = findCatalogNobleId(noble);
      if (id != null) {
        ids.add(id);
      }
    }
    return ids;
  }, [activeReveal, isSetupLikeView, displayBoard, catalogNobles]);
  const availableRevealCardIds = useMemo(() => {
    if (!activeReveal || !snapshot) {
      return new Set<number>();
    }
    if (activeReveal.zone === 'faceup_card') {
      const pendingKey = `${activeReveal.tier}:${activeReveal.slot}`;
      const hasPendingFaceupReveal = snapshot.pending_reveals.some(
        (reveal) =>
          reveal.zone === 'faceup_card' &&
          reveal.tier === activeReveal.tier &&
          reveal.slot === activeReveal.slot,
      );
      const ids = new Set<number>(
        hasPendingFaceupReveal
          ? (snapshot.hidden_faceup_reveal_candidates[pendingKey] ?? [])
          : (snapshot.hidden_deck_card_ids_by_tier[activeReveal.tier] ?? []),
      );
      return ids;
    }
    if (activeReveal.zone === 'reserved_card' && activeReveal.actor) {
      const ids = new Set(snapshot.hidden_reserved_reveal_candidates[`${activeReveal.actor}:${activeReveal.slot}`] ?? []);
      for (const cardId of snapshot.hidden_deck_card_ids_by_tier[activeReveal.tier] ?? []) {
        ids.add(cardId);
      }
      const player = displayBoard?.players.find((item) => item.seat === activeReveal.actor);
      const current = player?.reserved_public.find((item) => item.slot === activeReveal.slot);
      if (current && !current.is_placeholder) {
        const id = findCatalogCardId(current);
        if (id != null) {
          ids.add(id);
        }
      }
      return ids;
    }
    return new Set<number>();
  }, [activeReveal, snapshot, displayBoard, catalogCards]);
  const hasPendingFaceupReveal = useMemo(() => {
    if (!activeReveal || activeReveal.zone !== 'faceup_card' || !snapshot) {
      return false;
    }
    return snapshot.pending_reveals.some(
      (reveal) => reveal.zone === 'faceup_card' && reveal.tier === activeReveal.tier && reveal.slot === activeReveal.slot,
    );
  }, [activeReveal, snapshot]);
  useEffect(() => {
    if (!showAnalysisSettings) {
      return undefined;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (analysisSettingsRef.current && !analysisSettingsRef.current.contains(event.target as Node)) {
        setShowAnalysisSettings(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [showAnalysisSettings]);

  useEffect(() => {
    const container = moveLogGridRef.current;
    if (!container || moveLogEntries.length === 0) {
      return;
    }
    let frameId = 0;
    frameId = window.requestAnimationFrame(() => {
      if (currentSnapshotIndex <= 0 && highlightedVariation == null) {
        container.scrollTop = 0;
        return;
      }
      const activeElements = Array.from(
        container.querySelectorAll<HTMLElement>('.move-log-btn.active, .move-log-deviation-btn.active'),
      );
      const target = activeElements.length > 0 ? activeElements[activeElements.length - 1] : null;
      if (!target) {
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const pad = 6;
      const visibleTop = containerRect.top + pad;
      const visibleBottom = containerRect.bottom - pad;

      if (targetRect.top < visibleTop) {
        container.scrollTop -= (visibleTop - targetRect.top);
        return;
      }
      if (targetRect.bottom > visibleBottom) {
        container.scrollTop += (targetRect.bottom - visibleBottom);
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    currentSnapshotIndex,
    highlightedVariation,
    moveLogEntries.length,
    moveLogRows.length,
    showBoardAnalysis,
    topAnalysisMoves.length,
  ]);

  useEffect(() => {
    const keyboardNavigationEnabled = homeView === 'QUICK' || homeView === 'ANALYSIS' || isSetupLikeView;
    const activeSnapshot = snapshot;
    if (!activeSnapshot || !keyboardNavigationEnabled || moveLogEntries.length === 0 || isDeepAnalysisRunning) {
      return;
    }
    const snapshotForKeys: GameSnapshotDTO = activeSnapshot;
    const isLoadedMainlineExtensionState =
      loadedHistoricalMainlineLengthRef.current > 0 &&
      snapshotForKeys.current_snapshot_index == null &&
      currentSnapshotIndex > loadedHistoricalMainlineTailSnapshotRef.current;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.tagName === 'SELECT'
          || target.isContentEditable)
      ) {
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (snapshotForKeys.current_snapshot_index == null && !isLoadedMainlineExtensionState) {
          void onJumpToTurn(0, false, false);
          return;
        }
        void onJumpToSnapshot(0, false, false, false);
        return;
      }

      if (event.key === 'ArrowDown') {
        const useTurnNavigation = snapshotForKeys.current_snapshot_index == null && !isLoadedMainlineExtensionState;
        const finalSnapshotIndex = useTurnNavigation
          ? (mainlineMoveTurnIndices.length > 0 ? mainlineMoveTurnIndices[mainlineMoveTurnIndices.length - 1] : 0)
          : (mainlineMoveSnapshotIndices.length > 0 ? mainlineMoveSnapshotIndices[mainlineMoveSnapshotIndices.length - 1] : 0);
        event.preventDefault();
        if (useTurnNavigation) {
          void onJumpToTurn(finalSnapshotIndex, false, false);
          return;
        }
        if (
          loadedHistoricalMainlineLengthRef.current > 0 &&
          finalSnapshotIndex > loadedHistoricalMainlineTailSnapshotRef.current
        ) {
          void onJumpToLoadedMainlineExtension(finalSnapshotIndex, false);
          return;
        }
        void onJumpToSnapshot(finalSnapshotIndex, false, false, false);
        return;
      }

      const delta: -1 | 1 = event.key === 'ArrowLeft' ? -1 : 1;

      event.preventDefault();
      void onStepMainline(delta, false);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    snapshot,
    homeView,
    isSetupLikeView,
    moveLogEntries.length,
    isDeepAnalysisRunning,
    mainlineMoveSnapshotIndices,
    mainlineMoveTurnIndices,
    currentSnapshotIndex,
  ]);

  useEffect(() => {
    if (!hideAllExceptBoard) {
      return;
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Enter') {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setHideAllExceptBoard(false);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [hideAllExceptBoard]);

  const isBoardView = (homeView === 'QUICK' || isSetupLikeView) && snapshot;

  function replayFileStem(rawName: string | null, replay: GameReplayDTO): string {
    const fallback = `ahinlendor-${replay.game_id || 'replay'}`;
    const trimmed = rawName?.trim() ?? '';
    const baseName = trimmed.length > 0 ? trimmed : fallback;
    const sanitized = baseName
      .replace(/\.(sgr\.)?json$/i, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '');
    return sanitized || fallback;
  }

  function downloadReplayJson(replay: GameReplayDTO, requestedName: string | null): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blob = new Blob([JSON.stringify(replay, null, 2)], { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = `${replayFileStem(requestedName, replay)}-${timestamp}.sgr.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(downloadUrl);
    }
  }

  async function onSaveReplay(): Promise<void> {
    if (!snapshot) {
      setError('No analysis game is available to save.');
      return;
    }
    setIsReplaySaving(true);
    setError(null);
    try {
      const replay = await fetchJSON<GameReplayDTO>('/api/game/replay');
      const requestedName = window.prompt('Name this replay', `ahinlendor-${replay.game_id || 'replay'}`);
      if (requestedName === null) {
        return;
      }
      downloadReplayJson(replay, requestedName);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsReplaySaving(false);
    }
  }

  function requestReplayLoad(): void {
    replayFileInputRef.current?.click();
  }

  async function onReplayFileSelected(file: File | null): Promise<void> {
    if (!file) {
      return;
    }
    setIsReplayLoading(true);
    setError(null);
    clearPolling();
    setJobStatus(null);
    try {
      const replay = JSON.parse(await file.text()) as GameReplayDTO;
      const nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/replay/load', {
        method: 'POST',
        body: JSON.stringify(replay),
      });
      setAnalysisEntryPromptDone(true);
      setHomeView('ANALYSIS');
      setRevealSelections({});
      setActiveRevealKey(null);
      setLoadedMoveLog(null);
      loadedHistoricalMainlineLengthRef.current = 0;
      loadedHistoricalMainlineTailSnapshotRef.current = 0;
      setLoadedPlayerNames({
        P0: replay.players?.P0?.name ?? 'Player 1',
        P1: replay.players?.P1?.name ?? 'Player 2',
      });
      setVariationBranches([]);
      setDeepAnalysisBySnapshot({});
      setDeepAnalysisSearchBySnapshot({});
      analysisSearchByPositionRef.current = {};
      setIsLoadedPostAnalysisGame(true);
      setDeepAnalysisProgress(null);
      setIsDeepAnalysisRunning(false);
      clearActiveVariationSelection();
      lastAutoAnalyzeKeyRef.current = null;
      await handleSnapshotUpdate(nextSnapshot, false, null, false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsReplayLoading(false);
      if (replayFileInputRef.current) {
        replayFileInputRef.current.value = '';
      }
    }
  }

  function renderMoveContent(move: MoveLogDisplayEntry): ReactElement {
    const parts = move.label.split(' + ').filter((part) => part.length > 0);
    const extras = parts.slice(1);
    return (
      <span className="action-label">
        <ActionLabel actionIdx={move.action_idx} display={move.display ?? null} board={displayBoard ?? snapshot?.board_state ?? null} />
        {extras.map((part, idx) => (
          <span key={`${move.result_snapshot_index}-extra-${idx}`} className="action-meta">{` + ${part}`}</span>
        ))}
      </span>
    );
  }

  function renderMoveLabel(move: MoveLogDisplayEntry | undefined): ReactElement | string {
    if (!move) {
      return '-';
    }
    const entry = deepAnalysisBySnapshot[moveAnalysisKey(move)]
      ?? deepAnalysisBySnapshot[String(move.result_snapshot_index)];
    if (!entry || !shouldShowDeepAnalysisBadge(entry)) {
      return renderMoveContent(move);
    }
    const categoryClass = entry.category.toLowerCase();
    return (
      <span className="move-log-label-wrap">
        <span className="move-log-label-main">
          {renderMoveContent(move)}
        </span>
        <span
          className={`deep-analysis-badge ${categoryClass}`}
          aria-label={entry.category}
          title={entry.category}
        >
          <span aria-hidden="true">{deepAnalysisBadgeSymbol(entry)}</span>
        </span>
      </span>
    );
  }
  return (
    <main className={`app-shell ${isBoardView ? 'app-shell-board' : ''} ${hideAllExceptBoard ? 'board-only-mode' : ''}`}>
      <input
        ref={replayFileInputRef}
        type="file"
        accept=".sgr,.json,.sgr.json,application/json"
        className="replay-file-input"
        onChange={(event) => void onReplayFileSelected(event.target.files?.[0] ?? null)}
      />
      {!hideAllExceptBoard && (
        <TopNav
          alphabetaDepth={alphabetaDepth}
          deepAnalysisBootstrapSimulationsPerAction={deepAnalysisBootstrapSimulationsPerAction}
          deepAnalysisProgress={deepAnalysisProgress}
          deepAnalysisSimulations={deepAnalysisSimulations}
          homeView={homeView}
          isDeepAnalysisRunning={isDeepAnalysisRunning}
          canRunDeepAnalysis={canRunDeepAnalysisForCurrentSearch}
          moveCount={moveLogEntries.length}
          onOpenAbout={onOpenAboutView}
          onOpenAnalysis={onOpenManualView}
          onOpenHome={onOpenHomeView}
          onOpenQuick={onOpenQuickView}
          onRunDeepAnalysis={() => void onRunDeepAnalysis()}
          searchType={searchType}
          snapshotPresent={Boolean(snapshot)}
        />
      )}

      {homeView === 'HOME' && (
        <HomePage
          onOpenAbout={onOpenAboutView}
          onOpenAnalysis={onOpenManualView}
          onStartQuick={(seat) => void onStartQuickFromHome(seat)}
        />
      )}

      {homeView === 'ANALYSIS' && !snapshot && !analysisEntryPromptDone && (
        <section className="panel loading-panel analysis-entry-panel">
          <h2>Analysis</h2>
          <p>Start a new analysis board or load an existing replay.</p>
          <div className="analysis-entry-actions">
            <button type="button" onClick={() => void startAnalysisGame()} disabled={isAutoStartingGame || isReplayLoading}>
              New analysis
            </button>
            <button type="button" className="secondary-button" onClick={requestReplayLoad} disabled={isAutoStartingGame || isReplayLoading}>
              {isReplayLoading ? 'Loading...' : 'Load replay'}
            </button>
          </div>
        </section>
      )}

      {homeView === 'QUICK' && !snapshot && !quickEntryPromptDone && (
        <section className="panel loading-panel analysis-entry-panel">
          <h2>Quick Game</h2>
          <p>Play vs AhinLendor from a random opening. Choose whether to play first or second.</p>
          <div className="analysis-entry-actions quick-seat-actions">
            <button type="button" className="quick-seat-button" onClick={() => void startQuickGame('P0')} disabled={isAutoStartingGame}>
              Play as Player 1
            </button>
            <button type="button" className="quick-seat-button" onClick={() => void startQuickGame('P1')} disabled={isAutoStartingGame}>
              Play as Player 2
            </button>
          </div>
        </section>
      )}

      {(homeView === 'QUICK' || isSetupLikeView) && !snapshot && (homeView !== 'ANALYSIS' || analysisEntryPromptDone) && (homeView !== 'QUICK' || quickEntryPromptDone) && (
        <section className="panel loading-panel">
          <h2>{homeView === 'QUICK' ? 'Quick Game' : 'Analysis'}</h2>
          <p>{isReplayLoading ? 'Loading replay...' : (isAutoStartingGame ? 'Loading board...' : 'Preparing board...')}</p>
        </section>
      )}

      {homeView === 'ABOUT' && <AboutPage />}

      {isBoardView && (
        <section className={`panel game-layout ${hideAllExceptBoard ? 'board-only-mode' : ''}`}>
          <div className="board-column">
            <BoardViewport
              showEvaluation={showAnalysisUi && showBoardAnalysis && !hideAllExceptBoard}
              evalBarTopHeight={evalBarTopHeight}
              evalBarBottomHeight={evalBarBottomHeight}
              evalLabel={hasDisplayedEval ? evalBarLabel : null}
              evalSide={evalBarSide}
              evalUnresolved={!hasDisplayedEval}
            >
                {displayBoard ? (
                  <GameBoard
                    board={displayBoard}
                    isTerminal={snapshot.status !== 'IN_PROGRESS'}
                    onCardClick={onModeBoardCardClick}
                    onNobleClick={onModeBoardNobleClick}
                    onReservedCardClick={onModeReservedCardClick}
                  />
                ) : (
                  <div className="empty-note">Board data unavailable</div>
                )}
            </BoardViewport>
          </div>

          {!hideAllExceptBoard && (
          <aside className="engine-column">
            <div className="engine-box">
              <div className="analysis-panel-tabs" role="tablist" aria-label="Analysis panel sections">
                {showAnalysisUi && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activePanelTab === 'ANALYSIS'}
                    className={`analysis-panel-tab ${activePanelTab === 'ANALYSIS' ? 'active' : ''}`}
                    onClick={() => setAnalysisPanelTab('ANALYSIS')}
                  >
                    <span>Analysis</span>
                  </button>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={activePanelTab === 'MOVES'}
                  className={`analysis-panel-tab ${activePanelTab === 'MOVES' ? 'active' : ''}`}
                  onClick={() => setAnalysisPanelTab('MOVES')}
                >
                  <span>Moves</span>
                </button>
              </div>
              {activePanelTab === 'ANALYSIS' && (
                <div className="analysis-controls-row">
	                <label className="analysis-toggle">
	                  <input
	                    type="checkbox"
	                    checked={showBoardAnalysis}
	                    onChange={(event) => setShowBoardAnalysis(event.target.checked)}
	                  />
	                  <span>Analysis</span>
	                </label>
	                <div className="replay-actions">
	                  <button type="button" className="secondary-button replay-action-btn" onClick={() => void onSaveReplay()} disabled={!snapshot || isReplaySaving}>
	                    {isReplaySaving ? 'Saving...' : 'Save'}
	                  </button>
	                  <button type="button" className="secondary-button replay-action-btn" onClick={requestReplayLoad} disabled={isReplayLoading}>
	                    {isReplayLoading ? 'Loading...' : 'Load'}
	                  </button>
	                </div>
	                <div className="analysis-settings-wrap" ref={analysisSettingsRef}>
                  <button
                    type="button"
                    className={`analysis-settings-btn ${showAnalysisSettings ? 'active' : ''}`}
                    title={searchSettingsSummary}
                    aria-expanded={showAnalysisSettings}
                    aria-haspopup="dialog"
                    onClick={() => setShowAnalysisSettings((value) => !value)}
                  >
                    <span className="analysis-settings-icon" aria-hidden="true">⚙</span>
                  </button>
	                  {showAnalysisSettings && (
	                    <div className="analysis-settings-popover" role="dialog" aria-label="Analysis settings">
	                      <label className="analysis-settings-field">
	                        <span>MCTS sims</span>
	                        <input
	                          type="number"
	                          min={1}
	                          max={MAX_SEARCH_SIMULATIONS}
	                          value={searchSimulations}
	                          onChange={(event) => setSearchSimulations(Number(event.target.value))}
	                          aria-label="MCTS simulations"
	                        />
	                      </label>
	                      <label className="analysis-settings-field">
	                        <span>Bootstrap sims</span>
	                        <input
	                          type="number"
	                          min={1}
	                          max={MAX_SEARCH_SIMULATIONS}
	                          value={searchBootstrapSimulationsPerAction}
	                          onChange={(event) => setSearchBootstrapSimulationsPerAction(Number(event.target.value))}
	                          aria-label="Bootstrap simulations"
	                        />
	                      </label>
	                      <button
	                        type="button"
	                        className="analysis-settings-run-btn"
	                        onClick={() => {
	                          void startEngineThink({ searchTypeOverride: 'mcts_bootstrap' });
	                          setShowAnalysisSettings(false);
	                        }}
	                        disabled={!canRunCurrentSearch || uiStatus === 'WAITING_ENGINE'}
	                      >
	                        Run Search
	                      </button>
	                    </div>
	                  )}
                </div>
                </div>
              )}
              {activePanelTab === 'MOVES' && showAnalysisUi && (
                <div className="analysis-controls-row">
	                  <label className="analysis-toggle">
	                    <input
	                      type="checkbox"
	                      checked={showBoardAnalysis}
	                      onChange={(event) => setShowBoardAnalysis(event.target.checked)}
	                    />
	                    <span>Analysis</span>
	                  </label>
	                  <div className="replay-actions">
	                    <button type="button" className="secondary-button replay-action-btn" onClick={() => void onSaveReplay()} disabled={!snapshot || isReplaySaving}>
	                      {isReplaySaving ? 'Saving...' : 'Save'}
	                    </button>
	                    <button type="button" className="secondary-button replay-action-btn" onClick={requestReplayLoad} disabled={isReplayLoading}>
	                      {isReplayLoading ? 'Loading...' : 'Load'}
	                    </button>
	                  </div>
	                </div>
              )}
              {jobStatus?.error && <p className="error">Engine error: {jobStatus.error}</p>}
              <div className="analysis-panel-body">
                {activePanelTab === 'ANALYSIS' && showBoardAnalysis && (
                  <div className="analysis-lines" role="list">
                      {currentDeepAnalysisEntry && (
                        <div className="analysis-played-block">
                          <div className="analysis-section-header">Move played</div>
                          <div className="analysis-line" role="listitem">
                            <div className="analysis-line-stats">
                              <span
                                className={`analysis-line-q ${topMoveEvalClass(
                                  p0WinningEval(currentDeepAnalysisEntry.playedQ, snapshot?.player_to_move ?? null),
                                )}`}
                              >
                                {formatTopMoveEval(
                                  p0WinningEval(currentDeepAnalysisEntry.playedQ, snapshot?.player_to_move ?? null),
                                )}
                              </span>
                              <span className="analysis-line-visit analysis-line-visit-placeholder" aria-hidden="true">
                                --
                              </span>
                            </div>
                            <div className="analysis-line-name">
                              {playedAnalysisMove
                                ? (
                                    <ActionLabel
                                      actionIdx={playedAnalysisMove.action_idx}
                                      display={playedAnalysisMove.display ?? null}
                                      board={displayBoard ?? snapshot?.board_state ?? null}
                                    />
                                  )
                                : currentDeepAnalysisEntry.playedActionIdx}
                            </div>
                          </div>
                        </div>
                      )}
                      {snapshot?.status === 'IN_PROGRESS' && (
                        <>
                          <div className="analysis-section-header analysis-section-header-row">
                            <span>Top moves</span>
                            <span className="analysis-sims-count">{analysisSimsLabel}</span>
                          </div>
                          <div className="analysis-top-moves-list" role="list">
                          {topAnalysisMoves.length === 0 ? (
                            <div className="thinking-status" role="listitem">
                              {uiStatus === 'WAITING_REVEAL' ? (
                                'Waiting for setup...'
                              ) : isBootstrapAnalysisPhase || uiStatus === 'WAITING_ENGINE' ? (
                                <>
                                  Analyzing<span className="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
                                </>
                              ) : (
                                'Waiting for search...'
                              )}
                            </div>
                          ) : topAnalysisMoves.map((detail) => {
                            const absoluteEval = detail
                              ? p0WinningEval(detail.q_value, snapshot?.player_to_move ?? null)
                              : null;
                            const evalClass = topMoveEvalClass(absoluteEval);
                            return (
                              <button
                                key={`analysis-line-${detail.action_idx}`}
                                type="button"
                                className="analysis-line analysis-line-button"
                                role="listitem"
                                disabled={!canSubmitPlayerMove(snapshot)}
                                onClick={() => {
                                  void onSelectModeAction(detail.action_idx);
                                }}
                              >
                                <div className="analysis-line-stats">
                                  <span className={`analysis-line-q ${evalClass}`}>
                                    {formatTopMoveEval(absoluteEval)}
                                  </span>
                                </div>
                                <div className="analysis-line-name">
                                  <ActionLabel
                                    actionIdx={detail.action_idx}
                                    display={detail.display ?? null}
                                    board={displayBoard ?? snapshot?.board_state ?? null}
                                  />
                                </div>
                              </button>
                            );
                          })}
                          </div>
                        </>
                      )}
                      {snapshot?.status !== 'IN_PROGRESS' && (
                        <div className="analysis-line analysis-panel-empty analysis-panel-game-over" role="listitem">
                          {movesEmptyMessage}
                        </div>
                      )}
                  </div>
                )}
                {activePanelTab === 'MOVES' && (
                  <div className="analysis-move-groups" role="list">
                    {isQuickBotThinking ? (
                      <div className="thinking-status quick-thinking-status" role="listitem">
                        AhinLendor is thinking<span className="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
                      </div>
                    ) : uiStatus === 'WAITING_REVEAL' ? null : allAnalysisMoves.length === 0 ? (
                      <div
                        className={`analysis-line analysis-panel-empty ${isMovesGameOverMessage ? 'analysis-panel-game-over' : 'placeholder'}`}
                        role="listitem"
                      >
                        {movesEmptyMessage}
                      </div>
                    ) : (
                      groupedAnalysisMoves.map((group) => (
                        <section key={`move-group-${group.key}`} className={`analysis-move-group analysis-move-group-${group.key}`} aria-label={`${group.label} moves`}>
                          <div className="analysis-move-group-title">{group.label}</div>
                          {group.columns ? (
                            <div className="analysis-move-columns">
                              {group.columns.map((column) => (
                                <div key={`move-column-${column.key}`} className="analysis-move-column">
                                  <div className="analysis-move-column-title">{column.label}</div>
                                  <div className="analysis-moves-list" role="list">
                                    {column.moves.map((detail) => (
                                      <button
                                        key={`analysis-move-${detail.action_idx}`}
                                        type="button"
                                        className="analysis-line analysis-line-button analysis-line-move-only"
                                        role="listitem"
                                        disabled={!canSubmitPlayerMove(snapshot)}
                                        onClick={() => {
                                          void onSelectModeAction(detail.action_idx);
                                        }}
                                      >
                                        <div className="analysis-line-name">
                                          <ActionLabel
                                            actionIdx={detail.action_idx}
                                            display={detail.display ?? null}
                                            board={displayBoard ?? snapshot?.board_state ?? null}
                                            hideVerb={group.hideVerb}
                                          />
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="analysis-moves-list" role="list">
                              {(group.moves ?? []).map((detail) => {
                                return (
                                  <button
                                    key={`analysis-move-${detail.action_idx}`}
                                    type="button"
                                    className="analysis-line analysis-line-button analysis-line-move-only"
                                    role="listitem"
                                    disabled={!canSubmitPlayerMove(snapshot)}
                                    onClick={() => {
                                      void onSelectModeAction(detail.action_idx);
                                    }}
                                  >
                                    <div className="analysis-line-name">
                                      <ActionLabel
                                        actionIdx={detail.action_idx}
                                        display={detail.display ?? null}
                                        board={displayBoard ?? snapshot?.board_state ?? null}
                                        hideVerb={group.hideVerb}
                                      />
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </section>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="move-log-wrap">
              <div className="move-log-title-grid" aria-hidden="true">
                <span>#</span>
                <span>P1</span>
                <span>P2</span>
              </div>
              {moveLogEntries.length === 0 ? (
                <p className="empty-note">No moves yet.</p>
              ) : (
                <div className="move-log-grid" role="list" ref={moveLogGridRef}>
                  {moveLogTokens.map((token, tokenIdx) => {
                    if (token.kind === 'mainline_row') {
                      const { row, rowIdx } = token;
                      const p0Snap = row.p0?.result_snapshot_index ?? null;
                      const p1Snap = row.p1?.result_snapshot_index ?? null;
                      return (
                        <div key={`ml-${row.moveNumberLabel}-${rowIdx}`} className="move-log-row" role="listitem">
                          <div className="move-log-number">{row.moveNumberLabel}.</div>
                          <button
                            type="button"
                            className={`move-log-btn${isHighlightedMainlineMove(row.p0) ? ' active' : ''}`}
                            disabled={p0Snap == null || isHighlightedMainlineMove(row.p0)}
                            onClick={() => {
                              if (p0Snap != null) {
                                const isExt = loadedHistoricalMainlineLengthRef.current > 0 && p0Snap > loadedHistoricalMainlineTailSnapshotRef.current;
                                void (isExt
                                  ? onJumpToLoadedMainlineExtension(p0Snap, !autoAnalyzeOnNavigation)
                                  : onJumpToSnapshot(p0Snap, false, !autoAnalyzeOnNavigation));
                              }
                            }}
                          >
                            {renderMoveLabel(row.p0)}
                          </button>
                          <button
                            type="button"
                            className={`move-log-btn${isHighlightedMainlineMove(row.p1) ? ' active' : ''}`}
                            disabled={p1Snap == null || isHighlightedMainlineMove(row.p1)}
                            onClick={() => {
                              if (p1Snap != null) {
                                const isExt = loadedHistoricalMainlineLengthRef.current > 0 && p1Snap > loadedHistoricalMainlineTailSnapshotRef.current;
                                void (isExt
                                  ? onJumpToLoadedMainlineExtension(p1Snap, !autoAnalyzeOnNavigation)
                                  : onJumpToSnapshot(p1Snap, false, !autoAnalyzeOnNavigation));
                              }
                            }}
                          >
                            {renderMoveLabel(row.p1)}
                          </button>
                        </div>
                      );
                    }

                    // deviation_block: render as a single full-width row spanning all columns
                    const { branch } = token;
                    const isBranchActive = highlightedVariation?.branchId === branch.id;
                    return (
                      <div key={`dev-${branch.id}-${tokenIdx}`} className="move-log-deviation-row" role="listitem">
                        <span className="move-log-deviation-bracket">(</span>
                        <span className="move-log-deviation-moves">
                          {branch.moves.map((move, moveIdx) => {
                            const isActive = isBranchActive && highlightedVariation?.moveIndex === moveIdx;
                            return (
                              <button
                                key={`dev-move-${branch.id}-${moveIdx}`}
                                type="button"
                                className={`move-log-deviation-btn${isActive ? ' active' : ''}`}
                                disabled={isActive}
                                onClick={() => void onJumpToVariationMove(branch, moveIdx, !autoAnalyzeOnNavigation)}
                              >
                                {renderVariationMove(move)}
                              </button>
                            );
                          })}
                        </span>
                        <span className="move-log-deviation-bracket">)</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="analysis-nav-panel">
              <div className="analysis-nav-row">
                <button type="button" onClick={() => void onJumpToVisibleMainlineStart(!autoAnalyzeOnNavigation)} disabled={!canStepVisibleMainlineBackward} aria-label="First move" title="First move">
                  {'<<'}
                </button>
                <button type="button" onClick={() => void onStepMainline(-1, !autoAnalyzeOnNavigation)} disabled={!canStepVisibleMainlineBackward}>
                  {'<'}
                </button>
                <button type="button" onClick={() => void onStepMainline(1, !autoAnalyzeOnNavigation)} disabled={!canStepVisibleMainlineForward}>
                  {'>'}
                </button>
                <button type="button" onClick={() => void onJumpToVisibleMainlineEnd(!autoAnalyzeOnNavigation)} disabled={!canStepVisibleMainlineForward} aria-label="Last position" title="Last position">
                  {'>>'}
                </button>
              </div>
            </div>
          </aside>
          )}
        </section>
      )}

      {activeReveal && (
        <section className="reveal-modal-backdrop" onClick={() => setActiveRevealKey(null)}>
          <div className="reveal-modal" onClick={(event) => event.stopPropagation()}>
            <div className="reveal-modal-header">
              <div>
                <h3 className="reveal-modal-title">{revealTaskLabel(activeReveal)}</h3>
                {activeReveal.actor && <p>{activeReveal.actor}</p>}
              </div>
            </div>
            {activeReveal.zone === 'noble' ? (
              <>
                <div className="current-noble-slot-row noble-slot-row">
                  {activeBoardNobles.map((noble) => {
                    const isActiveSlot = noble.slot === activeReveal.slot;
                    const isInactiveChosenSlot = !isActiveSlot && !noble.is_placeholder;
                    return (
                      <div
                        key={`setup-noble-slot-${noble.slot}`}
                        className={`current-noble-slot ${isActiveSlot ? 'active' : ''} ${isInactiveChosenSlot ? 'board-unavailable' : ''}`}
                        onClick={() => noble.slot != null && openReveal('noble', 0, noble.slot)}
                      >
                        <NobleView noble={noble} />
                      </div>
                    );
                  })}
                </div>
                <div className="noble-catalog-grid">
                  {([
                    ['3 / 3 / 3', groupedCatalogNobles.three],
                    ['4 / 4', groupedCatalogNobles.four],
                  ] as const).map(([label, nobles]) => (
                    <div key={`noble-catalog-row-${label}`} className="noble-catalog-row">
                      <div className="noble-catalog-row-label">{label}</div>
                      <div className="noble-catalog-row-options">
                        {nobles.map((noble) => {
                          const isAvailable =
                            !isSetupLikeView || activeReveal.reason !== 'initial_noble_setup'
                              ? true
                              : !setupUnavailableNobleIds.has(noble.id);
                          return (
                            <div
                              key={`noble-catalog-${noble.id}`}
                              className={`noble-catalog-option ${isAvailable ? 'available' : 'unavailable'}`}
                              onClick={() => {
                                if (!isAvailable) return;
                                void onRevealNobleWithId(activeReveal.slot, noble.id);
                              }}
                              title={nobleOptionLabel(noble)}
                            >
                              <NobleView noble={{ points: noble.points, requirements: noble.requirements, slot: activeReveal.slot }} />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                {activeReveal.zone === 'faceup_card' && (
                  <div className="setup-tier-slot-row">
                    {activeTierBoardCards.map((card) => {
                      const isActiveSlot = card.slot === activeReveal.slot;
                      const isInactiveChosenSlot = !isActiveSlot && !card.is_placeholder;
                      return (
                        <div
                          key={`setup-tier-slot-${activeReveal.tier}-${card.slot}`}
                          className={`setup-tier-slot ${isActiveSlot ? 'active' : ''} ${isInactiveChosenSlot ? 'board-unavailable' : ''}`}
                          onClick={() => card.slot != null && openReveal('faceup_card', activeReveal.tier, card.slot)}
                        >
                          <CardView card={card} />
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="tier-catalog-grid">
                  {COLOR_ORDER.map((color) => (
                    <div key={`tier-catalog-row-${activeReveal.tier}-${color}`} className="tier-catalog-row">
                        <div className="tier-catalog-cards">
                        {cardsByTierAndColor[activeReveal.tier][color].map((card) => {
                          const isSetup = isSetupLikeView && activeReveal.zone === 'faceup_card' && activeReveal.reason === 'initial_setup';
                          const isOnBoardCard = activeReveal.zone === 'faceup_card' && occupiedBoardCardIds.has(card.id);
                          const isManualFreeEdit =
                            !isSetup &&
                            activeReveal.zone === 'faceup_card' &&
                            !hasPendingFaceupReveal &&
                            activeReveal.reason !== 'replacement_after_buy' &&
                            activeReveal.reason !== 'replacement_after_reserve';
                          const isReservedReplace = activeReveal.zone === 'reserved_card';
                          const isAvailable = isOnBoardCard
                            ? false
                            : isReservedReplace
                            ? availableRevealCardIds.has(card.id)
                            : (isManualFreeEdit
                              ? true
                              : (isSetup ? !setupUnavailableCardIds.has(card.id) : availableRevealCardIds.has(card.id)));
                          const optionClass = isAvailable ? 'available' : 'unavailable';
                          return (
                            <div
                              key={`tier-catalog-card-${card.id}`}
                              className={`tier-catalog-option ${optionClass}`}
                              onClick={() => {
                                if (!isAvailable) return;
                                if (activeReveal.zone === 'reserved_card') {
                                  if (!activeReveal.actor) return;
                                  void onRevealReservedCardWithId(activeReveal.actor, activeReveal.tier, activeReveal.slot, card.id);
                                  return;
                                }
                                void onRevealCardWithId(activeReveal.tier, activeReveal.slot, card.id);
                              }}
                              title={cardOptionLabel(card)}
                            >
                              <CardView
                                card={{
                                  points: card.points,
                                  bonus_color: card.bonus_color,
                                  cost: card.cost,
                                  source: activeReveal.zone === 'reserved_card' ? 'reserved_public' : 'faceup',
                                  tier: card.tier,
                                  slot: activeReveal.slot,
                                }}
                              />
                            </div>
                          );
                        })}
                        </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            <button type="button" className="secondary-button" onClick={() => setActiveRevealKey(null)}>
              Close
            </button>
          </div>
        </section>
      )}

      {error && <section className="panel error">Error: {error}</section>}
      {!hideAllExceptBoard && (
        <footer className="feedback-footer">
          Found a bug or have an idea?{' '}
          <a href="mailto:ahinlab0@gmail.com?subject=AhinLendor%20feedback&body=What%20happened:%0D%0A%0D%0AWhat%20I%20expected:%0D%0A%0D%0A(Bug%20or%20feature%20idea?)">
            Email me
          </a>
        </footer>
      )}
    </main>
  );
}
