import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const vaultPath = process.argv[2];

if (!vaultPath) {
  console.error("Usage: npm run local-install -- \"/path/to/Your Vault\"");
  process.exit(1);
}

const target = path.join(vaultPath, ".obsidian", "plugins", "vaultbox");
await fs.mkdir(target, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await fs.copyFile(file, path.join(target, file));
}

console.log(`Installed Vaultbox to ${target}`);
