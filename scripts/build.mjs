import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "src");
const distRoot = path.join(root, "dist");

async function copyTree(source, target) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(target, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath);
      continue;
    }
    await fs.copyFile(sourcePath, targetPath);
  }
}

await fs.rm(distRoot, { recursive: true, force: true });
await copyTree(sourceRoot, distRoot);
