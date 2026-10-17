# Extension Hub

The Extension Hub installs [external extensions](../writing-extensions.md#external-extensions) from git repositories, keeps track of their versions, and tells you when updates are available.

You can:

- register git repositories as **sources** (SSH, HTTPS, or a local path);
- see the extensions each source offers, with their released versions;
- install an extension by version, or from any tag, branch, or commit;
- update, roll back, and uninstall what you installed;
- let Palim check the sources periodically for new versions.

Installing, updating, and removing extensions and sources needs the `manage Extension` permission (admins). Everyone else can see the catalog.

> Extensions run inside the Palim server with full access to it. Only add sources whose code you trust.

## Requirements

- `git` and `tar` on the server. The Docker image includes them; see [Docker](../docker.md#extension-hub-git-access) for SSH keys in containers.
- **SSH** sources use the server's SSH keys and `known_hosts`, without prompts. **HTTPS** sources can carry an access token, which is stored encrypted in the secret vault (this needs a configured vault).

## Repository layout

A source is a git repository with one folder per extension:

```text
palim-extensions/
├── imap-fetch/
│   ├── index.ts
│   ├── package.json      # "name": "imap-fetch", "version": "1.3.0"
│   └── ...
└── json-parse/
    ├── index.ts
    └── package.json
```

A folder is offered when it contains an `index.ts` and a `package.json` whose `name` equals the folder name and whose `version` is a semver version. Folders without `index.ts` (docs, tooling) are ignored. Folders with an `index.ts` but a missing or invalid `package.json` are listed as **Not installable**, with the reason as a tooltip.

**Releases** are tags named `<name>@<version>`, for example `imap-fetch@1.3.0`. The tagged commit's `package.json` should carry the same version; the version dialog warns when it doesn't. See [Publishing for the Extension Hub](../writing-extensions.md#publishing-for-the-extension-hub).

## The Extension Hub page

Open **Extension Hub** in the sidebar. Its badge shows the number of available updates.

### Sources

**Add source** asks for:

| Field | Description |
| --- | --- |
| Name | Display name |
| Repository URL | `ssh://…`, `git@host:path`, `https://…`, or an absolute local path |
| Branch | Branch offered for installs without a release. Empty = the repository's default branch. |
| HTTPS access token | Optional, for private HTTPS repositories |

Saving clones the repository into a local mirror and lists its extensions. A source that can't be fetched is still saved, with the error shown, so you can correct the URL or credentials. **Fetch** updates one source. A source can only be deleted while nothing installed from it remains.

### Catalog

The catalog lists the extensions of each source:

- **Installed**: installed version and what it follows (a release tag, a branch, or a pinned commit).
- **Latest**: the newest release. Prereleases (`2.0.0-rc.1`) count only when **Include prereleases** is on in the hub's settings. Extensions without releases show the branch head.
- **Status**:

| Status | Meaning |
| --- | --- |
| Update: … | A newer version is available |
| Active | Installed and running |
| Disabled | Loaded, but not enabled in the settings: it stays off after a restart. **Enable** turns it on. |
| Not loaded / Error | Installed, but loading or starting failed (see the tooltip and the server log) |
| Modified | Files were changed after installing |
| Version mismatch | The manifest's version differs from `package.json` |
| Local folder | A hand-placed folder with this name exists; the hub won't overwrite it |

Below the sources, **Installed from removed sources** lists installs whose source or folder no longer exists (they can still be rolled back or uninstalled), and **Local extensions** lists hand-placed folders, which the hub never changes.

## Installing

**Install** opens the version dialog:

- a **release** installs that tag; update checks then look for newer releases;
- the **branch** entry installs the current branch head; update checks then report every new commit on the branch;
- **Other tag, branch, or commit** installs any ref. A commit stays pinned and is never reported as outdated.

The hub extracts the extension into the external extensions directory (`<DATA_DIR>/extensions/<name>`), where Palim loads it, installing its dependencies first. If it fails to load, the hub removes it again and shows the error.

A freshly installed extension runs right away but is **disabled** in the settings, like any new extension. Enable it on the catalog row or in the settings so it stays active after a restart.

## Updating, rolling back, uninstalling

- **Update** installs the available update. **Version…** switches to any other version, branch, or commit, including downgrades.
- An update is refused while the installed files were changed locally (**Modified**). The version dialog offers to replace the changes; the changed files are kept as the rollback backup.
- If the new version fails to load, the previous version is restored automatically.
- **Back to …** swaps in the version that the last update replaced. Doing it twice returns to the newer version. One previous version is kept.
- **Uninstall** unloads the extension and deletes its files. Its settings and secrets are kept, so a later reinstall picks them up.

Each update or rollback briefly unloads the extension (usually about a second) before the new version loads.

When Palim runs with `bun run dev` (Bun's watch mode), Bun keeps the extension's other modules cached, so an update or rollback only takes full effect after restarting the server. The hub says so after each update, and the catalog may show **Version mismatch** until then. `bun run start` and the Docker image are not affected.

## Update checks

The hub fetches all sources every **Update check interval** minutes (default 360, 0 = only on demand) and once shortly after startup. **Check for updates** on the page runs a check immediately. When new updates appear, the sidebar badge and open hub pages update and the server log notes them. Sources that can't be fetched show up as warnings on the extension in the settings.

Updates are never installed automatically.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Include prereleases | off | Offer prerelease versions as the latest version |
| Update check interval (minutes) | 360 | How often sources are fetched; 0 turns periodic checks off |

## Coexistence with hand-placed extensions

The hub only touches folders it installed; it records them in Palim's database. Anything else in the external extensions directory is listed as local and left alone, and the hub refuses to install over it. If that directory is itself a git working copy you develop in, add the folders the hub installs to its `.gitignore`, or develop elsewhere and install through the hub.

## Storage

| Path | Content |
| --- | --- |
| `<DATA_DIR>/extension-hub/repos/` | Local mirrors of the sources (bare git clones) |
| `<DATA_DIR>/extension-hub/backup/` | The previous version of each updated extension (for rollback) |
| `<DATA_DIR>/extension-hub/staging/`, `trash/` | Temporary folders during installs and removals |
| `<DATA_DIR>/extensions/<name>/` | Installed extensions, with a `.palim-source.json` note of their origin |
