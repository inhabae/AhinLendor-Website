FROM node:22-bookworm-slim AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM python:3.12-slim-bookworm AS engine-builder
ARG SPLENDOR_ZERO_URL=https://github.com/inhabae/Splendor-Zero.git
ARG SPLENDOR_ZERO_REF=7451e107189c726345042a62c67b279bc16d3f64
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ninja-build \
    && rm -rf /var/lib/apt/lists/*
RUN python -m pip install --no-cache-dir build pybind11 scikit-build-core
WORKDIR /engine
COPY docker/splendor-pyproject.toml /tmp/splendor-pyproject.toml
COPY docker/splendor-package.patch /tmp/splendor-package.patch
RUN git clone --filter=blob:none "${SPLENDOR_ZERO_URL}" source \
    && cd source \
    && git checkout "${SPLENDOR_ZERO_REF}" \
    && git apply /tmp/splendor-package.patch \
    && cp /tmp/splendor-pyproject.toml pyproject.toml \
    && python -m build --wheel --outdir /wheels

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AHINLENDOR_CHECKPOINT_DIR=/data/checkpoints \
    AHINLENDOR_SELFPLAY_DIR=/data/selfplay \
    AHINLENDOR_LIVE_SAVE_PATH=/data/live/current.json \
    AHINLENDOR_WEB_DIST_DIR=/app/dist
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY backend ./backend
COPY --from=engine-builder /wheels /wheels
RUN python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
    && python -m pip install --no-cache-dir /wheels/*.whl .
COPY --from=frontend /src/dist ./dist
RUN mkdir -p /data/checkpoints /data/selfplay /data/live
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"
CMD ["uvicorn", "ahinlendor.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
