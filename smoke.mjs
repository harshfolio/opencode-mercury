import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { server } from "./dist/server.js";

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
  const opencodeDbPath = path.join(root, "missing-opencode.db");

  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(sourcePath, { recursive: true });
  await fs.writeFile(
    path.join(sourcePath, "project-note.md"),
    `# Migration plan

- Keep context compact
- Import existing vault knowledge

Mercury should keep OpenCode current without requiring manual re-reading.
`,
    "utf8",
  );

  const plugin = await server(
    { directory: workspace },
    {
      vaultPath,
      memoryPath,
      opencodeDbPath,
      userDisplayName: "Smoke Test User",
      primaryWork: "Testing Mercury",
    },
  );

  const context = contextStub();

  try {
    await plugin.tool.pkm_bootstrap.execute(
      {
        vaultPath,
        memoryPath,
        opencodeDbPath,
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
        && Boolean(liveStatus.lastBackgroundTickAt);
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

    const inboxEntries = await fs.readdir(path.join(vaultPath, "00-09 Inbox"));
    if (!inboxEntries.some((entry) => entry.includes("Dropped Note"))) {
      throw new Error("Expected autonomous dropbox ingestion to create an inbox note");
    }

    const systemOutput = { system: [] };
    await plugin["experimental.chat.system.transform"]({}, systemOutput);
    if (!systemOutput.system.length) {
      throw new Error("Expected system context injection from Mercury");
    }

    console.log(JSON.stringify({
      smoke: "ok",
      indexedKnowledgeFiles: status.indexedKnowledgeFiles,
      pendingDropboxFiles: status.pendingDropboxFiles,
      injectedChars: systemOutput.system[0].length,
    }, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
