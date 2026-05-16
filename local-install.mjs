import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const runtimeFiles = [
  "main.js",
  "manifest.json",
  "styles.css",
];

const vaultRoot = process.argv[2];

if (!vaultRoot) {
  console.error("Usage: npm run local-install -- <vault-root>");
  process.exit(1);
}

const resolvedVaultRoot = await resolveVaultRoot(vaultRoot);
const pluginDir = path.join(resolvedVaultRoot, ".obsidian", "plugins", "vaultbox");
await fs.mkdir(pluginDir, { recursive: true });

for (const file of runtimeFiles) {
  const source = path.resolve(file);
  const sourceStat = await statOrNull(source);

  if (!sourceStat?.isFile()) {
    console.error(`Missing runtime file: ${source}`);
    console.error("Run npm run build before local-install, or use npm run local-install.");
    process.exit(1);
  }

  await fs.copyFile(source, path.join(pluginDir, file));
}

const installedFiles = await fs.readdir(pluginDir);
console.log(`Installed Vaultbox to ${pluginDir}`);
console.log(`Installed files: ${installedFiles.sort().join(", ")}`);

async function resolveVaultRoot(input) {
  const resolved = path.resolve(expandHome(input));
  const stat = await statOrNull(resolved);

  if (!stat?.isDirectory()) {
    console.error(`Vault path does not exist or is not a directory: ${resolved}`);
    process.exit(1);
  }

  if (path.basename(resolved) === "plugins" && path.basename(path.dirname(resolved)) === ".obsidian") {
    return path.dirname(path.dirname(resolved));
  }

  if (path.basename(resolved) === ".obsidian") {
    return path.dirname(resolved);
  }

  const obsidianDir = path.join(resolved, ".obsidian");
  const obsidianStat = await statOrNull(obsidianDir);
  if (!obsidianStat?.isDirectory()) {
    console.error(`Not an Obsidian vault root: ${resolved}`);
    console.error(`Expected to find: ${obsidianDir}`);
    process.exit(1);
  }

  return resolved;
}

function expandHome(target) {
  if (target === "~") {
    return process.env.HOME ?? target;
  }

  if (target.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", target.slice(2));
  }

  return target;
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
