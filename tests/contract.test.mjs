import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function contextStub() {
  return {
    metadata() {},
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mercury-contract-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let plugin = null;

  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const distPath = path.resolve("dist/server.js");
    const moduleUrl = `${pathToFileURL(distPath).href}?ts=${Date.now()}`;
    const pluginModule = await import(moduleUrl);

    assert.equal(typeof pluginModule.id, "string", "Plugin module must export a string id");
    assert.ok(pluginModule.id.length > 0, "Plugin id must not be empty");
    assert.equal(typeof pluginModule.server, "function", "Plugin module must export server()");
    assert.equal(typeof pluginModule.default, "object", "Plugin module must default-export an object");
    assert.equal(pluginModule.default.id, pluginModule.id, "Default export should expose the same id");
    assert.equal(pluginModule.default.server, pluginModule.server, "Default export should expose server()");

    plugin = await pluginModule.server({ directory: workspace }, {});
    assert.ok(plugin.tool, "Plugin should register tools");

    const toolNames = [
      "pkm_bootstrap",
      "pkm_status",
      "pkm_refresh",
      "pkm_backup_now",
      "pkm_import_knowledge",
      "pkm_ingest_note",
      "pkm_remember",
    ];

    for (const toolName of toolNames) {
      const definition = plugin.tool[toolName];
      assert.ok(definition, `Expected tool ${toolName} to be registered`);
      assert.equal(typeof definition.execute, "function", `Expected tool ${toolName} to expose execute()`);
    }

    assert.equal(typeof plugin["chat.message"], "function", "Expected chat.message hook");
    assert.equal(typeof plugin["command.execute.before"], "function", "Expected command.execute.before hook");
    assert.equal(typeof plugin["experimental.chat.system.transform"], "function", "Expected system transform hook");
    assert.equal(typeof plugin["experimental.session.compacting"], "function", "Expected session compacting hook");

    const context = contextStub();
    const status = JSON.parse(await plugin.tool.pkm_status.execute({}, context));
    assert.equal(typeof status.vaultPath, "string", "Status should include vaultPath");
    assert.equal(typeof status.memoryPath, "string", "Status should include memoryPath");

    console.log(JSON.stringify({
      contract: "ok",
      id: pluginModule.id,
      tools: toolNames,
    }, null, 2));
  } finally {
    process.env.HOME = previousHome;
    await (plugin?.__mercury_shutdown ? plugin.__mercury_shutdown() : Promise.resolve());
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
