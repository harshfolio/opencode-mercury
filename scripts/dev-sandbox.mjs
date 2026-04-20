import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const sandboxRoot = path.join(root, ".sandbox", "mercury-dev");
const homePath = path.join(sandboxRoot, "home");
const workspacePath = path.join(sandboxRoot, "workspace");
const configPath = path.join(homePath, ".config", "opencode", "opencode.json");
const pluginPath = path.join(root, "dist", "server.js");

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

async function main() {
  await Promise.all([
    ensureDir(workspacePath),
    ensureDir(path.dirname(configPath)),
    ensureDir(path.join(homePath, ".local", "share", "opencode")),
  ]);

  const allowHomeGlob = `${homePath.replace(/\\/g, "/")}/*`;
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(pluginPath).href],
    permission: {
      read: "allow",
      edit: "allow",
      bash: "allow",
      external_directory: {
        [allowHomeGlob]: "allow",
        "/tmp/*": "allow",
        "/var/folders/*": "allow",
      },
    },
  };

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(sandboxRoot, "README.md"),
    [
      "# Mercury Dev Sandbox",
      "",
      "This sandbox isolates Mercury from your real OpenCode profile.",
      "",
      "## Paths",
      `- Sandbox root: \`${sandboxRoot}\``,
      `- HOME: \`${homePath}\``,
      `- Workspace: \`${workspacePath}\``,
      `- OpenCode config: \`${configPath}\``,
      `- Plugin entry: \`${pluginPath}\``,
      "",
      "## Launch",
      `HOME="${homePath}" opencode`,
      "",
      "Mercury will use sandboxed defaults under this HOME, including its Vault42, hot memory, backup root, and OpenCode state surfaces.",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify({
    sandbox: "ready",
    sandboxRoot,
    homePath,
    workspacePath,
    configPath,
    launchCommand: `HOME="${homePath}" opencode`,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
