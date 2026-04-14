import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tool } from "@opencode-ai/plugin";

const SUPPORTED_NOTE_SUFFIXES = new Set([".md", ".txt", ".text"]);
const INSTALL_STATE = path.join(os.homedir(), ".opencode-pkm-plugin.json");
const NOISE_PATTERNS = [
  /@Sisyphus/i,
  /subagent/i,
  /^\[search-mode\]/i,
  /^show global memory health/i,
  /^review reco batch/i,
  /^march sessions/i,
  /^new session -/i,
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

function expandPath(input) {
  if (!input) return input;
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function truncate(text, limit = 120) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

function slugify(text) {
  const clean = String(text || "note").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "note";
}

function nowLocal() {
  return new Date();
}

function nowIso() {
  return nowLocal().toISOString();
}

function todayDate() {
  return nowIso().slice(0, 10);
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
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(target, value) {
  await writeText(target, `${JSON.stringify(value, null, 2)}\n`);
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
  return (sections.get(section) || []).map((line) => line.trim()).filter((line) => line.startsWith("- "));
}

function textFromParts(parts) {
  return (parts || [])
    .filter((part) => part && part.type === "text")
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

function summarizePrompt(text, fallback) {
  const first = String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return truncate(first || fallback || "Untitled session", 140);
}

function isNoise(text) {
  return NOISE_PATTERNS.some((pattern) => pattern.test(String(text || "")));
}

function classifyWorkstream(text) {
  const value = String(text || "").toLowerCase();
  const rules = [
    [["medusa", "inventory", "catalog", "catalogue", "collection", "brand", "order"], "Commerce and admin operations"],
    [["sqlmesh", "bigquery", "analytics", "warehouse", "dashboard", "data"], "Analytics and internal data systems"],
    [["figma", "ui", "design", "frontend", "dashboard"], "Product UX and internal tooling"],
    [["product", "growth", "search", "autosuggest", "checkout", "consult"], "Product and growth work"],
    [["twitter", "linkedin", "social media", "content", "engage"], "Audience and content systems"],
    [["vault", "memory", "pkm", "context", "agent"], "Agentic memory and workflow systems"],
  ];
  for (const [keywords, label] of rules) {
    if (keywords.some((keyword) => value.includes(keyword))) return label;
  }
  return null;
}

async function readInstallState() {
  return readJson(INSTALL_STATE, {});
}

async function writeInstallState(config) {
  await writeJson(INSTALL_STATE, config);
}

function materializePaths(input, config = {}) {
  const vaultPath = expandPath(config.vaultPath || path.join(os.homedir(), "PKM Vault"));
  const memoryPath = expandPath(config.memoryPath || path.join(os.homedir(), ".opencode-pkm-memory"));
  return {
    vaultPath,
    memoryPath,
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
    state: path.join(memoryPath, ".plugin-state.json"),
    domainsDir: path.join(memoryPath, "domains"),
  };
}

async function buildPaths(input, options = {}, overrides = {}) {
  const persisted = await readInstallState();
  return materializePaths(input, { ...persisted, ...options, ...overrides });
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
    ensureFile(path.join(paths.dropbox, "README.md"), "Drop .md or .txt notes here. The plugin ingests them into the vault inbox while OpenCode is active.\n", force),
    ensureFile(path.join(paths.domainsDir, "engineering.md"), "# Engineering\n\n- Add stable engineering preferences here.\n", force),
    ensureFile(path.join(paths.domainsDir, "product.md"), "# Product\n\n- Add stable product context here.\n", force),
    ensureFile(path.join(paths.domainsDir, "operations.md"), "# Operations\n\n- Add stable operational context here.\n", force),
  ]);
}

async function parseLedger(paths) {
  const raw = await readText(paths.ledger, "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

async function appendLedgerEntry(paths, entry) {
  await fs.appendFile(paths.ledger, `${JSON.stringify(entry)}\n`, "utf8");
}

async function ingestDropbox(paths) {
  const results = [];
  const items = await fs.readdir(paths.dropbox, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (!item.isFile()) continue;
    if (item.name.toLowerCase() === "readme.md") continue;
    const ext = path.extname(item.name).toLowerCase();
    if (!SUPPORTED_NOTE_SUFFIXES.has(ext)) continue;
    const fullPath = path.join(paths.dropbox, item.name);
    const raw = (await readText(fullPath, "")).trim();
    const title = summarizePrompt(raw, item.name.replace(ext, "").replace(/[-_]+/g, " "));
    const target = path.join(paths.vaultInbox, `${todayDate()} Dropped Note - ${slugify(title)}.md`);
    const body = `---
created: ${todayDate()}
updated: ${todayDate()}
type: note
source: plugin-ingest
confidence: 0.8
---

# ${title}

## Intake Metadata
- Original file: \`${item.name}\`

## Raw Capture
${raw || "(empty file)"}
`;
    await writeText(target, body);
    await ensureDir(paths.dropboxProcessed);
    await fs.rename(fullPath, path.join(paths.dropboxProcessed, item.name));
    results.push(path.basename(target));
  }
  return results;
}

async function updateSessionState(paths, sessionID, entry) {
  const state = await readJson(paths.state, { sessions: {} });
  if (state.sessions[sessionID]) return false;
  state.sessions[sessionID] = { title: entry.title, updated: entry.updated };
  await appendLedgerEntry(paths, entry);
  await writeJson(paths.state, state);
  return true;
}

function inferWorkstreams(entries) {
  const map = new Map();
  for (const entry of entries) {
    const label = classifyWorkstream(`${entry.title} ${entry.project} ${entry.directory}`);
    if (!label) continue;
    const current = map.get(label);
    if (!current || String(entry.updated) > String(current.updated)) {
      map.set(label, { label, evidence: truncate(entry.title, 100), updated: entry.updated });
    }
  }
  return Array.from(map.values()).sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, 4);
}

async function renderActiveContext(paths) {
  const priorities = bulletLines(await readText(paths.currentPriorities, ""), "Current Priorities");
  const ledger = (await parseLedger(paths)).filter((entry) => !isNoise(entry.title));
  const recent = ledger.slice(0, 5);
  const focus = recent.slice(0, 3).map((entry) => `- Recent work: ${entry.title} (${entry.project})`);
  const workstreams = inferWorkstreams(recent).map((item) => `- ${item.label} — ${item.evidence}`);

  return `---
updated: ${nowIso()}
source: plugin-auto
confidence: 0.82
---

# Active Context

## Current Priorities
${(priorities.length ? priorities : DEFAULT_PRIORITIES).join("\n")}

## Current Focus
${(focus.length ? focus : ["- No recent focus captured yet"]).join("\n")}

## Active Workstreams
${(workstreams.length ? workstreams : ["- No active workstreams inferred yet"]).join("\n")}

## Recent Sessions
${(recent.length ? recent.map((entry) => `- ${String(entry.updated).slice(0, 19)} — ${entry.project} — ${entry.title}`) : ["- No recent sessions captured yet"]).join("\n")}

## Durable Reminders
- Prefer durable knowledge in the vault
- Keep hot memory compact and current
- Use the dropbox for loose notes that should be ingested
`;
}

async function renderOverview(paths) {
  const baseline = bulletLines(await readText(paths.userProfile, ""), "General Work Baseline");
  const priorities = bulletLines(await readText(paths.currentPriorities, ""), "Current Priorities");
  const activeContext = await readText(paths.activeContext, "");
  const workstreams = bulletLines(activeContext, "Active Workstreams").slice(0, 4);
  const recent = bulletLines(activeContext, "Recent Sessions").slice(0, 3);

  return `---
updated: ${nowIso()}
source: plugin-auto
confidence: 0.86
---

# Overview

## General
${(baseline.length ? baseline : DEFAULT_BASELINE).join("\n")}

## Current Priorities
${(priorities.length ? priorities : DEFAULT_PRIORITIES).join("\n")}

## Active Workstreams
${(workstreams.length ? workstreams : ["- No active workstreams inferred yet"]).join("\n")}

## Recent Shared Work
${(recent.length ? recent : ["- No recent shared work captured yet"]).join("\n")}
`;
}

async function refreshDerivedFiles(paths) {
  await writeText(paths.activeContext, await renderActiveContext(paths));
  await writeText(paths.overview, await renderOverview(paths));
}

async function maintain(paths, sessionInfo, options) {
  await ensureScaffold(paths, options, false);
  const ingested = await ingestDropbox(paths);
  let added = false;
  if (sessionInfo?.sessionID && sessionInfo?.text && !isNoise(sessionInfo.text)) {
    added = await updateSessionState(paths, sessionInfo.sessionID, {
      session_id: sessionInfo.sessionID,
      updated: nowIso(),
      project: path.basename(sessionInfo.directory || "global") || "global",
      directory: sessionInfo.directory || "",
      title: summarizePrompt(sessionInfo.text, path.basename(sessionInfo.directory || "session")),
    });
  }
  await refreshDerivedFiles(paths);
  return { added, ingested };
}

function buildSystemContext(overview) {
  return `PKM overview (compact shared memory):\n${truncate(overview, 5000)}`;
}

export async function server(input, options = {}) {
  return {
    tool: {
      pkm_bootstrap: tool({
        description: "Bootstrap a portable PKM vault and hot-memory layer for the current user.",
        args: {
          vaultPath: tool.schema.string().optional().describe("Vault path to create or update"),
          memoryPath: tool.schema.string().optional().describe("Hot-memory path to create or update"),
          userDisplayName: tool.schema.string().optional().describe("Human-readable user name for bootstrap templates"),
          primaryWork: tool.schema.string().optional().describe("Short description of the user's core work"),
          force: tool.schema.boolean().optional().describe("Overwrite scaffold files even if they already exist"),
        },
        async execute(args, context) {
          const config = { ...options, ...args };
          const paths = await buildPaths(input, options, args);
          await ensureScaffold(paths, { ...options, ...args }, Boolean(args.force));
          await writeInstallState({
            vaultPath: paths.vaultPath,
            memoryPath: paths.memoryPath,
            userDisplayName: config.userDisplayName || options.userDisplayName || "",
            primaryWork: config.primaryWork || options.primaryWork || "",
          });
          await refreshDerivedFiles(paths);
          context.metadata({ title: "Bootstrapped PKM memory system", metadata: { vaultPath: paths.vaultPath, memoryPath: paths.memoryPath } });
          return `Bootstrapped PKM system.\nVault: ${paths.vaultPath}\nMemory: ${paths.memoryPath}`;
        },
      }),
      pkm_status: tool({
        description: "Inspect PKM vault and memory status for the installed plugin.",
        args: {},
        async execute(_args, context) {
          const basePaths = await buildPaths(input, options);
          await ensureScaffold(basePaths, options, false);
          await refreshDerivedFiles(basePaths);
          const ledger = await parseLedger(basePaths);
          context.metadata({ title: "PKM status", metadata: { ledgerEntries: ledger.length } });
          return `Vault: ${basePaths.vaultPath}\nMemory: ${basePaths.memoryPath}\nLedger entries: ${ledger.length}\nDropbox: ${basePaths.dropbox}`;
        },
      }),
      pkm_ingest_note: tool({
        description: "Ingest a raw note directly into the PKM vault inbox.",
        args: {
          title: tool.schema.string().optional().describe("Optional note title"),
          noteText: tool.schema.string().describe("Raw note text to ingest into the vault inbox"),
        },
        async execute(args, context) {
          const paths = await buildPaths(input, options);
          await ensureScaffold(paths, options, false);
          const title = summarizePrompt(args.title || args.noteText, "Ingested note");
          const target = path.join(paths.vaultInbox, `${todayDate()} Note - ${slugify(title)}.md`);
          const content = `---
created: ${todayDate()}
updated: ${todayDate()}
type: note
source: plugin-tool
confidence: 0.85
---

# ${title}

## Raw Capture
${args.noteText.trim()}
`;
          await writeText(target, content);
          await refreshDerivedFiles(paths);
          context.metadata({ title: "Ingested note", metadata: { file: target } });
          return `Ingested note into vault inbox: ${target}`;
        },
      }),
    },
    "chat.message": async (hookInput, output) => {
      const paths = await buildPaths(input, options);
      await maintain(paths, { sessionID: hookInput.sessionID, text: textFromParts(output.parts), directory: input.directory }, options);
    },
    "command.execute.before": async () => {
      const paths = await buildPaths(input, options);
      await ensureScaffold(paths, options, false);
      await ingestDropbox(paths);
      await refreshDerivedFiles(paths);
    },
    "experimental.chat.system.transform": async (_hookInput, output) => {
      const paths = await buildPaths(input, options);
      await ensureScaffold(paths, options, false);
      await refreshDerivedFiles(paths);
      const overview = await readText(paths.overview, "");
      if (overview.trim()) output.system.unshift(buildSystemContext(overview));
    },
    "shell.env": async (_hookInput, output) => {
      const basePaths = await buildPaths(input, options);
      output.env.OPENCODE_PKM_VAULT_PATH = basePaths.vaultPath;
      output.env.OPENCODE_PKM_MEMORY_PATH = basePaths.memoryPath;
      output.env.OPENCODE_PKM_DROPBOX_PATH = basePaths.dropbox;
    },
  };
}

export default { server };
