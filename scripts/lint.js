import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const roots = ["src", "tests", "scripts"];
const files = [];

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith(".js")) files.push(full);
  }
}

for (const root of roots) await walk(root);

let failed = 0;
for (const file of files) {
  const source = await readFile(file, "utf8");
  if (/\bparseFloat\b|\bNumber\.parseFloat\b/.test(source) && file.includes(`${path.sep}domain${path.sep}money.js`)) {
    console.error(`${file}: parseFloat is not allowed in the money path`);
    failed += 1;
  }
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    failed += 1;
  }
}

if (failed > 0) process.exit(1);
console.log(`lint ok (${files.length} files)`);
