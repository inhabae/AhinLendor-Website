import { ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconActivityHeartbeat,
  IconChartBar,
  IconHome,
  IconInfoCircle,
  IconPlayerPlay,
} from '@tabler/icons-react';
import {
  ActionDisplayDTO,
  ActionInfoDTO,
  CatalogCardDTO,
  CatalogNobleDTO,
  BoardStateDTO,
  CardDTO,
  ColorCountsDTO,
  EngineJobStatusDTO,
  EngineThinkRequest,
  EngineThinkResponse,
  GameSnapshotDTO,
  LiveSaveStatusDTO,
  MoveLogEntryDTO,
  NobleDTO,
  PlayerMoveResponse,
  RevealCardResponse,
  SearchType,
  Seat,
  TokenCountsDTO,
} from './types';
import { GameBoard } from './components/board/GameBoard';
import { ActionLabel } from './components/ActionLabel';
import { CardView } from './components/board/CardView';
import { NobleView } from './components/board/NobleView';
import { BoardViewport } from './components/board/BoardViewport';

type UiStatus = 'IDLE' | 'WAITING_ENGINE' | 'WAITING_PLAYER' | 'WAITING_REVEAL' | 'GAME_OVER';
type HomeView = 'HOME' | 'QUICK' | 'ANALYSIS' | 'LIVE' | 'ABOUT';
type AnalysisPanelTab = 'ANALYSIS' | 'MOVES';
const COLOR_ORDER: CatalogCardDTO['bonus_color'][] = ['white', 'blue', 'green', 'red', 'black'];

const POLL_MS = 400;
const LIVE_POLL_MS = 1000;
const LIVE_SEARCH_MAX_SIMULATIONS = 1_000_000;
const DEFAULT_DEEP_ANALYSIS_SIMULATIONS = 50_000;
const DEFAULT_GPU_EVAL_BATCH_SIZE = 64;
const MAX_EVAL_BATCH_SIZE = 64;
const DEFAULT_ALPHABETA_DEPTH = 3;
const DEFAULT_SEARCH_SIMULATIONS = 150_000;
const DEFAULT_BOOTSTRAP_SIMULATIONS_PER_ACTION = 2_000;

function analysisPublishInterval(totalSimulations: number): number {
  const normalized = Number.isInteger(totalSimulations) && totalSimulations >= 1 ? totalSimulations : 1;
  return Math.max(64, Math.min(2000, Math.floor(normalized / 20) || 1));
}

function isContinuationAction(actionIdx: number): boolean {
  return actionIdx >= 61 && actionIdx <= 68;
}

function winnerLabel(winner: number): string | null {
  if (winner === 0) return 'P1';
  if (winner === 1) return 'P2';
  return null;
}

interface MoveLogRow {
  moveNumber: number;
  moveNumberLabel: string;
  p0?: MoveLogDisplayEntry;
  p1?: MoveLogDisplayEntry;
}

type MoveLogDisplayEntry = MoveLogEntryDTO & {
  notation: string;
  turnLabel: string;
  fullMoveNumber: number;
  continuationIndex: number;
};

interface HighlightedMove {
  actor: Seat;
  resultTurnIndex: number;
  resultSnapshotIndex: number;
}

interface HighlightedVariation {
  branchId: number;
  moveIndex: number;
}

interface VariationMove {
  kind: 'move' | 'edit_faceup' | 'edit_reserved' | 'edit_noble';
  actor: Seat;
  actionIdx: number;
  replayActionIdxList?: number[];
  label: string;
  display?: ActionDisplayDTO | null;
  fullMoveNumber: number;
  targetSnapshotIndex: number;
  targetTurnIndex: number;
  jumpBySnapshot: boolean;
  tier?: number;
  slot?: number;
  seat?: Seat;
  cardId?: number;
  nobleId?: number;
}

interface VariationBranch {
  id: number;
  anchorSnapshotIndex: number;
  moves: VariationMove[];
}

type MoveToken =
  | { kind: 'mainline_row'; row: MoveLogRow; rowIdx: number }
  | { kind: 'deviation_block'; branch: VariationBranch };

type DeepAnalysisCategory = 'Best' | 'Good' | 'Mistake' | 'Blunder' | 'Unknown';
type MoveGroupKey = 'buy' | 'reserve' | 'take' | 'return' | 'noble' | 'other';

const MOVE_GROUP_LABELS: Record<MoveGroupKey, string> = {
  buy: 'Buy',
  reserve: 'Reserve',
  take: 'Take',
  return: 'Return',
  noble: 'Noble',
  other: 'Other',
};

interface DeepAnalysisEntry {
  category: DeepAnalysisCategory;
  playedActionIdx: number;
  bestActionIdx: number | null;
  playedQ: number | null;
  bestQ: number | null;
  qLoss: number | null;
}

type DeepAnalysisSearchResult = NonNullable<EngineJobStatusDTO['result']>;

function UiIcon({ name }: { name: 'home' | 'play' | 'analysis' | 'live' | 'about' }) {
  const Icon = name === 'home'
    ? IconHome
    : name === 'play'
      ? IconPlayerPlay
      : name === 'analysis'
        ? IconChartBar
        : name === 'about'
          ? IconInfoCircle
          : IconActivityHeartbeat;
  return <Icon className="ui-icon" size={17} stroke={1.75} aria-hidden="true" />;
}

const VIEW_PATHS: Record<HomeView, string> = {
  HOME: '/',
  QUICK: '/quick',
  ANALYSIS: '/analysis',
  LIVE: '/live',
  ABOUT: '/about',
};

function homeViewFromPath(pathname: string): HomeView {
  if (pathname.startsWith('/quick')) return 'QUICK';
  if (pathname.startsWith('/analysis')) return 'ANALYSIS';
  if (pathname.startsWith('/about') || pathname.startsWith('/live')) return 'ABOUT';
  return 'HOME';
}

function moveAnalysisKey(move: Pick<MoveLogEntryDTO, 'result_snapshot_index' | 'turn_index' | 'actor' | 'action_idx'>): string {
  return `${move.result_snapshot_index}:${move.turn_index}:${move.actor}:${move.action_idx}`;
}

function searchTypeLabel(searchType: SearchType): string {
  if (searchType === 'mcts_gpu') {
    return 'MCTS (GPU batched)';
  }
  if (searchType === 'mcts_bootstrap') {
    return 'MCTS Bootstrap';
  }
  if (searchType === 'ismcts') {
    return 'ISMCTS';
  }
  if (searchType === 'alphabeta') {
    return 'Alpha-Beta';
  }
  if (searchType === 'forced_child') {
    return 'Forced Search';
  }
  return 'MCTS';
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) {
        detail = body.detail;
      }
    } catch {
      // Ignore parse errors and keep status text.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

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

function continuationSuffix(index: number): string {
  if (index <= 0) {
    return '';
  }
  let out = '';
  let value = index;
  while (value > 0) {
    const rem = (value - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function topMoveEvalClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) {
    return 'neutral';
  }
  return value > 0 ? 'white-side' : 'black-side';
}

function formatTopMoveEval(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  const magnitude = Math.abs(value).toFixed(2);
  return value > 0 ? `+${magnitude}` : `-${magnitude}`;
}

function formatEvalBarValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  return Math.abs(value).toFixed(2);
}

function p1WinningEval(value: number | null | undefined, playerToMove: Seat | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || playerToMove == null) {
    return null;
  }
  return playerToMove === 'P1' ? value : -value;
}

function p0WinningEval(value: number | null | undefined, playerToMove: Seat | null | undefined): number | null {
  const p1Value = p1WinningEval(value, playerToMove);
  return p1Value == null ? null : -p1Value;
}

export function App() {
  const [catalogCards, setCatalogCards] = useState<CatalogCardDTO[]>([]);
  const [catalogNobles, setCatalogNobles] = useState<CatalogNobleDTO[]>([]);
  const [numSimulations] = useState(400);
  const [searchSimulations, setSearchSimulations] = useState(DEFAULT_SEARCH_SIMULATIONS);
  const [deepAnalysisSimulations, setDeepAnalysisSimulations] = useState(DEFAULT_DEEP_ANALYSIS_SIMULATIONS);
  const [searchBootstrapSimulationsPerAction, setSearchBootstrapSimulationsPerAction] = useState(
    DEFAULT_BOOTSTRAP_SIMULATIONS_PER_ACTION,
  );
  const [deepAnalysisBootstrapSimulationsPerAction, setDeepAnalysisBootstrapSimulationsPerAction] = useState(
    DEFAULT_BOOTSTRAP_SIMULATIONS_PER_ACTION,
  );
  const [searchEvalBatchSize, setSearchEvalBatchSize] = useState(DEFAULT_GPU_EVAL_BATCH_SIZE);
  const [deepAnalysisEvalBatchSize, setDeepAnalysisEvalBatchSize] = useState(DEFAULT_GPU_EVAL_BATCH_SIZE);
  const [searchType, setSearchType] = useState<SearchType>('mcts_bootstrap');
  const [alphabetaDepth, setAlphabetaDepth] = useState(DEFAULT_ALPHABETA_DEPTH);
  const [playerSeat] = useState<Seat>('P0');
  const [seed] = useState('');
  const [homeView, setHomeViewState] = useState<HomeView>(() => homeViewFromPath(window.location.pathname));

  function setHomeView(nextView: HomeView): void {
    setHomeViewState(nextView);
    const nextPath = VIEW_PATHS[nextView];
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ view: nextView }, '', nextPath);
    }
  }

  useEffect(() => {
    const onPopState = () => setHomeViewState(homeViewFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
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
  const [, setLiveSaveStatus] = useState<LiveSaveStatusDTO | null>(null);
const [displayedP0EvalValue, setDisplayedP0EvalValue] = useState<number | null>(null);
  const [analysisPanelTab, setAnalysisPanelTab] = useState<AnalysisPanelTab>('ANALYSIS');
  const [deepAnalysisBySnapshot, setDeepAnalysisBySnapshot] = useState<Record<string, DeepAnalysisEntry>>({});
  const [deepAnalysisSearchBySnapshot, setDeepAnalysisSearchBySnapshot] = useState<Record<string, DeepAnalysisSearchResult>>({});
  const [isLoadedPostAnalysisGame, setIsLoadedPostAnalysisGame] = useState(false);
  const [isDeepAnalysisRunning, setIsDeepAnalysisRunning] = useState(false);
  const [isAutoStartingGame, setIsAutoStartingGame] = useState(false);
  const [deepAnalysisProgress, setDeepAnalysisProgress] = useState<{ done: number; total: number } | null>(null);
  const [activeVariationSelection, setActiveVariationSelection] = useState<HighlightedVariation | null>(null);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const pollRef = useRef<number | null>(null);
  const livePollRef = useRef<number | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
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
  const moveLogGridRef = useRef<HTMLDivElement | null>(null);
  const evalAnimationFrameRef = useRef<number | null>(null);
const displayedP0EvalRef = useRef<number | null>(null);
  const autoStartViewRef = useRef<HomeView | null>(null);
  const isSetupLikeView = homeView === 'ANALYSIS';
  const isQuickGameView = homeView === 'QUICK';
  const showAnalysisUi = !isQuickGameView;
  const activePanelTab: AnalysisPanelTab = showAnalysisUi ? analysisPanelTab : 'MOVES';
  const lastLiveSaveUpdatedAtRef = useRef<string | null>(null);
  const lastAutoAnalyzeKeyRef = useRef<string | null>(null);
  const lastSnapshotSearchKeyRef = useRef<string | null>(null);
  const autoAnalyzeOnNavigation = showBoardAnalysis;

  const cardsByTier = useMemo(() => {
    return catalogCards.reduce<Record<number, CatalogCardDTO[]>>((acc, card) => {
      if (!acc[card.tier]) {
        acc[card.tier] = [];
      }
      acc[card.tier].push(card);
      return acc;
    }, {});
  }, [catalogCards]);
  const cardsByTierAndColor = useMemo(() => {
    const grouped: Record<number, Record<CatalogCardDTO['bonus_color'], CatalogCardDTO[]>> = {
      1: { white: [], blue: [], green: [], red: [], black: [] },
      2: { white: [], blue: [], green: [], red: [], black: [] },
      3: { white: [], blue: [], green: [], red: [], black: [] },
    };
    for (const card of catalogCards) {
      grouped[card.tier][card.bonus_color].push(card);
    }
    for (const tier of [1, 2, 3] as const) {
      for (const color of COLOR_ORDER) {
        grouped[tier][color].sort((a, b) => {
          const aTotal = a.cost.white + a.cost.blue + a.cost.green + a.cost.red + a.cost.black;
          const bTotal = b.cost.white + b.cost.blue + b.cost.green + b.cost.red + b.cost.black;
          if (aTotal !== bTotal) return aTotal - bTotal;
          if (a.points !== b.points) return a.points - b.points;
          return a.id - b.id;
        });
      }
    }
    return grouped;
  }, [catalogCards]);
  const moveLogEntries = useMemo<MoveLogEntryDTO[]>(() => {
    if (loadedMoveLog && loadedMoveLog.length > 0) {
      return loadedMoveLog;
    }
    return snapshot?.move_log ?? [];
  }, [loadedMoveLog, snapshot?.move_log]);
  const moveLogDisplayEntries = useMemo<MoveLogDisplayEntry[]>(() => {
    let fullMoveNumber = 0;
    let continuationIndex = 0;

    return moveLogEntries.map((move) => {
      const isContinuation = isContinuationAction(move.action_idx);
      const displayActor = move.actor;

      if (isContinuation) {
        continuationIndex += 1;
      } else {
        continuationIndex = 0;
        if (displayActor === 'P0') {
          fullMoveNumber += 1;
        } else if (fullMoveNumber <= 0) {
          fullMoveNumber = 1;
        }
      }

      const suffix = continuationSuffix(continuationIndex);
      const base = `${fullMoveNumber}${suffix}`;
      const notation = displayActor === 'P0' ? `${base}.` : `${base}...`;

      return {
        ...move,
        actor: displayActor,
        notation,
        turnLabel: base,
        fullMoveNumber,
        continuationIndex,
      };
    });
  }, [moveLogEntries]);
  const moveLogRows = useMemo<MoveLogRow[]>(() => {
    const rows: MoveLogRow[] = [];
    const rowByLabel = new Map<string, number>();
    for (const move of moveLogDisplayEntries) {
      const moveNumberLabel = move.turnLabel;
      const existingIdx = rowByLabel.get(move.turnLabel);
      if (existingIdx != null) {
        const existing = rows[existingIdx];
        if (move.actor === 'P0') {
          if (existing.p0 == null) {
            existing.p0 = move;
          } else {
            rows.push({ moveNumber: move.fullMoveNumber, moveNumberLabel, p0: move });
          }
        } else if (existing.p1 == null) {
          existing.p1 = move;
        } else {
          rows.push({ moveNumber: move.fullMoveNumber, moveNumberLabel, p1: move });
        }
      } else {
        rows.push(
          move.actor === 'P0'
            ? { moveNumber: move.fullMoveNumber, moveNumberLabel, p0: move }
            : { moveNumber: move.fullMoveNumber, moveNumberLabel, p1: move }
        );
        rowByLabel.set(move.turnLabel, rows.length - 1);
      }
    }
    return rows;
  }, [moveLogDisplayEntries]);
  const mainlineMoveNumberBySnapshot = useMemo<Map<number, number>>(() => {
    const out = new Map<number, number>();
    for (const row of moveLogRows) {
      if (row.p0?.result_snapshot_index != null) {
        out.set(row.p0.result_snapshot_index, row.moveNumber);
      }
      if (row.p1?.result_snapshot_index != null) {
        out.set(row.p1.result_snapshot_index, row.moveNumber);
      }
    }
    return out;
  }, [moveLogRows]);
  const variationBranchByAnchor = useMemo<Map<number, VariationBranch[]>>(() => {
    const out = new Map<number, VariationBranch[]>();
    for (const branch of variationBranches) {
      const existing = out.get(branch.anchorSnapshotIndex);
      if (existing) {
        existing.push(branch);
      } else {
        out.set(branch.anchorSnapshotIndex, [branch]);
      }
    }
    return out;
  }, [variationBranches]);
  const moveLogTokens = useMemo<MoveToken[]>(() => {
    const tokens: MoveToken[] = [];
    for (let rowIdx = 0; rowIdx < moveLogRows.length; rowIdx++) {
      const row = moveLogRows[rowIdx];
      tokens.push({ kind: 'mainline_row', row, rowIdx });
      // Emit deviation blocks anchored on p0's snapshot, then p1's snapshot,
      // so each branch appears immediately after the half-move it diverges from.
      const p0Snap = row.p0?.result_snapshot_index ?? null;
      const p1Snap = row.p1?.result_snapshot_index ?? null;
      const anchors: number[] = [];
      if (p0Snap != null) anchors.push(p0Snap);
      if (p1Snap != null && p1Snap !== p0Snap) anchors.push(p1Snap);
      for (const snap of anchors) {
        for (const branch of (variationBranchByAnchor.get(snap) ?? [])) {
          tokens.push({ kind: 'deviation_block', branch });
        }
      }
    }
    // Pre-game deviations (anchor = 0) before the first row.
    const preGame = variationBranchByAnchor.get(0) ?? [];
    if (preGame.length > 0) {
      const preTokens: MoveToken[] = [];
      for (const branch of preGame) {
        preTokens.push({ kind: 'deviation_block', branch });
      }
      tokens.unshift(...preTokens);
    }
    return tokens;
  }, [moveLogRows, variationBranchByAnchor]);
  const currentSnapshotIndex = useMemo<number>(() => {
    if (!snapshot) {
      return 0;
    }
    if (snapshot.current_snapshot_index != null) {
      return Number(snapshot.current_snapshot_index);
    }
    if (moveLogEntries.length === 0) {
      return 0;
    }
    let bestSnapshotIndex = 0;
    for (const move of moveLogEntries) {
      if (move.result_turn_index > snapshot.turn_index) {
        continue;
      }
      if (move.result_snapshot_index > bestSnapshotIndex) {
        bestSnapshotIndex = move.result_snapshot_index;
      }
    }
    return bestSnapshotIndex;
  }, [snapshot, moveLogEntries]);
  const mainlineMoveSnapshotIndices = useMemo<number[]>(() => {
    const indices = moveLogEntries
      .map((move) => move.result_snapshot_index)
      .filter((value) => Number.isFinite(value) && value > 0);
    const uniqueInOrder = Array.from(new Set(indices));
    return [0, ...uniqueInOrder];
  }, [moveLogEntries]);
  const mainlineMoveTurnIndices = useMemo<number[]>(() => {
    const indices = moveLogEntries
      .map((move) => move.result_turn_index)
      .filter((value) => Number.isFinite(value) && value > 0);
    const uniqueInOrder = Array.from(new Set(indices));
    return [0, ...uniqueInOrder];
  }, [moveLogEntries]);
  const isLoadedMainlineExtensionState = useMemo<boolean>(() => {
    return Boolean(
      snapshot &&
      loadedHistoricalMainlineLengthRef.current > 0 &&
      snapshot.current_snapshot_index == null &&
      currentSnapshotIndex > loadedHistoricalMainlineTailSnapshotRef.current
    );
  }, [snapshot, currentSnapshotIndex]);
  const useTurnNavigationForVisibleMainline = Boolean(snapshot?.current_snapshot_index == null && !isLoadedMainlineExtensionState);
  const visibleMainlineTargets = useMemo<number[]>(() => {
    return useTurnNavigationForVisibleMainline ? mainlineMoveTurnIndices : mainlineMoveSnapshotIndices;
  }, [useTurnNavigationForVisibleMainline, mainlineMoveTurnIndices, mainlineMoveSnapshotIndices]);
  const visibleMainlinePosition = useMemo<number>(() => {
    if (!snapshot) {
      return 0;
    }
    return useTurnNavigationForVisibleMainline ? snapshot.turn_index : currentSnapshotIndex;
  }, [snapshot, useTurnNavigationForVisibleMainline, currentSnapshotIndex]);
  const canStepVisibleMainlineBackward = useMemo<boolean>(() => {
    return visibleMainlineTargets.some((target) => target < visibleMainlinePosition);
  }, [visibleMainlineTargets, visibleMainlinePosition]);
  const canStepVisibleMainlineForward = useMemo<boolean>(() => {
    return visibleMainlineTargets.some((target) => target > visibleMainlinePosition);
  }, [visibleMainlineTargets, visibleMainlinePosition]);
  const highlightedMove = useMemo<HighlightedMove | null>(() => {
    if (moveLogDisplayEntries.length === 0 || currentSnapshotIndex <= 0) {
      return null;
    }
    let best: MoveLogDisplayEntry | null = null;
    for (const move of moveLogDisplayEntries) {
      if (move.result_snapshot_index > currentSnapshotIndex) {
        continue;
      }
      if (
        !best
        || move.result_snapshot_index > best.result_snapshot_index
      ) {
        best = move;
      }
    }
    if (best) {
      return {
        actor: best.actor,
        resultTurnIndex: best.result_turn_index,
        resultSnapshotIndex: best.result_snapshot_index,
      };
    }
    return null;
  }, [moveLogDisplayEntries, currentSnapshotIndex]);
  const highlightedVariation = useMemo<HighlightedVariation | null>(() => {
    if (!activeVariationSelection) {
      return null;
    }
    const branch = variationBranches.find((item) => item.id === activeVariationSelection.branchId) ?? null;
    if (!branch || activeVariationSelection.moveIndex < 0 || activeVariationSelection.moveIndex >= branch.moves.length) {
      return null;
    }
    return activeVariationSelection;
  }, [activeVariationSelection, variationBranches]);
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
    void (async () => {
      try {
        const cards = await fetchJSON<CatalogCardDTO[]>('/api/cards');
        const nobles = await fetchJSON<CatalogNobleDTO[]>('/api/nobles');
        setCatalogCards(cards);
        setCatalogNobles(nobles);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
      }
      if (livePollRef.current !== null) {
        window.clearInterval(livePollRef.current);
      }
      if (evalAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(evalAnimationFrameRef.current);
      }
    };
  }, []);

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

  function clearPolling(): void {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    activeJobIdRef.current = null;
  }

  function clearLivePolling(): void {
    if (livePollRef.current !== null) {
      window.clearInterval(livePollRef.current);
      livePollRef.current = null;
    }
  }

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
    if (deepResult || !preserveActiveSearch) {
      setJobStatus(
        deepResult
          ? {
              job_id: `deep-${snapshotIndex}`,
              status: 'DONE',
              result: deepResult,
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
    lastSnapshotSearchKeyRef.current = snapshotSearchKey(nextSnapshot);
    setUiStatus(deriveUiStatus(nextSnapshot));
    const nextAutoAnalyzeKey = autoAnalyzeKey(nextSnapshot);
    const shouldStartSearch =
      engineShouldMove ||
      (!suppressAutoAnalyze && shouldAutoAnalyze(nextSnapshot) && lastAutoAnalyzeKeyRef.current !== nextAutoAnalyzeKey);
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

  function cardOptionLabel(card: CatalogCardDTO): string {
    const cost = Object.entries(card.cost)
      .filter(([, count]) => count > 0)
      .map(([color, count]) => `${count}${color[0].toUpperCase()}`)
      .join(' ');
    return `#${card.id} ${card.bonus_color} ${card.points}pt${cost ? ` | ${cost}` : ''}`;
  }

  function nobleOptionLabel(noble: CatalogNobleDTO): string {
    const reqs = Object.entries(noble.requirements)
      .filter(([, count]) => count > 0)
      .map(([color, count]) => `${count}${color[0].toUpperCase()}`)
      .join(' ');
    return `#${noble.id} ${noble.points}pt${reqs ? ` | ${reqs}` : ''}`;
  }

  function findCatalogCard(card: BoardStateDTO['tiers'][number]['cards'][number]): CatalogCardDTO | null {
    const matches = catalogCards.filter((candidate) =>
      (card.tier == null || candidate.tier === card.tier) &&
      candidate.points === card.points &&
      candidate.bonus_color === card.bonus_color &&
      candidate.cost.white === card.cost.white &&
      candidate.cost.blue === card.cost.blue &&
      candidate.cost.green === card.cost.green &&
      candidate.cost.red === card.cost.red &&
      candidate.cost.black === card.cost.black
    );
    if (matches.length === 0) {
      return null;
    }
    return matches[0];
  }

  function findCatalogCardId(card: BoardStateDTO['tiers'][number]['cards'][number]): number | null {
    return findCatalogCard(card)?.id ?? null;
  }

  function findCatalogNobleId(noble: BoardStateDTO['nobles'][number]): number | null {
    const match = catalogNobles.find((candidate) =>
      candidate.points === noble.points &&
      candidate.requirements.white === noble.requirements.white &&
      candidate.requirements.blue === noble.requirements.blue &&
      candidate.requirements.green === noble.requirements.green &&
      candidate.requirements.red === noble.requirements.red &&
      candidate.requirements.black === noble.requirements.black
    );
    return match?.id ?? null;
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
    const useProgressiveSearch = supportsProgressiveTreeUpdates && (homeView === 'LIVE' || homeView === 'ANALYSIS');
    const totalSearchBudget = homeView === 'LIVE' ? LIVE_SEARCH_MAX_SIMULATIONS : nextNumSimulations;
    const publishInterval = homeView === 'LIVE'
      ? nextNumSimulations
      : analysisPublishInterval(nextNumSimulations);

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

  async function startEngineThink(options?: {
    searchTypeOverride?: SearchType;
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
    await handleSnapshotUpdate(nextSnapshot);
  }

  async function startQuickGame(): Promise<void> {
    await startGame(false, playerSeat, false);
  }

  async function startAnalysisGame(): Promise<void> {
    await startGame(true, playerSeat, true);
  }

  function resetGameViewState(): void {
    setError(null);
    clearPolling();
    clearLivePolling();
    setJobStatus(null);
    setSnapshot(null);
    setLoadedMoveLog(null);
    loadedHistoricalMainlineLengthRef.current = 0;
    loadedHistoricalMainlineTailSnapshotRef.current = 0;
    setLoadedPlayerNames(null);
    setVariationBranches([]);
    setDeepAnalysisBySnapshot({});
    setDeepAnalysisSearchBySnapshot({});
    setIsLoadedPostAnalysisGame(false);
    setDeepAnalysisProgress(null);
    setIsDeepAnalysisRunning(false);
    setIsAutoStartingGame(false);
    clearActiveVariationSelection();
    lastAutoAnalyzeKeyRef.current = null;
  }

  function onOpenQuickView(): void {
    resetGameViewState();
    setHomeView('QUICK');
  }

  function onOpenManualView(): void {
    resetGameViewState();
    setHomeView('ANALYSIS');
  }

  function onOpenAboutView(): void {
    resetGameViewState();
    setRevealSelections({});
    setActiveRevealKey(null);
    setLiveSaveStatus(null);
    lastLiveSaveUpdatedAtRef.current = null;
    setHomeView('ABOUT');
  }

  useEffect(() => {
    if (homeView !== 'QUICK' && homeView !== 'ANALYSIS') {
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
        if (homeView === 'QUICK') {
          await startQuickGame();
        } else {
          await startAnalysisGame();
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsAutoStartingGame(false);
      }
    })();
  }, [homeView, isAutoStartingGame, playerSeat, snapshot]);

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
        const baseFullMoveNumber = variationCtx?.baseFullMoveNumber ?? 1;

        if (activeVariationBranchIdRef.current == null) {
          const isDeviation = isOnMainlineSnapshot && expectedMainlineMove != null && expectedMainlineMove.action_idx !== actionIdx;
          if (isDeviation) {
            const branchId = variationBranchIdCounterRef.current++;
            selectVariationMove(branchId, 0);
            setVariationBranches((prev) => [
              ...prev,
              {
                id: branchId,
                anchorSnapshotIndex: beforeSnapshotIndex,
                moves: [{
                  kind: 'move',
                  actor,
                  actionIdx,
                  replayActionIdxList: [actionIdx],
                  label,
                  display,
                  fullMoveNumber: baseFullMoveNumber,
                  targetSnapshotIndex: result.snapshot.current_snapshot_index ?? -1,
                  targetTurnIndex: result.snapshot.turn_index,
                  jumpBySnapshot: result.snapshot.current_snapshot_index != null,
                }],
              },
            ]);
          }
        } else {
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
            return {
              ...branch,
              moves: [...preservedMoves, {
                kind: 'move',
                actor,
                actionIdx,
                replayActionIdxList: [actionIdx],
                label,
                display,
                fullMoveNumber: (() => {
                  const last = preservedMoves[preservedMoves.length - 1];
                  if (!last) return baseFullMoveNumber;
                  return last.actor === 'P1' && actor === 'P0'
                    ? last.fullMoveNumber + 1
                    : last.fullMoveNumber;
                })(),
                targetSnapshotIndex: result.snapshot.current_snapshot_index ?? -1,
                targetTurnIndex: result.snapshot.turn_index,
                jumpBySnapshot: result.snapshot.current_snapshot_index != null,
              }],
            };
          }));
          if (activeId != null) {
            selectVariationMove(activeId, (selectedMoveIndex ?? -1) + 1);
          }
        }
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
  void onPlayerMove;

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

  async function onSelectLiveAction(_actionIdx: number): Promise<void> {
    return;
  }

  async function onSelectModeAction(actionIdx: number): Promise<void> {
    if (homeView === 'QUICK') {
      await onSelectQuickAction(actionIdx);
      return;
    }
    if (homeView === 'ANALYSIS') {
      await onSelectAnalysisAction(actionIdx);
      return;
    }
    if (homeView === 'LIVE') {
      await onSelectLiveAction(actionIdx);
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
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze || isLoadedPostAnalysisGame;
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
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze || isLoadedPostAnalysisGame;
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
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze || isLoadedPostAnalysisGame;
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
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze || isLoadedPostAnalysisGame;
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
      await onJumpToTurn(fallbackTurnIndex, false, suppressAutoAnalyze || isLoadedPostAnalysisGame);
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
      // Appended post-load mainline moves now live in backend snapshot history,
      // so prefer a direct snapshot jump instead of replaying from the tail.
      const directSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/jump-to-snapshot', {
        method: 'POST',
        body: JSON.stringify({ snapshot_index: snapshotIndex }),
      });
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze || isLoadedPostAnalysisGame;
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
      const shouldSuppressAutoAnalyze = suppressAutoAnalyze || isLoadedPostAnalysisGame;
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

  function appendVariationEditNode(
    beforeSnapshot: GameSnapshotDTO,
    beforeSnapshotIndex: number,
    actor: Seat,
    label: string,
    resultSnapshot: GameSnapshotDTO,
    kind: 'edit_faceup' | 'edit_reserved' | 'edit_noble',
    payload: { tier?: number; slot?: number; seat?: Seat; cardId?: number; nobleId?: number },
  ): void {
    const variationCtx = deriveVariationContext(beforeSnapshot, beforeSnapshotIndex, actor);
    const isOnMainlineSnapshot = variationCtx?.isOnMainlineSnapshot ?? false;
    const baseFullMoveNumber = variationCtx?.baseFullMoveNumber ?? 1;

    if (activeVariationBranchIdRef.current == null) {
      if (!isOnMainlineSnapshot) {
        return;
      }
      const branchId = variationBranchIdCounterRef.current++;
      selectVariationMove(branchId, 0);
      setVariationBranches((prev) => [
        ...prev,
        {
          id: branchId,
          anchorSnapshotIndex: beforeSnapshotIndex,
          moves: [{
            kind,
            actor,
            actionIdx: -1,
            label,
            fullMoveNumber: baseFullMoveNumber,
            targetSnapshotIndex: resultSnapshot.current_snapshot_index ?? -1,
            targetTurnIndex: resultSnapshot.turn_index,
            jumpBySnapshot: resultSnapshot.current_snapshot_index != null,
            ...payload,
          }],
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
        moves: [
          ...preservedMoves,
          {
            kind,
            actor,
            actionIdx: -1,
            label,
            fullMoveNumber,
            targetSnapshotIndex: resultSnapshot.current_snapshot_index ?? -1,
            targetTurnIndex: resultSnapshot.turn_index,
            jumpBySnapshot: resultSnapshot.current_snapshot_index != null,
            ...payload,
          },
        ],
      };
    }));
    if (activeId != null) {
      selectVariationMove(activeId, (selectedMoveIndex ?? -1) + 1);
    }
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
      await handleSnapshotUpdate(result.snapshot, result.engine_should_move);
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
    if (homeView === 'ANALYSIS' || homeView === 'LIVE') {
      openReveal('faceup_card', tier, slot);
    }
  }

  function onModeBoardNobleClick(slot: number): void {
    if (homeView === 'ANALYSIS' || homeView === 'LIVE') {
      openReveal('noble', 0, slot);
    }
  }

  function onModeReservedCardClick(seat: Seat, slot: number): void {
    if (homeView !== 'ANALYSIS' && homeView !== 'LIVE') {
      return;
    }
    const player = displayBoard?.players.find((item) => item.seat === seat);
    const card = player?.reserved_public.find((item) => item.slot === slot);
    const inferredTier = card ? (findCatalogCard(card)?.tier ?? null) : null;
    const tier = card?.tier
      ?? inferredTier
      ?? snapshot?.pending_reveals.find((item) => item.zone === 'reserved_card' && item.actor === seat && item.slot === slot)?.tier;
    if (tier != null) {
      openReveal('reserved_card', tier, slot, seat);
    }
  }

  const isTreeSearchType =
    searchType === 'mcts' || searchType === 'mcts_gpu' || searchType === 'mcts_bootstrap' || searchType === 'ismcts';
  const usesEvalBatchSize = searchType === 'mcts_gpu' || searchType === 'mcts_bootstrap';
  const canRunCurrentSearch = (() => {
    if (searchType === 'alphabeta') {
      return alphabetaDepth >= 1;
    }
    if (searchType === 'forced_child') {
      return searchSimulations >= 1;
    }
    if (searchType === 'mcts_bootstrap') {
      return (
        searchSimulations >= 1 &&
        searchBootstrapSimulationsPerAction >= 1 &&
        searchEvalBatchSize >= 1 &&
        searchEvalBatchSize <= MAX_EVAL_BATCH_SIZE
      );
    }
    if (searchType === 'mcts_gpu') {
      return searchSimulations >= 1 && searchEvalBatchSize >= 1 && searchEvalBatchSize <= MAX_EVAL_BATCH_SIZE;
    }
    return searchSimulations >= 1;
  })();
  const canRunDeepAnalysisForCurrentSearch = (() => {
    if (searchType === 'alphabeta') {
      return alphabetaDepth >= 1;
    }
    if (searchType === 'mcts_gpu') {
      return deepAnalysisSimulations >= 1 && deepAnalysisEvalBatchSize >= 1 && deepAnalysisEvalBatchSize <= MAX_EVAL_BATCH_SIZE;
    }
    if (searchType === 'mcts_bootstrap') {
      return (
        deepAnalysisSimulations >= 1 &&
        deepAnalysisBootstrapSimulationsPerAction >= 1 &&
        deepAnalysisEvalBatchSize >= 1 &&
        deepAnalysisEvalBatchSize <= MAX_EVAL_BATCH_SIZE
      );
    }
    return deepAnalysisSimulations >= 1;
  })();
  const searchSettingsSummary = (() => {
    if (searchType === 'alphabeta') {
      return `${searchTypeLabel(searchType)} • depth ${alphabetaDepth}`;
    }
    if (searchType === 'forced_child') {
      return `${searchTypeLabel(searchType)} • ${searchSimulations.toLocaleString()} per action`;
    }
    if (searchType === 'mcts_bootstrap') {
      if (homeView === 'LIVE') {
        return `${searchTypeLabel(searchType)} | publish every ${searchSimulations.toLocaleString()} sims | bootstrap ${searchBootstrapSimulationsPerAction.toLocaleString()} per action | batch ${searchEvalBatchSize.toLocaleString()}`;
      }
      if (homeView === 'ANALYSIS') {
        return `${searchTypeLabel(searchType)} | ${searchSimulations.toLocaleString()} total sims | bootstrap ${searchBootstrapSimulationsPerAction.toLocaleString()} per action | publish every ${analysisPublishInterval(searchSimulations).toLocaleString()} | batch ${searchEvalBatchSize.toLocaleString()}`;
      }
      return `${searchTypeLabel(searchType)} | ${searchSimulations.toLocaleString()} sims | bootstrap ${searchBootstrapSimulationsPerAction.toLocaleString()} per action | batch ${searchEvalBatchSize.toLocaleString()}`;
    }
    if (searchType === 'mcts_gpu') {
      if (homeView === 'LIVE') {
        return `${searchTypeLabel(searchType)} | publish every ${searchSimulations.toLocaleString()} sims | batch ${searchEvalBatchSize.toLocaleString()}`;
      }
      if (homeView === 'ANALYSIS') {
        return `${searchTypeLabel(searchType)} | ${searchSimulations.toLocaleString()} total sims | publish every ${analysisPublishInterval(searchSimulations).toLocaleString()} | batch ${searchEvalBatchSize.toLocaleString()}`;
      }
      return `${searchTypeLabel(searchType)} | ${searchSimulations.toLocaleString()} sims | batch ${searchEvalBatchSize.toLocaleString()}`;
    }
    if (homeView === 'LIVE') {
      return `${searchTypeLabel(searchType)} • publish every ${searchSimulations.toLocaleString()} sims`;
    }
    if (homeView === 'ANALYSIS' && searchType === 'mcts') {
      return `${searchTypeLabel(searchType)} • ${searchSimulations.toLocaleString()} total sims • publish every ${analysisPublishInterval(searchSimulations).toLocaleString()} sims`;
    }
    return `${searchTypeLabel(searchType)} • ${searchSimulations.toLocaleString()} sims`;
  })();
  const deepAnalysisSettingsLabel = (() => {
    if (searchType === 'alphabeta') {
      return 'Depth';
    }
    if (searchType === 'forced_child') {
      return 'Per Action';
    }
    if (searchType === 'mcts_bootstrap') {
      return 'Deep';
    }
    return 'Deep';
  })();
  const deepAnalysisSettingsTitle = (() => {
    if (searchType === 'alphabeta') {
      return 'Alpha-Beta depth per move';
    }
    if (searchType === 'forced_child') {
      return 'Forced search simulations per action for each move';
    }
    if (searchType === 'mcts_bootstrap') {
      return 'Deep analysis total simulations per move';
    }
    return 'Deep analysis simulations per move';
  })();
  const bootstrapSettingsTitle = (() => {
    if (searchType === 'mcts_bootstrap') {
      return 'Bootstrap simulations per legal root action';
    }
    return 'Bootstrap simulations per action';
  })();
  const deepAnalysisBatchSizeTitle = 'Deep analysis evaluation batch size';
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
  const liveMctsTopAction = useMemo(() => {
    const details = jobStatus?.result?.action_details;
    if (!details?.length) return null;
    let best: typeof details[number] | null = null;
    for (const action of details) {
      if (action.masked) continue;
      if (best == null || action.policy_prob > best.policy_prob) best = action;
    }
    return best;
  }, [jobStatus]);
  const liveModelTopAction = useMemo(() => {
    const details = jobStatus?.result?.model_action_details;
    if (!details?.length) return null;
    let best: typeof details[number] | null = null;
    for (const action of details) {
      if (action.masked) continue;
      if (best == null || action.policy_prob > best.policy_prob) best = action;
    }
    return best;
  }, [jobStatus]);
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
  const analysisEvalValue = useMemo<number | null>(() => {
    if (homeView === 'ANALYSIS') {
      return preferredAnalysisResult?.selected_action_q
        ?? preferredAnalysisResult?.root_value
        ?? currentDeepAnalysisEntry?.bestQ
        ?? null;
    }
    return jobStatus?.result?.root_value ?? null;
  }, [homeView, currentDeepAnalysisEntry, preferredAnalysisResult, jobStatus]);
  const p0EvalValue = useMemo<number | null>(() => {
    return p0WinningEval(analysisEvalValue, snapshot?.player_to_move ?? null);
  }, [analysisEvalValue, snapshot]);
  useEffect(() => {
    displayedP0EvalRef.current = displayedP0EvalValue;
  }, [displayedP0EvalValue]);

  useEffect(() => {
    if (p0EvalValue == null || !Number.isFinite(p0EvalValue)) {
      return;
    }
    if (evalAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(evalAnimationFrameRef.current);
      evalAnimationFrameRef.current = null;
    }
    setDisplayedP0EvalValue((current) => {
      if (current == null || !Number.isFinite(current)) {
        return p0EvalValue;
      }
      return current;
    });
    const startValue = displayedP0EvalRef.current != null && Number.isFinite(displayedP0EvalRef.current)
      ? displayedP0EvalRef.current
      : p0EvalValue;
    if (Math.abs(startValue - p0EvalValue) < 0.0001) {
      setDisplayedP0EvalValue(p0EvalValue);
      return;
    }
    const startedAt = performance.now();
    const durationMs = 525;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = startValue + (p0EvalValue - startValue) * eased;
      displayedP0EvalRef.current = nextValue;
      setDisplayedP0EvalValue(nextValue);
      if (progress < 1) {
        evalAnimationFrameRef.current = window.requestAnimationFrame(step);
      } else {
        evalAnimationFrameRef.current = null;
      }
    };
    evalAnimationFrameRef.current = window.requestAnimationFrame(step);
  }, [p0EvalValue]);
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
    const details = preferredAnalysisResult?.action_details ?? [];
    return details
      .filter((detail) => !detail.masked)
      .slice()
      .sort((a, b) => {
        if (b.policy_prob !== a.policy_prob) return b.policy_prob - a.policy_prob;
        return a.action_idx - b.action_idx;
      });
  }, [preferredAnalysisResult, snapshot?.status]);
  const playedAnalysisMove = useMemo(() => {
    if (!currentDeepAnalysisEntry) {
      return null;
    }
    const details = preferredAnalysisResult?.action_details ?? [];
    return details.find((detail) => detail.action_idx === currentDeepAnalysisEntry.playedActionIdx) ?? null;
  }, [currentDeepAnalysisEntry, preferredAnalysisResult]);
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

    const rankedDetails = preferredAnalysisResult?.action_details ?? [];
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
  }, [preferredAnalysisResult, showBoardAnalysis, snapshot, uiStatus]);
  const groupedAnalysisMoves = useMemo(() => {
    const groups: Record<MoveGroupKey, ActionInfoDTO[]> = {
      buy: [],
      reserve: [],
      take: [],
      return: [],
      noble: [],
      other: [],
    };
    for (const detail of allAnalysisMoves) {
      const idx = detail.action_idx;
      if ((0 <= idx && idx <= 14)) {
        groups.buy.push(detail);
      } else if (15 <= idx && idx <= 29) {
        groups.reserve.push(detail);
      } else if (30 <= idx && idx <= 59) {
        groups.take.push(detail);
      } else if (61 <= idx && idx <= 65) {
        groups.return.push(detail);
      } else if (66 <= idx && idx <= 68) {
        groups.noble.push(detail);
      } else {
        groups.other.push(detail);
      }
    }
    return (['buy', 'reserve', 'take', 'return', 'noble', 'other'] as MoveGroupKey[])
      .map((key) => ({ key, label: MOVE_GROUP_LABELS[key], moves: groups[key] }))
      .filter((group) => group.moves.length > 0);
  }, [allAnalysisMoves]);
  const movesEmptyMessage = useMemo(() => {
    if (snapshot?.status !== 'IN_PROGRESS') {
      const winner = winnerLabel(snapshot?.winner ?? -1);
      return winner ? `Game over · ${winner} is victorious` : 'Game over';
    }
    if (uiStatus === 'WAITING_REVEAL' || snapshot.pending_reveals.some((reveal) => isBlockingPendingReveal(reveal))) {
      return 'Waiting for setup...';
    }
    return 'Waiting for search...';
  }, [snapshot, uiStatus]);
  const isMovesGameOverMessage = snapshot?.status !== 'IN_PROGRESS';
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
          display_name: player.display_name,
          role_label: player.seat === snapshot.config.player_seat ? 'You' : 'AhinLendor',
        };
      }
      const overrideName = loadedPlayerNames?.[player.seat];
      if (!overrideName) {
        return player;
      }
      return {
        ...player,
        role_label: overrideName,
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
  const groupedCatalogNobles = useMemo(() => {
    const groups = {
      three: [] as CatalogNobleDTO[],
      four: [] as CatalogNobleDTO[],
    };
    for (const noble of catalogNobles) {
      const reqs = COLOR_ORDER.map((color) => noble.requirements[color]).filter((count) => count > 0);
      if (reqs.length === 3 && reqs.every((count) => count === 3)) {
        groups.three.push(noble);
      } else if (reqs.length === 2 && reqs.every((count) => count === 4)) {
        groups.four.push(noble);
      }
    }
    return groups;
  }, [catalogNobles]);
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
  const liveAvailableCardIds = useMemo(() => {
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
    const keyboardNavigationEnabled = homeView === 'QUICK' || homeView === 'ANALYSIS' || isSetupLikeView || homeView === 'LIVE';
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
          void onJumpToTurn(0, false, !autoAnalyzeOnNavigation);
          return;
        }
        void onJumpToSnapshot(0, false, !autoAnalyzeOnNavigation, false);
        return;
      }

      if (event.key === 'ArrowDown') {
        const useTurnNavigation = snapshotForKeys.current_snapshot_index == null && !isLoadedMainlineExtensionState;
        const finalSnapshotIndex = useTurnNavigation
          ? (mainlineMoveTurnIndices.length > 0 ? mainlineMoveTurnIndices[mainlineMoveTurnIndices.length - 1] : 0)
          : (mainlineMoveSnapshotIndices.length > 0 ? mainlineMoveSnapshotIndices[mainlineMoveSnapshotIndices.length - 1] : 0);
        event.preventDefault();
        if (useTurnNavigation) {
          void onJumpToTurn(finalSnapshotIndex, false, !autoAnalyzeOnNavigation);
          return;
        }
        if (
          loadedHistoricalMainlineLengthRef.current > 0 &&
          finalSnapshotIndex > loadedHistoricalMainlineTailSnapshotRef.current
        ) {
          void onJumpToLoadedMainlineExtension(finalSnapshotIndex, !autoAnalyzeOnNavigation);
          return;
        }
        void onJumpToSnapshot(finalSnapshotIndex, false, !autoAnalyzeOnNavigation, false);
        return;
      }

      const delta: -1 | 1 = event.key === 'ArrowLeft' ? -1 : 1;

      event.preventDefault();
      void onStepMainline(delta, !autoAnalyzeOnNavigation);
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
    autoAnalyzeOnNavigation,
    mainlineMoveSnapshotIndices,
    mainlineMoveTurnIndices,
    currentSnapshotIndex,
  ]);

  useEffect(() => {
    if (homeView !== 'LIVE') {
      clearLivePolling();
      return;
    }

    async function pollLiveSave(): Promise<void> {
      try {
        const status = await fetchJSON<LiveSaveStatusDTO>('/api/game/live-save/status');
        setLiveSaveStatus(status);
        if (!status.exists || !status.updated_at) {
          return;
        }
        if (status.updated_at === lastLiveSaveUpdatedAtRef.current) {
          return;
        }
        const nextSnapshot = await fetchJSON<GameSnapshotDTO>('/api/game/live-save/load', {
          method: 'POST',
          body: '{}',
        });
        const nextSearchKey = snapshotSearchKey(nextSnapshot);
        const preserveActiveSearch =
          activeJobIdRef.current !== null &&
          lastSnapshotSearchKeyRef.current === nextSearchKey;
        if (!preserveActiveSearch) {
          clearPolling();
          setJobStatus(null);
        }
        lastLiveSaveUpdatedAtRef.current = status.updated_at;
        await handleSnapshotUpdate(nextSnapshot, false, null, false, preserveActiveSearch);
      } catch (err) {
        setError((err as Error).message);
      }
    }

    void pollLiveSave();
    clearLivePolling();
    livePollRef.current = window.setInterval(() => {
      void pollLiveSave();
    }, LIVE_POLL_MS);
    return () => {
      clearLivePolling();
    };
  }, [homeView]);

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

  const isBoardView = (homeView === 'QUICK' || isSetupLikeView || homeView === 'LIVE') && snapshot;

  async function onSaveBoardImage(): Promise<void> {
    if (!displayBoard) {
      setError('Board is unavailable to export.');
      return;
    }

    try {
      setError(null);

      const escapeXml = (value: string): string => value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      const rootStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      const pageBackground = bodyStyle.backgroundColor || 'rgb(17, 19, 23)';
      const panelFill = rootStyle.getPropertyValue('--panel').trim() || '#17181b';
      const boardFill = rootStyle.getPropertyValue('--board-surface-bg').trim() || '#2e343d';
      const textLight = rootStyle.color || '#eef2fb';
      const textMuted = '#9aa6bc';

      const colorMap: Record<string, string> = {
        white: '#f7f5e9',
        blue: '#3e59ab',
        green: '#20805c',
        red: '#a64242',
        black: '#52422f',
        gold: '#d6b35f',
      };
      const reqOrder: Array<'white' | 'blue' | 'green' | 'red' | 'black'> = ['white', 'blue', 'green', 'red', 'black'];
      const tokenOrder: Array<'gold' | 'white' | 'blue' | 'green' | 'red' | 'black'> = ['gold', 'white', 'blue', 'green', 'red', 'black'];
      const width = 1880;
      const height = 1040;

      const renderToken = (x: number, y: number, color: keyof TokenCountsDTO, count: number): string => `
        <g transform="translate(${x} ${y})">
          <circle cx="30" cy="30" r="24" fill="${colorMap[color]}" stroke="#1e223080" stroke-width="3" />
          <text x="30" y="38" text-anchor="middle" font-size="26" font-weight="800" fill="${color === 'white' || color === 'gold' ? '#1f2430' : '#ffffff'}">${count}</text>
        </g>
      `;
      const renderCostRow = (cost: ColorCountsDTO, startX: number, y: number): string => reqOrder
        .filter((color) => cost[color] > 0)
        .map((color, idx) => `
          <g transform="translate(${startX + idx * 34} ${y})">
            <circle cx="14" cy="14" r="14" fill="${colorMap[color]}" stroke="#1e223080" stroke-width="2" />
            <text x="14" y="19" text-anchor="middle" font-size="14" font-weight="800" fill="#ffffff">${cost[color]}</text>
          </g>
        `)
        .join('');
      const renderCard = (card: CardDTO, x: number, y: number, widthPx = 148, heightPx = 196): string => {
        const stroke = card.is_placeholder ? '#a2abb9' : '#0f1320';
        const fill = card.is_placeholder ? '#c9cfd8' : '#f3efe4';
        const banner = card.is_placeholder ? '#d9dee6' : colorMap[card.bonus_color];
        const label = card.is_placeholder ? '?' : `${card.points}`;
        return `
          <g transform="translate(${x} ${y})">
            <rect x="0" y="0" width="${widthPx}" height="${heightPx}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="3" />
            <rect x="0" y="0" width="${widthPx}" height="42" rx="14" fill="${banner}" />
            <text x="18" y="30" font-size="28" font-weight="900" fill="${card.is_placeholder || card.bonus_color === 'white' ? '#1f2430' : '#ffffff'}">${label}</text>
            ${card.is_placeholder ? '<text x="74" y="112" text-anchor="middle" font-size="72" font-weight="800" fill="#6b7380">?</text>' : renderCostRow(card.cost, 18, 150)}
          </g>
        `;
      };
      const renderNoble = (noble: NobleDTO | null, x: number, y: number): string => {
        if (!noble) {
          return `<rect x="${x}" y="${y}" width="132" height="100" rx="14" fill="#242a33" opacity="0.35" />`;
        }
        return `
          <g transform="translate(${x} ${y})">
            <rect x="0" y="0" width="132" height="100" rx="14" fill="#ece2c6" stroke="#5f4b2b" stroke-width="3" />
            <text x="18" y="28" font-size="26" font-weight="900" fill="#2b2111">${noble.points}</text>
            ${renderCostRow(noble.requirements, 14, 52)}
          </g>
        `;
      };
      const renderPlayer = (player: BoardStateDTO['players'][number], x: number, y: number): string => `
        <g transform="translate(${x} ${y})">
          <rect x="0" y="0" width="360" height="410" rx="18" fill="${panelFill}" stroke="rgba(255,255,255,0.08)" stroke-width="2" />
          <text x="24" y="38" font-size="28" font-weight="800" fill="${textLight}">${escapeXml(player.display_name)}</text>
          <text x="300" y="38" font-size="24" font-weight="800" fill="${textLight}">${player.points}★</text>
          <text x="24" y="76" font-size="18" font-weight="700" fill="${textMuted}">Tokens</text>
          ${tokenOrder.map((color, idx) => renderToken(18 + (idx % 3) * 106, 94 + Math.floor(idx / 3) * 76, color, player.tokens[color])).join('')}
          <text x="24" y="264" font-size="18" font-weight="700" fill="${textMuted}">Bonuses</text>
          ${reqOrder.map((color, idx) => renderToken(18 + idx * 66, 280, color, player.bonuses[color])).join('')}
          <text x="24" y="388" font-size="18" font-weight="700" fill="${textMuted}">Reserved ${player.reserved_total}/3</text>
          ${Array.from({ length: 3 }, (_, idx) => renderCard(
            player.reserved_public.find((card) => card.slot === idx) ?? {
              points: 0,
              bonus_color: 'white',
              cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
              source: 'reserved_public',
              slot: idx,
              is_placeholder: true,
            },
            18 + idx * 112,
            404,
            100,
            132,
          )).join('')}
        </g>
      `;

      const nobleBySlot = new Map((displayBoard.nobles ?? []).map((noble) => [noble.slot ?? -1, noble]));
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
          <rect width="${width}" height="${height}" fill="${pageBackground}" />
          ${renderPlayer(displayBoard.players[0], 40, 70)}
          ${renderPlayer(displayBoard.players[1], 40, 560)}
          <g transform="translate(440 60)">
            <rect x="0" y="0" width="1380" height="920" rx="26" fill="${boardFill}" />
            <g transform="translate(84 44)">
              ${[0, 1, 2].map((slot) => renderNoble(nobleBySlot.get(slot) ?? null, slot * 170, 0)).join('')}
            </g>
            <g transform="translate(680 56)">
              ${tokenOrder.map((color, idx) => renderToken(idx * 98, 0, color, displayBoard.bank[color])).join('')}
            </g>
            ${displayBoard.tiers.map((tier, rowIdx) => `
              <g transform="translate(72 ${188 + rowIdx * 238})">
                <rect x="0" y="0" width="118" height="196" rx="18" fill="#20252d" />
                <text x="59" y="82" text-anchor="middle" font-size="52" font-weight="900" fill="${textLight}">${tier.tier}</text>
                <text x="59" y="126" text-anchor="middle" font-size="26" font-weight="700" fill="${textMuted}">${tier.deck_count}</text>
                ${Array.from({ length: 4 }, (_, slot) => renderCard(
                  tier.cards.find((card) => card.slot === slot) ?? {
                    points: 0,
                    bonus_color: 'white',
                    cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
                    source: 'faceup',
                    tier: tier.tier,
                    slot,
                    is_placeholder: true,
                  },
                  156 + slot * 272,
                  0,
                )).join('')}
              </g>
            `).join('')}
          </g>
        </svg>
      `;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      const downloadBlob = (blob: Blob, extension: 'png' | 'svg'): void => {
        const downloadUrl = URL.createObjectURL(blob);
        try {
          const anchor = document.createElement('a');
          anchor.href = downloadUrl;
          anchor.download = `splendor-board-${timestamp}.${extension}`;
          anchor.click();
        } finally {
          URL.revokeObjectURL(downloadUrl);
        }
      };

      try {
        const scale = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Canvas export is unavailable.');
        }
        ctx.scale(scale, scale);

        const drawRoundedRect = (
          x: number,
          y: number,
          rectWidth: number,
          rectHeight: number,
          radius: number,
          fill: string,
          stroke?: string,
          strokeWidth = 1,
        ): void => {
          const safeRadius = Math.min(radius, rectWidth / 2, rectHeight / 2);
          ctx.beginPath();
          ctx.moveTo(x + safeRadius, y);
          ctx.lineTo(x + rectWidth - safeRadius, y);
          ctx.quadraticCurveTo(x + rectWidth, y, x + rectWidth, y + safeRadius);
          ctx.lineTo(x + rectWidth, y + rectHeight - safeRadius);
          ctx.quadraticCurveTo(x + rectWidth, y + rectHeight, x + rectWidth - safeRadius, y + rectHeight);
          ctx.lineTo(x + safeRadius, y + rectHeight);
          ctx.quadraticCurveTo(x, y + rectHeight, x, y + rectHeight - safeRadius);
          ctx.lineTo(x, y + safeRadius);
          ctx.quadraticCurveTo(x, y, x + safeRadius, y);
          ctx.closePath();
          ctx.fillStyle = fill;
          ctx.fill();
          if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = strokeWidth;
            ctx.stroke();
          }
        };

        const drawText = (
          text: string,
          x: number,
          y: number,
          font: string,
          fill: string,
          align: CanvasTextAlign = 'left',
        ): void => {
          ctx.font = font;
          ctx.fillStyle = fill;
          ctx.textAlign = align;
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(text, x, y);
        };

        const drawToken = (x: number, y: number, color: keyof TokenCountsDTO, count: number): void => {
          ctx.beginPath();
          ctx.arc(x + 30, y + 30, 24, 0, Math.PI * 2);
          ctx.fillStyle = colorMap[color];
          ctx.fill();
          ctx.strokeStyle = '#1e223080';
          ctx.lineWidth = 3;
          ctx.stroke();
          drawText(
            String(count),
            x + 30,
            y + 39,
            '800 26px Arial',
            color === 'white' || color === 'gold' ? '#1f2430' : '#ffffff',
            'center',
          );
        };

        const drawCostRow = (cost: ColorCountsDTO, startX: number, y: number): void => {
          reqOrder
            .filter((color) => cost[color] > 0)
            .forEach((color, idx) => {
              const cx = startX + idx * 34 + 14;
              const cy = y + 14;
              ctx.beginPath();
              ctx.arc(cx, cy, 14, 0, Math.PI * 2);
              ctx.fillStyle = colorMap[color];
              ctx.fill();
              ctx.strokeStyle = '#1e223080';
              ctx.lineWidth = 2;
              ctx.stroke();
              drawText(String(cost[color]), cx, y + 19, '800 14px Arial', '#ffffff', 'center');
            });
        };

        const drawCard = (card: CardDTO, x: number, y: number, widthPx = 148, heightPx = 196): void => {
          const stroke = card.is_placeholder ? '#a2abb9' : '#0f1320';
          const fill = card.is_placeholder ? '#c9cfd8' : '#f3efe4';
          const banner = card.is_placeholder ? '#d9dee6' : colorMap[card.bonus_color];
          const valueColor = card.is_placeholder || card.bonus_color === 'white' ? '#1f2430' : '#ffffff';
          drawRoundedRect(x, y, widthPx, heightPx, 14, fill, stroke, 3);
          drawRoundedRect(x, y, widthPx, 42, 14, banner);
          ctx.fillStyle = fill;
          ctx.fillRect(x, y + 14, widthPx, 28);
          drawText(card.is_placeholder ? '?' : String(card.points), x + 18, y + 30, '900 28px Arial', valueColor);
          if (card.is_placeholder) {
            drawText('?', x + widthPx / 2, y + 122, '800 72px Arial', '#6b7380', 'center');
          } else {
            drawCostRow(card.cost, x + 18, y + 150);
          }
        };

        const drawNoble = (noble: NobleDTO | null, x: number, y: number): void => {
          if (!noble) {
            ctx.save();
            ctx.globalAlpha = 0.35;
            drawRoundedRect(x, y, 132, 100, 14, '#242a33');
            ctx.restore();
            return;
          }
          drawRoundedRect(x, y, 132, 100, 14, '#ece2c6', '#5f4b2b', 3);
          drawText(String(noble.points), x + 18, y + 28, '900 26px Arial', '#2b2111');
          drawCostRow(noble.requirements, x + 14, y + 52);
        };

        const drawPlayer = (player: BoardStateDTO['players'][number], x: number, y: number): void => {
          drawRoundedRect(x, y, 360, 560, 18, panelFill, 'rgba(255,255,255,0.08)', 2);
          drawText(player.display_name, x + 24, y + 38, '800 28px Arial', textLight);
          drawText(`${player.points}*`, x + 320, y + 38, '800 24px Arial', textLight, 'right');
          drawText('Tokens', x + 24, y + 76, '700 18px Arial', textMuted);
          tokenOrder.forEach((color, idx) => {
            drawToken(x + 18 + (idx % 3) * 106, y + 94 + Math.floor(idx / 3) * 76, color, player.tokens[color]);
          });
          drawText('Bonuses', x + 24, y + 264, '700 18px Arial', textMuted);
          reqOrder.forEach((color, idx) => {
            drawToken(x + 18 + idx * 66, y + 280, color, player.bonuses[color]);
          });
          drawText(`Reserved ${player.reserved_total}/3`, x + 24, y + 388, '700 18px Arial', textMuted);
          Array.from({ length: 3 }, (_, idx) => {
            const fallbackCard: CardDTO = {
              points: 0,
              bonus_color: 'white',
              cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
              source: 'reserved_public',
              slot: idx,
              is_placeholder: true,
            };
            const card = player.reserved_public.find((item) => item.slot === idx) ?? fallbackCard;
            drawCard(card, x + 18 + idx * 112, y + 404, 100, 132);
            return null;
          });
        };

        ctx.fillStyle = pageBackground;
        ctx.fillRect(0, 0, width, height);
        drawPlayer(displayBoard.players[0], 40, 70);
        drawPlayer(displayBoard.players[1], 40, 560);
        drawRoundedRect(440, 60, 1380, 920, 26, boardFill);

        [0, 1, 2].forEach((slot) => {
          drawNoble(nobleBySlot.get(slot) ?? null, 524 + slot * 170, 104);
        });
        tokenOrder.forEach((color, idx) => {
          drawToken(1120 + idx * 98, 116, color, displayBoard.bank[color]);
        });
        displayBoard.tiers.forEach((tier, rowIdx) => {
          const rowX = 512;
          const rowY = 248 + rowIdx * 238;
          drawRoundedRect(rowX, rowY, 118, 196, 18, '#20252d');
          drawText(String(tier.tier), rowX + 59, rowY + 82, '900 52px Arial', textLight, 'center');
          drawText(String(tier.deck_count), rowX + 59, rowY + 126, '700 26px Arial', textMuted, 'center');
          Array.from({ length: 4 }, (_, slot) => {
            const fallbackCard: CardDTO = {
              points: 0,
              bonus_color: 'white',
              cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
              source: 'faceup',
              tier: tier.tier,
              slot,
              is_placeholder: true,
            };
            const card = tier.cards.find((item) => item.slot === slot) ?? fallbackCard;
            drawCard(card, rowX + 156 + slot * 272, rowY, 148, 196);
            return null;
          });
        });

        const pngBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Failed to encode board image.'));
            }
          }, 'image/png');
        });
        downloadBlob(pngBlob, 'png');
      } catch {
        const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        downloadBlob(svgBlob, 'svg');
      }
    } catch (err) {
      setError((err as Error).message);
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
      {!hideAllExceptBoard && (
      <header className="top-nav">
        <button type="button" className="brand-link" onClick={() => setHomeView('HOME')} aria-label="AhinLendor home">
          <img src="/ahin.svg" alt="" className="brand-mark" />
          <span className="brand-wordmark">AhinLendor</span>
        </button>
        <nav className="nav-links" aria-label="Primary navigation">
          <button
            type="button"
            className={`nav-link ${homeView === 'HOME' ? 'nav-link-active' : ''}`}
            onClick={() => setHomeView('HOME')}
          >
            <UiIcon name="home" />
            <span>Home</span>
          </button>
          <button
            type="button"
            className={`nav-link ${homeView === 'QUICK' ? 'nav-link-active' : ''}`}
            onClick={onOpenQuickView}
          >
            <UiIcon name="play" />
            <span>Quick Game</span>
          </button>
          <button
            type="button"
            className={`nav-link ${homeView === 'ANALYSIS' ? 'nav-link-active' : ''}`}
            onClick={onOpenManualView}
          >
            <UiIcon name="analysis" />
            <span>Analysis</span>
          </button>
          <button
            type="button"
            className={`nav-link ${homeView === 'ABOUT' ? 'nav-link-active' : ''}`}
            onClick={onOpenAboutView}
          >
            <UiIcon name="about" />
            <span>About</span>
          </button>
        </nav>
        <div className="header-actions auth-nav">
          {homeView !== 'HOME' && (
            <>
              {homeView === 'ANALYSIS' && snapshot && (
                <>
                  <button
                    type="button"
                    onClick={() => void onRunDeepAnalysis()}
                    disabled={isDeepAnalysisRunning || moveLogEntries.length === 0 || !canRunDeepAnalysisForCurrentSearch}
                    title={
                      searchType === 'alphabeta'
                        ? `Run deep analysis across all logged moves (depth ${alphabetaDepth})`
                        : searchType === 'forced_child'
                          ? `Run deep analysis across all logged moves (${deepAnalysisSimulations.toLocaleString()} per-action sims)`
                          : searchType === 'mcts_bootstrap'
                            ? `Run deep analysis across all logged moves (${deepAnalysisSimulations.toLocaleString()} total sims, bootstrap ${deepAnalysisBootstrapSimulationsPerAction.toLocaleString()} per action)`
                          : `Run deep analysis across all logged moves (${deepAnalysisSimulations.toLocaleString()} sims per move)`
                    }
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
            </>
          )}
        </div>
      </header>
      )}

      {homeView === 'HOME' && (
        <section className="home-landing">
          <div className="home-hero">
            <h2>AhinLendor</h2>
          </div>
          <div className="home-mode-grid">
            <button type="button" className="home-mode-card" onClick={onOpenQuickView}>
              <UiIcon name="play" />
              <strong>Quick Game</strong>
              <span>Engine vs human from a random opening.</span>
            </button>
            <button type="button" className="home-mode-card" onClick={onOpenManualView}>
              <UiIcon name="analysis" />
              <strong>Analysis</strong>
              <span>Manual setup with continuous analysis.</span>
            </button>
            <button type="button" className="home-mode-card" onClick={onOpenAboutView}>
              <UiIcon name="about" />
              <strong>About</strong>
              <span>Development notes, engine features, and project background.</span>
            </button>
          </div>
        </section>
      )}

      {(homeView === 'QUICK' || isSetupLikeView) && !snapshot && (
        <section className="panel loading-panel">
          <h2>{homeView === 'QUICK' ? 'Quick Game' : 'Analysis'}</h2>
          <p>{isAutoStartingGame ? 'Loading board...' : 'Preparing board...'}</p>
        </section>
      )}

      {homeView === 'ABOUT' && (
        <section className="panel about-panel">
          <h2>About AhinLendor</h2>
          <div className="about-content">
            <section>
              <h3>Development</h3>
              <p>
                AhinLendor is a Splendor analysis and play environment built around an engine-first workflow.
                This page can describe the training process, search improvements, and the design decisions behind the interface.
              </p>
            </section>
            <section>
              <h3>Features</h3>
              <p>
                Highlight quick play, manual analysis, move ranking, board reconstruction, and engine evaluation tools here.
              </p>
            </section>
            <section>
              <h3>Engine</h3>
              <p>
                Add notes about MCTS, bootstrap search, model checkpoints, and how AhinLendor evaluates Splendor positions.
              </p>
            </section>
          </div>
        </section>
      )}

      {isBoardView && (
        <section className={`panel game-layout ${hideAllExceptBoard ? 'board-only-mode' : ''}`}>
          <div className="board-column">
            <BoardViewport
              showEvaluation={showAnalysisUi && showBoardAnalysis && !hideAllExceptBoard}
              evalBarTopHeight={evalBarTopHeight}
              evalBarBottomHeight={evalBarBottomHeight}
              evalLabel={evalBarLabel}
              evalSide={evalBarSide}
            >
                {displayBoard ? (
                  <GameBoard
                    board={displayBoard}
                    isTerminal={snapshot.status !== 'IN_PROGRESS'}
                    mctsTopAction={liveMctsTopAction}
                    modelTopAction={liveModelTopAction}
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
                <div className="analysis-settings-wrap" ref={analysisSettingsRef}>
                  <button
                    type="button"
                    className={`analysis-settings-btn ${showAnalysisSettings ? 'active' : ''}`}
                    title={searchSettingsSummary}
                    aria-expanded={showAnalysisSettings}
                    aria-haspopup="dialog"
                    onClick={() => setShowAnalysisSettings((value) => !value)}
                  >
                    <svg className="analysis-settings-icon" viewBox="1 3 22 18" aria-hidden="true">
                      <path d="M3 6h18M3 12h18M3 18h18" />
                      <circle cx="8" cy="6" r="1.45" />
                      <circle cx="16" cy="12" r="1.45" />
                      <circle cx="10" cy="18" r="1.45" />
                    </svg>
                  </button>
                  {showAnalysisSettings && (
                    <div className="analysis-settings-popover" role="dialog" aria-label="Analysis settings">
                      {snapshot.status === 'IN_PROGRESS' && (snapshot.config?.analysis_mode || snapshot.player_to_move !== snapshot.config?.player_seat) && (
                        <div className="analysis-settings-section analysis-search-row">
                          <select
                            value={searchType}
                            onChange={(event) => setSearchType(event.target.value as SearchType)}
                            aria-label="Search type"
                          >
                            <option value="mcts">MCTS</option>
                            <option value="mcts_gpu">MCTS (GPU batched)</option>
                            <option value="mcts_bootstrap">MCTS Bootstrap</option>
                            <option value="ismcts">ISMCTS</option>
                            <option value="alphabeta">Alpha-Beta</option>
                            <option value="forced_child">Forced Search</option>
                          </select>
                          {isTreeSearchType && (
                            <input
                              type="number"
                              min={1}
                              max={LIVE_SEARCH_MAX_SIMULATIONS}
                              value={searchSimulations}
                              onChange={(event) => setSearchSimulations(Number(event.target.value))}
                              aria-label={homeView === 'LIVE' ? 'Intermediate publish simulations' : 'Search simulations'}
                              title={homeView === 'LIVE' ? 'Publish updated live analysis every N simulations during the same search job' : 'Search simulations'}
                            />
                          )}
                          {searchType === 'alphabeta' && (
                            <input
                              type="number"
                              min={1}
                              max={64}
                              value={alphabetaDepth}
                              onChange={(event) => setAlphabetaDepth(Number(event.target.value))}
                              aria-label="Alpha-Beta depth"
                              title="Alpha-Beta search depth"
                            />
                          )}
                          {searchType === 'forced_child' && (
                            <input
                              type="number"
                              min={1}
                              max={LIVE_SEARCH_MAX_SIMULATIONS}
                              value={searchSimulations}
                              onChange={(event) => setSearchSimulations(Number(event.target.value))}
                              aria-label="Forced search simulations per action"
                              title="Forced search simulations per action"
                            />
                          )}
                          {searchType === 'mcts_bootstrap' && (
                            <input
                              type="number"
                              min={1}
                              max={LIVE_SEARCH_MAX_SIMULATIONS}
                              value={searchBootstrapSimulationsPerAction}
                              onChange={(event) => setSearchBootstrapSimulationsPerAction(Number(event.target.value))}
                              aria-label="Bootstrap simulations per action"
                              title={bootstrapSettingsTitle}
                            />
                          )}
                          {usesEvalBatchSize && (
                            <input
                              type="number"
                              min={1}
                              max={MAX_EVAL_BATCH_SIZE}
                              value={searchEvalBatchSize}
                              onChange={(event) => setSearchEvalBatchSize(Number(event.target.value))}
                              aria-label="Search evaluation batch size"
                              title="Leaf evaluation batch size"
                            />
                          )}
                          <button
                            onClick={() => {
                              void startEngineThink();
                              setShowAnalysisSettings(false);
                            }}
                            disabled={!canRunCurrentSearch || uiStatus === 'WAITING_ENGINE'}
                          >
                            {homeView === 'LIVE' ? 'Analyze Turn' : 'Run Search'}
                          </button>
                        </div>
                      )}
                      {homeView === 'LIVE' && isTreeSearchType && (
                        <div className="analysis-settings-section analysis-search-row">
                          <span>Limit</span>
                          <span>{LIVE_SEARCH_MAX_SIMULATIONS.toLocaleString()} sims</span>
                        </div>
                      )}
                      {homeView !== 'LIVE' && (
                        <div className="analysis-settings-section analysis-search-row">
                          <span>{deepAnalysisSettingsLabel}</span>
                          {searchType === 'alphabeta' ? (
                            <input
                              type="number"
                              min={1}
                              max={64}
                              value={alphabetaDepth}
                              onChange={(event) => setAlphabetaDepth(Number(event.target.value))}
                              aria-label="Deep analysis Alpha-Beta depth"
                              title={deepAnalysisSettingsTitle}
                            />
                          ) : (
                            <input
                              type="number"
                              min={1}
                              max={LIVE_SEARCH_MAX_SIMULATIONS}
                              value={deepAnalysisSimulations}
                              onChange={(event) => setDeepAnalysisSimulations(Number(event.target.value))}
                              aria-label={searchType === 'forced_child' ? 'Deep analysis forced search simulations per action' : 'Deep analysis simulations'}
                              title={deepAnalysisSettingsTitle}
                            />
                          )}
                        </div>
                      )}
                      {homeView !== 'LIVE' && searchType === 'mcts_bootstrap' && (
                        <div className="analysis-settings-section analysis-search-row">
                          <span>Bootstrap</span>
                          <input
                            type="number"
                            min={1}
                            max={LIVE_SEARCH_MAX_SIMULATIONS}
                            value={deepAnalysisBootstrapSimulationsPerAction}
                            onChange={(event) => setDeepAnalysisBootstrapSimulationsPerAction(Number(event.target.value))}
                            aria-label="Deep analysis bootstrap simulations per action"
                            title="Bootstrap simulations per legal root action for each deep-analysis search"
                          />
                        </div>
                      )}
                      {homeView !== 'LIVE' && usesEvalBatchSize && (
                        <div className="analysis-settings-section analysis-search-row">
                          <span>Batch</span>
                          <input
                            type="number"
                            min={1}
                            max={MAX_EVAL_BATCH_SIZE}
                            value={deepAnalysisEvalBatchSize}
                            onChange={(event) => setDeepAnalysisEvalBatchSize(Number(event.target.value))}
                            aria-label="Deep analysis evaluation batch size"
                            title={deepAnalysisBatchSizeTitle}
                          />
                        </div>
                      )}
                      <div className="analysis-settings-section">
                        <label className="analysis-toggle">
                          <input
                            type="checkbox"
                            checked={hideAllExceptBoard}
                            onChange={(event) => {
                              const nextValue = event.target.checked;
                              setHideAllExceptBoard(nextValue);
                              if (nextValue) {
                                setShowAnalysisSettings(false);
                              }
                            }}
                          />
                          <span>Hide all except board</span>
                        </label>
                      </div>
                      <div className="analysis-settings-section">
                        <button
                          type="button"
                          onClick={() => {
                            void onSaveBoardImage();
                            setShowAnalysisSettings(false);
                          }}
                          disabled={!displayBoard}
                        >
                          Save board image
                        </button>
                      </div>
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
                          <div className="analysis-section-header">Top moves</div>
                          <div className="analysis-top-moves-list" role="list">
                          {topAnalysisMoves.length === 0 ? (
                            <div className="analysis-line placeholder" role="listitem">
                              <div className="analysis-line-name">{uiStatus === 'WAITING_REVEAL' ? 'Waiting for setup...' : 'Waiting for search...'}</div>
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
                  </div>
                )}
                {activePanelTab === 'MOVES' && (
                  <div className="analysis-move-groups" role="list">
                    {uiStatus === 'WAITING_REVEAL' ? null : allAnalysisMoves.length === 0 ? (
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
                          <div className="analysis-moves-list" role="list">
                            {group.moves.map((detail) => {
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
                                      hideVerb={group.key !== 'other'}
                                    />
                                  </div>
                                </button>
                              );
                            })}
                          </div>
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
                            ? liveAvailableCardIds.has(card.id)
                            : (isManualFreeEdit
                              ? true
                              : (isSetup ? !setupUnavailableCardIds.has(card.id) : liveAvailableCardIds.has(card.id)));
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
    </main>
  );
}
