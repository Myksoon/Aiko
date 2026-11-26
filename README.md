<div align="center">

<img src="docs/assets/aiko-logo-rounded.png" width="180" alt="Aiko">

<h1 align="center">Aiko</h1>

<p align="center"><b>Hi! I'm Aiko</b> - an autonomous AI companion for Discord, open source</p>

<p align="center">
  <img src="https://img.shields.io/badge/Made%20with-Love-ec6aa8?style=flat-square" alt="Made with Love">
  <a href="https://github.com/Myksoon/Aiko"><img src="https://img.shields.io/badge/GitHub-Myksoon%2FAiko-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub Myksoon/Aiko"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Docker-0078d4?style=flat-square" alt="Platform Windows and Docker">
  <img src="https://img.shields.io/badge/node-24-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/python-3.11%2B-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.11+">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/core-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript core">
  <img src="https://img.shields.io/badge/store-SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite store">
  <img src="https://img.shields.io/badge/platform-Discord-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord">
  <img src="https://img.shields.io/badge/deploy-Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
</p>

<p align="center">
  <a href="https://github.com/Myksoon/Aiko/actions/workflows/ci.yml"><img src="https://github.com/Myksoon/Aiko/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/Myksoon/Aiko/stargazers"><img src="https://img.shields.io/github/stars/Myksoon/Aiko?style=flat-square&logo=github" alt="GitHub stars"></a>
</p>

</div>

Aiko is an autonomous AI companion for Discord that chats, reacts to images, sends reaction GIFs, joins voice channels, and manages memory inside guardrails you configure. You can switch between three personas (Kuudere, E-Girl, Tsundere) from the Windows control window.

Aiko runs on a modular TypeScript core backed by SQLite, with optional Python GPU workers for speech recognition, voice cloning, and singing. Every conversation, decision, and outgoing message passes through explicit safety, moderation, and language filters before reaching Discord.

---

## Quick Start

Run Aiko in Docker to move cleanly across laptops, desktops, or servers, or run directly from source with Node.js 24.

### Docker (Recommended for Portability)

```bash
git clone https://github.com/Myksoon/Aiko.git && cd Aiko
cp .env.example .env
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d --build
```

Open the admin panel at `http://127.0.0.1:7878/`.

### Local Node.js 24 Setup

```bash
git clone https://github.com/Myksoon/Aiko.git && cd Aiko
node scripts/setup.mjs
pnpm build:web
pnpm dev up
```

On Windows, you can also double-click `Aiko Control.cmd` to start, stop, and switch text/self-chat and voice services.

## Hardware and System Requirements

Choose the tier that matches the modules you plan to run:

| Mode | CPU | RAM | GPU / VRAM | Disk | Notes |
|---|---|---|---|---|---|
| Text-only (Cloud LLM, Local or Docker) | 2 vCPU | 1-2 GB | None | ~1 GB | Runs on any laptop, VPS, or Docker host |
| Text + Voice (Local ASR + Cloud TTS) | 4+ cores | 8 GB | NVIDIA 4-6 GB VRAM | ~6 GB | Tested on RTX 2060 6 GB; CPU fallback works for SenseVoice |
| Full Local Voice (Qwen3-ASR + Qwen3-TTS) | 6+ cores | 16 GB | NVIDIA 8-12 GB VRAM | ~15 GB | RTX 3060 12 GB / RTX 4060 Ti or higher, CUDA 12+ |
| Full Stack (Voice + Singing / Stage) | 8+ cores | 16-32 GB | NVIDIA 12-16+ GB VRAM | ~25 GB | Demucs + Seed-VC singing and live overlay rendering |

Software prerequisites:

- **Core (Docker):** Docker Engine 24+ and Docker Compose v2.
- **Core (Native):** Node.js 24+ and pnpm 9+ (`corepack enable`).
- **Voice Workers (Optional):** Python 3.11+ managed with [uv](https://docs.astral.sh/uv/) and NVIDIA CUDA drivers for GPU acceleration.

## Docker Deployment

The Docker setup isolates Core in a non-root Node 24 container (`aiko-core`) with read-only root filesystem, loopback-only host port bindings (`127.0.0.1`), and a persistent `core-data` volume for SQLite.

1. Create your environment files from the templates:

```bash
cp .env.example .env
cp deploy/.env.example deploy/.env
```

2. Edit `.env` with your LLM key, Discord token, owner ID, and a generated `AIKO_API_TOKEN`.
3. Build and start Core:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f core
```

4. Optional GPU speech workers on the host (`http://127.0.0.1:8001` and `8002`):

```bash
cd workers && docker compose up -d --build
```

The Core container reaches host workers automatically via `host.docker.internal`. See [deploy/README.md](deploy/README.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md) for backups, custom container configs, and single-image usage.

## Configuration

Runtime secrets belong in the root `.env` file (never commit `.env` to git):

| Name | Default | Description |
|---|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible or DeepSeek API base URL |
| `LLM_API_KEY` | empty | API key for chat, reflection, and memory summarization |
| `DISCORD_BOT_TOKEN` | empty | Discord bot token for text chat and slash commands |
| `DISCORD_SELF_TOKEN` | empty | Optional self-account token if using self-chat mode |
| `AIKO_OWNER_ID` | empty | Your Discord user ID for owner permissions (`MIYORIA_OWNER_ID` alias supported) |
| `AIKO_API_TOKEN` | empty | Bearer token protecting the admin API and web panel (`MIYORIA_API_TOKEN` alias supported) |
| `DISCORD_CLIENT_ID` | empty | Optional Discord OAuth2 client ID for web panel login |
| `DISCORD_CLIENT_SECRET` | empty | Optional Discord OAuth2 client secret |
| `VOICE_LINK_TOKEN` | empty | Shared token for remote `voice-node` connections |
| `STAGE_LINK_TOKEN` | empty | Shared token for remote Stage / OBS connections |
| `TAVILY_API_KEY` | empty | Optional Tavily key for web search (uses DuckDuckGo if empty) |
| `IMAGE_API_KEY` | empty | Optional API key for photo generation in `draw_picture` |
| `IMAGE_BASE_URL` | empty | Optional base URL for the image generation backend |
| `IMAGE_MODEL` | empty | Optional image model override |
| `DATABASE_URL` | `sqlite:data/aiko.db` | SQLite database path (`memory://` for ephemeral test runs) |

## Capabilities

| Area | What Aiko Does |
|---|---|
| Chat & Personality | Replies in natural bilingual casual Bahasa Indonesia and English inside a calm kuudere persona (with Indonesian priority and CJK output filtering for non-CJK profiles) |
| Live Discord Presence | Syncs active Discord presence (`osu!`, `YouTube Music`, `Roblox`, `Minecraft`, `Stardew Valley`) directly into current turn context |
| Vision & Image Reactions | Reads images posted in Discord chats and responds specifically to the image content when appropriate |
| GIFs & Drawing | Sends anime reaction GIFs (`anime_gif`), Discord meme GIFs (`tenor_gif`), and persistent sketchbook/pixel/photo canvases (`draw_picture`) |
| Voice | Listens with Qwen3-ASR / SenseVoice, speaks via TTS, and supports selective barge-in |
| Memory & Notebook | Stores conversational recaps, per-person impressions, working notes, and short-TTL background activity |
| Web Tools | Searches and reads public web pages (`web_search`, `web_read`, `web_image`) as untrusted quoted data |
| Safety & Guardrails | Enforces owner rules, moderation checks, hourly spend/token caps, SFW picture filters, and opt-out privacy (`/me privacy`) |
| Multi-Machine (`hostd`) | Runs services on one PC or splits Core and GPU workers across machines over port 7880 |

## Multi-Machine Setup

Every host runs `hostd` from `host.toml` to supervise services, restart crashes, and collect logs:

```bash
pnpm dev init                 # write initial config and host.toml
pnpm dev add asr tts turn     # install Python speech workers with uv
pnpm dev doctor               # verify environments, models, and ports
pnpm dev up                   # start hostd and enabled services
pnpm dev status               # check running services and LLM usage
pnpm dev down                 # stop all services and hostd
```

To attach a secondary GPU machine without duplicating Discord tokens or databases:

```bash
pnpm dev host invite                         # on the Core machine
pnpm dev host join <core-address> --code <c> # on the GPU machine
pnpm dev host approve <name>                 # on the Core machine
```

## Project Structure

```text
packages/         Core modules (brain, heart, memory, runtime, discord, api, cli, hostd, store, types)
apps/panel        Admin web panel served by Core on :7878
apps/overlay      OBS browser-source overlay
apps/voice-node   Discord voice client and Go Live node
workers/          Python GPU inference workers (asr, tts, sing, turn)
profiles/         Character profiles (Aiko persona, rules, lorebook, examples)
deploy/           Dockerfiles and Compose definitions for Core and speech workers
docs/             Architecture, operations, setup, and design documents
```

## Running Tests

Typecheck, lint, build the web panel, and run unit tests from the repository root:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build:web
```

## Documentation

- [Docker Deployment Guide](deploy/README.md)
- [Operations Manual](docs/OPERATIONS.md)
- [Setup Guide](docs/SETUP.md)
- [Architecture Overview](docs/ARCHITECTURE.md)
- [Speech Workers](workers/README.md)
- [Voice Node](apps/voice-node/README.md)

## License

No license has been selected yet; all rights are reserved by the repository owner.
