import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
const distEntry = path.join(repoRoot, "dist", "server.js");
const pluginUrl = pathToFileURL(distEntry).href;

const mercuryAllowlist = {
  "/Users/harshsharma/Documents/Vault42/*": "allow",
  "/Users/harshsharma/.config/opencode/memory/*": "allow",
  "/Users/harshsharma/Library/Application Support/opencode-mercury/*": "allow",
};

function normalizePluginEntry(entry) {
  if (Array.isArray(entry) && entry[0] && String(entry[0]).includes("opencode-pkm-memory-plugin")) {
    return [pluginUrl, entry[1] || {}];
  }
  if (typeof entry === "string" && entry.includes("opencode-pkm-memory-plugin")) {
    return pluginUrl;
  }
  return entry;
}

async function main() {
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  const originalPlugins = Array.isArray(config.plugin) ? config.plugin : [];
  const nextPlugins = originalPlugins.map(normalizePluginEntry);

  const hasMercury = nextPlugins.some((entry) => {
    if (typeof entry === "string") return entry === pluginUrl;
    return Array.isArray(entry) && entry[0] === pluginUrl;
  });

  if (!hasMercury) {
    throw new Error(`Could not find a Mercury plugin entry to migrate in ${configPath}`);
  }

  config.plugin = nextPlugins;
  config.permission = config.permission || {};
  config.permission.external_directory = {
    ...mercuryAllowlist,
    ...(config.permission.external_directory || {}),
  };

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    migrated: true,
    configPath,
    pluginUrl,
    allowlist: Object.keys(mercuryAllowlist),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
