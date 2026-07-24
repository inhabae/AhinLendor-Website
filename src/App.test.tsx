import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const emptySnapshot = {
  game_id: 'test-game',
  status: 'IN_PROGRESS',
  player_to_move: 'P0',
  legal_actions: [],
  legal_action_details: [],
  winner: -1,
  turn_index: 0,
  current_snapshot_index: null,
  move_log: [],
  config: {
    checkpoint_id: 'default',
    checkpoint_path: '/data/checkpoints/default.pt',
    num_simulations: 400,
    player_seat: 'P0',
    seed: 1,
    manual_reveal_mode: false,
    analysis_mode: false,
  },
  board_state: null,
  pending_reveals: [],
  hidden_deck_card_ids_by_tier: {},
  hidden_faceup_reveal_candidates: {},
  hidden_reserved_reveal_candidates: {},
  can_undo: false,
  can_redo: false,
};

describe('AhinLendor routing and setup', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/game/new') {
        return Promise.resolve(jsonResponse(emptySnapshot));
      }
      return Promise.resolve(jsonResponse([]));
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('opens Quick Game from the home mode card and updates the URL', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /play as player 1/i }));
    expect(window.location.pathname).toBe('/quick');
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        '/api/game/new',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"analysis_mode":false'),
        }),
      );
    });
  });

  it('prompts before starting Analysis from a direct URL', async () => {
    window.history.replaceState({}, '', '/analysis');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Analysis' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load replay/i })).toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith('/api/game/new', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: /new analysis/i }));
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        '/api/game/new',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"manual_reveal_mode":true'),
        }),
      );
    });
    expect(screen.queryByRole('button', { name: 'Setup' })).not.toBeInTheDocument();
  });

  it('surfaces API initialization failures', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 500, statusText: 'Server Error' }))));
    render(<App />);
    expect(await screen.findByText(/Error:/)).toBeInTheDocument();
  });
});
