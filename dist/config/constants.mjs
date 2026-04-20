import os from "node:os";
import path from "node:path";

export const SUPPORTED_NOTE_SUFFIXES = new Set([".md", ".txt", ".text"]);
export const INSTALL_STATE = path.join(os.homedir(), ".opencode-pkm-plugin.json");
export const DEFAULT_MEMORY_ROOT = path.join(os.homedir(), ".config", "opencode", "memory");
export const DEFAULT_OPENCODE_CONFIG_ROOT = path.join(os.homedir(), ".config", "opencode");
export const DEFAULT_VAULT_ROOT = path.join(os.homedir(), "Documents", "Vault42");
export const DEFAULT_BACKUP_ROOT = process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Application Support", "opencode-mercury", "backups")
  : path.join(os.homedir(), ".local", "share", "opencode-mercury", "backups");
export const DEFAULT_DB_CANDIDATES = [
  path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
  path.join(os.homedir(), "Library", "Application Support", "opencode", "opencode.db"),
];
export const MAINTENANCE_INTERVAL_MS = 60_000;
export const VAULT_SCAN_INTERVAL_MS = 120_000;
export const DEFAULT_BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_BACKUP_RETENTION_COUNT = 14;
export const WATCH_DEBOUNCE_MS = 750;
export const MAX_RECENT_SESSIONS = 8;
export const MAX_RECENT_KNOWLEDGE = 5;
export const OVERVIEW_CONTEXT_LIMIT = 3_500;
export const ACTIVE_CONTEXT_LIMIT = 2_500;

export const BACKUP_SCOPE_DEFINITIONS = [
  {
    key: "vault",
    directoryName: "vault",
    label: "Vault42",
    excludedPrefixes: [".git", ".obsidian/cache", ".trash"],
  },
  {
    key: "opencodeConfig",
    directoryName: "opencode-config",
    label: "OpenCode config",
    excludedPrefixes: ["node_modules", "memory/logs", "memory/dropbox/processed", "memory/dropbox/failed"],
  },
  {
    key: "opencodeState",
    directoryName: "opencode-state",
    label: "OpenCode runtime state",
    excludedPrefixes: ["bin", "log", "tool-output", "worktree"],
  },
];

export const NOISE_PATTERNS = [
  /@Sisyphus/i,
  /subagent/i,
  /^\[search-mode\]/i,
  /^show global memory health/i,
  /^review reco batch/i,
  /^march sessions/i,
  /^new session -/i,
];

export const CORRECTION_PATTERNS = [
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bdont\b/i,
  /\bnever\b/i,
  /\balways\b/i,
  /\buse\b.+\binstead\b/i,
  /\bwrong\b/i,
  /\bshouldn't\b/i,
  /\bshould not\b/i,
];

export const WORKSTREAM_RULES = [
  {
    label: "Agentic memory and workflow systems",
    keywords: ["vault42", "vault", "memory", "pkm", "context", "agentic", "knowledge", "opencode"],
  },
  {
    label: "Clinikally commerce and admin operations",
    keywords: ["medusa", "inventory", "catalog", "catalogue", "collection", "brand", "order", "sku"],
  },
  {
    label: "Analytics, warehouse, and internal data systems",
    keywords: ["delta", "sqlmesh", "bigquery", "warehouse", "analytics", "dashboard", "data"],
  },
  {
    label: "Product UX, dashboards, and internal tooling",
    keywords: ["vision", "figma", "ui", "frontend", "design", "widget"],
  },
  {
    label: "Social media growth automation",
    keywords: ["twitter", "linkedin", "social media", "engage", "content", "impressions"],
  },
  {
    label: "Clinikally product and growth work",
    keywords: ["clinikally", "consult", "product", "growth", "search", "autosuggest", "checkout"],
  },
];

export const DEFAULT_BASELINE = [
  "- Primary work spans product, engineering systems, analytics, and AI-assisted execution",
  "- The vault is the durable knowledge layer; hot memory is the compact shared working set",
  "- The system should preserve context across sessions without turning into a noisy archive",
];

export const DEFAULT_PRIORITIES = [
  "- Keep current priorities explicit and compact",
  "- Preserve cross-session context without bloating prompts",
  "- Route durable knowledge into the vault and volatile context into hot memory",
];

export const DEFAULT_REMINDERS = [
  "- Prefer durable knowledge in the vault",
  "- Keep hot memory compact and current",
  "- Use the dropbox for loose notes that should be ingested",
  "- Never auto-promote temporary project facts into global rules",
];

export const SENSITIVE_PATTERNS = [
  /(api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie|session)[^\n]{0,120}/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gi,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
];

export const PATH_REDACTION_PATTERNS = [
  /\/Users\/[^\s`]+/g,
  /\/home\/[^\s`]+/g,
  /[A-Za-z]:\\[^\s`]+/g,
];
