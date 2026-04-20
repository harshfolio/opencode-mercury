# Changelog

All notable changes to Mercury are documented here.

## 0.2.1 - 2026-04-20

- cache hot ledger and knowledge-index reads to reduce repeated disk parsing
- build overview and active context from a single derived-memory pass
- fix live-config allowlist precedence and exact root path matching
- improve public release readiness and listing assets

## 0.2.0 - 2026-04-20

- fix plugin loading by exporting a valid OpenCode plugin id
- add contract tests and sandboxed OpenCode development workflow
- add live-config migration script for local production setup
- stabilize Bun SQLite runtime support and backup behavior
