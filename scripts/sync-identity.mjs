#!/usr/bin/env node
// Vendors the identity-registry code of agents-marketplace into this SDK.
//
//   node scripts/sync-identity.mjs <agents-marketplace path> [--allow-dirty]
//
// The script copies these files unchanged:
//   - the identity transaction builders (packages/shared/src/identity/tx/**), the
//     identity helpers and every shared module that they import (relative imports,
//     followed to the end);
//   - the advert codec and the canonical JSON helper that the vault client needs;
//   - the identity-marketplace blueprint (contracts/identity-marketplace/plutus.json)
//     and the deployed legacy-registry blueprint (tests/legacy-registry/fixtures);
//   - the minimal `aiken tx simulate` harness of tests/legacy-registry/harness;
//   - the published mainnet deployment record
//     (contracts/identity-marketplace/deploy/mainnet/deployment.json), which the
//     tests compare with the mainnet defaults of the configuration.
// Each file keeps its path below the vendor root, so the relative imports
// between the copies stay valid. Then the script writes VENDORED-FROM.md with
// the source commit and the SHA-256 of each file. tests/unit/vendored.test.ts
// checks that table against the files in both directions.
//
// The copies must equal the source commit: the script refuses source files
// with uncommitted changes, unless --allow-dirty is given.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Runtime copies (bundled into dist) and test copies (vitest only). */
export const RUNTIME_ROOT = "src/vendor/agents-marketplace";
export const TEST_ROOT = "tests/vendor/agents-marketplace";
export const TABLE_FILE = "VENDORED-FROM.md";

/** Modules whose relative imports are followed; each lands below RUNTIME_ROOT. */
const RUNTIME_ENTRIES = [
  "packages/shared/src/identity/tx/index.ts",
  "packages/shared/src/identity/index.ts",
  "packages/shared/src/cbor/IdentityAdvertDatum.ts",
  "packages/shared/src/cbor/canonical.ts",
];

/** Data files below RUNTIME_ROOT. */
const RUNTIME_FILES = [
  "contracts/identity-marketplace/plutus.json",
  "tests/legacy-registry/fixtures/agent-registry.plutus.json",
];

/** Test harness modules whose relative imports are followed; each lands below TEST_ROOT. */
const TEST_ENTRIES = [
  "tests/legacy-registry/harness/blueprint.ts",
  "tests/legacy-registry/harness/simulate.ts",
];

/** Test data files below TEST_ROOT. */
const TEST_FILES = [
  "contracts/identity-marketplace/deploy/mainnet/deployment.json",
];

const IMPORT_PATTERN = /(?:^|[\s;])(?:import|export)\s(?:[^;'"]*?\sfrom\s)?["']([^"']+)["']/g;

function fail(message) {
  console.error(`sync-identity: ${message}`);
  process.exit(1);
}

function git(source, args) {
  return execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
}

/** The source path of a relative import, or null for a package import. */
function resolveImport(source, from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = base.endsWith(".js")
    ? [`${base.slice(0, -3)}.ts`, base]
    : base.endsWith(".json") || base.endsWith(".ts")
      ? [base]
      : [`${base}.ts`, `${base}/index.ts`];
  const found = candidates.find((candidate) => existsSync(join(source, candidate)));
  if (found === undefined) fail(`${from} imports ${specifier}, which does not exist in the source`);
  return found;
}

/** Every module that the entries import, followed through relative imports. */
function closure(source, entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    if (!existsSync(join(source, file))) fail(`missing source file ${file}`);
    seen.add(file);
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(source, file), "utf8");
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const target = resolveImport(source, file, match[1]);
      if (target !== null && !seen.has(target)) stack.push(target);
    }
  }
  return [...seen].sort();
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function main() {
  const args = process.argv.slice(2);
  const allowDirty = args.includes("--allow-dirty");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) fail("usage: node scripts/sync-identity.mjs <agents-marketplace path> [--allow-dirty]");
  const source = resolve(positional[0]);
  if (!existsSync(join(source, "packages/shared/src/identity/tx/index.ts"))) {
    fail(`${source} is not an agents-marketplace checkout with the identity builders`);
  }

  const runtime = [...closure(source, RUNTIME_ENTRIES), ...RUNTIME_FILES].sort();
  const tests = [...closure(source, TEST_ENTRIES), ...TEST_FILES].sort();
  const all = [...runtime, ...tests];

  const commit = git(source, ["rev-parse", "HEAD"]);
  const dirty = git(source, ["status", "--porcelain", "--", ...all]);
  if (dirty !== "" && !allowDirty) {
    fail(`these source files differ from ${commit}; commit them or pass --allow-dirty:\n${dirty}`);
  }
  const committedAt = git(source, ["log", "-1", "--format=%cI", commit]);

  for (const root of [RUNTIME_ROOT, TEST_ROOT]) rmSync(join(SDK_ROOT, root), { recursive: true, force: true });
  const rows = [];
  for (const [root, files] of [[RUNTIME_ROOT, runtime], [TEST_ROOT, tests]]) {
    for (const file of files) {
      const destination = posix.join(root, file);
      const target = join(SDK_ROOT, destination);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(source, file), target);
      if (!statSync(target).isFile()) fail(`could not copy ${file}`);
      rows.push({ destination, file, hash: sha256(target) });
    }
  }
  rows.sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0));

  const lines = [
    "# Vendored files",
    "",
    "Do not edit these files by hand. `scripts/sync-identity.mjs` copies them unchanged from",
    "agents-marketplace and writes this table. `tests/unit/vendored.test.ts` checks the table",
    "against the files in both directions.",
    "",
    "| Field | Value |",
    "|---|---|",
    "| Source | https://github.com/Apex-Fusion/agents-marketplace |",
    `| Commit | \`${commit}\` |`,
    `| Commit date | ${committedAt} |`,
    `| Local changes in the copied files | ${dirty === "" ? "none" : "yes (--allow-dirty)"} |`,
    `| Command | \`node scripts/sync-identity.mjs <agents-marketplace path>\` |`,
    "",
    `Runtime copies live below \`${RUNTIME_ROOT}/\`; test copies live below \`${TEST_ROOT}/\`.`,
    "Each copy keeps its source path below its vendor root.",
    "",
    "| File | Source path | SHA-256 |",
    "|---|---|---|",
    ...rows.map((r) => `| \`${r.destination}\` | \`${r.file}\` | \`${r.hash}\` |`),
    "",
  ];
  writeFileSync(join(SDK_ROOT, TABLE_FILE), lines.join("\n"));
  console.log(`sync-identity: copied ${rows.length} files from ${relative(SDK_ROOT, source) || "."} at ${commit}`);
  if (dirty !== "") console.log("sync-identity: the copies include uncommitted source changes");
}

if (normalize(fileURLToPath(import.meta.url)) === normalize(resolve(process.argv[1] ?? ""))) main();
