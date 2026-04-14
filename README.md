# OpenCode Mercury

A private installable OpenCode plugin that gives any user:
- a portable PKM vault
- a compact hot-memory layer
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
- `dropbox/`
- `domains/`

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
        "memoryPath": "~/.opencode-pkm-memory",
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

## How it works

- On first use, it scaffolds a generic vault and memory layer if they do not exist.
- On each user message, it updates hot memory and recent-work context.
- On each command run, it opportunistically ingests notes dropped into the memory dropbox.
- It injects `overview.md` into the OpenCode system context so the agent starts with compact context instead of bloated history.

## Tools

- `pkm_bootstrap` — initialize or reinitialize the vault + memory scaffold
- `pkm_status` — inspect configured paths and current memory health
- `pkm_ingest_note` — turn raw note text into a vault inbox note immediately

## Design goals

- user-agnostic
- device-agnostic
- small hot context, deep durable vault
- no personal hardcoded paths beyond configurable defaults
- no dependence on launchd/cron to function
