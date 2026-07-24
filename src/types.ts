export type Seat = 'P0' | 'P1';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
export type SearchType = 'mcts' | 'mcts_gpu' | 'mcts_bootstrap' | 'ismcts' | 'alphabeta' | 'forced_child';

export interface ActionInfoDTO {
  action_idx: number;
  label: string;
  display?: ActionDisplayDTO | null;
}

export interface MoveLogEntryDTO {
  turn_index: number;
  result_turn_index: number;
  result_snapshot_index: number;
  actor: Seat;
  action_idx: number;
  label: string;
  display?: ActionDisplayDTO | null;
}

export interface GameConfigDTO {
  checkpoint_id: string;
  checkpoint_path: string;
  num_simulations: number;
  player_seat: Seat;
  seed: number;
  manual_reveal_mode: boolean;
  analysis_mode: boolean;
}

export interface ColorCountsDTO {
  white: number;
  blue: number;
  green: number;
  red: number;
  black: number;
}

export interface TokenCountsDTO extends ColorCountsDTO {
  gold: number;
}

export interface CardDTO {
  points: number;
  bonus_color: 'white' | 'blue' | 'green' | 'red' | 'black';
  cost: ColorCountsDTO;
  source: 'faceup' | 'reserved_public' | 'reserved_private';
  tier?: number;
  slot?: number;
  is_placeholder?: boolean;
}

export interface ActionDisplayDTO {
  kind: 'card' | 'deck' | 'tokens' | 'pass' | 'noble' | 'unknown';
  verb: 'BUY' | 'RESERVE' | 'TAKE' | 'RETURN' | 'PASS' | 'NOBLE' | 'UNKNOWN';
  card?: CardDTO | null;
  noble?: NobleDTO | null;
  tier?: number | null;
  token_colors?: Array<'white' | 'blue' | 'green' | 'red' | 'black'>;
  token_duplicate?: number | null;
  noble_slot?: number | null;
}

export interface NobleDTO {
  points: number;
  requirements: ColorCountsDTO;
  slot?: number;
  is_placeholder?: boolean;
}

export interface CatalogNobleDTO {
  id: number;
  points: number;
  requirements: ColorCountsDTO;
}

export interface TierRowDTO {
  tier: number;
  deck_count: number;
  cards: CardDTO[];
}

export interface PlayerBoardDTO {
  seat: Seat;
  display_name: string;
  role_label?: string;
  points: number;
  tokens: TokenCountsDTO;
  bonuses: ColorCountsDTO;
  reserved_public: CardDTO[];
  reserved_total: number;
  is_to_move: boolean;
}

export interface BoardStateDTO {
  meta: {
    target_points: number;
    turn_index: number;
    player_to_move: Seat;
  };
  players: [PlayerBoardDTO, PlayerBoardDTO];
  bank: TokenCountsDTO;
  nobles: NobleDTO[];
  tiers: [TierRowDTO, TierRowDTO, TierRowDTO];
}

export interface GameSnapshotDTO {
  game_id: string;
  status: string;
  player_to_move: Seat;
  legal_actions: number[];
  legal_action_details: ActionInfoDTO[];
  winner: number;
  turn_index: number;
  current_snapshot_index?: number | null;
  move_log: MoveLogEntryDTO[];
  config?: GameConfigDTO;
  board_state?: BoardStateDTO | null;
  pending_reveals: PendingRevealDTO[];
  hidden_deck_card_ids_by_tier: Record<number, number[]>;
  hidden_faceup_reveal_candidates: Record<string, number[]>;
  hidden_reserved_reveal_candidates: Record<string, number[]>;
  can_undo: boolean;
  can_redo: boolean;
}

export interface EngineThinkResponse {
  job_id: string;
  status: 'QUEUED' | 'RUNNING';
}

export interface EngineThinkRequest {
  num_simulations?: number;
  search_type?: SearchType;
  continuous_until_cancel?: boolean;
  max_total_simulations?: number;
  eval_batch_size?: number;
  alphabeta_depth?: number;
  forced_child_simulations_per_action?: number;
  bootstrap_simulations_per_action?: number;
  forced_root_action_idx?: number;
}

export interface EngineJobStatusDTO {
  job_id: string;
  status: JobStatus;
  error?: string | null;
  result?: {
    action_idx: number;
    search_type?: SearchType;
    search_phase?: 'bootstrap' | 'mcts' | 'complete';
    action_details: ActionVizDTO[];
    model_action_details?: ActionVizDTO[] | null;
    root_value?: number | null;
    selected_action_q?: number | null;
    total_simulations?: number | null;
  } | null;
}

export interface PlayerMoveResponse {
  snapshot: GameSnapshotDTO;
  engine_should_move: boolean;
}

export interface RevealCardResponse {
  snapshot: GameSnapshotDTO;
  engine_should_move: boolean;
}

export interface PlacementHintDTO {
  zone: 'faceup_card' | 'reserved_card' | 'bank_token' | 'other';
  tier?: number;
  slot?: number;
  color?: 'white' | 'blue' | 'green' | 'red' | 'black';
}

export interface ActionVizDTO {
  action_idx: number;
  label: string;
  display?: ActionDisplayDTO | null;
  masked: boolean;
  policy_prob: number;
  q_value?: number | null;
  pv_preview?: string | null;
  is_selected: boolean;
  placement_hint: PlacementHintDTO;
}

export interface PendingRevealDTO {
  zone: 'faceup_card' | 'reserved_card' | 'noble';
  tier: number;
  slot: number;
  reason: 'initial_setup' | 'replacement_after_buy' | 'replacement_after_reserve' | 'reserved_from_deck' | 'initial_noble_setup';
  actor?: Seat | null;
  action_idx?: number | null;
}

export interface GameReplayDTO {
  format: 'sgr';
  version: 1;
  game_id: string;
  created_at: string;
  catalog_version: 'standard-90-card-10-noble-v1';
  players: Record<Seat, { name: string }>;
  rules: {
    target_points: number;
    num_players: number;
  };
  setup: {
    faceup_cards: Record<number, number[]>;
    nobles: number[];
  };
  events: CompactReplayEventDTO[];
  result: {
    status: 'COMPLETED' | 'RESIGNED' | 'ABANDONED';
    winner: Seat | null;
    final_turn_index: number;
  };
}

export interface CompactReplayEventDTO {
  k: 'm' | 'rc' | 'rr' | 'rn' | 'rs';
  a?: number | null;
  p?: Seat | null;
  t?: number | null;
  s?: number | null;
  c?: number | null;
  n?: number | null;
}

export interface CatalogCardDTO {
  id: number;
  tier: number;
  points: number;
  bonus_color: 'white' | 'blue' | 'green' | 'red' | 'black';
  cost: ColorCountsDTO;
}
