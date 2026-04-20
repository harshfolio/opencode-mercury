# OpenCode Mercury

A private installable OpenCode plugin that gives any user:
- a portable PKM vault
- a compact hot-memory layer
- existing-knowledge import into that vault
- vault re-indexing while OpenCode is active
- OpenCode session backfill from the local OpenCode database
- automatic session-aware memory refresh while OpenCode is active
- periodic backups for the vault, OpenCode config, and OpenCode runtime state
- dropbox-style note ingestion into the vault inbox

## What it creates

### Vault
- `Vault Home.md`
- `AGENTS.md`
- `00-09 Inbox/`
- `10-19 Projects/`
- `20-29 Areas/`
- `30-69 Resources/`
- `80-89 Engineering/`
- `90-99 Archive/`
- `_agent/context.md`

### Hot memory
- `overview.md`
- `user-profile.md`
- `current-priorities.md`
- `active-context.md`
- `session-ledger.jsonl`
- `corrections.jsonl`
- `knowledge-index.json`
- `dropbox/`
- `.plugin-state.json`
- `logs/`
- `domains/`

Mercury also manages `dropbox/processed`, `dropbox/failed`, and extra domain files such as `domains/social-media.md` and `domains/finance.md`.

## Runtime requirements

- Node.js 22+ (Mercury uses `node:sqlite`)
- An OpenCode build that supports the hooks Mercury uses: `chat.message`, `command.execute.before`, `experimental.chat.system.transform`, and `experimental.session.compacting`

## Backup coverage

By default Mercury snapshots three surfaces into a backup root outside the vault/config trees:

- the configured vault
- the OpenCode config root (usually `~/.config/opencode`)
- the OpenCode runtime/state directory that contains `opencode.db`

Defaults:

- backup interval: every 12 hours while OpenCode is active
- retention: last 14 snapshots per scope
- default backup root on macOS: `~/Library/Application Support/opencode-mercury/backups`

## Install

Add the plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@harshfolio/opencode-mercury",
      {
        "vaultPath": "~/Documents/Vault42",
        "memoryPath": "~/.config/opencode/memory",
        "opencodeConfigPath": "~/.config/opencode",
        "backupRoot": "~/Library/Application Support/opencode-mercury/backups",
        "backupIntervalHours": 12,
        "backupRetentionCount": 14,
        "userDisplayName": "Your Name",
        "primaryWork": "Product, engineering, and operations"
      }
    ]
  ]
}
```

Or install with:

```bash
opencode plugin @harshfolio/opencode-mercury --global
```

For local development on this machine, prefer the built entrypoint instead of the repo directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///Users/harshsharma/Documents/Side%20Projects/opencode-pkm-memory-plugin/dist/server.js",
      {
        "vaultPath": "~/Documents/Vault42",
        "memoryPath": "~/.config/opencode/memory",
        "opencodeConfigPath": "~/.config/opencode",
        "backupRoot": "~/Library/Application Support/opencode-mercury/backups"
      }
    ]
  ]
}
```

## Private package publishing

This package is configured for GitHub Packages as a private scoped package under `@harshfolio`.

To install from GitHub Packages, the user needs npm auth for `npm.pkg.github.com`.

Example `.npmrc`:

```ini
@harshfolio:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

## How it works

- On first use, it scaffolds a generic vault and memory layer if they do not exist.
- Mercury is hook-driven, not daemon-driven: while OpenCode is active, chat/command/system hooks keep the memory layer fresh without requiring launchd/cron.
- Mercury starts an autonomous maintenance controller on plugin load, so it can keep refreshing while OpenCode stays open.
- On each user message, it updates session-ledger state and recent-work context without doing the heavier vault walk.
- It opportunistically backfills recent OpenCode sessions and corrections from the local `opencode.db`.
- It scans the configured vault on maintenance intervals while OpenCode is active and also reacts to vault/dropbox file-watch events when supported.
- On each command run, it opportunistically ingests notes dropped into the memory dropbox.
- It injects both `overview.md` and `active-context.md` into the OpenCode system context with a capped context budget so the agent starts with compact, current context instead of bloated history.
- `pkm_refresh` exists as an escape hatch, not the normal maintenance path.
- `pkm_status` reports whether local `opencode.db` backfill is actually available, plus whether core state files were readable.
- The same maintenance controller also creates periodic backups for the vault, OpenCode config, and OpenCode runtime state.

In practice, Mercury stays updated in three layers:

1. **Startup maintenance** when the plugin loads
2. **Autonomous background maintenance** on a fixed interval while OpenCode is open
3. **Watch-triggered maintenance** when vault or dropbox files change

## Tools

- `pkm_bootstrap` — initialize or reinitialize the vault + memory scaffold
- `pkm_status` — inspect configured paths and current memory health
- `pkm_refresh` — force a full refresh across sessions, vault knowledge, and derived memory
- `pkm_backup_now` — force immediate backups for the vault and OpenCode surfaces Mercury protects
- `pkm_import_knowledge` — import or re-index existing notes so Mercury can learn from them
- `pkm_ingest_note` — turn raw note text into a vault inbox note immediately

`pkm_status` also reports whether local `opencode.db` backfill is available on the current machine, plus backup root, interval, retention, and last snapshot metadata.

## Current setup migration

If you already use `Vault42` plus `~/.config/opencode/memory`, point Mercury at those same paths so the plugin owns the same memory surface instead of creating a second parallel setup:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@harshfolio/opencode-mercury",
      {
        "vaultPath": "~/Documents/Vault42",
        "memoryPath": "~/.config/opencode/memory",
        "opencodeConfigPath": "~/.config/opencode",
        "backupRoot": "~/Library/Application Support/opencode-mercury/backups",
        "backupIntervalHours": 12,
        "backupRetentionCount": 14
      }
    ]
  ]
}
```

Recommended migration flow:

1. Repoint Mercury at your existing vault and memory paths.
2. Run `pkm_bootstrap` once to ensure missing Mercury scaffold files exist.
3. Run `pkm_import_knowledge` if you want Mercury to copy notes from outside the configured vault. Use `index` mode only for paths already inside the configured vault.
4. Run `pkm_refresh` once after migration to rebuild derived memory and the knowledge index.

On this machine, the repo also includes a scripted live-config migration:

```bash
npm run migrate:live-config
```

That script:

- builds the latest Mercury dist files
- rewrites the live OpenCode plugin entry to `file:///.../dist/server.js`
- explicitly allows Mercury's working directories (`Vault42`, `~/.config/opencode/memory`, and the Mercury backup root) in `external_directory`

## Sandboxed development loop

Mercury is safest to develop against an isolated OpenCode HOME first, not the live profile.

Create the sandbox:

```bash
npm run dev:sandbox
```

Launch OpenCode inside it:

```bash
HOME="/Users/harshsharma/Documents/Side Projects/opencode-pkm-memory-plugin/.sandbox/mercury-dev/home" opencode
```

What this gives you:

- isolated OpenCode config/state under `.sandbox/mercury-dev/home`
- Mercury loaded from `dist/server.js`
- sandbox-only Vault42, memory, backup root, and OpenCode database surfaces
- a safe place to validate plugin loading before touching the live profile

Recommended local workflow:

1. `npm run verify`
2. `npm run dev:sandbox`
3. Launch sandboxed OpenCode and verify Mercury loads cleanly
4. Only then run `npm run migrate:live-config` or update the live profile manually

## Design goals

- user-agnostic
- device-agnostic
- small hot context, deep durable vault
- no personal hardcoded paths beyond configurable defaults
- no dependence on launchd/cron to function
