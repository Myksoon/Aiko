// Module `platform.discord.self`: opt-in user-account Discord adapter for text chat only
// (messages, reactions, typing, DMs, images/attachments). Never joins voice, never registers slash
// commands or handles interactions.

import { Client } from "@lng2004/discord.js-selfbot-v13";
import { LlmRouterKey, userMessage, withLlmTag } from "@miyoria/llm/llm";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  placeConfig,
  withTimeout,
} from "@miyoria/runtime/kernel";
import { SettingsStoreKey, StoreKey } from "@miyoria/store";
import {
  PlaceDirectoryKey,
  PlacesKey,
  PlatformHistoriesKey,
  PlatformSinksKey,
  ProfileIdKey,
  PromptContributorsKey,
} from "@miyoria/types";
import {
  AMBIENT_PRESENCE_CONTRIBUTOR,
  type AmbientPresenceSnapshot,
  ambientPresenceContributor,
  type PresenceClientLike,
  runAmbientPresenceLoop,
} from "./ambient-presence.js";
import { emojiContributor } from "./emoji.js";
import {
  DESCRIBE_PROMPT,
  DESCRIPTION_PREFIX,
  type Describe,
  DescribeQueue,
  type DescriptionStore,
  EmojiDescriber,
} from "./emoji-describe.js";
import { type AmbientPlaces, perGuild } from "./gate.js";
import { PLATFORM, parseUserIds } from "./mapping.js";
import { SHUTDOWN_GRACE_MS } from "./module.js";
import { type SelfClientLike, SelfGatewayBridge, SelfShared } from "./self-bridge.js";
import {
  type DiscordSelfConfig,
  DiscordSelfConfigSchema,
  resolveSelfToken,
} from "./self-config.js";
import { SelfDiscordPlaces, type SelfPlacesClientLike } from "./self-places.js";
import {
  STICKER_DESCRIBE_PROMPT,
  STICKER_DESCRIPTION_PREFIX,
  StickerDescriber,
  stickerContributor,
} from "./stickers.js";

const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export interface DiscordSelfOptions {
  /** Base directory used to resolve `token_env_file` (Core's `baseDir`). */
  baseDir?: string;
}

export class DiscordSelfModule implements Module {
  static readonly ID = "platform.discord.self";

  readonly manifest: ModuleManifest = defineManifest(DiscordSelfModule.ID, "Discord self chat", {
    description: "Discord user account: text chat only (no voice, no slash commands)",
    icon: "message-circle",
    category: "platform",
    optional: ["world"],
    configSchema: DiscordSelfConfigSchema,
  });

  readonly #baseDir: string | undefined;
  #running: SelfShared | null = null;
  #unregister: (() => void)[] = [];

  constructor(options: DiscordSelfOptions = {}) {
    this.#baseDir = options.baseDir;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(DiscordSelfConfigSchema);
    const token = resolveSelfToken(config, this.#baseDir);
    const selfIds = parseUserIds(config.self_account_ids);
    const sinks = ctx.services.get(PlatformSinksKey) ?? null;
    if (sinks === null) {
      ctx.log.warn("PlatformSinks service missing; output actions cannot reach Discord");
    }
    const histories = ctx.services.get(PlatformHistoriesKey) ?? null;
    const places = this.#places(ctx);
    const shared = new SelfShared(config, selfIds, sinks, histories, places);
    this.#running = shared;

    const client = new Client();
    new SelfGatewayBridge(ctx, shared).attach(client as unknown as SelfClientLike);
    ctx.provide(
      PlaceDirectoryKey,
      new SelfDiscordPlaces(client as unknown as SelfPlacesClientLike, () => shared.ready),
    );
    const describing = new DescribeQueue();
    this.#startEmoji(ctx, shared, describing);
    this.#startStickers(ctx, shared, describing);
    ctx.spawn("gateway", (signal) => runSelfGateway(client, token, shared, ctx, signal));
    if (config.presence.enabled) {
      let currentPresence: AmbientPresenceSnapshot | null = null;
      const contributors = ctx.services.get(PromptContributorsKey);
      if (contributors) {
        contributors.register(
          ambientPresenceContributor(
            () => currentPresence,
            () => ctx.clock.now(),
          ),
        );
        this.#unregister.push(() => contributors.unregister(AMBIENT_PRESENCE_CONTRIBUTOR));
      }
      ctx.spawn("ambient-presence", (signal) =>
        runAmbientPresenceLoop({
          client: client as unknown as PresenceClientLike,
          isReady: () => shared.ready,
          config: config.presence,
          rich: true,
          signal,
          now: () => ctx.clock.now(),
          onUpdate: (snap) => {
            currentPresence = snap;
          },
        }),
      );
    }
  }

  #places(ctx: ModuleContext): AmbientPlaces | null {
    const places = ctx.services.get(PlacesKey);
    if (places === undefined) return null;
    const settings = ctx.services.get(StoreKey)?.config?.places;
    return {
      config: placeConfig(ctx, DiscordSelfConfigSchema as never),
      places,
      own: (space, key) => settings?.get("space", space, DiscordSelfModule.ID, key) != null,
    };
  }

  #startEmoji(ctx: ModuleContext, shared: SelfShared, queue: DescribeQueue): void {
    const config = shared.config.emoji;
    const describer = new EmojiDescriber(
      descriptionStore(ctx, DESCRIPTION_PREFIX),
      describeWithModel(ctx, "emoji", DESCRIBE_PROMPT),
      undefined,
      queue,
    );
    const per = perGuild(shared as never, (c) => c.emoji);
    const owner = (name: string, guild: string | null): string | undefined =>
      per.descriptions(guild)[name]?.trim() || undefined;
    const contributors = ctx.services.get(PromptContributorsKey);
    const contributor = emojiContributor(
      shared.emoji,
      { owner, described: (id) => describer.get(id) },
      { max_listed: config.max_listed, enabled: (guild) => per.enabled(guild) },
    );
    contributors?.register(contributor);
    this.#unregister.push(() => contributors?.unregister(contributor.key));
    void describer.load();
    if (!config.auto_describe) return;
    const controller = new AbortController();
    this.#unregister.push(() => controller.abort());
    const off = shared.emoji.onChange((guild) => {
      if (!per.enabled(guild)) return;
      void describer.describeMissing(
        shared.emoji.list(guild),
        (e) => owner(e.name, guild) !== undefined,
        controller.signal,
      );
    });
    this.#unregister.push(off);
  }

  #startStickers(ctx: ModuleContext, shared: SelfShared, queue: DescribeQueue): void {
    const config = shared.config.stickers;
    const describer = new StickerDescriber(
      descriptionStore(ctx, STICKER_DESCRIPTION_PREFIX),
      describeWithModel(ctx, "sticker", STICKER_DESCRIBE_PROMPT),
      undefined,
      queue,
    );
    const per = perGuild(shared as never, (c) => c.stickers);
    const owner = (name: string, guild: string | null): string | undefined =>
      per.descriptions(guild)[name]?.trim() || undefined;
    const contributors = ctx.services.get(PromptContributorsKey);
    const contributor = stickerContributor(
      shared.stickers,
      { owner, described: (id) => describer.get(id) },
      { max_listed: config.max_listed, enabled: (guild) => per.enabled(guild) },
    );
    contributors?.register(contributor);
    this.#unregister.push(() => contributors?.unregister(contributor.key));
    void describer.load();
    if (!config.auto_describe) return;
    const controller = new AbortController();
    this.#unregister.push(() => controller.abort());
    const off = shared.stickers.onChange((guild) => {
      if (!per.enabled(guild)) return;
      void describer.describeMissing(
        shared.stickers.list(guild),
        (s) => owner(s.name, guild) !== undefined,
        controller.signal,
      );
    });
    this.#unregister.push(off);
  }

  async stop(): Promise<void> {
    for (const undo of this.#unregister.splice(0)) undo();
    const shared = this.#running;
    this.#running = null;
    if (shared) {
      shared.ready = false;
      if (shared.sink !== null && shared.sinks?.get(PLATFORM) === shared.sink) {
        shared.sinks.unregister(PLATFORM);
      }
      if (shared.history !== null && shared.histories?.get(PLATFORM) === shared.history) {
        shared.histories.unregister(PLATFORM);
      }
      shared.sink = null;
      shared.history = null;
    }
  }

  async health(): Promise<Health> {
    const shared = this.#running;
    if (shared === null) return { status: "unhealthy", reason: "not running" };
    return shared.ready ? HEALTHY : { status: "degraded", reason: "connecting to Discord" };
  }
}

function descriptionStore(ctx: ModuleContext, prefix: string): DescriptionStore | null {
  const store = ctx.services.get(SettingsStoreKey);
  const profile = ctx.services.get(ProfileIdKey);
  if (!store || profile === undefined) return null;
  return {
    async load() {
      const out = new Map<string, string>();
      for (const [key, value] of await store.list(profile, prefix)) {
        if (typeof value === "string") out.set(key.slice(prefix.length), value);
      }
      return out;
    },
    save: (id, line) => store.set(profile, `${prefix}${id}`, line),
  };
}

function describeWithModel(
  ctx: ModuleContext,
  label: "emoji" | "sticker",
  prompt: (name: string) => string,
): Describe | null {
  return async (dataUrl, name, signal) => {
    const router = ctx.services.get(LlmRouterKey);
    if (router?.takesImages("chat") !== true) return null;
    const response = await withLlmTag({ module: "discord", label }, () =>
      router.complete(
        "chat",
        {
          messages: [
            userMessage([
              { type: "text", text: prompt(name) },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
            ]),
          ],
          max_tokens: 80,
          thinking: false,
          reasoning_purpose: "emoji",
        },
        signal,
      ),
    );
    return response.text;
  };
}

async function runSelfGateway(
  client: Client,
  token: string,
  shared: SelfShared,
  ctx: ModuleContext,
  signal: AbortSignal,
): Promise<void> {
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const fatal = new Promise<never>((_, reject) => {
    client.on("shardDisconnect", (event) => {
      shared.ready = false;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        reject(new Error(`Discord self gateway closed with code ${event.code}`));
      }
    });
  });
  fatal.catch(() => undefined);
  client.on("shardReady", () => {
    shared.ready = true;
  });
  client.on("shardResume", () => {
    shared.ready = true;
  });
  client.on("error", (error) => {
    ctx.log.warn({ error: errorMessage(error) }, "Discord self client error");
  });
  client.on("shardError", (error) => {
    ctx.log.warn({ error: errorMessage(error) }, "Discord self shard error");
  });

  const login = client.login(token);
  login.catch(() => undefined);
  try {
    await Promise.race([login, aborted, fatal]);
    if (!signal.aborted) await Promise.race([aborted, fatal]);
  } finally {
    ctx.log.info("shutting down Discord self gateway");
    try {
      client.user?.setPresence({ status: "invisible", activities: [] });
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      // ignore if gateway already closed
    }
    await withTimeout(
      Promise.resolve()
        .then(() => client.destroy())
        .catch((error: unknown) => {
          ctx.log.debug({ error: errorMessage(error) }, "error while closing the self gateway");
        }),
      SHUTDOWN_GRACE_MS,
    );
  }
}

export type { DiscordSelfConfig };
