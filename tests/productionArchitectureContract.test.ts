import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const roots = ["server", "src", "scripts", "public", ".github/workflows", "tests"];
const standalone = [".env.example"];
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".yml", ".yaml", ".toml"]);
const forbidden = [
  ["cerberus-design", "preview.onrender.com"].join("-"),
  ["cerberus-static", "catalog.onrender.com"].join("-"),
  ["https://cerberus-forge-deploy-backend.onrender.com", "api", "products"].join("/"),
];

function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return textExtensions.has(path.extname(entry.name)) ? [full] : [];
  });
}

test("production surfaces contain no obsolete public catalog or frontend endpoints", () => {
  const files = [...roots.flatMap(filesUnder), ...standalone];
  const violations: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const marker of forbidden) if (source.includes(marker)) violations.push(`${file}: ${marker}`);
  }
  assert.deepEqual(violations, []);
});
