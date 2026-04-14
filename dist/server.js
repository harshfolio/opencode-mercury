import { promises as fs, watch as watchFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tool } from "@opencode-ai/plugin";

const SUPPORTED_NOTE_SUFFIXES = new Set([".md", ".txt", ".text"]);
const INSTALL_STATE = path.join(os.homedir(), ".opencode-pkm-plugin.json");
const DEFAULT_MEMORY_ROOT = path.join(os.homedir(), ".config", "opencode", "memory");
const DEFAULT_VAULT_ROOT = path.join(os.homedir(), "PKM Vault");
const DEFAULT_DB_CANDIDATES = [
  path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
  path.join(os.homedir(), "Library", "Application Support", "opencode", "opencode.db"),
];
const MAINTENANCE_INTERVAL_MS = 60_000;
const VAULT_SCAN_INTERVAL_MS = 120_000;
const WATCH_DEBOUNCE_MS = 750;
const MAX_RECENT_SESSIONS = 8;
const MAX_RECENT_KNOWLEDGE = 5;
const OVERVIEW_CONTEXT_LIMIT = 3_500;
const ACTIVE_CONTEXT_LIMIT = 2_500;

const NOISE_PATTERNS = [
  /@Sisyphus/i,
  /subagent/i,
  /^\[search-mode\]/i,
  /^show global memory health/i,
  /^review reco batch/i,
  /^march sessions/i,
  /^new session -/i,
];

const CORRECTION_PATTERNS = [
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

const WORKSTREAM_RULES = [
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

const DEFAULT_BASELINE = [
  "- Primary work spans product, engineering systems, analytics, and AI-assisted execution",
  "- The vault is the durable knowledge layer; hot memory is the compact shared working set",
  "- The system should preserve context across sessions without turning into a noisy archive",
];

const DEFAULT_PRIORITIES = [
  "- Keep current priorities explicit and compact",
  "- Preserve cross-session context without bloating prompts",
  "- Route durable knowledge into the vault and volatile context into hot memory",
];

const DEFAULT_REMINDERS = [
  "- Prefer durable knowledge in the vault",
  "- Keep hot memory compact and current",
  "- Use the dropbox for loose notes that should be ingested",
  "- Never auto-promote temporary project facts into global rules",
];

const SENSITIVE_PATTERNS = [
  /(api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie|session)[^\n]{0,120}/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gi,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
];

const PATH_REDACTION_PATTERNS = [
  /\/Users\/[^\s`]+/g,
  /\/home\/[^\s`]+/g,
  /[A-Za-z]:\\[^\s`]+/g,
];

const maintenanceControllers = new Map();

function expandPath(input) {
  if (!input) return input;
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatIsoWithOffset(date = new Date()) {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainder = pad(Math.abs(offsetMinutes) % 60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetRemainder}`;
}

function nowLocal() {
  return new Date();
}

function nowIso() {
  return formatIsoWithOffset(nowLocal());
}

function todayDate() {
  return nowIso().slice(0, 10);
}

function isoFromMs(value) {
  if (!Number.isFinite(value)) return "";
  return formatIsoWithOffset(new Date(value));
}

function formatRecentTimestamp(value) {
  const iso = isoFromMs(value);
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

function truncate(text, limit = 120) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

function redactSensitiveText(text) {
  let value = String(text || "");
  for (const pattern of SENSITIVE_PATTERNS) {
    value = value.replace(pattern, "[redacted]");
  }
  for (const pattern of PATH_REDACTION_PATTERNS) {
    value = value.replace(pattern, "[redacted-path]");
  }
  return value;
}

function truncateBlock(text, limit = 3000) {
  const clean = String(text || "").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit).trimEnd()}\n…`;
}

function slugify(text) {
  const clean = String(text || "note")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "note";
}

function normalizeRelativePath(value) {
  return String(value || "").split(path.sep).join("/");
}

function stripFences(text) {
  return String(text || "").trim().replace(/^```(?:[\w-]+)?\n?/, "").replace(/\n?```$/, "").trim();
}

function textFromParts(parts) {
  return (parts || [])
    .filter((part) => part && part.type === "text")
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

function summarizePrompt(text, fallback) {
  const first = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return truncate(first || fallback || "Untitled session", 140);
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function parseSections(markdown) {
  const sections = new Map();
  let current = "__root__";
  sections.set(current, []);
  for (const line of String(markdown || "").split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      sections.set(current, []);
      continue;
    }
    sections.get(current).push(line);
  }
  return sections;
}

function bulletLines(markdown, section) {
  const sections = parseSections(markdown);
  return (sections.get(section) || [])
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

function mergeUniqueLines(...groups) {
  const results = [];
  const seen = new Set();
  for (const group of groups) {
    for (const line of group || []) {
      const value = String(line || "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      results.push(value);
    }
  }
  return results;
}

function isNoise(text) {
  return NOISE_PATTERNS.some((pattern) => pattern.test(String(text || "")));
}

function scoreWorkstream(text, rule) {
  const haystack = String(text || "").toLowerCase();
  return rule.keywords.reduce((total, keyword) => total + (haystack.includes(keyword) ? 1 : 0), 0);
}

function classifyWorkstream(text) {
  let best = null;
  WORKSTREAM_RULES.forEach((rule, index) => {
    const score = scoreWorkstream(text, rule);
    if (!score) return;
    if (!best || score > best.score || (score === best.score && index < best.index)) {
      best = { label: rule.label, score, index };
    }
  });
  return best?.label || null;
}

function stripFrontmatter(text) {
  const source = redactSensitiveText(String(text || ""));
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return source;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      return lines.slice(index + 1).join("\n");
    }
  }
  return source;
}

function extractNoteTitle(text, fallback) {
  const body = stripFrontmatter(text);
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s+/.test(line));
  if (heading) return truncate(heading.replace(/^#{1,6}\s+/, ""), 140);
  const paragraph = lines.find((line) => !line.startsWith("- ") && !/^\w[\w\s-]*:$/.test(line));
  if (paragraph) return truncate(paragraph, 140);
  return truncate(redactSensitiveText(fallback || "Untitled note"), 140);
}

function extractNoteBullets(text, limit = 3) {
  return stripFrontmatter(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, limit)
    .map((line) => truncate(line, 160));
}

function extractNoteSummary(text, title) {
  const body = stripFrontmatter(text);
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const paragraph = lines.find(
    (line) =>
      !line.startsWith("#") &&
      !line.startsWith("- ") &&
      !/^\w[\w\s-]*:$/.test(line) &&
      line.length > 12,
  );
  if (paragraph) return truncate(paragraph, 220);
  const bullet = lines.find((line) => line.startsWith("- "));
  if (bullet) return truncate(bullet.replace(/^-\s+/, ""), 220);
  return truncate(redactSensitiveText(title), 220);
}

function zoneLabelForRelativePath(relativePath) {
  const [top] = normalizeRelativePath(relativePath).split("/");
  if (!top) return "Vault";
  return top.replace(/^\d{2}-\d{2}\s*/, "").replace(/[_-]+/g, " ").trim() || "Vault";
}

function isWithinPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

async function readText(target, fallback = "") {
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    return fallback;
  }
}

async function writeText(target, content) {
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, content, "utf8");
}

async function ensureFile(target, content, force = false) {
  if (!force && await exists(target)) return false;
  await writeText(target, content);
  return true;
}

async function readJson(target, fallback) {
  const raw = await readText(target, "");
  return raw.trim() ? safeJsonParse(raw, fallback) : fallback;
}

async function writeJson(target, value) {
  await writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonFileWithReporting(paths, target, label, fallback) {
  const raw = await readText(target, "");
  if (!raw.trim()) return { value: fallback, readError: false };
  const parsed = safeJsonParse(raw, null);
  if (parsed !== null) return { value: parsed, readError: false };
  await appendErrorLog(paths, `read-json:${label}`, new Error(`Invalid JSON in ${target}`));
  return { value: fallback, readError: true };
}

async function appendText(target, content) {
  await ensureDir(path.dirname(target));
  await fs.appendFile(target, content, "utf8");
}

async function moveFile(source, target) {
  await ensureDir(path.dirname(target));
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error && error.code === "EXDEV") {
      await fs.copyFile(source, target);
      await fs.unlink(source);
      return;
    }
    throw error;
  }
}

async function uniqueTargetPath(target) {
  const parsed = path.parse(target);
  let attempt = target;
  let counter = 1;
  while (await exists(attempt)) {
    attempt = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`);
    counter += 1;
  }
  return attempt;
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const expanded = expandPath(candidate);
    if (await exists(expanded)) return expanded;
  }
  return "";
}

function maintenanceControllerKey(paths) {
  return `${paths.vaultPath}::${paths.memoryPath}`;
}

function firstDefinedPath(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return expandPath(value.trim());
  }
  return "";
}

async function readInstallState() {
  return readJson(INSTALL_STATE, {});
}

async function writeInstallState(config) {
  await writeJson(INSTALL_STATE, config);
}

async function materializePaths(input, config = {}) {
  const persisted = await readInstallState();
  const memoryPath = firstDefinedPath(config.memoryPath, persisted.memoryPath)
    || await firstExistingPath([process.env.OPENCODE_PKM_MEMORY_PATH, DEFAULT_MEMORY_ROOT])
    || DEFAULT_MEMORY_ROOT;
  const vaultPath = firstDefinedPath(config.vaultPath, persisted.vaultPath, process.env.OPENCODE_PKM_VAULT_PATH)
    || DEFAULT_VAULT_ROOT;
  const opencodeDbPath = firstDefinedPath(config.opencodeDbPath, persisted.opencodeDbPath, process.env.OPENCODE_PKM_DB_PATH)
    || await firstExistingPath(DEFAULT_DB_CANDIDATES)
    || DEFAULT_DB_CANDIDATES[0];

  return {
    input,
    vaultPath,
    memoryPath,
    opencodeDbPath,
    vaultHome: path.join(vaultPath, "Vault Home.md"),
    vaultAgents: path.join(vaultPath, "AGENTS.md"),
    vaultInbox: path.join(vaultPath, "00-09 Inbox"),
    vaultAgentContext: path.join(vaultPath, "_agent", "context.md"),
    overview: path.join(memoryPath, "overview.md"),
    userProfile: path.join(memoryPath, "user-profile.md"),
    currentPriorities: path.join(memoryPath, "current-priorities.md"),
    activeContext: path.join(memoryPath, "active-context.md"),
    corrections: path.join(memoryPath, "corrections.jsonl"),
    ledger: path.join(memoryPath, "session-ledger.jsonl"),
    dropbox: path.join(memoryPath, "dropbox"),
    dropboxProcessed: path.join(memoryPath, "dropbox", "processed"),
    dropboxFailed: path.join(memoryPath, "dropbox", "failed"),
    logsDir: path.join(memoryPath, "logs"),
    errorLog: path.join(memoryPath, "logs", "plugin-errors.log"),
    state: path.join(memoryPath, ".plugin-state.json"),
    knowledgeIndex: path.join(memoryPath, "knowledge-index.json"),
    domainsDir: path.join(memoryPath, "domains"),
  };
}

async function buildPaths(input, options = {}, overrides = {}) {
  return materializePaths(input, { ...options, ...overrides });
}

function renderVaultHome() {
  return `# Vault Home

This vault is the durable knowledge layer for the PKM + memory plugin.

## Zones
- [[00-09 Inbox/_Index|Inbox]]
- [[10-19 Projects/_Index|Projects]]
- [[20-29 Areas/_Index|Areas]]
- [[30-69 Resources/_Index|Resources]]
- [[80-89 Engineering/_Index|Engineering]]
- [[90-99 Archive/_Index|Archive]]
- [[_agent/context|Agent Context]]
`;
}

function renderVaultAgents() {
  return `# Vault Agents

Use this vault as the durable PKM and common memory layer.

## Retrieval Order
1. Read \`Vault Home.md\`
2. Open the right zone index
3. Read local indexes before deep notes
4. Keep hot/session context outside the vault when it is volatile
`;
}

function renderZoneIndex(name, purpose) {
  return `# ${name} Index

${purpose}
`;
}

function renderVaultContext() {
  return `# Agent Context

## Focus
- Keep current priorities explicit
- Preserve continuity between sessions
- Route stable knowledge into the vault

## Quick Links
- [[Vault Home]]
- [[00-09 Inbox/_Index|Inbox]]
`;
}

function renderUserProfile({ userDisplayName, primaryWork }) {
  const baseline = [
    `- ${userDisplayName || "The user"} works across ${primaryWork || "product, engineering, operations, and knowledge work"}`,
    ...DEFAULT_BASELINE,
  ];

  return `---
updated: ${todayDate()}
source: plugin-bootstrap
confidence: 0.9
---

# User Profile

## Identity
- ${userDisplayName || "Unknown user"}

## General Work Baseline
${baseline.join("\n")}

## Working Preferences
- Keep context compact and high-signal
- Prefer durable knowledge in the vault and volatile knowledge in hot memory
- Avoid bloated prompts and repeated rediscovery
`;
}

function renderCurrentPriorities() {
  return `---
updated: ${todayDate()}
source: plugin-bootstrap
confidence: 0.8
---

# Current Priorities

${DEFAULT_PRIORITIES.join("\n")}
`;
}

function renderKnowledgeIndexSeed() {
  return `${JSON.stringify({ version: 1, updated: "", files: {} }, null, 2)}\n`;
}

function renderStateSeed() {
  return `${JSON.stringify({
    version: 1,
    sessions: {},
    imports: [],
    lastMaintenanceAt: "",
    lastMaintenanceMs: 0,
    lastSessionSyncMs: 0,
    lastVaultScanAt: "",
    lastVaultScanMs: 0,
  }, null, 2)}\n`;
}

async function ensureScaffold(paths, options = {}, force = false) {
  await Promise.all([
    ensureDir(paths.vaultInbox),
    ensureDir(path.join(paths.vaultPath, "10-19 Projects")),
    ensureDir(path.join(paths.vaultPath, "20-29 Areas")),
    ensureDir(path.join(paths.vaultPath, "30-69 Resources")),
    ensureDir(path.join(paths.vaultPath, "80-89 Engineering")),
    ensureDir(path.join(paths.vaultPath, "90-99 Archive")),
    ensureDir(path.dirname(paths.vaultAgentContext)),
    ensureDir(paths.dropboxProcessed),
    ensureDir(paths.dropboxFailed),
    ensureDir(paths.logsDir),
    ensureDir(paths.domainsDir),
  ]);

  await Promise.all([
    ensureFile(paths.vaultHome, renderVaultHome(), force),
    ensureFile(paths.vaultAgents, renderVaultAgents(), force),
    ensureFile(path.join(paths.vaultPath, "00-09 Inbox", "_Index.md"), renderZoneIndex("Inbox", "Temporary capture surface before durable filing."), force),
    ensureFile(path.join(paths.vaultPath, "10-19 Projects", "_Index.md"), renderZoneIndex("Projects", "Active project work and time-bound initiatives."), force),
    ensureFile(path.join(paths.vaultPath, "20-29 Areas", "_Index.md"), renderZoneIndex("Areas", "Ongoing responsibilities and recurring systems."), force),
    ensureFile(path.join(paths.vaultPath, "30-69 Resources", "_Index.md"), renderZoneIndex("Resources", "Reusable reference material and long-term knowledge."), force),
    ensureFile(path.join(paths.vaultPath, "80-89 Engineering", "_Index.md"), renderZoneIndex("Engineering", "Technical decisions, patterns, and system knowledge."), force),
    ensureFile(path.join(paths.vaultPath, "90-99 Archive", "_Index.md"), renderZoneIndex("Archive", "Dormant and historical material."), force),
    ensureFile(paths.vaultAgentContext, renderVaultContext(), force),
    ensureFile(paths.userProfile, renderUserProfile(options), force),
    ensureFile(paths.currentPriorities, renderCurrentPriorities(), force),
    ensureFile(paths.activeContext, "# Active Context\n", force),
    ensureFile(paths.overview, "# Overview\n", force),
    ensureFile(paths.corrections, "", force),
    ensureFile(paths.ledger, "", force),
    ensureFile(paths.knowledgeIndex, renderKnowledgeIndexSeed(), force),
    ensureFile(paths.state, renderStateSeed(), force),
    ensureFile(path.join(paths.dropbox, "README.md"), "Drop .md or .txt notes here. Mercury ingests them into the vault inbox while OpenCode is active.\n", force),
    ensureFile(path.join(paths.domainsDir, "engineering.md"), "# Engineering\n\n- Stable engineering context lands here.\n", force),
    ensureFile(path.join(paths.domainsDir, "product.md"), "# Product\n\n- Stable product context lands here.\n", force),
    ensureFile(path.join(paths.domainsDir, "social-media.md"), "# Social Media\n\n- Stable audience and content context lands here.\n", force),
    ensureFile(path.join(paths.domainsDir, "finance.md"), "# Finance\n\n- Stable commercial and financial context lands here.\n", force),
  ]);
}

async function readPluginState(paths) {
  const { value: state, readError } = await readJsonFileWithReporting(paths, paths.state, "plugin-state", {});
  return {
    version: 1,
    sessions: typeof state.sessions === "object" && state.sessions ? state.sessions : {},
    imports: Array.isArray(state.imports) ? state.imports : [],
    lastMaintenanceAt: String(state.lastMaintenanceAt || ""),
    lastMaintenanceMs: Number(state.lastMaintenanceMs || 0),
    lastSessionSyncMs: Number(state.lastSessionSyncMs || 0),
    lastVaultScanAt: String(state.lastVaultScanAt || ""),
    lastVaultScanMs: Number(state.lastVaultScanMs || 0),
    readError,
  };
}

async function writePluginState(paths, state) {
  const sessions = Object.fromEntries(Object.entries(state.sessions || {})
    .sort((left, right) => String(right[1]?.updated || "").localeCompare(String(left[1]?.updated || "")))
    .slice(0, 250)
    .map(([sessionID, value]) => [sessionID, value]));

  await writeJson(paths.state, {
    version: 1,
    sessions,
    imports: (state.imports || []).slice(-25),
    lastMaintenanceAt: state.lastMaintenanceAt || "",
    lastMaintenanceMs: Number(state.lastMaintenanceMs || 0),
    lastSessionSyncMs: Number(state.lastSessionSyncMs || 0),
    lastVaultScanAt: state.lastVaultScanAt || "",
    lastVaultScanMs: Number(state.lastVaultScanMs || 0),
  });
}

async function readKnowledgeIndex(paths) {
  const { value: index, readError } = await readJsonFileWithReporting(paths, paths.knowledgeIndex, "knowledge-index", { version: 1, updated: "", files: {} });
  return {
    version: 1,
    updated: String(index.updated || ""),
    files: typeof index.files === "object" && index.files ? index.files : {},
    readError,
  };
}

async function writeKnowledgeIndex(paths, index) {
  await writeJson(paths.knowledgeIndex, {
    version: 1,
    updated: index.updated || nowIso(),
    files: index.files || {},
  });
}

async function appendErrorLog(paths, label, error) {
  const message = `${nowIso()} ${label}: ${error instanceof Error ? error.stack || error.message : String(error)}\n`;
  await appendText(paths.errorLog, message);
}

async function parseLedger(paths) {
  const raw = await readText(paths.ledger, "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJsonParse(line, null))
    .filter(Boolean)
    .sort((left, right) => String(right.updated || "").localeCompare(String(left.updated || "")));
}

async function countJsonLines(target) {
  const raw = await readText(target, "");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

async function appendLedgerEntry(paths, entry) {
  await appendText(paths.ledger, `${JSON.stringify(entry)}\n`);
}

async function existingLedgerIds(paths) {
  const entries = await parseLedger(paths);
  return new Set(entries.map((entry) => entry.session_id).filter(Boolean));
}

async function readExistingCorrections(paths) {
  const raw = await readText(paths.corrections, "");
  const values = new Set();
  raw.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const item = safeJsonParse(line, null);
      const correction = item?.correction;
      if (typeof correction === "string" && correction.trim()) values.add(correction);
    });
  return values;
}

async function appendCorrections(paths, entries) {
  if (!entries.length) return 0;
  await appendText(paths.corrections, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return entries.length;
}

async function readExistingActiveContext(paths) {
  const raw = await readText(paths.activeContext, "");
  return {
    openThreads: bulletLines(raw, "Open Threads"),
    reminders: bulletLines(raw, "Durable Reminders"),
  };
}

async function readUserBaseline(paths) {
  return bulletLines(await readText(paths.userProfile, ""), "General Work Baseline").slice(0, 4);
}

async function readCurrentPriorities(paths) {
  const priorities = bulletLines(await readText(paths.currentPriorities, ""), "Current Priorities");
  return priorities.length ? priorities.slice(0, 5) : DEFAULT_PRIORITIES;
}

async function readVaultFocus(paths) {
  return bulletLines(await readText(paths.vaultAgentContext, ""), "Focus").slice(0, 3);
}

function connectDb(dbPath) {
  return new DatabaseSync(dbPath);
}

function queryAll(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function firstUserPrompt(db, sessionID) {
  const messages = queryAll(db, "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC", sessionID);
  for (const row of messages) {
    const message = safeJsonParse(row.data, null);
    if (!message || message.role !== "user") continue;
    const parts = queryAll(db, "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC", row.id);
    for (const partRow of parts) {
      const part = safeJsonParse(partRow.data, null);
      if (!part || part.type !== "text") continue;
      const text = stripFences(part.text || "");
      if (!text) continue;
      const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (firstLine) return truncate(firstLine, 120);
    }
  }
  return "";
}

async function buildSessionSummariesFromDb(paths, limit = MAX_RECENT_SESSIONS) {
  if (!await exists(paths.opencodeDbPath)) return [];
  const db = connectDb(paths.opencodeDbPath);
  try {
    const rows = queryAll(db, "SELECT id, title, directory, time_updated FROM session ORDER BY time_updated DESC LIMIT ?", limit);
    return rows.map((row) => {
      const promptExcerpt = firstUserPrompt(db, row.id);
      const project = path.basename(row.directory || "global") || "global";
      let title = row.title || promptExcerpt || project;
      if (String(title).startsWith("New session -") && promptExcerpt) title = promptExcerpt;
      return {
        session_id: row.id,
        updated: isoFromMs(row.time_updated),
        updated_ms: row.time_updated,
        project,
        directory: row.directory || "",
        title: truncate(title, 100),
        prompt_excerpt: promptExcerpt,
      };
    });
  } finally {
    db.close();
  }
}

async function appendSessionLedgerEntries(paths, summaries, sinceMs) {
  const seen = await existingLedgerIds(paths);
  const additions = summaries.filter((summary) => !seen.has(summary.session_id) && summary.updated_ms > sinceMs);
  if (!additions.length) return 0;
  await appendText(paths.ledger, `${additions.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return additions.length;
}

async function extractCorrectionCandidates(paths, sinceMs) {
  if (!await exists(paths.opencodeDbPath)) return [];
  const existing = await readExistingCorrections(paths);
  const db = connectDb(paths.opencodeDbPath);
  try {
    const sessionRows = queryAll(db, "SELECT id, directory FROM session WHERE time_updated > ? ORDER BY time_updated DESC LIMIT 20", sinceMs);
    const entries = [];
    for (const sessionRow of sessionRows) {
      const project = path.basename(sessionRow.directory || "global") || "global";
      const messageRows = queryAll(db, "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC", sessionRow.id);
      for (const messageRow of messageRows) {
        const message = safeJsonParse(messageRow.data, null);
        if (!message || message.role !== "user") continue;
        const partRows = queryAll(db, "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC", messageRow.id);
        for (const partRow of partRows) {
          const part = safeJsonParse(partRow.data, null);
          if (!part || part.type !== "text") continue;
          for (const rawLine of String(part.text || "").split(/\r?\n/)) {
            const line = truncate(rawLine, 220);
            if (line.length < 12) continue;
            if (!CORRECTION_PATTERNS.some((pattern) => pattern.test(line))) continue;
            if (existing.has(line)) continue;
            entries.push({
              ts: nowIso(),
              scope: "session-correction",
              project,
              correction: line,
              source: `opencode-session:${sessionRow.id}`,
              confidence: 0.65,
            });
            existing.add(line);
          }
        }
      }
    }
    return entries;
  } finally {
    db.close();
  }
}

async function updateSessionState(paths, state, sessionInfo) {
  const sessionID = sessionInfo?.sessionID;
  const text = sessionInfo?.text;
  if (!sessionID || !text || isNoise(text)) return false;

  const knownSessions = new Set(Object.keys(state.sessions || {}));
  if (!knownSessions.has(sessionID)) {
    const ledgerIDs = await existingLedgerIds(paths);
    if (ledgerIDs.has(sessionID)) {
      state.sessions[sessionID] = { title: summarizePrompt(text, "Known session"), updated: nowIso() };
      return false;
    }
  }

  if (state.sessions[sessionID]) return false;
  const entry = {
    session_id: sessionID,
    updated: nowIso(),
    updated_ms: Date.now(),
    project: path.basename(sessionInfo.directory || "global") || "global",
    directory: sessionInfo.directory || "",
    title: summarizePrompt(text, path.basename(sessionInfo.directory || "session")),
    prompt_excerpt: summarizePrompt(text, path.basename(sessionInfo.directory || "session")),
  };
  state.sessions[sessionID] = { title: entry.title, updated: entry.updated };
  await appendLedgerEntry(paths, entry);
  return true;
}

async function listSupportedFiles(root) {
  if (!await exists(root)) return [];
  const stats = await fs.lstat(root);
  if (stats.isSymbolicLink()) return [];
  if (stats.isFile()) {
    return SUPPORTED_NOTE_SUFFIXES.has(path.extname(root).toLowerCase()) ? [root] : [];
  }

  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", ".obsidian"].includes(entry.name)) continue;
        await walk(fullPath);
        continue;
      }
      if (SUPPORTED_NOTE_SUFFIXES.has(path.extname(entry.name).toLowerCase())) results.push(fullPath);
    }
  }
  await walk(root);
  return results.sort((left, right) => left.localeCompare(right));
}

function shouldIgnoreVaultFile(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const base = path.basename(normalized);
  if (["Vault Home.md", "AGENTS.md", "_Index.md"].includes(base)) return true;
  if (normalized.startsWith("_agent/")) return true;
  return false;
}

function summarizeKnowledgeFile(rawContent, relativePath, stats) {
  const fallbackTitle = path.basename(relativePath, path.extname(relativePath)).replace(/[-_]+/g, " ");
  const title = extractNoteTitle(rawContent, fallbackTitle);
  const summary = extractNoteSummary(rawContent, title);
  const bullets = extractNoteBullets(rawContent, 3);
  const zone = zoneLabelForRelativePath(relativePath);
  const evidence = `${relativePath} ${title} ${summary} ${bullets.join(" ")}`;
  return {
    relativePath,
    title,
    summary,
    bullets,
    zone,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    updated: isoFromMs(stats.mtimeMs),
    workstream: classifyWorkstream(evidence),
  };
}

async function syncKnowledgeIndex(paths, state, force = false) {
  const index = await readKnowledgeIndex(paths);
  const files = await listSupportedFiles(paths.vaultPath);
  const seen = new Set();
  let added = 0;
  let updated = 0;

  for (const fullPath of files) {
    const relativePath = normalizeRelativePath(path.relative(paths.vaultPath, fullPath));
    if (!relativePath || shouldIgnoreVaultFile(relativePath)) continue;
    seen.add(relativePath);
    const stats = await fs.stat(fullPath);
    const previous = index.files[relativePath];
    if (!force && previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size) continue;
    const rawContent = await readText(fullPath, "");
    index.files[relativePath] = summarizeKnowledgeFile(rawContent, relativePath, stats);
    if (previous) updated += 1;
    else added += 1;
  }

  let removed = 0;
  for (const relativePath of Object.keys(index.files)) {
    if (seen.has(relativePath)) continue;
    delete index.files[relativePath];
    removed += 1;
  }

  index.updated = nowIso();
  state.lastVaultScanAt = index.updated;
  state.lastVaultScanMs = Date.now();
  await writeKnowledgeIndex(paths, index);

  return {
    scanned: files.length,
    indexed: Object.keys(index.files).length,
    added,
    updated,
    removed,
  };
}

function recentKnowledgeEntries(index) {
  return Object.values(index.files || {})
    .sort((left, right) => Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0))
    .slice(0, MAX_RECENT_KNOWLEDGE);
}

function inferWorkstreams(signals) {
  const workstreams = new Map();
  for (const signal of signals) {
    const label = classifyWorkstream(signal.text);
    if (!label) continue;
    const current = workstreams.get(label);
    if (!current || signal.updatedMs > current.updatedMs) {
      workstreams.set(label, { label, evidence: truncate(signal.evidence, 110), updatedMs: signal.updatedMs });
    }
  }
  return Array.from(workstreams.values())
    .sort((left, right) => right.updatedMs - left.updatedMs)
    .slice(0, 4);
}

async function renderActiveContext(paths) {
  const existing = await readExistingActiveContext(paths);
  const priorities = await readCurrentPriorities(paths);
  const vaultFocus = await readVaultFocus(paths);
  const ledger = (await parseLedger(paths)).filter((entry) => !isNoise(`${entry.title || ""} ${entry.prompt_excerpt || ""} ${entry.directory || ""}`));
  const recentSessions = ledger.slice(0, 5);
  const knowledgeIndex = await readKnowledgeIndex(paths);
  const recentKnowledge = recentKnowledgeEntries(knowledgeIndex);

  const focusLines = mergeUniqueLines(
    vaultFocus,
    recentSessions.slice(0, 3).map((entry) => `- Recent work: ${entry.title} (${entry.project})`),
    recentKnowledge.slice(0, 2).map((entry) => `- Recent knowledge: ${entry.title} — ${entry.summary}`),
  );

  const workstreams = inferWorkstreams([
    ...recentSessions.map((entry) => ({
      text: `${entry.title || ""} ${entry.prompt_excerpt || ""} ${entry.project || ""} ${entry.directory || ""}`,
      evidence: entry.title || entry.prompt_excerpt || entry.project || "Recent session",
      updatedMs: Number(entry.updated_ms || Date.parse(entry.updated || "") || 0),
    })),
    ...recentKnowledge.map((entry) => ({
      text: `${entry.relativePath || ""} ${entry.title || ""} ${entry.summary || ""} ${(entry.bullets || []).join(" ")}`,
      evidence: `${entry.title} — ${entry.summary}`,
      updatedMs: Number(entry.mtimeMs || 0),
    })),
  ]);

  const recentSessionLines = recentSessions.length
    ? recentSessions.map((entry) => `- ${formatRecentTimestamp(Number(entry.updated_ms || Date.parse(entry.updated || "") || 0))} — ${entry.project} — ${entry.title}`)
    : ["- No recent sessions captured yet"];

  const recentKnowledgeLines = recentKnowledge.length
    ? recentKnowledge.map((entry) => `- ${entry.title} — ${entry.summary}`)
    : ["- No recent knowledge updates captured yet"];

  const reminderLines = mergeUniqueLines(existing.reminders, DEFAULT_REMINDERS);

  return `---
updated: ${nowIso()}
source: plugin-auto
confidence: 0.84
---

# Active Context

## Current Priorities
${(priorities.length ? priorities : DEFAULT_PRIORITIES).join("\n")}

## Current Focus
${(focusLines.length ? focusLines : ["- No recent focus captured yet"]).join("\n")}

## Active Workstreams
${(workstreams.length ? workstreams.map((item) => `- ${item.label} — ${item.evidence}`) : ["- No active workstreams inferred yet"]).join("\n")}

## Recent Sessions
${recentSessionLines.join("\n")}

## Recent Knowledge
${recentKnowledgeLines.join("\n")}

## Open Threads
${(existing.openThreads.length ? existing.openThreads : ["- No open threads captured yet"]).join("\n")}

## Durable Reminders
${(reminderLines.length ? reminderLines : DEFAULT_REMINDERS).join("\n")}
`;
}

async function renderOverview(paths) {
  const baseline = await readUserBaseline(paths);
  const priorities = await readCurrentPriorities(paths);
  const activeContext = await readText(paths.activeContext, "");
  const workstreams = bulletLines(activeContext, "Active Workstreams").slice(0, 4);
  const recentSharedWork = bulletLines(activeContext, "Recent Sessions").slice(0, 3);
  const recentKnowledge = bulletLines(activeContext, "Recent Knowledge").slice(0, 3);

  return `---
updated: ${nowIso()}
source: plugin-auto
confidence: 0.88
---

# Overview

## General
${(baseline.length ? baseline : DEFAULT_BASELINE).join("\n")}

## Current Priorities
${(priorities.length ? priorities : DEFAULT_PRIORITIES).join("\n")}

## Active Workstreams
${(workstreams.length ? workstreams : ["- No active workstreams inferred yet"]).join("\n")}

## Recent Shared Work
${(recentSharedWork.length ? recentSharedWork : ["- No recent shared work captured yet"]).join("\n")}

## Recent Knowledge
${(recentKnowledge.length ? recentKnowledge : ["- No recent knowledge captured yet"]).join("\n")}
`;
}

async function refreshDerivedFiles(paths) {
  await writeText(paths.activeContext, await renderActiveContext(paths));
  await writeText(paths.overview, await renderOverview(paths));
}

async function listPendingDropboxFiles(paths) {
  if (!await exists(paths.dropbox)) return [];
  const items = await fs.readdir(paths.dropbox, { withFileTypes: true });
  return items
    .filter((item) => item.isFile())
    .map((item) => item.name)
    .filter((name) => name.toLowerCase() !== "readme.md")
    .filter((name) => SUPPORTED_NOTE_SUFFIXES.has(path.extname(name).toLowerCase()));
}

async function ingestDropbox(paths) {
  if (!await exists(paths.dropbox)) return [];
  const items = await fs.readdir(paths.dropbox, { withFileTypes: true });
  const ingested = [];
  const failed = [];

  for (const item of items) {
    if (!item.isFile()) continue;
    if (item.name.toLowerCase() === "readme.md") continue;
    const extension = path.extname(item.name).toLowerCase();
    if (!SUPPORTED_NOTE_SUFFIXES.has(extension)) continue;

    const fullPath = path.join(paths.dropbox, item.name);
    const raw = (await readText(fullPath, "")).trim();
    const title = extractNoteTitle(raw, item.name.replace(extension, "").replace(/[-_]+/g, " "));
    const stamp = nowLocal().toTimeString().slice(0, 8).replace(/:/g, "");
    const targetBase = path.join(paths.vaultInbox, `${todayDate()} Dropped Note - ${slugify(title)}.md`);
    const target = await uniqueTargetPath(targetBase);
    const content = `---
created: ${todayDate()}
updated: ${todayDate()}
type: note
tags:
  - type/note
  - topic/inbox
  - status/active
source: mercury-dropbox
confidence: 0.8
review_after: ""
---

# ${title}

## Intake Metadata
- Ingested at: ${stamp}
- Original file: \`${item.name}\`
- Original path: \`${fullPath}\`

## Raw Capture
${raw || "(empty file)"}
`;

    try {
      await writeText(target, content);
      const destination = await uniqueTargetPath(path.join(paths.dropboxProcessed, item.name));
      await moveFile(fullPath, destination);
        ingested.push(path.basename(target));
    } catch (error) {
      const failedDestination = await uniqueTargetPath(path.join(paths.dropboxFailed, item.name));
      if (await exists(fullPath)) await moveFile(fullPath, failedDestination);
      failed.push({
        file: item.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ingested, failed };
}

function normalizeImportMode(mode) {
  const value = String(mode || "auto").trim().toLowerCase();
  if (!["auto", "copy", "index"].includes(value)) {
    throw new Error(`Unsupported import mode: ${mode}`);
  }
  return value;
}

async function copyKnowledgeIntoVault(paths, sourcePath) {
  const source = expandPath(sourcePath);
  if (!await exists(source)) throw new Error(`Import source not found: ${source}`);

  const sourceStats = await fs.lstat(source);
  if (sourceStats.isSymbolicLink()) {
    throw new Error(`Import source must not be a symbolic link: ${source}`);
  }
  const files = await listSupportedFiles(source);
  const importRoot = path.join(paths.vaultPath, "30-69 Resources", "Imported", slugify(path.basename(source) || "import"));
  let copied = 0;
  let skipped = 0;

  for (const file of files) {
    const relative = sourceStats.isFile() ? path.basename(file) : path.relative(source, file);
    const raw = await readText(file, "");
    const targetBase = path.join(importRoot, relative);
    let target = targetBase;
    if (await exists(target)) {
      const current = await readText(target, "");
      if (current === raw) {
        skipped += 1;
        continue;
      }
      target = await uniqueTargetPath(targetBase);
    }
    await writeText(target, raw);
    copied += 1;
  }

  return { copied, skipped, targetRoot: importRoot, filesSeen: files.length };
}

async function importKnowledge(paths, state, sourcePath, mode) {
  const source = expandPath(sourcePath);
  if (!source) throw new Error("sourcePath is required");
  const normalizedMode = normalizeImportMode(mode);
  const withinVault = isWithinPath(paths.vaultPath, source);
  let copyResult = { copied: 0, skipped: 0, targetRoot: withinVault ? paths.vaultPath : "", filesSeen: 0 };

  if (normalizedMode === "index" && !withinVault) {
    throw new Error("index mode only works for paths already inside the configured vault");
  }

  if (normalizedMode === "copy" || (!withinVault && normalizedMode === "auto")) {
    copyResult = await copyKnowledgeIntoVault(paths, source);
  }

  const knowledge = await syncKnowledgeIndex(paths, state, true);
  state.imports = [
    ...(state.imports || []),
    {
      sourcePath: source,
      mode: withinVault ? "index" : normalizedMode === "auto" ? "copy" : normalizedMode,
      importedAt: nowIso(),
      copied: copyResult.copied,
      skipped: copyResult.skipped,
      targetRoot: copyResult.targetRoot,
      filesSeen: copyResult.filesSeen,
      indexed: knowledge.indexed,
    },
  ].slice(-25);

  return { ...copyResult, knowledge };
}

async function syncOpenCodeActivity(paths, state) {
  const summaries = await buildSessionSummariesFromDb(paths, MAX_RECENT_SESSIONS + 2);
  const sinceMs = Number(state.lastSessionSyncMs || 0);
  const ledgerEntriesAppended = await appendSessionLedgerEntries(paths, summaries, sinceMs);
  const correctionsAppended = await appendCorrections(paths, await extractCorrectionCandidates(paths, sinceMs));
  const latest = summaries.reduce((max, item) => Math.max(max, Number(item.updated_ms || 0)), sinceMs);
  state.lastSessionSyncMs = latest;
  return {
    sessionsSeen: summaries.length,
    ledgerEntriesAppended,
    correctionsAppended,
    latestSessionAt: latest ? isoFromMs(latest) : "",
  };
}

async function collectStatus(paths) {
  const state = await readPluginState(paths);
  const knowledgeIndex = await readKnowledgeIndex(paths);
  const databaseBackfillAvailable = await exists(paths.opencodeDbPath);
  const controller = maintenanceControllers.get(maintenanceControllerKey(paths));
  return {
    vaultPath: paths.vaultPath,
    memoryPath: paths.memoryPath,
    opencodeDbPath: paths.opencodeDbPath,
    databaseBackfillAvailable,
    maintenanceStrategy: "hook-driven while OpenCode is active",
    autonomousMaintenanceActive: Boolean(controller),
    backgroundIntervalActive: Boolean(controller?.intervalHandle),
    fileWatchEnabled: Boolean(controller?.watchers.length),
    watchedPaths: controller?.watchedPaths || [],
    lastBackgroundTickAt: controller?.lastBackgroundTickAt || null,
    lastBackgroundReason: controller?.lastBackgroundReason || null,
    activitySyncIntervalMs: MAINTENANCE_INTERVAL_MS,
    vaultScanIntervalMs: VAULT_SCAN_INTERVAL_MS,
    systemContextBudgetChars: OVERVIEW_CONTEXT_LIMIT + ACTIVE_CONTEXT_LIMIT,
    recentSessionWindow: MAX_RECENT_SESSIONS,
    recentKnowledgeWindow: MAX_RECENT_KNOWLEDGE,
    pluginStateReadError: state.readError,
    knowledgeIndexReadError: knowledgeIndex.readError,
    lastMaintenanceAt: state.lastMaintenanceAt || null,
    lastSessionSyncAt: state.lastSessionSyncMs ? isoFromMs(state.lastSessionSyncMs) : null,
    lastVaultScanAt: state.lastVaultScanAt || null,
    ledgerEntries: (await parseLedger(paths)).length,
    corrections: await countJsonLines(paths.corrections),
    indexedKnowledgeFiles: Object.keys(knowledgeIndex.files || {}).length,
    pendingDropboxFiles: await listPendingDropboxFiles(paths),
    imports: (state.imports || []).slice(-5),
  };
}

async function maintain(
  paths,
  sessionInfo,
  options,
  {
    force = false,
    reason = "hook",
    allowActivitySync = true,
    allowKnowledgeSync = true,
    allowDropboxIngest = true,
  } = {},
) {
  await ensureScaffold(paths, options, false);
  const state = await readPluginState(paths);
  const nowMs = Date.now();

  const dropbox = allowDropboxIngest ? await ingestDropbox(paths) : { ingested: [], failed: [] };
  const sessionAdded = await updateSessionState(paths, state, sessionInfo);

  let activity = { sessionsSeen: 0, ledgerEntriesAppended: 0, correctionsAppended: 0, latestSessionAt: "" };
  if (allowActivitySync && (force || !state.lastSessionSyncMs || nowMs - Number(state.lastSessionSyncMs || 0) >= MAINTENANCE_INTERVAL_MS)) {
    activity = await syncOpenCodeActivity(paths, state);
  }

  let knowledge = { scanned: 0, indexed: 0, added: 0, updated: 0, removed: 0 };
  if (
    allowKnowledgeSync
    && (
    force
    || !state.lastVaultScanMs
    || nowMs - Number(state.lastVaultScanMs || 0) >= VAULT_SCAN_INTERVAL_MS
    || Boolean(dropbox.ingested.length)
    )
  ) {
    knowledge = await syncKnowledgeIndex(paths, state, force);
  }

  await refreshDerivedFiles(paths);

  state.lastMaintenanceAt = nowIso();
  state.lastMaintenanceMs = nowMs;
  await writePluginState(paths, state);

  return {
    reason,
    sessionAdded,
    dropboxIngested: dropbox.ingested,
    dropboxFailed: dropbox.failed,
    activity,
    knowledge,
    status: await collectStatus(paths),
  };
}

function buildSystemContext(overview, activeContext) {
  return [
    "PKM overview (compact shared memory):",
    truncateBlock(redactSensitiveText(overview), OVERVIEW_CONTEXT_LIMIT),
    "",
    "PKM active context:",
    truncateBlock(redactSensitiveText(activeContext), ACTIVE_CONTEXT_LIMIT),
  ].join("\n");
}

async function runHookMaintenance(input, options, sessionInfo, control) {
  const paths = await buildPaths(input, options);
  try {
    await maintain(paths, sessionInfo, options, control);
  } catch (error) {
    await appendErrorLog(paths, `hook:${control?.reason || "unknown"}`, error);
  }
}

function scheduleControllerRun(controller, reason, delay = WATCH_DEBOUNCE_MS) {
  if (controller.shutdown) return;
  if (controller.scheduledReason === null || reason !== "watch-event") {
    controller.scheduledReason = reason;
  }
  if (controller.scheduledTimer) return;
  controller.scheduledTimer = setTimeout(() => {
    controller.scheduledTimer = null;
    const scheduledReason = controller.scheduledReason || reason;
    controller.scheduledReason = null;
    void controller.run(scheduledReason);
  }, delay);
  controller.scheduledTimer.unref?.();
}

function attachWatch(controller, target, options, reason) {
  try {
    const watcher = watchFs(target, options, () => {
      scheduleControllerRun(controller, reason);
    });
    watcher.unref?.();
    watcher.on("error", async (error) => {
      await appendErrorLog(controller.paths, `watch:${reason}`, error);
    });
    controller.watchers.push(watcher);
    controller.watchedPaths.push(target);
  } catch (error) {
    void appendErrorLog(controller.paths, `watch:${reason}`, error);
  }
}

async function ensureMaintenanceController(paths, options) {
  const key = maintenanceControllerKey(paths);
  const existing = maintenanceControllers.get(key);
  if (existing) return existing;

  await ensureScaffold(paths, options, false);

  const controller = {
    key,
    paths,
    options,
    intervalHandle: null,
    scheduledTimer: null,
    scheduledReason: null,
    watchers: [],
    watchedPaths: [],
    running: false,
    shutdown: false,
    lastBackgroundTickAt: "",
    lastBackgroundReason: "",
    async run(reason) {
      if (controller.shutdown) return;
      if (controller.running) {
        scheduleControllerRun(controller, reason, WATCH_DEBOUNCE_MS);
        return;
      }
      controller.running = true;
      try {
        const result = await maintain(controller.paths, null, controller.options, {
          force: false,
          reason,
          allowActivitySync: true,
          allowKnowledgeSync: true,
          allowDropboxIngest: true,
        });
        controller.lastBackgroundTickAt = result.status.lastMaintenanceAt || nowIso();
        controller.lastBackgroundReason = reason;
      } catch (error) {
        await appendErrorLog(controller.paths, `background:${reason}`, error);
      } finally {
        controller.running = false;
      }
    },
  };

  maintenanceControllers.set(key, controller);

  controller.intervalHandle = setInterval(() => {
    void controller.run("background-interval");
  }, MAINTENANCE_INTERVAL_MS);
  controller.intervalHandle.unref?.();

  attachWatch(controller, paths.dropbox, { persistent: false }, "dropbox-watch");
  attachWatch(controller, paths.vaultPath, { persistent: false, recursive: true }, "vault-watch");

  scheduleControllerRun(controller, "startup-maintenance", 25);

  return controller;
}

export async function server(input, options = {}) {
  const controllerPaths = await buildPaths(input, options);
  await ensureMaintenanceController(controllerPaths, options);

  return {
    tool: {
      pkm_bootstrap: tool({
        description: "Bootstrap or reinitialize a portable PKM vault and hot-memory layer.",
        args: {
          vaultPath: tool.schema.string().optional().describe("Vault path to create or update"),
          memoryPath: tool.schema.string().optional().describe("Hot-memory path to create or update"),
          opencodeDbPath: tool.schema.string().optional().describe("Optional explicit OpenCode SQLite database path"),
          userDisplayName: tool.schema.string().optional().describe("Human-readable user name for templates"),
          primaryWork: tool.schema.string().optional().describe("Short description of the user's core work"),
          force: tool.schema.boolean().optional().describe("Overwrite scaffold files even if they already exist"),
        },
        async execute(args, context) {
          const config = { ...options, ...args };
          const paths = await buildPaths(input, options, args);
          await ensureScaffold(paths, config, Boolean(args.force));
          await writeInstallState({
            vaultPath: paths.vaultPath,
            memoryPath: paths.memoryPath,
            opencodeDbPath: paths.opencodeDbPath,
            userDisplayName: config.userDisplayName || options.userDisplayName || "",
            primaryWork: config.primaryWork || options.primaryWork || "",
          });
          const result = await maintain(paths, null, config, { force: true, reason: "bootstrap" });
          context.metadata({ title: "Bootstrapped Mercury PKM", metadata: { vaultPath: paths.vaultPath, memoryPath: paths.memoryPath } });
          return JSON.stringify({
            message: "Bootstrapped Mercury PKM system",
            vaultPath: paths.vaultPath,
            memoryPath: paths.memoryPath,
            opencodeDbPath: paths.opencodeDbPath,
            result,
          }, null, 2);
        },
      }),
      pkm_status: tool({
        description: "Inspect PKM vault, memory freshness, and indexed knowledge status.",
        args: {},
        async execute(_args, context) {
          const paths = await buildPaths(input, options);
          await ensureScaffold(paths, options, false);
          const status = await collectStatus(paths);
          context.metadata({ title: "Mercury PKM status", metadata: { indexedKnowledgeFiles: status.indexedKnowledgeFiles } });
          return JSON.stringify(status, null, 2);
        },
      }),
      pkm_refresh: tool({
        description: "Force a full Mercury refresh: session backfill, vault scan, and derived-memory rebuild.",
        args: {},
        async execute(_args, context) {
          const paths = await buildPaths(input, options);
          const result = await maintain(paths, null, options, { force: true, reason: "manual-refresh" });
          context.metadata({ title: "Refreshed Mercury PKM", metadata: { indexedKnowledgeFiles: result.status.indexedKnowledgeFiles } });
          return JSON.stringify(result, null, 2);
        },
      }),
      pkm_import_knowledge: tool({
        description: "Import or re-index existing notes so Mercury can derive compact context from them.",
        args: {
          sourcePath: tool.schema.string().describe("File or directory containing notes to import or re-index"),
          mode: tool.schema.string().optional().describe("Import mode: auto, copy, or index"),
        },
        async execute(args, context) {
          const config = { ...options, ...args };
          const paths = await buildPaths(input, options, args);
          await ensureScaffold(paths, config, false);
          const state = await readPluginState(paths);
          const result = await importKnowledge(paths, state, args.sourcePath, args.mode);
          state.lastMaintenanceAt = nowIso();
          state.lastMaintenanceMs = Date.now();
          await writePluginState(paths, state);
          await refreshDerivedFiles(paths);
          context.metadata({ title: "Imported knowledge into Mercury", metadata: { sourcePath: args.sourcePath, indexed: result.knowledge.indexed } });
          return JSON.stringify({
            sourcePath: expandPath(args.sourcePath),
            mode: normalizeImportMode(args.mode),
            result,
            status: await collectStatus(paths),
          }, null, 2);
        },
      }),
      pkm_ingest_note: tool({
        description: "Ingest a raw note directly into the vault inbox and refresh derived memory.",
        args: {
          title: tool.schema.string().optional().describe("Optional note title"),
          noteText: tool.schema.string().describe("Raw note text to ingest into the vault inbox"),
        },
        async execute(args, context) {
          const paths = await buildPaths(input, options);
          await ensureScaffold(paths, options, false);
          const title = extractNoteTitle(args.title || args.noteText, "Ingested note");
          const target = await uniqueTargetPath(path.join(paths.vaultInbox, `${todayDate()} Note - ${slugify(title)}.md`));
          const content = `---
created: ${todayDate()}
updated: ${todayDate()}
type: note
source: mercury-tool
confidence: 0.85
---

# ${title}

## Raw Capture
${args.noteText.trim()}
`;
          await writeText(target, content);
          const result = await maintain(paths, null, options, { force: true, reason: "ingest-note" });
          context.metadata({ title: "Ingested note into Mercury", metadata: { file: target } });
          return JSON.stringify({ file: target, result }, null, 2);
        },
      }),
    },
    "chat.message": async (hookInput, output) => {
      await runHookMaintenance(
        input,
        options,
        {
          sessionID: hookInput.sessionID,
          text: textFromParts(output.parts),
          directory: input.directory,
        },
        { force: false, reason: "chat-message", allowKnowledgeSync: false },
      );
    },
    "command.execute.before": async () => {
      await runHookMaintenance(input, options, null, { force: false, reason: "command-before" });
    },
    "experimental.chat.system.transform": async (_hookInput, output) => {
      const paths = await buildPaths(input, options);
      try {
        await ensureScaffold(paths, options, false);
        const overview = await readText(paths.overview, "");
        const activeContext = await readText(paths.activeContext, "");
        if (overview.trim() || activeContext.trim()) {
          output.system.unshift(buildSystemContext(overview, activeContext));
        }
      } catch (error) {
        await appendErrorLog(paths, "hook:system-transform", error);
      }
    },
    "experimental.session.compacting": async (_hookInput, output) => {
      const paths = await buildPaths(input, options);
      try {
        await ensureScaffold(paths, options, false);
        const overview = await readText(paths.overview, "");
        if (overview.trim()) {
          output.context.push(`Use this compact PKM overview as durable context during compaction:\n${truncateBlock(redactSensitiveText(overview), 2500)}`);
        }
      } catch (error) {
        await appendErrorLog(paths, "hook:session-compacting", error);
      }
    },
  };
}

export default { server };
