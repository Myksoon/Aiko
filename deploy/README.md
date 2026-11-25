# Aiko Docker Deployment

Docker configuration for running Aiko Core (Node.js 24 with built-in admin panel and SQLite storage) portably across machines. Full operational details are in [docs/OPERATIONS.md](../docs/OPERATIONS.md).

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Aiko Core service, loopback ports, and persistent SQLite volume |
| `Dockerfile.core` | Multi-stage Node 24 image (`aiko-core`) running as non-root `aiko` |
| `aiko.docker.toml` | Container default config (`0.0.0.0` binds inside container) |
| `.env.example` | Optional Docker Compose overrides (`deploy/.env`) |
| `speech/` | Optional GPU speech worker Compose stack for Linux hosts |

Ignored build paths are listed in [`.dockerignore`](../.dockerignore). Local `.env`, `*.db`, and `profiles/*/data` files are never baked into the image.

## Quick Start

```bash
cp .env.example .env
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f core
```

The admin panel is available at `http://127.0.0.1:7878/`.

## Notes

- **Two `.env` files**: `deploy/.env` controls Docker Compose options (ports, image tag, UID/GID), while root `.env` holds runtime secrets (`LLM_API_KEY`, `DISCORD_BOT_TOKEN`, `AIKO_API_TOKEN`, etc.).
- **Container binds**: `aiko.docker.toml` binds `7878`, `7879`, and `7882` on `0.0.0.0` inside the container while Compose exposes them only on `127.0.0.1`. Do not mount a host `aiko.toml` / `miyoria.toml` bound to `127.0.0.1` directly into the container.
- **Persistent state**: SQLite (`sqlite:/data/aiko.db`) and extensions live in the `core-data` Docker volume, and `./profiles` is mounted at `/profiles`.
- **Single-image usage**:

```bash
docker build -f deploy/Dockerfile.core -t aiko-core .
docker run --rm --env-file .env -e DATABASE_URL=sqlite:/data/aiko.db -p 127.0.0.1:7878:7878 -v aiko-data:/data aiko-core
docker run --rm --env-file .env -e DATABASE_URL=sqlite:/data/aiko.db -v aiko-data:/data aiko-core doctor
```
