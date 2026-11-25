// `[modules."platform.discord.self"]` config section (opt-in Discord user account for text chat).
//
// Reads text messages, reactions, typing and cached presences/voice states using a user account
// token (`DISCORD_SELF_TOKEN`, `SELF_TOKEN`, or `token_env_file`). Never joins voice and never
// registers slash commands.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { AmbientPresenceConfigSchema } from "./ambient-presence.js";

const SelfEmojiConfigSchema = z.object({
  enabled: z.boolean().default(true),
  descriptions: z.record(z.string(), z.string()).default({}),
  auto_describe: z.boolean().default(true),
  max_listed: z.number().int().nonnegative().default(40),
  per_message: z.number().int().nonnegative().default(1),
  window_messages: z.number().int().positive().default(3),
  max_in_window: z.number().int().nonnegative().default(1),
});

const SelfStickerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  descriptions: z.record(z.string(), z.string()).default({}),
  auto_describe: z.boolean().default(true),
  max_listed: z.number().int().nonnegative().default(20),
  window_messages: z.number().int().positive().default(5),
  max_in_window: z.number().int().nonnegative().default(1),
  per_hour: z.number().int().nonnegative().default(3),
});

const Snowflake = z.union([z.string(), z.number()]).transform((value, ctx) => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      ctx.addIssue({
        code: "custom",
        message: `\`${value}\` is not a safe integer; write Discord ids as quoted strings`,
      });
      return z.NEVER;
    }
    return String(value);
  }
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    ctx.addIssue({ code: "custom", message: `\`${value}\` is not a Discord id` });
    return z.NEVER;
  }
  return BigInt(trimmed).toString();
});

export const DiscordSelfConfigSchema = z.object({
  /** User token. Leave empty when loading from `token_env_file`. */
  token: z.string().default(""),
  /** Optional path (relative to Core's `baseDir`) to a `.env` file carrying `SELF_TOKEN`. */
  token_env_file: z.string().default(""),
  /** Her other accounts (e.g. the official bot account id). Mentions/replies to them count. */
  self_account_ids: z.array(z.string()).default([]),
  /**
   * Off by default for user accounts so startup never fires bulk member fetch (`OP 8`) queries;
   * cached gateway presences still update when enabled.
   */
  presence_intents: z.boolean().default(false),
  ambient_text: z.enum(["allowlist", "tiers"]).default("allowlist"),
  ambient_channels: z.array(Snowflake).default([]),
  ambient_follow: z.boolean().nullable().default(null),
  /** When true, newly joined guilds inherit the configured ambient rules immediately. */
  follow_new_guilds: z.boolean().default(false),
  presence: AmbientPresenceConfigSchema.prefault({}),
  emoji: SelfEmojiConfigSchema.prefault({}),
  stickers: SelfStickerConfigSchema.prefault({}),
  max_upload_bytes: z.number().int().positive().default(10_485_760),
});

export type DiscordSelfConfig = z.output<typeof DiscordSelfConfigSchema>;

const TOKEN_ENV_KEYS = ["DISCORD_SELF_TOKEN", "SELF_TOKEN"] as const;

function parseEnvFileToken(raw: string): string | null {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (val !== "") values.set(key, val);
  }
  for (const key of TOKEN_ENV_KEYS) {
    const hit = values.get(key)?.trim();
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolves the user account token from `config.token` or `config.token_env_file`.
 * Never includes the token value in thrown error messages.
 */
export function resolveSelfToken(config: DiscordSelfConfig, baseDir?: string): string {
  const direct = config.token.trim();
  if (direct !== "") return direct;
  const envFile = config.token_env_file.trim();
  if (envFile !== "") {
    const fullPath = resolve(baseDir ?? process.cwd(), envFile);
    let raw: string;
    try {
      raw = readFileSync(fullPath, "utf8");
    } catch {
      throw new Error(`self token env file could not be read (${config.token_env_file})`);
    }
    const found = parseEnvFileToken(raw);
    if (found !== null) return found;
  }
  throw new Error("self token is empty; set DISCORD_SELF_TOKEN or token_env_file");
}
