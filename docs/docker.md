# Docker / Podman

A multi-stage [Dockerfile](../Dockerfile) produces a minimal production image with the frontend and the [portal](portal.md) pre-bundled.

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

If a reverse proxy (nginx, Caddy, Traefik) sits in front of the container, set `TRUSTED_PROXIES` to its address or network (for example `172.16.0.0/12` for Docker's default bridge networks). Otherwise every client appears with the proxy's IP and shares one rate-limit bucket and login-throttle counter. See [Reverse proxies](api-security-model.md#reverse-proxies).

Containers usually run in UTC. Set `WORKFLOW_TIMEZONE` (for example `Europe/Berlin`) so workflow date functions such as `today()` and `formatDate()` work in your local time.

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

## Extension Hub: git access

The image ships `git` and `openssh-client` for the [Extension Hub](extensions/extension-hub.md), which installs extensions from git repositories.

- **HTTPS** repositories need nothing extra; for private ones, enter an access token in the source dialog (stored in the secret vault).
- **SSH** repositories need a key and the server's host key. The container runs as root, so either mount them to `/root/.ssh`, or point git at mounted files:

```yaml
volumes:
  - ./secrets/palim_deploy_key:/run/secrets/palim_deploy_key:ro
  - ./secrets/known_hosts:/run/secrets/known_hosts:ro
environment:
  GIT_SSH_COMMAND: ssh -i /run/secrets/palim_deploy_key -o UserKnownHostsFile=/run/secrets/known_hosts -o BatchMode=yes
```

Use a read-only deploy key, and keep `BatchMode=yes` when you set `GIT_SSH_COMMAND` yourself, so a missing key fails instead of waiting for a prompt. Create `known_hosts` with `ssh-keyscan -p <port> <host> > known_hosts`.

## Volumes

The compose file defines two named volumes:

| Volume | Mounted at | Purpose |
| ------ | ---------- | ------- |
| `app-work` | `/app/.work` | Agent workspace (tasks, inbox, wiki, workflows) |
| `app-db` | `/app/.palim` | Default `DATA_DIR` containing SQLite databases (bunqueue, palim) |

Data in these volumes persists across container restarts and image rebuilds.

### Using host directories instead

If you prefer to mount directories from your host (e.g. to access workspace files directly or share them with other tools), replace the named volumes with bind mounts in `docker-compose.yml`:

```yaml
volumes:
  - ~/palim-work:/app/.work
  - ~/palim-db:/app/.palim
```

Or with `docker run`:

```bash
docker run \
  --env-file .env \
  -e WEB_HOST='::' \
  -v ~/palim-work:/app/.work \
  -v ~/palim-db:/app/.palim \
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
