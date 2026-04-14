# OpenCode Mercury

A private installable OpenCode plugin that gives any user:
- a portable PKM vault
- a compact hot-memory layer
- existing-knowledge import into that vault
- vault re-indexing while OpenCode is active
- OpenCode session backfill from the local OpenCode database
- automatic session-aware memory refresh while OpenCode is active
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

## Install

Add the plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@harshfolio/opencode-mercury",
      {
        "vaultPath": "~/PKM Vault",
        "memoryPath": "~/.config/opencode/memory",
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

In practice, Mercury stays updated in three layers:

1. **Startup maintenance** when the plugin loads
2. **Autonomous background maintenance** on a fixed interval while OpenCode is open
3. **Watch-triggered maintenance** when vault or dropbox files change

## Tools

- `pkm_bootstrap` — initialize or reinitialize the vault + memory scaffold
- `pkm_status` — inspect configured paths and current memory health
- `pkm_refresh` — force a full refresh across sessions, vault knowledge, and derived memory
- `pkm_import_knowledge` — import or re-index existing notes so Mercury can learn from them
- `pkm_ingest_note` — turn raw note text into a vault inbox note immediately

`pkm_status` also reports whether local `opencode.db` backfill is available on the current machine.

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
        "memoryPath": "~/.config/opencode/memory"
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

## Design goals

- user-agnostic
- device-agnostic
- small hot context, deep durable vault
- no personal hardcoded paths beyond configurable defaults
- no dependence on launchd/cron to function
