# Mercury submission copy for opencode.cafe

## Name

Mercury

## Short description

Persistent local memory for OpenCode that keeps compact context, session continuity, and vault knowledge current.

## Long description

Mercury is an OpenCode plugin that maintains a compact local memory layer while you work.

It is designed for the gap between stateless sessions and bloated memory dumps:

- maintains `overview.md` and `active-context.md` automatically
- backfills useful local OpenCode activity from the machine's own runtime state
- indexes vault knowledge into compact summaries instead of injecting raw note dumps
- preserves priorities, reminders, and corrections across sessions
- keeps everything local-first and inspectable on disk

Mercury also includes bootstrap, refresh, import, ingest, backup, and status tools for explicit control.

## Category

Plugin

## Repository

https://github.com/harshfolio/opencode-mercury

## Installation

```bash
git clone https://github.com/harshfolio/opencode-mercury ~/.config/opencode/plugins/opencode-mercury
cd ~/.config/opencode/plugins/opencode-mercury
npm install
npm run build
```

Then add the built plugin to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///Users/YOUR_NAME/.config/opencode/plugins/opencode-mercury/dist/server.js",
      {
        "vaultPath": "~/Documents/Vault",
        "memoryPath": "~/.config/opencode/memory",
        "opencodeConfigPath": "~/.config/opencode",
        "backupRoot": "~/Library/Application Support/opencode-mercury/backups"
      }
    ]
  ]
}
```

Run `pkm_bootstrap` once, then `pkm_status` to confirm health.

## Why it matters

Mercury gives OpenCode a compact, durable memory layer without requiring cloud memory services or manual prompt stuffing each session. It is meant to make continuity useful without making context bloated.
