#!/usr/bin/env node
/**
 * Switch Aiko's active persona preset inside `profiles/aiko/` while preserving
 * tokens, database, voice setup, `[llm.purposes]`, `[language]`, and `[behavior]`.
 *
 * Usage:
 *   node scripts/aiko-persona.mjs list
 *   node scripts/aiko-persona.mjs current
 *   node scripts/aiko-persona.mjs use <id>
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = join(REPO_ROOT, "profiles", "aiko");
const PRESETS_DIR = join(PROFILE_DIR, "presets");
const PERSONA_DIR = join(PROFILE_DIR, "persona");
const ACTIVE_FILE = join(PERSONA_DIR, ".active");
const PROFILE_TOML = join(PROFILE_DIR, "profile.toml");

function loadPreset(id) {
  const dir = join(PRESETS_DIR, id);
  const metaPath = join(dir, "preset.json");
  if (!existsSync(metaPath)) {
    throw new Error(`Unknown persona preset "${id}" (missing ${metaPath}).`);
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const required = [
    join(dir, "identity.md"),
    join(dir, "style.md"),
    join(dir, "lorebook.toml"),
    join(dir, "examples", "basic.md"),
  ];
  for (const file of required) {
    if (!existsSync(file)) {
      throw new Error(`Preset "${id}" is incomplete (missing ${file}).`);
    }
  }
  return { dir, meta };
}

function listPresets() {
  if (!existsSync(PRESETS_DIR)) return [];
  const entries = readdirSync(PRESETS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  const presets = [];
  for (const entry of entries) {
    const metaPath = join(PRESETS_DIR, entry.name, "preset.json");
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    presets.push({
      id: meta.id ?? entry.name,
      order: meta.order ?? 99,
      label: meta.label ?? entry.name,
      description: meta.description ?? "",
      display: meta.temperament?.display ?? "open",
    });
  }
  presets.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return presets;
}

function getActiveId() {
  if (!existsSync(ACTIVE_FILE)) return "kuudere";
  const raw = readFileSync(ACTIVE_FILE, "utf8").trim();
  return raw || "kuudere";
}

function formatEmotionsToml(meta) {
  const { mood, temperament } = meta;
  const lines = [
    `[mood]          # Active persona: ${meta.label ?? meta.id}`,
    `valence = ${mood.valence}`,
    `arousal = ${mood.arousal}`,
    `energy  = ${mood.energy}`,
    "",
    "[temperament]",
    `display = ${JSON.stringify(temperament.display ?? "open")}`,
    "[temperament.emotions]",
  ];
  for (const [name, cfg] of Object.entries(temperament.emotions ?? {})) {
    lines.push(
      `${name.padEnd(11, " ")} = { gain = ${cfg.gain}, half_life_mins = ${cfg.half_life_mins} }`,
    );
  }
  return lines.join("\n");
}

function usePreset(id) {
  const { dir, meta } = loadPreset(id);

  mkdirSync(join(PERSONA_DIR, "examples"), { recursive: true });
  copyFileSync(join(dir, "identity.md"), join(PERSONA_DIR, "identity.md"));
  copyFileSync(join(dir, "style.md"), join(PERSONA_DIR, "style.md"));
  copyFileSync(join(dir, "examples", "basic.md"), join(PERSONA_DIR, "examples", "basic.md"));
  copyFileSync(join(dir, "lorebook.toml"), join(PROFILE_DIR, "lorebook.toml"));

  const profileRaw = readFileSync(PROFILE_TOML, "utf8");
  const normalized = profileRaw.replaceAll("\r\n", "\n");
  const pattern = /\[mood\][\s\S]*?(?=\n\[behavior\])/;
  if (!pattern.test(normalized)) {
    throw new Error(
      `Could not find [mood]...[behavior] section in ${PROFILE_TOML}; refusing to overwrite profile.toml.`,
    );
  }
  const updated = normalized.replace(pattern, `${formatEmotionsToml(meta)}\n`);
  writeFileSync(PROFILE_TOML, updated, "utf8");
  writeFileSync(ACTIVE_FILE, `${meta.id ?? id}\n`, "utf8");

  console.log(`Switched Aiko persona to ${meta.label ?? id} (${meta.id ?? id}).`);
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "list") {
    const active = getActiveId();
    const presets = listPresets();
    console.log(JSON.stringify({ active, presets }, null, 2));
    return;
  }
  if (cmd === "current") {
    console.log(getActiveId());
    return;
  }
  if (cmd === "use") {
    if (!arg) {
      console.error("Usage: node scripts/aiko-persona.mjs use <id>");
      process.exit(1);
    }
    usePreset(arg.trim());
    return;
  }
  console.error("Usage: node scripts/aiko-persona.mjs <list|current|use <id>>");
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
