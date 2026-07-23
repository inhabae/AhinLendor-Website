# AhinLendor

AhinLendor is the standalone web application for the Splendor-Zero engine. It combines a React/TypeScript interface, a FastAPI service, and the packaged native Splendor engine in one deployable CPU container.

The interface provides three URL-backed modes:

- `/` — mode selection and application status.
- `/quick` — human versus engine games from a random opening.
- `/analysis` — manual setup, continuous search, variations, deep analysis, save/load, and replay navigation.

## Local development

Requirements:

- Node.js 22+
- Python 3.12+
- A built or installed `splendor-zero` engine package

Install and run the frontend:

```bash
npm install
npm run dev
```

Install the engine and API from sibling checkouts:

```bash
python -m pip install -e ../Splendor-Zero
python -m pip install -e '.[test]'
uvicorn ahinlendor.main:app --reload --port 8000
```

Vite proxies `/api` and `/healthz` to `http://127.0.0.1:8000`. Override this with `AHINLENDOR_API_URL` when necessary.

## Configuration

Copy `.env.example` to `.env` when you need to override runtime paths:

| Variable | Purpose |
| --- | --- |
| `AHINLENDOR_CHECKPOINT_DIR` | Read-only directory containing `.pt` checkpoints |
| `AHINLENDOR_DEFAULT_CHECKPOINT` | Checkpoint filename or id that should be used automatically |
| `AHINLENDOR_WEB_DIST_DIR` | Built Vite distribution served by FastAPI |

The application is intentionally single-user and should sit behind a private network or upstream access gateway.

## CPU Docker deployment

The image builds the frontend, builds the pinned Splendor-Zero native wheel, installs CPU PyTorch, and runs one Uvicorn worker:

```bash
cp .env.example .env
docker compose build
docker compose up -d
```

Place checkpoints under `data/checkpoints/`. The app defaults to `train_1773766638_123_resume_cycle_1405.pt`, so keep that file there or set `AHINLENDOR_DEFAULT_CHECKPOINT` to a different filename. Compose binds the service to `127.0.0.1:8000`; expose it through your private reverse proxy or access gateway. The health endpoint is `/healthz`.

To build against a different engine revision:

```bash
docker build --build-arg SPLENDOR_ZERO_REF=<commit-or-tag> -t ahinlendor .
```

## Validation

```bash
npm test
npm run build
PYTHONPATH=backend:../Splendor-Zero python -m pytest tests/backend
```

The native game/search smoke test additionally requires at least one compatible `.pt` checkpoint in the configured checkpoint directory.
