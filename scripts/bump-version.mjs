// Bump the app version everywhere it lives, in one shot, so a release can never ship
// with the manifests disagreeing. Prints the new version to stdout for the caller
// (release.yml) to tag with.
//
//   node scripts/bump-version.mjs patch|minor|major|<x.y.z>

import { readFileSync, writeFileSync } from "node:fs";

const TAURI_CONF = "apps/desktop/src-tauri/tauri.conf.json";
const CARGO_TOML = "apps/desktop/src-tauri/Cargo.toml";
const JSON_FILES = ["package.json", "apps/desktop/package.json", TAURI_CONF];

const kind = process.argv[2];
const current = JSON.parse(readFileSync(TAURI_CONF, "utf8")).version;
const [major, minor, patch] = current.split(".").map(Number);

let next;
if (kind === "major") next = `${major + 1}.0.0`;
else if (kind === "minor") next = `${major}.${minor + 1}.0`;
else if (kind === "patch") next = `${major}.${minor}.${patch + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(kind)) next = kind;
else {
  console.error(`usage: bump-version.mjs patch|minor|major|<x.y.z> (current: ${current})`);
  process.exit(1);
}

for (const file of JSON_FILES) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.version = next;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// Only the [package] version sits at line start; dependency `version = "2"` entries are
// inside inline tables and never match.
const cargo = readFileSync(CARGO_TOML, "utf8");
writeFileSync(CARGO_TOML, cargo.replace(/^version = ".*"$/m, `version = "${next}"`));

console.log(next);
