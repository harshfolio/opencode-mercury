import { promises as fs, watch as watchFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { tool } from "@opencode-ai/plugin";
import {
  ACTIVE_CONTEXT_LIMIT,
  BACKUP_SCOPE_DEFINITIONS,
  CORRECTION_PATTERNS,
  DEFAULT_BACKUP_INTERVAL_MS,
  DEFAULT_BACKUP_RETENTION_COUNT,
  DEFAULT_BASELINE,
  DEFAULT_BACKUP_ROOT,
  DEFAULT_DB_CANDIDATES,
  DEFAULT_MEMORY_ROOT,
  DEFAULT_OPENCODE_CONFIG_ROOT,
  DEFAULT_PRIORITIES,
  DEFAULT_REMINDERS,
  DEFAULT_VAULT_ROOT,
  INSTALL_STATE,
  MAINTENANCE_INTERVAL_MS,
  MAX_RECENT_KNOWLEDGE,
  MAX_RECENT_SESSIONS,
  NOISE_PATTERNS,
  OVERVIEW_CONTEXT_LIMIT,
  PATH_REDACTION_PATTERNS,
  SENSITIVE_PATTERNS,
  SUPPORTED_NOTE_SUFFIXES,
  VAULT_SCAN_INTERVAL_MS,
  WATCH_COOLDOWN_MS,
  WATCH_DEBOUNCE_MS,
  WORKSTREAM_RULES,
} from "./config/constants.mjs";

export const id = "@harshfolio/opencode-mercury";

const maintenanceControllers = new Map();
const maintenanceChains = new Map();
let sqliteDriverPromise = null;
const MAX_METRIC_RUNS = 20;
const fileReadCaches = {
  ledger: { path: "", mtimeMs: 0, size: 0, value: [] },
  knowledgeIndex: { path: "", mtimeMs: 0, size: 0, value: { version: 1, updated: "", files: {} }, readError: false },
};

function dynamicImport(specifier) {
  return new Function("specifier", "return import(specifier);")(specifier);
}

async function resolveSqliteDriver() {
  if (!sqliteDriverPromise) {
    sqliteDriverPromise = (async () => {
      let nodeSqliteError = null;
      try {
        const module = await dynamicImport("bun:sqlite");
        if (typeof module?.Database === "function") {
          return {
            runtime: "bun:sqlite",
            open(dbPath) {
              return new module.Database(dbPath);
            },
            queryAll(db, sql, ...params) {
              return db.query(sql).all(...params);
            },
            close(db) {
              db.close(false);
            },
          };
        }
      } catch {}

      try {
        const module = await dynamicImport("node:sqlite");
        if (typeof module?.DatabaseSync !== "function") {
          throw new Error("`node:sqlite` did not expose DatabaseSync");
        }
        return {
          runtime: "node:sqlite",
          open(dbPath) {
            return new module.DatabaseSync(dbPath);
          },
          queryAll(db, sql, ...params) {
            return db.prepare(sql).all(...params);
          },
          close(db) {
            db.close();
          },
        };
      } catch (error) {
        nodeSqliteError = error;
      }

      throw nodeSqliteError || new Error("No compatible SQLite runtime available");
    })();
  }
  return sqliteDriverPromise;
}

async function hasSqliteSupport() {
  try {
    await resolveSqliteDriver();
    return true;
  } catch {
    return false;
  }
}

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

function splitFrontmatter(markdown) {
  const source = String(markdown || "");
  if (!source.startsWith("---\n")) return { frontmatter: "", body: source };
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: "", body: source };
  return {
    frontmatter: source.slice(0, end + 5),
    body: source.slice(end + 5),
  };
}

function updateFrontmatterValue(frontmatter, key, value) {
  const clean = String(frontmatter || "");
  if (!clean.trim()) {
    return `---\n${key}: ${value}\n---\n\n`;
  }
  const lines = clean.trimEnd().split(/\r?\n/);
  const nextEntry = `${key}: ${value}`;
  const index = lines.findIndex((line, lineIndex) => lineIndex > 0 && lineIndex < lines.length - 1 && line.startsWith(`${key}:`));
  if (index >= 0) lines[index] = nextEntry;
  else lines.splice(lines.length - 1, 0, nextEntry);
  return `${lines.join("\n")}\n\n`;
}

function normalizeBulletItem(content) {
  const clean = String(content || "").trim().replace(/^-\s+/, "");
  return clean ? `- ${clean}` : "";
}

function upsertBulletSection(markdown, sectionTitle, content) {
  const bullet = normalizeBulletItem(content);
  if (!bullet) return String(markdown || "");

  const { frontmatter, body } = splitFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  const heading = `## ${sectionTitle}`;
  const sectionStart = lines.findIndex((line) => line.trim() === heading);

  if (sectionStart === -1) {
    const bodyText = body.trimEnd();
    const section = `${heading}\n${bullet}`;
    return `${frontmatter}${bodyText ? `${bodyText}\n\n${section}\n` : `${section}\n`}`;
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      sectionEnd = index;
      break;
    }
  }

  const sectionLines = lines.slice(sectionStart + 1, sectionEnd).map((line) => line.trim());
  if (sectionLines.includes(bullet)) {
    return `${frontmatter}${body}`;
  }

  let insertAt = sectionEnd;
  while (insertAt > sectionStart + 1 && !lines[insertAt - 1].trim()) insertAt -= 1;
  lines.splice(insertAt, 0, bullet);
  return `${frontmatter}${lines.join("\n")}`;
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

async function readFileStats(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function resetFileCache(name, target = "") {
  if (name === "ledger") {
    fileReadCaches.ledger = { path: target, mtimeMs: 0, size: 0, value: [] };
    return;
  }
  if (name === "knowledgeIndex") {
    fileReadCaches.knowledgeIndex = {
      path: target,
      mtimeMs: 0,
      size: 0,
      value: { version: 1, updated: "", files: {} },
      readError: false,
    };
  }
}

function invalidateDerivedCachesForPath(target) {
  const normalizedTarget = String(target || "");
  if (!normalizedTarget) return;
  if (normalizedTarget === fileReadCaches.ledger.path) resetFileCache("ledger", normalizedTarget);
  if (normalizedTarget === fileReadCaches.knowledgeIndex.path) resetFileCache("knowledgeIndex", normalizedTarget);
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
  invalidateDerivedCachesForPath(target);
}

async function writeTextIfChanged(target, content) {
  try {
    const existing = await fs.readFile(target, "utf8");
    if (existing === content) return false;
  } catch {}
  await writeText(target, content);
  return true;
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
  invalidateDerivedCachesForPath(target);
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

async function runSerializedMaintenance(paths, operation) {
  const key = maintenanceControllerKey(paths);
  const previous = maintenanceChains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  maintenanceChains.set(key, current);
  try {
    return await current;
  } finally {
    if (maintenanceChains.get(key) === current) maintenanceChains.delete(key);
  }
}

function firstDefinedPath(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return expandPath(value.trim());
  }
  return "";
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function snapshotTimestamp() {
  return `${nowIso().replace(/:/g, "-")}-${String(Date.now() % 1000).padStart(3, "0")}`;
}

function normalizeBackupRecord(record = {}) {
  return {
    lastRunAt: String(record.lastRunAt || ""),
    lastRunMs: Number(record.lastRunMs || 0),
    lastSnapshotPath: String(record.lastSnapshotPath || ""),
    lastReason: String(record.lastReason || ""),
    lastError: String(record.lastError || ""),
  };
}

function shouldRunBackup(record, intervalMs, force = false) {
  if (force) return true;
  if (!record?.lastRunMs) return true;
  return Date.now() - Number(record.lastRunMs || 0) >= intervalMs;
}

function resolveBackupIntervalMs(config = {}, persisted = {}) {
  const explicitMs = parsePositiveNumber(config.backupIntervalMs, 0);
  if (explicitMs) return explicitMs;

  const explicitHours = parsePositiveNumber(config.backupIntervalHours, 0);
  if (explicitHours) return explicitHours * 60 * 60 * 1000;

  const persistedMs = parsePositiveNumber(persisted.backupIntervalMs, 0);
  if (persistedMs) return persistedMs;

  const persistedHours = parsePositiveNumber(persisted.backupIntervalHours, 0);
  if (persistedHours) return persistedHours * 60 * 60 * 1000;

  return DEFAULT_BACKUP_INTERVAL_MS;
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
  const opencodeConfigPath = firstDefinedPath(config.opencodeConfigPath, persisted.opencodeConfigPath, process.env.OPENCODE_PKM_CONFIG_PATH)
    || DEFAULT_OPENCODE_CONFIG_ROOT;
  const backupRoot = firstDefinedPath(config.backupRoot, persisted.backupRoot, process.env.OPENCODE_PKM_BACKUP_ROOT)
    || DEFAULT_BACKUP_ROOT;
  const backupIntervalMs = resolveBackupIntervalMs(config, persisted);
  const backupRetentionCount = parsePositiveInteger(config.backupRetentionCount, parsePositiveInteger(persisted.backupRetentionCount, DEFAULT_BACKUP_RETENTION_COUNT));
  const explicitDbPath = firstDefinedPath(config.opencodeDbPath, process.env.OPENCODE_PKM_DB_PATH);
  const rememberedDbPath = firstDefinedPath(persisted.opencodeDbPath);
  const opencodeDbPath = explicitDbPath
    || await firstExistingPath([rememberedDbPath, ...DEFAULT_DB_CANDIDATES])
    || rememberedDbPath
    || DEFAULT_DB_CANDIDATES[0];

  return {
    input,
    vaultPath,
    memoryPath,
    opencodeConfigPath,
    opencodeDbPath,
    opencodeStateRoot: path.dirname(opencodeDbPath),
    backupRoot,
    backupIntervalMs,
    backupRetentionCount,
    vaultHome: path.join(vaultPath, "Vault Home.md"),
    vaultAgents: path.join(vaultPath, "AGENTS.md"),
    opencodeAgents: path.join(opencodeConfigPath, "AGENTS.md"),
    opencodeAgentsBackup: path.join(opencodeConfigPath, "AGENTS.mercury-backup.md"),
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
    backups: {
      vault: normalizeBackupRecord(),
      opencodeConfig: normalizeBackupRecord(),
      opencodeState: normalizeBackupRecord(),
    },
    lastMaintenanceAt: "",
    lastMaintenanceMs: 0,
    lastSessionSyncMs: 0,
    lastOpenCodePollMs: 0,
    lastOpenCodeLedgerCursor: { updatedMs: 0, sessionID: "" },
    lastOpenCodeCorrectionCursor: { updatedMs: 0, sessionID: "" },
    lastVaultScanAt: "",
    lastVaultScanMs: 0,
    lastDerivedFingerprint: "",
    lastAgentsFingerprint: "",
    metrics: {
      lastRuns: [],
    },
  }, null, 2)}\n`;
}

function normalizeMetrics(metrics) {
  return {
    lastRuns: Array.isArray(metrics?.lastRuns) ? metrics.lastRuns.slice(-MAX_METRIC_RUNS) : [],
  };
}

function normalizeOpenCodeCursor(cursor) {
  return {
    updatedMs: Number(cursor?.updatedMs || 0),
    sessionID: String(cursor?.sessionID || ""),
  };
}

async function ensureScaffold(paths, options = {}, force = false) {
  await Promise.all([
    ensureDir(paths.vaultInbox),
    ensureDir(paths.backupRoot),
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
    backups: {
      vault: normalizeBackupRecord(state.backups?.vault),
      opencodeConfig: normalizeBackupRecord(state.backups?.opencodeConfig),
      opencodeState: normalizeBackupRecord(state.backups?.opencodeState),
    },
    lastMaintenanceAt: String(state.lastMaintenanceAt || ""),
    lastMaintenanceMs: Number(state.lastMaintenanceMs || 0),
    lastSessionSyncMs: Number(state.lastSessionSyncMs || 0),
    lastOpenCodePollMs: Number(state.lastOpenCodePollMs || 0),
    lastOpenCodeLedgerCursor: normalizeOpenCodeCursor(state.lastOpenCodeLedgerCursor),
    lastOpenCodeCorrectionCursor: normalizeOpenCodeCursor(state.lastOpenCodeCorrectionCursor),
    lastVaultScanAt: String(state.lastVaultScanAt || ""),
    lastVaultScanMs: Number(state.lastVaultScanMs || 0),
    lastDerivedFingerprint: String(state.lastDerivedFingerprint || ""),
    lastAgentsFingerprint: String(state.lastAgentsFingerprint || ""),
    metrics: normalizeMetrics(state.metrics),
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
    backups: {
      vault: normalizeBackupRecord(state.backups?.vault),
      opencodeConfig: normalizeBackupRecord(state.backups?.opencodeConfig),
      opencodeState: normalizeBackupRecord(state.backups?.opencodeState),
    },
    lastMaintenanceAt: state.lastMaintenanceAt || "",
    lastMaintenanceMs: Number(state.lastMaintenanceMs || 0),
    lastSessionSyncMs: Number(state.lastSessionSyncMs || 0),
    lastOpenCodePollMs: Number(state.lastOpenCodePollMs || 0),
    lastOpenCodeLedgerCursor: normalizeOpenCodeCursor(state.lastOpenCodeLedgerCursor),
    lastOpenCodeCorrectionCursor: normalizeOpenCodeCursor(state.lastOpenCodeCorrectionCursor),
    lastVaultScanAt: state.lastVaultScanAt || "",
    lastVaultScanMs: Number(state.lastVaultScanMs || 0),
    lastDerivedFingerprint: state.lastDerivedFingerprint || "",
    lastAgentsFingerprint: state.lastAgentsFingerprint || "",
    metrics: normalizeMetrics(state.metrics),
  });
}

function metricDurationMs(startMs) {
  return Number((performance.now() - startMs).toFixed(1));
}

function rememberMaintenanceMetrics(state, run) {
  const metrics = normalizeMetrics(state.metrics);
  metrics.lastRuns.push(run);
  metrics.lastRuns = metrics.lastRuns.slice(-MAX_METRIC_RUNS);
  state.metrics = metrics;
}

function fingerprintFromStats(statsMap) {
  return Object.entries(statsMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value?.mtimeMs || 0}:${value?.size || 0}`)
    .join("|");
}

async function computeDerivedFingerprint(paths) {
  const [ledger, knowledgeIndex, currentPriorities, userProfile, vaultAgentContext] = await Promise.all([
    readFileStats(paths.ledger),
    readFileStats(paths.knowledgeIndex),
    readFileStats(paths.currentPriorities),
    readFileStats(paths.userProfile),
    readFileStats(paths.vaultAgentContext),
  ]);
  return fingerprintFromStats({ ledger, knowledgeIndex, currentPriorities, userProfile, vaultAgentContext });
}

async function computeAgentsFingerprint(paths) {
  const userProfile = await readFileStats(paths.userProfile);
  return fingerprintFromStats({ userProfile });
}

async function readKnowledgeIndex(paths) {
  const stats = await readFileStats(paths.knowledgeIndex);
  if (!stats) {
    resetFileCache("knowledgeIndex", paths.knowledgeIndex);
    return {
      version: 1,
      updated: "",
      files: {},
      readError: false,
    };
  }

  const cached = fileReadCaches.knowledgeIndex;
  if (
    cached.path === paths.knowledgeIndex
    && cached.mtimeMs === stats.mtimeMs
    && cached.size === stats.size
  ) {
    return {
      version: 1,
      updated: String(cached.value.updated || ""),
      files: typeof cached.value.files === "object" && cached.value.files ? cached.value.files : {},
      readError: cached.readError,
    };
  }

  const { value: index, readError } = await readJsonFileWithReporting(paths, paths.knowledgeIndex, "knowledge-index", { version: 1, updated: "", files: {} });
  fileReadCaches.knowledgeIndex = {
    path: paths.knowledgeIndex,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    value: index,
    readError,
  };
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
  fileReadCaches.knowledgeIndex = {
    path: paths.knowledgeIndex,
    mtimeMs: 0,
    size: 0,
    value: { version: 1, updated: index.updated || nowIso(), files: index.files || {} },
    readError: false,
  };
}

async function appendErrorLog(paths, label, error) {
  const message = `${nowIso()} ${label}: ${error instanceof Error ? error.stack || error.message : String(error)}\n`;
  await appendText(paths.errorLog, message);
}

function shouldSkipBackupRelativePath(relativePath, excludedPrefixes = []) {
  const normalized = normalizeRelativePath(relativePath);
  return excludedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function backupFilterFor(sourceRoot, backupRoot, excludedPrefixes = []) {
  const backupInsideSource = isWithinPath(sourceRoot, backupRoot);
  const backupRelative = backupInsideSource ? normalizeRelativePath(path.relative(sourceRoot, backupRoot)) : "";

  return (sourcePath) => {
    if (sourcePath === sourceRoot) return true;
    const relativePath = normalizeRelativePath(path.relative(sourceRoot, sourcePath));
    if (!relativePath || relativePath === ".") return true;
    if (backupRelative && (relativePath === backupRelative || relativePath.startsWith(`${backupRelative}/`))) return false;
    return !shouldSkipBackupRelativePath(relativePath, excludedPrefixes);
  };
}

async function pruneBackupSnapshots(scopeRoot, retentionCount) {
  if (!await exists(scopeRoot)) return [];
  const entries = await fs.readdir(scopeRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const removable = directories.slice(0, Math.max(0, directories.length - retentionCount));
  await Promise.all(removable.map((name) => fs.rm(path.join(scopeRoot, name), { recursive: true, force: true })));
  return removable;
}

async function createDirectorySnapshot(sourceRoot, scopeRoot, backupRoot, excludedPrefixes, snapshotName) {
  await ensureDir(scopeRoot);
  const snapshotPath = await uniqueTargetPath(path.join(scopeRoot, snapshotName));
  await fs.cp(sourceRoot, snapshotPath, {
    recursive: true,
    force: true,
    preserveTimestamps: false,
    filter: backupFilterFor(sourceRoot, backupRoot, excludedPrefixes),
  });
  return snapshotPath;
}

function backupSpecs(paths) {
  return [
    {
      ...BACKUP_SCOPE_DEFINITIONS[0],
      sourceRoot: paths.vaultPath,
      scopeRoot: path.join(paths.backupRoot, BACKUP_SCOPE_DEFINITIONS[0].directoryName),
    },
    {
      ...BACKUP_SCOPE_DEFINITIONS[1],
      sourceRoot: paths.opencodeConfigPath,
      scopeRoot: path.join(paths.backupRoot, BACKUP_SCOPE_DEFINITIONS[1].directoryName),
    },
    {
      ...BACKUP_SCOPE_DEFINITIONS[2],
      sourceRoot: paths.opencodeStateRoot,
      scopeRoot: path.join(paths.backupRoot, BACKUP_SCOPE_DEFINITIONS[2].directoryName),
    },
  ];
}

async function runBackups(paths, state, { force = false, reason = "maintenance" } = {}) {
  const snapshotName = snapshotTimestamp();
  const backupRunAt = nowIso();
  const results = [];

  for (const spec of backupSpecs(paths)) {
    const previous = normalizeBackupRecord(state.backups?.[spec.key]);
    if (!shouldRunBackup(previous, paths.backupIntervalMs, force)) {
      results.push({ scope: spec.key, label: spec.label, skipped: true, reason: "not-due" });
      continue;
    }

    if (!await exists(spec.sourceRoot)) {
      results.push({ scope: spec.key, label: spec.label, skipped: true, reason: "missing-source" });
      continue;
    }

    try {
      const snapshotPath = await createDirectorySnapshot(spec.sourceRoot, spec.scopeRoot, paths.backupRoot, spec.excludedPrefixes, snapshotName);
      await pruneBackupSnapshots(spec.scopeRoot, paths.backupRetentionCount);
      state.backups[spec.key] = {
        lastRunAt: backupRunAt,
        lastRunMs: Date.now(),
        lastSnapshotPath: snapshotPath,
        lastReason: reason,
        lastError: "",
      };
      results.push({ scope: spec.key, label: spec.label, snapshotPath, skipped: false });
    } catch (error) {
      state.backups[spec.key] = {
        ...previous,
        lastReason: reason,
        lastError: error instanceof Error ? error.message : String(error),
      };
      await appendErrorLog(paths, `backup:${spec.key}`, error);
      results.push({
        scope: spec.key,
        label: spec.label,
        failed: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function parseLedger(paths) {
  const stats = await readFileStats(paths.ledger);
  if (!stats) {
    resetFileCache("ledger", paths.ledger);
    return [];
  }

  const cached = fileReadCaches.ledger;
  if (
    cached.path === paths.ledger
    && cached.mtimeMs === stats.mtimeMs
    && cached.size === stats.size
  ) {
    return cached.value;
  }

  const raw = await readText(paths.ledger, "");
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJsonParse(line, null))
    .filter(Boolean)
    .sort((left, right) => String(right.updated || "").localeCompare(String(left.updated || "")));
  fileReadCaches.ledger = {
    path: paths.ledger,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    value: entries,
  };
  return entries;
}

function latestLedgerEntries(entries) {
  const latestBySession = new Map();
  for (const entry of entries) {
    const sessionID = String(entry?.session_id || "");
    if (!sessionID) continue;
    const current = latestBySession.get(sessionID);
    if (!current || Number(entry.updated_ms || 0) >= Number(current.updated_ms || 0)) {
      latestBySession.set(sessionID, entry);
    }
  }
  return Array.from(latestBySession.values())
    .sort((left, right) => Number(right.updated_ms || 0) - Number(left.updated_ms || 0));
}

async function countJsonLines(target) {
  const raw = await readText(target, "");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

async function appendLedgerEntry(paths, entry) {
  await appendText(paths.ledger, `${JSON.stringify(entry)}\n`);
}

async function existingLedgerIds(paths) {
  const entries = latestLedgerEntries(await parseLedger(paths));
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
  const raw = await readText(paths.currentPriorities, "");
  const priorities = bulletLines(raw, "Current Priorities");
  if (priorities.length) return priorities.slice(0, 5);
  const fallbackBullets = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
  if (fallbackBullets.length) return fallbackBullets.slice(0, 5);
  return priorities.length ? priorities.slice(0, 5) : DEFAULT_PRIORITIES;
}

async function readProfileSection(paths, section, limit = 5) {
  return bulletLines(await readText(paths.userProfile, ""), section).slice(0, limit);
}

const MEMORY_PROFILE_SECTIONS = {
  identity: "Identity",
  "account-map": "Account Map",
  "general-work-baseline": "General Work Baseline",
  "working-preferences": "Working Preferences",
  "stable-preferences": "Stable Preferences",
};

async function rememberProfileFact(paths, category, content) {
  const sectionTitle = MEMORY_PROFILE_SECTIONS[category];
  if (!sectionTitle) {
    throw new Error(`Unsupported memory category: ${category}`);
  }

  const currentProfile = await readText(paths.userProfile, renderUserProfile({}));
  let nextProfile = upsertBulletSection(currentProfile, sectionTitle, content);
  const split = splitFrontmatter(nextProfile);
  const updatedFrontmatter = updateFrontmatterValue(split.frontmatter, "updated", todayDate());
  nextProfile = `${updatedFrontmatter}${split.body.trimStart()}`;
  await writeText(paths.userProfile, nextProfile.endsWith("\n") ? nextProfile : `${nextProfile}\n`);
}

async function readVaultFocus(paths) {
  return bulletLines(await readText(paths.vaultAgentContext, ""), "Focus").slice(0, 3);
}

function isMercuryManagedAgents(text) {
  return String(text || "").includes("Generated by Mercury");
}

async function renderGlobalAgents(paths) {
  const identity = await readProfileSection(paths, "Identity", 3);
  const accountMap = await readProfileSection(paths, "Account Map", 3);
  const workingPreferences = await readProfileSection(paths, "Working Preferences", 6);
  const stablePreferences = await readProfileSection(paths, "Stable Preferences", 5);

  return `# Global Agent Standards (Mercury-managed)

> Generated by Mercury. This file is the thin stable operating profile for OpenCode on this machine.
> Volatile/project context does **not** live here. Mercury owns that context in \`~/.config/opencode/memory/\`.

## Source of Truth
- Stable user/profile memory lives in \`~/.config/opencode/memory/user-profile.md\`
- Compact current context lives in \`~/.config/opencode/memory/overview.md\` and \`~/.config/opencode/memory/active-context.md\`
- Durable knowledge lives in the configured vault
- Do not duplicate volatile project state in this file

## Session Start Protocol
- Read \`~/.config/opencode/memory/overview.md\` at session start
- Read \`~/.config/opencode/memory/user-profile.md\` when stable preferences or identity context matters
- Read \`~/.config/opencode/memory/active-context.md\` only when continuity or strategic context is relevant
- Use Mercury tools to write memory back instead of editing memory files manually when possible

## Identity
${(identity.length ? identity : ["- Unknown user"]).join("\n")}

## Account Map
${(accountMap.length ? accountMap : ["- No account mapping captured yet"]).join("\n")}

## Working Preferences
${(workingPreferences.length ? workingPreferences : ["- Keep context compact and high-signal"]).join("\n")}

## Stable Preferences
${(stablePreferences.length ? stablePreferences : ["- No stable preferences captured yet"]).join("\n")}

## Mercury Write-back Protocol
- Use \`pkm_remember\` for stable profile facts and user preferences
- Use \`pkm_ingest_note\` for raw captures that belong in the vault inbox
- Use \`pkm_refresh\` when you want a full memory rebuild
- Treat Mercury as the memory authority; treat this file as its stable bootstrap surface
`;
}

async function syncGlobalAgents(paths, state) {
  const fingerprint = await computeAgentsFingerprint(paths);
  if (state && state.lastAgentsFingerprint === fingerprint) return false;
  const existing = await readText(paths.opencodeAgents, "");
  if (existing.trim() && !isMercuryManagedAgents(existing) && !await exists(paths.opencodeAgentsBackup)) {
    await writeText(paths.opencodeAgentsBackup, existing.endsWith("\n") ? existing : `${existing}\n`);
  }
  const changed = await writeTextIfChanged(paths.opencodeAgents, await renderGlobalAgents(paths));
  if (state) state.lastAgentsFingerprint = fingerprint;
  return changed;
}

async function connectDb(dbPath) {
  const driver = await resolveSqliteDriver();
  return {
    driver,
    handle: driver.open(dbPath),
  };
}

function queryAll(db, sql, ...params) {
  return db.driver.queryAll(db.handle, sql, ...params);
}

function sessionCursorFromRow(row) {
  return {
    updatedMs: Number(row?.time_updated || 0),
    sessionID: String(row?.id || ""),
  };
}

function compareSessionCursor(left, right) {
  if (Number(left?.updatedMs || 0) !== Number(right?.updatedMs || 0)) {
    return Number(left?.updatedMs || 0) - Number(right?.updatedMs || 0);
  }
  return String(left?.sessionID || "").localeCompare(String(right?.sessionID || ""));
}

function maxSessionCursor(...cursors) {
  return cursors.reduce((best, cursor) => (compareSessionCursor(cursor, best) > 0 ? cursor : best), { updatedMs: 0, sessionID: "" });
}

function sessionPageQuery(direction, includeCursor = false) {
  const comparator = direction === "desc" ? "<" : ">";
  const order = direction === "desc" ? "DESC" : "ASC";
  if (!includeCursor) {
    return `SELECT id, title, directory, time_updated FROM session ORDER BY time_updated ${order}, id ${order} LIMIT ?`;
  }
  return `SELECT id, title, directory, time_updated FROM session WHERE time_updated ${comparator} ? OR (time_updated = ? AND id ${comparator} ?) ORDER BY time_updated ${order}, id ${order} LIMIT ?`;
}

function loadSessionRows(db, cursor, limit, direction = "asc") {
  const normalized = normalizeOpenCodeCursor(cursor);
  const includeCursor = Boolean(normalized.updatedMs || normalized.sessionID);
  return includeCursor
    ? queryAll(db, sessionPageQuery(direction, true), normalized.updatedMs, normalized.updatedMs, normalized.sessionID, limit)
    : queryAll(db, sessionPageQuery(direction, false), limit);
}

function loadMessagesForSessions(db, sessionIDs) {
  if (!sessionIDs.length) return [];
  const placeholders = sessionIDs.map(() => "?").join(", ");
  return queryAll(
    db,
    `SELECT id, session_id, time_created, data FROM message WHERE session_id IN (${placeholders}) ORDER BY session_id ASC, time_created ASC, id ASC`,
    ...sessionIDs,
  );
}

function loadPartsForMessages(db, messageIDs) {
  if (!messageIDs.length) return [];
  const rows = [];
  for (let index = 0; index < messageIDs.length; index += 250) {
    const batch = messageIDs.slice(index, index + 250);
    const placeholders = batch.map(() => "?").join(", ");
    rows.push(...queryAll(
      db,
      `SELECT id, message_id, time_created, data FROM part WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, id ASC`,
      ...batch,
    ));
  }
  return rows;
}

function hydrateSessionArtifacts(sessionRows, messageRows, partRows, existingCorrections = null) {
  const partsByMessage = new Map();
  for (const row of partRows) {
    const entries = partsByMessage.get(row.message_id) || [];
    entries.push(row);
    partsByMessage.set(row.message_id, entries);
  }

  const textByMessage = new Map();
  for (const [messageID, rows] of partsByMessage.entries()) {
    const text = rows
      .map((partRow) => ({
        timeCreated: Number(partRow.time_created || 0),
        id: String(partRow.id || ""),
        part: safeJsonParse(partRow.data, null),
      }))
      .sort((left, right) => left.timeCreated - right.timeCreated || left.id.localeCompare(right.id))
      .map((entry) => entry.part)
      .filter((part) => part && part.type === "text")
      .map((part) => stripFences(part.text || ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    textByMessage.set(messageID, text);
  }

  const messagesBySession = new Map();
  for (const row of messageRows) {
    const entries = messagesBySession.get(row.session_id) || [];
    const message = safeJsonParse(row.data, null);
    entries.push({
      id: String(row.id || ""),
      role: message?.role || "",
      text: textByMessage.get(row.id) || "",
    });
    messagesBySession.set(row.session_id, entries);
  }

  const summaries = [];
  const corrections = [];
  for (const row of sessionRows) {
    const messages = messagesBySession.get(row.id) || [];
    const project = path.basename(row.directory || "global") || "global";
    const promptExcerpt = messages
      .filter((message) => message.role === "user")
      .map((message) => message.text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "")
      .find(Boolean) || "";
    let title = row.title || promptExcerpt || project;
    if (String(title).startsWith("New session -") && promptExcerpt) title = promptExcerpt;
    const assistantSummary = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text)
      .find((text) => text && !isNoise(text));
    const summary = assistantSummary ? extractNoteSummary(assistantSummary, title) : "";
    summaries.push({
      session_id: row.id,
      updated: isoFromMs(row.time_updated),
      updated_ms: row.time_updated,
      project,
      directory: row.directory || "",
      title: truncate(title, 100),
      prompt_excerpt: truncate(promptExcerpt, 120),
      summary: truncate(summary || promptExcerpt || title, 180),
    });
    if (!existingCorrections) continue;
    for (const message of messages) {
      if (message.role !== "user" || !message.text) continue;
      for (const rawLine of String(message.text || "").split(/\r?\n/)) {
        const line = truncate(rawLine, 220);
        if (line.length < 12) continue;
        if (!CORRECTION_PATTERNS.some((pattern) => pattern.test(line))) continue;
        if (existingCorrections.has(line)) continue;
        corrections.push({
          ts: nowIso(),
          scope: "session-correction",
          project,
          correction: line,
          source: `opencode-session:${row.id}`,
          confidence: 0.65,
        });
        existingCorrections.add(line);
      }
    }
  }

  return { summaries, corrections };
}

function loadSessionArtifacts(db, sessionRows, existingCorrections = null) {
  if (!sessionRows.length) return { summaries: [], corrections: [] };
  const sessionIDs = sessionRows.map((row) => row.id);
  const messageRows = loadMessagesForSessions(db, sessionIDs);
  const messageIDs = messageRows.map((row) => row.id);
  const partRows = loadPartsForMessages(db, messageIDs);
  return hydrateSessionArtifacts(sessionRows, messageRows, partRows, existingCorrections);
}

async function buildRecentSessionSummariesFromDb(paths, limit = MAX_RECENT_SESSIONS) {
  if (!await exists(paths.opencodeDbPath)) return [];
  let db;
  try {
    db = await connectDb(paths.opencodeDbPath);
    const rows = loadSessionRows(db, null, limit, "desc");
    return loadSessionArtifacts(db, rows).summaries;
  } finally {
    db?.driver.close(db.handle);
  }
}

async function appendSessionLedgerEntries(paths, summaries) {
  const latestEntries = new Map(latestLedgerEntries(await parseLedger(paths)).map((entry) => [entry.session_id, entry]));
  const additions = summaries.filter((summary) => {
    const current = latestEntries.get(summary.session_id);
    if (!current) return true;
    return Number(summary.updated_ms || 0) > Number(current.updated_ms || 0)
      || String(summary.summary || "") !== String(current.summary || "")
      || String(summary.title || "") !== String(current.title || "");
  });
  if (!additions.length) return 0;
  await appendText(paths.ledger, `${additions.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return additions.length;
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
    summary: summarizePrompt(text, path.basename(sessionInfo.directory || "session")),
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

function normalizeKnowledgeRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return "";
  if (normalized === ".") return "";
  return normalized;
}

async function syncKnowledgeEntryAtPath(paths, index, relativePath, force = false) {
  const normalized = normalizeKnowledgeRelativePath(relativePath);
  if (!normalized || shouldIgnoreVaultFile(normalized)) return { scanned: 0, added: 0, updated: 0, removed: 0, changed: false };
  const fullPath = path.join(paths.vaultPath, normalized);
  const stats = await readFileStats(fullPath);
  if (!stats || !stats.isFile() || !SUPPORTED_NOTE_SUFFIXES.has(path.extname(normalized).toLowerCase())) {
    const subtreePrefix = `${normalized}/`;
    const removedKeys = Object.keys(index.files).filter((key) => key === normalized || key.startsWith(subtreePrefix));
    if (removedKeys.length) {
      for (const key of removedKeys) delete index.files[key];
      return { scanned: 1, added: 0, updated: 0, removed: removedKeys.length, changed: true };
    }
    return { scanned: 1, added: 0, updated: 0, removed: 0, changed: false };
  }
  const previous = index.files[normalized];
  if (!force && previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
    return { scanned: 1, added: 0, updated: 0, removed: 0, changed: false };
  }
  const rawContent = await readText(fullPath, "");
  index.files[normalized] = summarizeKnowledgeFile(rawContent, normalized, stats);
  return { scanned: 1, added: previous ? 0 : 1, updated: previous ? 1 : 0, removed: 0, changed: true };
}

async function syncKnowledgeIndexFull(paths, state, force = false) {
  const index = await readKnowledgeIndex(paths);
  const files = await listSupportedFiles(paths.vaultPath);
  const seen = new Set();
  let added = 0;
  let updated = 0;

  for (const fullPath of files) {
    const relativePath = normalizeKnowledgeRelativePath(path.relative(paths.vaultPath, fullPath));
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

async function syncKnowledgeIndexDirty(paths, state, dirtyPaths, force = false) {
  const uniquePaths = Array.from(new Set((dirtyPaths || []).map(normalizeKnowledgeRelativePath).filter(Boolean)));
  if (!uniquePaths.length) {
    const index = await readKnowledgeIndex(paths);
    return {
      scanned: 0,
      indexed: Object.keys(index.files || {}).length,
      added: 0,
      updated: 0,
      removed: 0,
    };
  }
  const index = await readKnowledgeIndex(paths);
  let scanned = 0;
  let added = 0;
  let updated = 0;
  let removed = 0;
  let changed = false;
  for (const relativePath of uniquePaths) {
    const result = await syncKnowledgeEntryAtPath(paths, index, relativePath, force);
    scanned += result.scanned;
    added += result.added;
    updated += result.updated;
    removed += result.removed;
    changed = changed || result.changed;
  }
  if (changed || force) {
    index.updated = nowIso();
    state.lastVaultScanAt = index.updated;
    state.lastVaultScanMs = Date.now();
    await writeKnowledgeIndex(paths, index);
  }
  return {
    scanned,
    indexed: Object.keys(index.files || {}).length,
    added,
    updated,
    removed,
  };
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

async function syncKnowledgeIndex(paths, state, { force = false, dirtyPaths = [], fullRescan = false } = {}) {
  if (force || fullRescan || !dirtyPaths.length) {
    return await syncKnowledgeIndexFull(paths, state, force);
  }
  return await syncKnowledgeIndexDirty(paths, state, dirtyPaths, force);
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

async function buildDerivedMemory(paths) {
  const existing = await readExistingActiveContext(paths);
  const priorities = await readCurrentPriorities(paths);
  const vaultFocus = await readVaultFocus(paths);
  const ledger = latestLedgerEntries(await parseLedger(paths)).filter((entry) => !isNoise(`${entry.title || ""} ${entry.summary || ""} ${entry.prompt_excerpt || ""} ${entry.directory || ""}`));
  const recentSessions = ledger.slice(0, 5);
  const knowledgeIndex = await readKnowledgeIndex(paths);
  const recentKnowledge = recentKnowledgeEntries(knowledgeIndex);

  const focusLines = mergeUniqueLines(
    vaultFocus,
    recentSessions.slice(0, 3).map((entry) => `- Recent work: ${entry.summary || entry.title} (${entry.project})`),
    recentKnowledge.slice(0, 2).map((entry) => `- Recent knowledge: ${entry.title} — ${entry.summary}`),
  );

  const workstreams = inferWorkstreams([
    ...recentSessions.map((entry) => ({
      text: `${entry.title || ""} ${entry.summary || ""} ${entry.prompt_excerpt || ""} ${entry.project || ""} ${entry.directory || ""}`,
      evidence: entry.summary || entry.title || entry.prompt_excerpt || entry.project || "Recent session",
      updatedMs: Number(entry.updated_ms || Date.parse(entry.updated || "") || 0),
    })),
    ...recentKnowledge.map((entry) => ({
      text: `${entry.relativePath || ""} ${entry.title || ""} ${entry.summary || ""} ${(entry.bullets || []).join(" ")}`,
      evidence: `${entry.title} — ${entry.summary}`,
      updatedMs: Number(entry.mtimeMs || 0),
    })),
  ]);

  const recentSessionLines = recentSessions.length
    ? recentSessions.map((entry) => `- ${formatRecentTimestamp(Number(entry.updated_ms || Date.parse(entry.updated || "") || 0))} — ${entry.project} — ${entry.summary || entry.title}`)
    : ["- No recent sessions captured yet"];

  const recentKnowledgeLines = recentKnowledge.length
    ? recentKnowledge.map((entry) => `- ${entry.title} — ${entry.summary}`)
    : ["- No recent knowledge updates captured yet"];

  const reminderLines = mergeUniqueLines(existing.reminders, DEFAULT_REMINDERS);

  const activeContext = `---
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

  const baseline = await readUserBaseline(paths);
  const overview = `---
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
${(workstreams.length ? workstreams.map((item) => `- ${item.label} — ${item.evidence}`) : ["- No active workstreams inferred yet"]).join("\n")}

## Recent Shared Work
${recentSessionLines.slice(0, 3).join("\n")}

## Recent Knowledge
${recentKnowledgeLines.slice(0, 3).join("\n")}
`;

  return { activeContext, overview };
}

async function refreshDerivedFiles(paths, state) {
  const fingerprint = await computeDerivedFingerprint(paths);
  if (state && state.lastDerivedFingerprint === fingerprint) return false;
  const derived = await buildDerivedMemory(paths);
  const [activeChanged, overviewChanged] = await Promise.all([
    writeTextIfChanged(paths.activeContext, derived.activeContext),
    writeTextIfChanged(paths.overview, derived.overview),
  ]);
  if (state) state.lastDerivedFingerprint = fingerprint;
  return activeChanged || overviewChanged;
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
  const indexedPaths = [];
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
      indexedPaths.push(normalizeKnowledgeRelativePath(path.relative(paths.vaultPath, target)));
    } catch (error) {
      const failedDestination = await uniqueTargetPath(path.join(paths.dropboxFailed, item.name));
      if (await exists(fullPath)) await moveFile(fullPath, failedDestination);
      failed.push({
        file: item.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ingested, indexedPaths, failed };
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

async function syncOpenCodeActivity(paths, state, { forceFull = false } = {}) {
  const recentSummaries = await buildRecentSessionSummariesFromDb(paths, MAX_RECENT_SESSIONS + 2);
  const existingCorrections = await readExistingCorrections(paths);
  let ledgerEntriesAppended = 0;
  let correctionsAppended = 0;
  let ledgerCursor = normalizeOpenCodeCursor(state.lastOpenCodeLedgerCursor);
  let correctionCursor = normalizeOpenCodeCursor(state.lastOpenCodeCorrectionCursor);
  const pageSize = MAX_RECENT_SESSIONS + 24;
  const maxPages = forceFull ? 1000 : 4;

  if (await exists(paths.opencodeDbPath)) {
    let db;
    try {
      db = await connectDb(paths.opencodeDbPath);
      for (let page = 0; page < maxPages; page += 1) {
        const ledgerRows = loadSessionRows(db, ledgerCursor, pageSize, "asc");
        if (!ledgerRows.length) break;
        const { summaries } = loadSessionArtifacts(db, ledgerRows);
        ledgerEntriesAppended += await appendSessionLedgerEntries(paths, summaries);
        ledgerCursor = sessionCursorFromRow(ledgerRows.at(-1));
        if (ledgerRows.length < pageSize) break;
      }

      for (let page = 0; page < maxPages; page += 1) {
        const correctionRows = loadSessionRows(db, correctionCursor, pageSize, "asc");
        if (!correctionRows.length) break;
        const { corrections } = loadSessionArtifacts(db, correctionRows, existingCorrections);
        correctionsAppended += await appendCorrections(paths, corrections);
        correctionCursor = sessionCursorFromRow(correctionRows.at(-1));
        if (correctionRows.length < pageSize) break;
      }
    } finally {
      db?.driver.close(db.handle);
    }
  }

  state.lastOpenCodePollMs = Date.now();
  state.lastOpenCodeLedgerCursor = ledgerCursor;
  state.lastOpenCodeCorrectionCursor = correctionCursor;
  state.lastSessionSyncMs = Math.max(Number(ledgerCursor.updatedMs || 0), Number(correctionCursor.updatedMs || 0));
  return {
    sessionsSeen: recentSummaries.length,
    ledgerEntriesAppended,
    correctionsAppended,
    latestSessionAt: state.lastSessionSyncMs ? isoFromMs(state.lastSessionSyncMs) : "",
  };
}

async function collectStatus(paths) {
  const state = await readPluginState(paths);
  const knowledgeIndex = await readKnowledgeIndex(paths);
  const databaseBackfillAvailable = await exists(paths.opencodeDbPath) && await hasSqliteSupport();
  const controller = maintenanceControllers.get(maintenanceControllerKey(paths));
  return {
    vaultPath: paths.vaultPath,
    memoryPath: paths.memoryPath,
    opencodeConfigPath: paths.opencodeConfigPath,
    opencodeDbPath: paths.opencodeDbPath,
    backupRoot: paths.backupRoot,
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
    backupIntervalMs: paths.backupIntervalMs,
    backupRetentionCount: paths.backupRetentionCount,
    systemContextBudgetChars: OVERVIEW_CONTEXT_LIMIT + ACTIVE_CONTEXT_LIMIT,
    recentSessionWindow: MAX_RECENT_SESSIONS,
    recentKnowledgeWindow: MAX_RECENT_KNOWLEDGE,
    pluginStateReadError: state.readError,
    knowledgeIndexReadError: knowledgeIndex.readError,
    lastMaintenanceAt: state.lastMaintenanceAt || null,
    lastSessionSyncAt: state.lastSessionSyncMs ? isoFromMs(state.lastSessionSyncMs) : null,
    lastOpenCodePollAt: state.lastOpenCodePollMs ? isoFromMs(state.lastOpenCodePollMs) : null,
    lastOpenCodeLedgerCursor: state.lastOpenCodeLedgerCursor,
    lastOpenCodeCorrectionCursor: state.lastOpenCodeCorrectionCursor,
    lastVaultScanAt: state.lastVaultScanAt || null,
    ledgerEntries: (await parseLedger(paths)).length,
    corrections: await countJsonLines(paths.corrections),
    indexedKnowledgeFiles: Object.keys(knowledgeIndex.files || {}).length,
    pendingDropboxFiles: await listPendingDropboxFiles(paths),
    imports: (state.imports || []).slice(-5),
    backups: state.backups,
    maintenanceMetrics: state.metrics,
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
    allowDerivedRefresh = true,
    allowAgentSync = true,
    allowBackups = true,
    includeStatus = false,
    dirtyKnowledgePaths = [],
    fullKnowledgeRescan = false,
  } = {},
) {
  return await runSerializedMaintenance(paths, async () => {
    await ensureScaffold(paths, options, false);
    const state = await readPluginState(paths);
    const nowMs = Date.now();
    const startedAt = performance.now();
    const phaseTimings = {};

    const dropboxStart = performance.now();
    const dropbox = allowDropboxIngest ? await ingestDropbox(paths) : { ingested: [], indexedPaths: [], failed: [] };
    phaseTimings.dropboxMs = metricDurationMs(dropboxStart);

    const sessionStart = performance.now();
    const sessionAdded = await updateSessionState(paths, state, sessionInfo);
    phaseTimings.sessionStateMs = metricDurationMs(sessionStart);

    let activity = { sessionsSeen: 0, ledgerEntriesAppended: 0, correctionsAppended: 0, latestSessionAt: "" };
    const activityStart = performance.now();
    if (allowActivitySync && (force || !state.lastOpenCodePollMs || nowMs - Number(state.lastOpenCodePollMs || 0) >= MAINTENANCE_INTERVAL_MS)) {
      activity = await syncOpenCodeActivity(paths, state, { forceFull: force });
    }
    phaseTimings.activitySyncMs = metricDurationMs(activityStart);

    let knowledge = { scanned: 0, indexed: 0, added: 0, updated: 0, removed: 0 };
    const knowledgeStart = performance.now();
    const pendingKnowledgePaths = Array.from(new Set([...(dirtyKnowledgePaths || []), ...(dropbox.indexedPaths || [])].map(normalizeKnowledgeRelativePath).filter(Boolean)));
    if (
      allowKnowledgeSync
      && (
        force
        || fullKnowledgeRescan
        || !state.lastVaultScanMs
        || nowMs - Number(state.lastVaultScanMs || 0) >= VAULT_SCAN_INTERVAL_MS
        || Boolean(pendingKnowledgePaths.length)
      )
    ) {
      const knowledgeIntervalDue = !state.lastVaultScanMs || nowMs - Number(state.lastVaultScanMs || 0) >= VAULT_SCAN_INTERVAL_MS;
      knowledge = await syncKnowledgeIndex(paths, state, {
        force,
        dirtyPaths: pendingKnowledgePaths,
        fullRescan: force || fullKnowledgeRescan || knowledgeIntervalDue,
      });
    }
    phaseTimings.knowledgeSyncMs = metricDurationMs(knowledgeStart);

    const derivedStart = performance.now();
    const derivedChanged = allowDerivedRefresh ? await refreshDerivedFiles(paths, state) : false;
    phaseTimings.derivedRefreshMs = metricDurationMs(derivedStart);

    const agentsStart = performance.now();
    const agentsChanged = allowAgentSync ? await syncGlobalAgents(paths, state) : false;
    phaseTimings.agentSyncMs = metricDurationMs(agentsStart);

    const backupStart = performance.now();
    const backups = allowBackups ? await runBackups(paths, state, { force, reason }) : [];
    phaseTimings.backupMs = metricDurationMs(backupStart);

    state.lastMaintenanceAt = nowIso();
    state.lastMaintenanceMs = nowMs;
    rememberMaintenanceMetrics(state, {
      at: state.lastMaintenanceAt,
      reason,
      sessionAdded,
      derivedChanged,
      agentsChanged,
      timings: {
        ...phaseTimings,
        totalMs: metricDurationMs(startedAt),
      },
    });
    await writePluginState(paths, state);

    return {
      reason,
      sessionAdded,
      dropboxIngested: dropbox.ingested,
      dropboxFailed: dropbox.failed,
      activity,
      knowledge,
      backups,
      timings: state.metrics.lastRuns.at(-1)?.timings || phaseTimings,
      status: includeStatus ? await collectStatus(paths) : null,
    };
  });
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
    const watcher = watchFs(target, options, (_eventType, filename) => {
      if (reason === "vault-watch") {
        const relativePath = normalizeKnowledgeRelativePath(filename ? String(filename) : "");
        if (relativePath && SUPPORTED_NOTE_SUFFIXES.has(path.extname(relativePath).toLowerCase())) controller.pendingKnowledgePaths.add(relativePath);
        else controller.fullKnowledgeRescanRequired = true;
      }
      const lastWatchMs = Number(controller.lastWatchRunMs || 0);
      if (lastWatchMs && Date.now() - lastWatchMs < WATCH_COOLDOWN_MS) {
        scheduleControllerRun(controller, reason, Math.max(250, WATCH_COOLDOWN_MS - (Date.now() - lastWatchMs)));
        return;
      }
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

async function shutdownMaintenanceController(paths) {
  const key = maintenanceControllerKey(paths);
  const controller = maintenanceControllers.get(key);
  if (!controller) return;

  controller.shutdown = true;

  if (controller.scheduledTimer) {
    clearTimeout(controller.scheduledTimer);
    controller.scheduledTimer = null;
  }

  if (controller.intervalHandle) {
    clearInterval(controller.intervalHandle);
    controller.intervalHandle = null;
  }

  for (const watcher of controller.watchers) {
    try {
      watcher.close();
    } catch {}
  }

  controller.watchers = [];
  controller.watchedPaths = [];
  maintenanceControllers.delete(key);
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
    pendingKnowledgePaths: new Set(),
    fullKnowledgeRescanRequired: false,
    lastBackgroundTickAt: "",
    lastBackgroundReason: "",
    lastWatchRunMs: 0,
    async run(reason) {
      if (controller.shutdown) return;
      if (controller.running) {
        scheduleControllerRun(controller, reason, WATCH_DEBOUNCE_MS);
        return;
      }
      controller.running = true;
      try {
        const dirtyKnowledgePaths = Array.from(controller.pendingKnowledgePaths);
        controller.pendingKnowledgePaths.clear();
        const fullKnowledgeRescan = controller.fullKnowledgeRescanRequired;
        controller.fullKnowledgeRescanRequired = false;
        const result = await maintain(controller.paths, null, controller.options, {
          force: false,
          reason,
          allowActivitySync: true,
          allowKnowledgeSync: true,
          allowDropboxIngest: true,
          dirtyKnowledgePaths,
          fullKnowledgeRescan,
        });
        controller.lastBackgroundTickAt = result.status?.lastMaintenanceAt || nowIso();
        controller.lastBackgroundReason = reason;
        if (reason === "dropbox-watch" || reason === "vault-watch") {
          controller.lastWatchRunMs = Date.now();
        }
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
    __mercury_shutdown: async () => {
      await shutdownMaintenanceController(controllerPaths);
    },
    tool: {
      pkm_bootstrap: tool({
        description: "Bootstrap or reinitialize a portable PKM vault and hot-memory layer.",
        args: {
          vaultPath: tool.schema.string().optional().describe("Vault path to create or update"),
          memoryPath: tool.schema.string().optional().describe("Hot-memory path to create or update"),
          opencodeConfigPath: tool.schema.string().optional().describe("OpenCode config root to include in backups"),
          opencodeDbPath: tool.schema.string().optional().describe("Optional explicit OpenCode SQLite database path"),
          backupRoot: tool.schema.string().optional().describe("Directory where Mercury snapshots vault and OpenCode state"),
          backupIntervalHours: tool.schema.number().optional().describe("How often Mercury should create backups while OpenCode is active"),
          backupRetentionCount: tool.schema.number().optional().describe("How many snapshots per backup scope Mercury should retain"),
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
            opencodeConfigPath: paths.opencodeConfigPath,
            opencodeDbPath: paths.opencodeDbPath,
            backupRoot: paths.backupRoot,
            backupIntervalMs: paths.backupIntervalMs,
            backupRetentionCount: paths.backupRetentionCount,
            userDisplayName: config.userDisplayName || options.userDisplayName || "",
            primaryWork: config.primaryWork || options.primaryWork || "",
          });
          await ensureMaintenanceController(paths, config);
          const result = await maintain(paths, null, config, { force: true, reason: "bootstrap", includeStatus: true });
          context.metadata({ title: "Bootstrapped Mercury PKM", metadata: { vaultPath: paths.vaultPath, memoryPath: paths.memoryPath, backupRoot: paths.backupRoot } });
          return JSON.stringify({
            message: "Bootstrapped Mercury PKM system",
            vaultPath: paths.vaultPath,
            memoryPath: paths.memoryPath,
            opencodeConfigPath: paths.opencodeConfigPath,
            opencodeDbPath: paths.opencodeDbPath,
            backupRoot: paths.backupRoot,
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
          await ensureMaintenanceController(paths, options);
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
          const result = await maintain(paths, null, options, { force: true, reason: "manual-refresh", includeStatus: true });
          context.metadata({ title: "Refreshed Mercury PKM", metadata: { indexedKnowledgeFiles: result.status.indexedKnowledgeFiles } });
          return JSON.stringify(result, null, 2);
        },
      }),
      pkm_backup_now: tool({
        description: "Force immediate backups for the vault and OpenCode surfaces Mercury protects.",
        args: {},
        async execute(_args, context) {
          const paths = await buildPaths(input, options);
          const { backups, status } = await runSerializedMaintenance(paths, async () => {
            await ensureScaffold(paths, options, false);
            const state = await readPluginState(paths);
            const backups = await runBackups(paths, state, { force: true, reason: "manual-backup" });
            state.lastMaintenanceAt = nowIso();
            state.lastMaintenanceMs = Date.now();
            await writePluginState(paths, state);
            return { backups, status: await collectStatus(paths) };
          });
          context.metadata({ title: "Backed up Mercury world", metadata: { backupRoot: paths.backupRoot } });
          return JSON.stringify({ backupRoot: paths.backupRoot, backups, status }, null, 2);
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
          const { result, backups, status } = await runSerializedMaintenance(paths, async () => {
            await ensureScaffold(paths, config, false);
            const state = await readPluginState(paths);
            const result = await importKnowledge(paths, state, args.sourcePath, args.mode);
            const backups = await runBackups(paths, state, { force: false, reason: "import-knowledge" });
            state.lastMaintenanceAt = nowIso();
            state.lastMaintenanceMs = Date.now();
            await writePluginState(paths, state);
            await refreshDerivedFiles(paths, state);
            return { result, backups, status: await collectStatus(paths) };
          });
          context.metadata({ title: "Imported knowledge into Mercury", metadata: { sourcePath: args.sourcePath, indexed: result.knowledge.indexed } });
          return JSON.stringify({
            sourcePath: expandPath(args.sourcePath),
            mode: normalizeImportMode(args.mode),
            result,
            backups,
            status,
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
          const result = await maintain(paths, null, options, { force: true, reason: "ingest-note", includeStatus: true });
          context.metadata({ title: "Ingested note into Mercury", metadata: { file: target } });
          return JSON.stringify({ file: target, result }, null, 2);
        },
      }),
      pkm_remember: tool({
        description: "Store a stable user/profile memory fact directly in Mercury's hot-memory profile.",
        args: {
          category: tool.schema.string().describe("Target memory category: identity, account-map, general-work-baseline, working-preferences, or stable-preferences"),
          content: tool.schema.string().describe("Bullet-sized memory fact to persist"),
        },
        async execute(args, context) {
          const paths = await buildPaths(input, options);
          const status = await runSerializedMaintenance(paths, async () => {
            await ensureScaffold(paths, options, false);
            await rememberProfileFact(paths, args.category, args.content);
            const state = await readPluginState(paths);
            await refreshDerivedFiles(paths, state);
            await syncGlobalAgents(paths, state);
            state.lastMaintenanceAt = nowIso();
            state.lastMaintenanceMs = Date.now();
            await writePluginState(paths, state);
            return await collectStatus(paths);
          });
          context.metadata({ title: "Stored Mercury memory", metadata: { category: args.category } });
          return JSON.stringify({
            category: args.category,
            content: normalizeBulletItem(args.content),
            userProfile: paths.userProfile,
            status,
          }, null, 2);
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
        {
          force: false,
          reason: "chat-message",
          allowActivitySync: false,
          allowKnowledgeSync: false,
          allowDropboxIngest: false,
          allowDerivedRefresh: false,
          allowAgentSync: false,
          allowBackups: false,
        },
      );
    },
    "command.execute.before": async () => {
      await runHookMaintenance(input, options, null, { force: false, reason: "command-before", allowBackups: false });
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

export default { id, server };
