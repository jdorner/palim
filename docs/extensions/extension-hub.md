# Extension Hub

The Extension Hub installs [external extensions](../writing-extensions.md#external-extensions) from git repositories, keeps track of their versions, and tells you when updates are available.

You can:

- register git repositories as **sources** (SSH, HTTPS, or a local path);
- see the extensions each source offers, with their released versions;
- install an extension by version, or from any tag, branch, or commit;
- update (including downgrades) and uninstall what you installed;
- let Palim check the sources periodically for new versions, and start workflows when it finds some.

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

| Field              | Description                                                                             |
| ------------------ | --------------------------------------------------------------------------------------- |
| Name               | Display name                                                                            |
| Repository URL     | `ssh://…`, `git@host:path`, `https://…`, or an absolute local path                      |
| Branch             | Branch offered for installs without a release. Empty = the repository's default branch. |
| HTTPS access token | Optional, for private HTTPS repositories                                                |

The token is stored encrypted in the secret vault as the extension secret `SOURCE_TOKEN_<source id>`. Clearing it or deleting the source deletes the secret, and on startup the hub removes tokens of sources that no longer exist. Some servers refuse git over HTTPS altogether: Gitea and Forgejo answer `Interacting with repositories by HTTP protocol is not allowed` when `DISABLE_HTTP_GIT` is on; use SSH there.

Saving clones the repository into a local mirror and lists its extensions. A source that can't be fetched is still saved, with the error shown, so you can correct the URL or credentials. **Fetch** updates one source. A source can only be deleted while nothing installed from it remains.

### Catalog

The catalog lists the extensions of each source:

- **Installed**: installed version and what it follows (a release tag, a branch, or a pinned commit).
- **Latest**: the newest release. Prereleases (`2.0.0-rc.1`) count only when **Include prereleases** is on in the hub's settings. Extensions without releases show the branch head.
- **Status**:

| Status             | Meaning                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Update: …          | A newer version is available                                                                   |
| Active             | Installed and running                                                                          |
| Disabled           | Loaded, but not enabled in the settings: it stays off after a restart. **Enable** turns it on. |
| Not loaded / Error | Installed, but loading or starting failed (see the tooltip and the server log)                 |
| Modified           | Files were changed after installing                                                            |
| Version mismatch   | The manifest's version differs from `package.json`                                             |
| Local folder       | A hand-placed folder with this name exists; the hub won't overwrite it                         |

Below the sources, **Installed from removed sources** lists installs whose source or folder no longer exists (they can still be uninstalled). Hand-placed extensions are not listed separately; see them under **Settings → Extensions**. When one has the same name as an extension a source offers, its catalog row shows **Local folder**, and the hub won't install over it.

## Installing

**Install** opens the version dialog:

- a **release** installs that tag; update checks then look for newer releases;
- the **branch** entry installs the current branch head; update checks then report every new commit on the branch;
- **Other tag, branch, or commit** installs any ref. A commit stays pinned and is never reported as outdated.

The hub extracts the extension into the external extensions directory (`<DATA_DIR>/extensions/<name>`), where Palim loads it, installing its dependencies first. If it fails to load, the hub removes it again and shows the error.

A freshly installed extension is loaded but stays **disabled**, like any new extension: it starts only once you enable it on the catalog row or in the settings. Errors in its start-up code therefore show up when you enable it, not during the install.

## Updating and uninstalling

- **Update** installs the available update. **Version…** switches to any other version, branch, or commit, including downgrades.
- An update is refused while the installed files were changed locally (**Modified**). The version dialog offers to replace them; the local changes are then lost.
- An update keeps the extension enabled or disabled as it was. If the new version of an enabled extension fails to load, the previous version is restored automatically. To go back to an older version later, pick it in **Version…**.
- **Uninstall** unloads the extension and deletes its files. Its settings and secrets are kept, so a later reinstall picks them up.

Each update briefly unloads the extension (usually about a second) before the new version loads.

When Palim runs with `bun run dev` (Bun's watch mode), Bun keeps the extension's other modules cached, so an update only takes full effect after restarting the server. The hub says so after each update, and the catalog may show **Version mismatch** until then. `bun run start` and the Docker image are not affected.

## Update checks

The hub fetches all sources every **Update check interval** minutes (default 360, 0 = only on demand) and once shortly after startup. **Check for updates** on the page runs a check immediately. When new updates appear, the sidebar badge and open hub pages update and the server log notes them. Sources that can't be fetched show up as warnings on the extension in the settings.

Updates are never installed automatically.

## Notifications

To be notified of new versions, create a workflow with the trigger type **Extension update** (`extension-update`). When a check (periodic or **Check for updates**) finds updates it hasn't seen before, the hub starts every enabled workflow with this trigger once, with all of them. What happens next is up to the workflow: a Telegram, ntfy, or Gotify message, an e-mail, a ticket.

- No workflow with this trigger means no notification. To pause notifications without deleting the workflows, turn off **Update notifications** in the hub settings; the workflows then show a warning. Updates found while it is off are not reported later.
- An update counts as new per extension, target version (tag or branch), and commit. Each one is reported once; a later release of the same extension is reported again, even when its tag points at the same commit.
- Updates already known at startup (from the local mirrors) are not reported, so a restart doesn't send anything again. Neither are updates that appear because of something you did yourself, such as installing an older version or turning on **Include prereleases**.
- Drafts and disabled workflows don't start. If a workflow can't be started, the server log says why; the check itself isn't affected.
- Runs started by the periodic check have no initiating user, so they are visible to admins. A check you start with **Check for updates** attributes the runs to you.

The workflow receives this trigger payload; the editor knows its fields, so you don't declare an output schema:

```json5
{
  updates: [
    {
      name: "imap-fetch",         // extension
      source: "Palim extensions", // source it was installed from
      installedVersion: "1.2.0",
      installedRef: "imap-fetch@1.2.0",
      latestRef: "imap-fetch@1.3.0",
      latestVersion: "1.3.0",     // null when unknown (branch head with a broken package.json)
      commit: "…",
    },
  ],
  checkedAt: "2026-11-23T10:00:00.000Z",
  hubUrl: "https://palim.example.com/ext-page/extension-hub/hub", // based on WEB_PUBLIC_URL
}
```

Example with the [Telegram](telegram.md) notify step:

```json5
{
  name: "extension-updates",
  trigger: { type: "extension-update" },
  enabled: true,
  steps: {
    notify: {
      type: "notify-telegram",
      message: 'New extension versions: {{ join(pluck(trigger.payload.updates, "latestRef"), ", ") }}\n{{ trigger.payload.hubUrl }}',
    },
  },
  edges: [],
}
```

## Settings

| Setting                         | Default | Description                                                |
| ------------------------------- | ------- | ---------------------------------------------------------- |
| Include prereleases             | off     | Offer prerelease versions as the latest version            |
| Update check interval (minutes) | 360     | How often sources are fetched; 0 turns periodic checks off |
| Update notifications            | on      | Start workflows with the Extension update trigger          |

## Coexistence with hand-placed extensions

The hub only touches folders it installed; it records them in Palim's database. Anything else in the external extensions directory is left alone (it appears under Settings → Extensions), and the hub refuses to install over it. If that directory is itself a git working copy you develop in, add the folders the hub installs to its `.gitignore`, or develop elsewhere and install through the hub.

## Storage

| Path                                          | Content                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `<DATA_DIR>/extension-hub/repos/`             | Local mirrors of the sources (bare git clones)                                            |
| `<DATA_DIR>/extension-hub/backup/`            | The old version of an extension while an update is loading (restored if the update fails) |
| `<DATA_DIR>/extension-hub/staging/`, `trash/` | Temporary folders during installs and removals                                            |
| `<DATA_DIR>/extensions/<name>/`               | Installed extensions, with a `.palim-source.json` note of their origin                    |
