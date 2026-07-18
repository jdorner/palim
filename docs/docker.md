# Docker / Podman

A multi-stage [Dockerfile](../Dockerfile) produces a minimal production image with the frontend pre-bundled.

## Quick Start

```bash
# 1. Run setup to create your .env (if you haven't already)
bun run setup

# 2. Build the image
docker build -t palim .

# 3. Run with your .env injected at runtime
docker compose up
```

Or without compose:

```bash
docker run \
  --env-file .env \
  -e WEB_HOST='::' \
  -e OPENAI_API_BASE_URL='http://host.containers.internal:11434/v1' \
  -p 3000:3000 \
  --name palim \
  -it palim
```

Everything above works identically with Podman:

```bash
podman compose up --build
```

## Networking

Set `WEB_HOST=::` so the server binds to all interfaces (IPv4 and IPv6) inside the container, which is required for port mapping to work.

A [`docker-compose.yml`](../docker-compose.yml) is provided for volume-managed runs with persistent workspace and database data.

## Connecting to a Local LLM

If your LLM runs on the host machine (e.g. llama.cpp on `localhost:11434`), the container cannot reach it via `localhost` because that refers to the container's own network namespace.

The `docker-compose.yml` overrides `OPENAI_API_BASE_URL` with a special hostname that resolves to the host:

| Runtime | Hostname                   |
| ------- | -------------------------- |
| Podman  | `host.containers.internal` |
| Docker  | `host.docker.internal`     |

The provided compose file uses the Podman variant by default. If you use Docker, change it in the `environment` section of `docker-compose.yml`:

```yaml
environment:
  OPENAI_API_BASE_URL: http://host.docker.internal:11434/v1
```

The `environment` key in compose takes precedence over values from `env_file`, so your local `.env` stays unchanged (pointing at `localhost` for native development) while the container gets the correct host-reachable URL at runtime.

## Volumes

The compose file defines two named volumes:

| Volume | Mounted at | Purpose |
| ------ | ---------- | ------- |
| `app-work` | `/app/.work` | Agent workspace (tasks, inbox, wiki, workflows) |
| `app-db` | `/app/.db` | SQLite databases (bunqueue, palim) |

Data in these volumes persists across container restarts and image rebuilds.

### Using host directories instead

If you prefer to mount directories from your host (e.g. to access workspace files directly or share them with other tools), replace the named volumes with bind mounts in `docker-compose.yml`:

```yaml
volumes:
  - ~/palim-work:/app/.work
  - ~/palim-db:/app/.db
```

Or with `docker run`:

```bash
docker run \
  --env-file .env \
  -e WEB_HOST='::' \
  -v ~/palim-work:/app/.work \
  -v ~/palim-db:/app/.db \
  -p 3000:3000 \
  --name palim \
  -it palim
```

Note: the container runs as root, so files created inside will be owned by `root` on the host. With Podman you can add `--userns=keep-id` to map the container root to your host user.

## Environment Variables

The container reads environment variables from two sources (in order of precedence):

1. **`environment`** in `docker-compose.yml` - explicit overrides (highest priority)
2. **`env_file`** - your `.env` file injected at runtime

This means you can keep your `.env` pointed at `localhost` for native development while compose overrides only what's needed for the container context.

See the main [Configuration](../README.md#configuration) section for all available variables.
