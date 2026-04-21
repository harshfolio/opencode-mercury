import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

async function seedOpencodeDb(opencodeDbPath, workspace) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(opencodeDbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT,
      data TEXT,
      time_created INTEGER
    );
  `);

  const now = Date.now();
  db.prepare("INSERT INTO session (id, title, directory, time_updated) VALUES (?, ?, ?, ?)")
    .run("session-1", "New session - scratch", workspace, now);

  db.prepare("INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)")
    .run("message-user-1", "session-1", JSON.stringify({ role: "user" }), now - 2_000);
  db.prepare("INSERT INTO part (message_id, data, time_created) VALUES (?, ?, ?)")
    .run(
      "message-user-1",
      JSON.stringify({ type: "text", text: "CONTEXT: Evaluating a skincare concierge app concept. Need to understand the state of AI skin scanning technology and progress tracking." }),
      now - 1_900,
    );

  db.prepare("INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)")
    .run("message-assistant-1", "session-1", JSON.stringify({ role: "assistant" }), now - 1_000);
  db.prepare("INSERT INTO part (message_id, data, time_created) VALUES (?, ?, ?)")
    .run(
      "message-assistant-1",
      JSON.stringify({ type: "text", text: "Key finding: Clinical credibility plus Rx pathway is the defensible moat. Progress tracking is the retention primitive." }),
      now - 900,
    );

  db.close();
}

function contextStub() {
  return {
    metadata() {},
  };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 200 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mercury-smoke-"));
  const workspace = path.join(root, "workspace");
  const vaultPath = path.join(root, "Vault");
  const memoryPath = path.join(root, "memory");
  const sourcePath = path.join(root, "source-notes");
  const opencodeConfigPath = path.join(root, "opencode-config");
  const opencodeStatePath = path.join(root, "opencode-state");
  const opencodeDbPath = path.join(opencodeStatePath, "opencode.db");
  const backupRoot = path.join(root, "backups");

  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(sourcePath, { recursive: true });
  await fs.mkdir(opencodeConfigPath, { recursive: true });
  await fs.mkdir(opencodeStatePath, { recursive: true });
  await seedOpencodeDb(opencodeDbPath, workspace);
  await fs.writeFile(
    path.join(sourcePath, "project-note.md"),
    `# Migration plan

- Keep context compact
- Import existing vault knowledge

Mercury should keep OpenCode current without requiring manual re-reading.
`,
    "utf8",
  );
  await fs.writeFile(path.join(opencodeConfigPath, "opencode.json"), '{"plugin":[]}', "utf8");
  await fs.writeFile(path.join(opencodeStatePath, "auth.json"), '{"provider":"test"}', "utf8");

  process.env.HOME = root;
  const { id, default: pluginModule, server } = await import(`./dist/server.js?ts=${Date.now()}`);

  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Expected Mercury to export a non-empty plugin id");
  }
  if (pluginModule?.id !== id || pluginModule?.server !== server) {
    throw new Error("Expected default export to expose the Mercury id and server contract");
  }

  const plugin = await server(
    { directory: workspace },
    {
      vaultPath,
      memoryPath,
      opencodeConfigPath,
      opencodeDbPath,
      backupRoot,
      backupIntervalMs: 1_000,
      backupRetentionCount: 3,
      userDisplayName: "Smoke Test User",
      primaryWork: "Testing Mercury",
    },
  );

  const context = contextStub();
  let shutdownPromise = Promise.resolve();

  try {
    await plugin.tool.pkm_bootstrap.execute(
      {
        vaultPath,
        memoryPath,
        opencodeConfigPath,
        opencodeDbPath,
        backupRoot,
        backupIntervalMs: 1_000,
        backupRetentionCount: 3,
        userDisplayName: "Smoke Test User",
        primaryWork: "Testing Mercury",
      },
      context,
    );

    await fs.writeFile(
      path.join(memoryPath, "dropbox", "quick-note.md"),
      "Need Mercury to keep the active context updated from dropped notes.",
      "utf8",
    );

    await plugin.tool.pkm_import_knowledge.execute({ sourcePath, mode: "copy" }, context);

    const updatedItself = await waitFor(async () => {
      const liveStatus = JSON.parse(await plugin.tool.pkm_status.execute({}, context));
      return liveStatus.autonomousMaintenanceActive
        && liveStatus.backgroundIntervalActive
        && liveStatus.pendingDropboxFiles.length === 0
        && Boolean(liveStatus.lastBackgroundTickAt)
        && Boolean(liveStatus.backups.vault.lastSnapshotPath)
        && Boolean(liveStatus.backups.opencodeConfig.lastSnapshotPath)
        && Boolean(liveStatus.backups.opencodeState.lastSnapshotPath);
    });

    if (!updatedItself) {
      throw new Error("Expected Mercury autonomous maintenance to ingest dropbox notes without manual refresh");
    }

    const status = JSON.parse(await plugin.tool.pkm_status.execute({}, context));
    if (status.indexedKnowledgeFiles < 1) {
      throw new Error(`Expected indexedKnowledgeFiles >= 1, received ${status.indexedKnowledgeFiles}`);
    }
    if (!status.autonomousMaintenanceActive || !status.backgroundIntervalActive) {
      throw new Error("Expected autonomous maintenance controller to be active");
    }
    const backupErrors = Object.entries(status.backups).filter(([, value]) => value.lastError);
    if (backupErrors.length) {
      throw new Error(`Expected smoke backups to be clean, found errors in scopes: ${backupErrors.map(([scope]) => scope).join(", ")}`);
    }

    await Promise.all([
      fs.access(status.backups.vault.lastSnapshotPath),
      fs.access(status.backups.opencodeConfig.lastSnapshotPath),
      fs.access(status.backups.opencodeState.lastSnapshotPath),
    ]);

    const inboxEntries = await fs.readdir(path.join(vaultPath, "00-09 Inbox"));
    if (!inboxEntries.some((entry) => entry.includes("Dropped Note"))) {
      throw new Error("Expected autonomous dropbox ingestion to create an inbox note");
    }

    const systemOutput = { system: [] };
    await plugin["experimental.chat.system.transform"]({}, systemOutput);
    if (!systemOutput.system.length) {
      throw new Error("Expected system context injection from Mercury");
    }
    const systemText = systemOutput.system.join("\n");
    if (!systemText.includes("Clinical credibility plus Rx pathway is the defensible moat.")) {
      throw new Error("Expected Mercury to surface synthesized session outcome summaries");
    }
    if (systemText.includes("Need to understand the state of AI skin scanning technology")) {
      throw new Error("Expected Mercury to avoid surfacing raw prompt fragments when an outcome summary exists");
    }

    const globalAgents = await fs.readFile(path.join(opencodeConfigPath, "AGENTS.md"), "utf8");
    if (!globalAgents.includes("Generated by Mercury")) {
      throw new Error("Expected Mercury to own the global AGENTS.md surface");
    }
    if (!globalAgents.includes("~/.config/opencode/memory/overview.md")) {
      throw new Error("Expected Mercury-managed AGENTS.md to route through Mercury memory files");
    }

    const errorLogPath = path.join(memoryPath, "logs", "plugin-errors.log");
    let errorLog = "";
    try {
      errorLog = await fs.readFile(errorLogPath, "utf8");
    } catch {}
    if (errorLog.trim()) {
      throw new Error(`Expected clean plugin error log during smoke run, found:\n${errorLog}`);
    }

    console.log(JSON.stringify({
      smoke: "ok",
      id,
      indexedKnowledgeFiles: status.indexedKnowledgeFiles,
      pendingDropboxFiles: status.pendingDropboxFiles,
      backupRoot: status.backupRoot,
      backupScopes: Object.fromEntries(Object.entries(status.backups).map(([key, value]) => [key, Boolean(value.lastSnapshotPath)])),
      injectedChars: systemOutput.system[0].length,
    }, null, 2));
  } finally {
    shutdownPromise = plugin?.__mercury_shutdown ? plugin.__mercury_shutdown() : Promise.resolve();
    await shutdownPromise;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
