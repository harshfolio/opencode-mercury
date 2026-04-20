# Mercury

Mercury is an OpenCode plugin that keeps a **compact, local memory layer** fresh while you work.

It is built for the gap between stateless sessions and bloated memory dumps:

- keep current context warm across sessions
- remember priorities, reminders, and corrections
- index vault knowledge without shoving the whole vault into prompts
- stay local-first, inspectable, and backup-friendly

## What Mercury gives you

- **Overview + active context** injected automatically into OpenCode
- **Session continuity** from recent local OpenCode activity
- **Vault knowledge indexing** with compact summaries
- **Dropbox note ingestion** into a structured vault inbox
- **Backups** for vault, OpenCode config, and runtime state
- **Manual tools** for bootstrap, refresh, import, ingest, and status

## Quick start

### Option 1: Install from source (recommended today)

```bash
git clone https://github.com/harshfolio/opencode-mercury ~/.config/opencode/plugins/opencode-mercury
cd ~/.config/opencode/plugins/opencode-mercury
npm install
npm run build
```

Add Mercury to `~/.config/opencode/opencode.json`:

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
        "backupRoot": "~/Library/Application Support/opencode-mercury/backups",
        "backupIntervalHours": 12,
        "backupRetentionCount": 14,
        "userDisplayName": "Your Name",
        "primaryWork": "Product, engineering, research, or operations"
      }
    ]
  ]
}
```

Then run:

- `pkm_bootstrap` once to scaffold files
- `pkm_status` to confirm health
- `pkm_refresh` if you want an immediate full rebuild

### Option 2: Install as a package

Mercury is now configured for a **public npm release path**.

Once the public npm publish is completed, the install flow becomes:

```bash
npm install -g @harshfolio/opencode-mercury
```

Until that publish is completed, the source install above remains the reliable path.

## Runtime requirements

- Node.js 22+
- An OpenCode build with these hooks:
  - `chat.message`
  - `command.execute.before`
  - `experimental.chat.system.transform`
  - `experimental.session.compacting`

Mercury supports SQLite access in both Bun-hosted and Node-hosted OpenCode runtimes.

## Tools

- `pkm_bootstrap` — initialize or reinitialize the vault + memory scaffold
- `pkm_status` — inspect configured paths and memory health
- `pkm_refresh` — force a full refresh across sessions, vault knowledge, and derived memory
- `pkm_backup_now` — force immediate backups
- `pkm_import_knowledge` — import or re-index existing notes
- `pkm_ingest_note` — turn raw note text into a vault inbox note immediately

## What Mercury creates

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

Mercury also manages `dropbox/processed`, `dropbox/failed`, and additional domain files as it learns more about the working set.

## How it works

Mercury is **hook-driven**, not daemon-driven.

While OpenCode is active, Mercury keeps itself fresh through:

1. **Startup maintenance** when the plugin loads
2. **Background maintenance** on a fixed interval while OpenCode stays open
3. **Watch-triggered maintenance** when vault or dropbox files change

In practice it does four kinds of work:

- keeps session continuity current
- backfills useful local OpenCode activity
- indexes vault knowledge into compact summaries
- injects overview + active context into the system prompt with hard budgets

## Backup coverage

By default Mercury snapshots three surfaces outside the vault/config trees:

- the configured vault
- the OpenCode config root
- the OpenCode runtime/state directory containing `opencode.db`

Defaults:

- backup interval: every 12 hours while OpenCode is active
- retention: last 14 snapshots per scope
- default macOS backup root: `~/Library/Application Support/opencode-mercury/backups`

## Migrating an existing setup

If you already use a vault plus `~/.config/opencode/memory`, point Mercury at those same paths so it owns the same memory surface instead of creating a parallel setup.

Recommended flow:

1. Repoint Mercury at your existing vault and memory paths
2. Run `pkm_bootstrap` once to ensure scaffold files exist
3. Run `pkm_import_knowledge` if you want to copy notes from outside the vault
4. Run `pkm_refresh` once to rebuild derived memory and the knowledge index

For this repo, there is also a local helper:

```bash
npm run migrate:live-config
```

That script:

- builds the latest dist files
- rewrites the local OpenCode plugin entry to the built Mercury file
- sets persistent `external_directory` allowlist rules for Mercury-owned paths

## Sandboxed development

Mercury is safest to develop against an isolated OpenCode HOME first.

```bash
npm run dev:sandbox
HOME="$(pwd)/.sandbox/mercury-dev/home" opencode
```

Recommended workflow:

1. `npm run verify`
2. `npm run dev:sandbox`
3. validate Mercury in the sandbox
4. only then update the live profile

## Troubleshooting

### Mercury still asks for path access

Make sure the configured Mercury paths are allowlisted in `external_directory` and restart OpenCode fully. Fresh processes pick up config reliably; already-open processes may still use cached permission state.

### Local activity backfill is unavailable

`pkm_status` reports whether local `opencode.db` access is available. If it is false, confirm the runtime can access SQLite and that the configured OpenCode state path is correct.

### Refreshes feel slow on very large vaults

Mercury currently favors correctness over aggressive incremental indexing. The current releases already cache hot state and reduce repeated recomputation, but very large vaults will still benefit from future incremental indexing work.

## Design goals

- local-first
- compact hot context, deep durable knowledge
- minimal prompt bloat
- portable vault and memory surfaces
- no cloud dependency for core memory flows

## Public launch assets

- `docs/awesome-opencode-plugin.yaml` contains a ready-to-submit awesome-opencode entry draft
- `docs/opencode-cafe-submission.md` contains ready-to-paste marketplace copy
- GitHub Releases are used for versioned public release notes

## License

MIT
