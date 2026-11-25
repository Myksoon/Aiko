import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandReply } from "@miyoria/commands";
import type { ModuleContext } from "@miyoria/runtime/kernel";
import {
  Events as BusEvents,
  type ContextKey,
  PlacesKey,
  PlatformHistories,
  PlatformSinks,
  PresencePrivacyKey,
} from "@miyoria/types";
import { ActivityType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  AMBIENT_PRESENCE_PRESETS,
  DiscordSelfConfigSchema,
  DiscordSelfModule,
  formatPresencePayload,
  MUSIC_TRACKS,
  normalizeMessageLike,
  OSU_MAPS,
  pickAmbientPresence,
  plainTextOfReply,
  resolveSelfToken,
  runAmbientPresenceLoop,
  type SelfClientLike,
  SelfDiscordHistory,
  SelfDiscordPlaces,
  SelfDiscordSink,
  SelfGatewayBridge,
  type SelfHistoryClientLike,
  type SelfPlacesClientLike,
  SelfShared,
  type SelfSinkClientLike,
} from "../src/index.js";

const ctxCh: ContextKey = { platform: "discord", scope: "100", channel: "200", kind: "channel" };

describe("resolveSelfToken", () => {
  it("uses direct token when provided and falls back to token_env_file without leaking secret on error", () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-self-tok-"));
    try {
      const cfg = DiscordSelfConfigSchema.parse({ token: "  tok_direct_123  " });
      expect(resolveSelfToken(cfg, dir)).toBe("tok_direct_123");

      const envPath = join(dir, ".env");
      writeFileSync(envPath, '# comment\nOTHER=foo\nSELF_TOKEN="tok_from_file_456"\n', "utf8");
      const fromFile = DiscordSelfConfigSchema.parse({ token_env_file: ".env" });
      expect(resolveSelfToken(fromFile, dir)).toBe("tok_from_file_456");

      const emptyCfg = DiscordSelfConfigSchema.parse({});
      expect(() => resolveSelfToken(emptyCfg, dir)).toThrow(/self token is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SelfDiscordSink", () => {
  it("sends text, attachments, reply without pinging, sticker fallback, and plain-text cards", async () => {
    const sentPayloads: unknown[] = [];
    const reacted: unknown[] = [];
    let typed = 0;
    let stickerFailOnce = true;

    const channel = {
      id: "200",
      name: "general",
      send: vi.fn(async (opts: { stickers?: string[] }) => {
        if (opts.stickers && stickerFailOnce) {
          stickerFailOnce = false;
          throw Object.assign(new Error("Invalid sticker"), { code: 50081 });
        }
        sentPayloads.push(opts);
        return { id: String(1000 + sentPayloads.length) };
      }),
      sendTyping: vi.fn(async () => {
        typed++;
      }),
      messages: {
        react: vi.fn(async (id: string, emoji: string) => {
          reacted.push({ id, emoji });
        }),
        edit: vi.fn(async () => undefined),
      },
    };

    const client: SelfSinkClientLike = {
      channels: {
        cache: { get: (id) => (id === "200" || id === "300" ? channel : undefined) },
        fetch: async (id) => (id === "200" || id === "300" ? channel : null),
      },
      guilds: {
        cache: { get: (id) => (id === "100" ? { name: "TestGuild" } : undefined) },
        fetch: async (id) => (id === "100" ? { name: "TestGuild" } : null),
      },
      users: {
        createDM: vi.fn(async () => ({ id: "300" })),
      },
    };

    const sink = new SelfDiscordSink(
      client,
      () => undefined,
      null,
      {
        source: () => ({
          open: async () => ({
            artifact_id: "art1",
            filename: "pic.jpg",
            data: Uint8Array.from([1, 2, 3]),
            size: 3,
            content_type: "image/jpeg",
          }),
        }),
        maxBytes: () => 10_000_000,
      },
      null,
    );

    const res = await sink.send(ctxCh, {
      text: "hello there",
      reply_to: { context: ctxCh, id: "999" },
      attachments: [{ artifact_id: "art1" }],
      proactive: true,
    } as never);

    expect(res.id).toBe("1001");
    expect(sentPayloads[0]).toMatchObject({
      content: "hello there",
      allowedMentions: { parse: ["users"], roles: [], repliedUser: false },
      reply: { messageReference: "999", failIfNotExists: false },
      flags: ["SUPPRESS_NOTIFICATIONS"],
    });
    expect((sentPayloads[0] as { files?: unknown[] }).files).toHaveLength(1);

    await sink.typing(ctxCh);
    expect(typed).toBe(1);

    await sink.react({ context: ctxCh, id: "999" }, "👍");
    expect(reacted).toEqual([{ id: "999", emoji: "👍" }]);

    const dm = await sink.openDm({ platform: "discord", id: "42" });
    expect(dm).toEqual({ platform: "discord", scope: null, channel: "300", kind: "dm" });

    const cardReply: CommandReply = {
      text: "",
      card: {
        accent: "info",
        title: "Panel Title",
        blocks: [
          { type: "text", text: "Line one" },
          { type: "muted", text: "Note" },
        ],
      },
    };
    expect(plainTextOfReply(cardReply)).toBe("**Panel Title**\nLine one\nNote");
    const cardRef = await sink.sendCard(ctxCh, cardReply);
    expect(cardRef.id).toBe("1002");
    expect(await sink.describe(ctxCh)).toBe("TestGuild / general");
  });
});

describe("SelfDiscordHistory and SelfDiscordPlaces", () => {
  it("maps v13 string message types, repliedUser, and channel places", async () => {
    const msgs = [
      {
        id: "10",
        type: "DEFAULT",
        channelId: "200",
        guildId: "100",
        author: { id: "55", username: "Hikaru", bot: false },
        content: "hi aiko",
        createdTimestamp: 1000,
        mentions: { users: { keys: () => [] }, repliedUser: { id: "77" } },
        attachments: { values: () => [] },
        reference: { messageId: "9", channelId: "200", guildId: "100", type: "REPLY" },
      },
      {
        id: "11",
        type: "GUILD_MEMBER_JOIN",
        channelId: "200",
        guildId: "100",
        author: { id: "56", username: "Joiner", bot: false },
        content: "joined",
        createdTimestamp: 2000,
        mentions: { users: { keys: () => [] } },
        attachments: { values: () => [] },
      },
    ];
    const historyClient: SelfHistoryClientLike = {
      channels: {
        fetch: async () => ({
          messages: {
            cache: { get: () => undefined },
            fetch: async () => ({ values: () => msgs }),
          },
        }),
      },
    };
    const history = new SelfDiscordHistory(historyClient, new Set(["77"]));
    const out = await history.recent(ctxCh, { before: null, limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]?.reply_to_self).toBe(true);
    expect(out[0]?.text).toBe("hi aiko");

    const placesClient: SelfPlacesClientLike = {
      guilds: {
        cache: {
          values: () => [
            {
              id: "100",
              name: "Server",
              me: { id: "77" },
              channels: {
                cache: {
                  values: () => [
                    {
                      id: "200",
                      name: "chat",
                      type: "GUILD_TEXT",
                      position: 1,
                      permissionsFor: () => ({
                        has: (p: string) => p === "VIEW_CHANNEL" || p === "SEND_MESSAGES",
                      }),
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    };
    const places = new SelfDiscordPlaces(placesClient, () => true);
    expect(places.rooms()).toMatchObject([{ id: "200", kind: "text", usable: true }]);
  });
});

describe("SelfGatewayBridge", () => {
  it("handles ready, gated messages, and string presence activity types without slash commands", async () => {
    const published: Array<{ event: string; data: unknown }> = [];
    const provided: string[] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sinks = new PlatformSinks();
    const histories = new PlatformHistories();

    const ctx = {
      publish: (def: { type: string }, data: unknown) => published.push({ event: def.type, data }),
      provide: (key: { id: string }) => provided.push(key.id),
      services: {
        get: (key: unknown) => {
          if (key === PlacesKey) return undefined;
          if (key === PresencePrivacyKey) return { presenceAllowed: () => true };
          return undefined;
        },
      },
      clock: { now: () => 5000 },
    } as unknown as ModuleContext;

    const cfg = DiscordSelfConfigSchema.parse({
      ambient_text: "allowlist",
      ambient_channels: ["200"],
      presence_intents: true,
    });
    const shared = new SelfShared(cfg, [], sinks, histories, null);
    const bridge = new SelfGatewayBridge(ctx, shared);

    const client: SelfClientLike = {
      user: { id: "77", username: "aiko" },
      guilds: { cache: { values: () => [], get: () => undefined } },
      channels: { cache: { get: () => undefined }, fetch: async () => null },
      users: { cache: { get: () => undefined } },
      on: (event, listener) => listeners.set(event, listener as never),
    };
    bridge.attach(client);

    listeners.get("ready")?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(shared.ready).toBe(true);
    expect(sinks.get("discord")).toBeDefined();
    expect(histories.get("discord")).toBeDefined();
    expect(published.some((p) => p.event === BusEvents.PlatformReady.type)).toBe(true);

    // Allowed channel message reaches bus; unallowed channel is dropped
    listeners.get("messageCreate")?.({
      id: "m1",
      type: "DEFAULT",
      channelId: "200",
      guildId: "100",
      channel: { id: "200", type: "GUILD_TEXT" },
      author: { id: "55", username: "Hikaru", bot: false },
      content: "yo",
      createdTimestamp: 1000,
      mentions: { users: { keys: () => [] } },
      attachments: { values: () => [] },
    });
    listeners.get("messageCreate")?.({
      id: "m2",
      type: "DEFAULT",
      channelId: "999",
      guildId: "100",
      channel: { id: "999", type: "GUILD_TEXT" },
      author: { id: "55", username: "Hikaru", bot: false },
      content: "ignored room",
      createdTimestamp: 1001,
      mentions: { users: { keys: () => [] } },
      attachments: { values: () => [] },
    });
    await new Promise((r) => setTimeout(r, 20));
    const msgEvents = published.filter((p) => p.event === BusEvents.PlatformMessageCreated.type);
    expect(msgEvents).toHaveLength(1);
    expect((msgEvents[0]?.data as { text: string } | undefined)?.text).toBe("yo");

    // String activity type maps to enum value
    listeners.get("presenceUpdate")?.(null, {
      userId: "55",
      guild: { id: "100" },
      status: "online",
      activities: [{ name: "Minecraft", type: "PLAYING" }],
      user: { id: "55", username: "Hikaru", bot: false },
    });
    await new Promise((r) => setTimeout(r, 10));
    const presEvents = published.filter((p) => p.event === BusEvents.PlatformPresence.type);
    expect(presEvents).toHaveLength(1);
    expect(
      (presEvents[0]?.data as { activities: Array<{ type: string }> } | undefined)?.activities[0]
        ?.type,
    ).toBe("playing");
    expect(ActivityType.Playing).toBe(0);

    // Module metadata
    const mod = new DiscordSelfModule();
    expect(mod.manifest.id).toBe("platform.discord.self");
  });

  it("preserves server nicknames from prototype getters on messages, history, and presence", async () => {
    class MockSelfMessage {
      id = "m_nick";
      type = "DEFAULT";
      channelId = "200";
      guildId = "100";
      channel = { id: "200", type: "GUILD_TEXT" };
      author = { id: "55", username: "hikaru_user", globalName: "光", bot: false };
      content = "halo aiko";
      createdTimestamp = 2000;
      mentions = { users: { keys: () => [] } };
      attachments = { values: () => [] };
      get member() {
        return { nickname: "pria kacamata" };
      }
    }

    class MockSelfPresence {
      userId = "55";
      guild = { id: "100" };
      status = "online";
      activities = [{ name: "osu!", type: "PLAYING" }];
      get user() {
        return { id: "55", username: "hikaru_user", globalName: "光", bot: false };
      }
      get member() {
        return {
          nickname: "pria kacamata",
          user: { id: "55", username: "hikaru_user", globalName: "光", bot: false },
        };
      }
    }

    const msgInstance = new MockSelfMessage();
    expect(normalizeMessageLike(msgInstance).member?.nickname).toBe("pria kacamata");

    const published: Array<{ event: string; data: unknown }> = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const ctx = {
      publish: (def: { type: string }, data: unknown) => published.push({ event: def.type, data }),
      provide: () => undefined,
      services: {
        get: (key: unknown) => {
          if (key === PlacesKey) return undefined;
          if (key === PresencePrivacyKey) return { presenceAllowed: () => true };
          return undefined;
        },
      },
      clock: { now: () => 5000 },
    } as unknown as ModuleContext;

    const cfg = DiscordSelfConfigSchema.parse({
      ambient_text: "allowlist",
      ambient_channels: ["200"],
      presence_intents: true,
    });
    const bridge = new SelfGatewayBridge(ctx, new SelfShared(cfg, [], new PlatformSinks()));
    const client: SelfClientLike = {
      user: { id: "77", username: "aiko" },
      guilds: { cache: { values: () => [], get: () => undefined } },
      channels: { cache: { get: () => undefined }, fetch: async () => null },
      users: { cache: { get: () => undefined } },
      on: (event, listener) => listeners.set(event, listener as never),
    };
    bridge.attach(client);

    listeners.get("messageCreate")?.(msgInstance);
    listeners.get("presenceUpdate")?.(null, new MockSelfPresence());
    await new Promise((r) => setTimeout(r, 20));

    const msgEvt = published.find((p) => p.event === BusEvents.PlatformMessageCreated.type);
    expect(
      (msgEvt?.data as { author: { display_name: string } } | undefined)?.author.display_name,
    ).toBe("pria kacamata");

    const presEvt = published.find((p) => p.event === BusEvents.PlatformPresence.type);
    expect((presEvt?.data as { display_name: string | null } | undefined)?.display_name).toBe(
      "pria kacamata",
    );

    // History preserves prototype getter member and falls back to guilds.cache when member is null
    const cachedGuildMsg = {
      id: "m_cache",
      type: "DEFAULT" as const,
      channelId: "200",
      guildId: "100",
      author: { id: "55", username: "hikaru_user", globalName: "光", bot: false },
      member: null,
      content: "older msg",
      createdTimestamp: 1500,
      mentions: { users: { keys: () => [] } },
      attachments: { values: () => [] },
    };
    const historyClient: SelfHistoryClientLike = {
      channels: {
        fetch: async () => ({
          messages: {
            cache: { get: () => undefined },
            fetch: async () => ({ values: () => [msgInstance, cachedGuildMsg] }),
          },
        }),
      },
      guilds: {
        cache: {
          get: (id) =>
            id === "100"
              ? {
                  members: {
                    cache: {
                      get: (uid) =>
                        uid === "55"
                          ? {
                              id: "55",
                              nickname: "pria kacamata",
                              user: {
                                id: "55",
                                username: "hikaru_user",
                                globalName: "光",
                                bot: false,
                              },
                            }
                          : undefined,
                    },
                  },
                }
              : undefined,
        },
      },
    };
    const history = new SelfDiscordHistory(historyClient, new Set(["77"]));
    const out = await history.recent(ctxCh, { before: null, limit: 10 });
    expect(out.map((m) => m.author.display_name)).toEqual(["pria kacamata", "pria kacamata"]);
  });
});

describe("ambient Discord Rich Presence & status", () => {
  it("picks from expected presets without repeating back-to-back and biases late night", () => {
    const names = AMBIENT_PRESENCE_PRESETS.map((p) => p.activity?.name).filter(Boolean);
    expect(names).toContain("osu!");
    expect(names).toContain("Roblox");
    expect(names).toContain("CLIP STUDIO PAINT");
    expect(names).toContain("YouTube Music");
    expect(names).toContain("Stardew Valley");
    expect(names).toContain("Minecraft");
    expect(AMBIENT_PRESENCE_PRESETS.some((p) => p.activity === null)).toBe(true);

    const dayMs = new Date("2026-11-24T05:00:00Z").getTime(); // 12:00 UTC+7
    let prev: number | null = null;
    for (let i = 0; i < 12; i++) {
      const picked = pickAmbientPresence(dayMs, prev, () => (i * 0.17) % 1);
      expect(picked.index).not.toBe(prev);
      prev = picked.index;
    }

    const nightMs = new Date("2026-11-24T19:00:00Z").getTime(); // 02:00 UTC+7
    const nightPick = pickAmbientPresence(nightMs, null, () => 0.1);
    expect(nightPick.preset.lateNight).toBe(true);
  });

  it("formats authentic osu!, YouTube Music, Bloxstrap Roblox, CSP, and clean bot payloads", () => {
    const nowMs = 1_700_000_000_000;

    const osuPreset = AMBIENT_PRESENCE_PRESETS.find((p) => p.kind === "osu")!;
    const osuRich = formatPresencePayload(osuPreset, {
      rich: true,
      nowMs,
      sessionStartMs: nowMs,
      osuIndex: 0,
    });
    expect(osuRich.activities[0]).toMatchObject({
      type: 0,
      name: "osu!",
      application_id: "1216669957799018608",
      details: OSU_MAPS[0]!.details,
      state: OSU_MAPS[0]!.state,
      timestamps: { start: nowMs },
      assets: {
        large_image: "1252834872297259048",
        small_image: OSU_MAPS[0]!.modeAsset,
      },
    });

    const ytmPreset = AMBIENT_PRESENCE_PRESETS.find((p) => p.kind === "youtube-music")!;
    const ytmRich = formatPresencePayload(ytmPreset, {
      rich: true,
      nowMs,
      trackIndex: 0,
    });
    expect(ytmRich.activities[0]).toMatchObject({
      type: 2,
      name: "YouTube Music",
      application_id: "463151177836658699",
      details: MUSIC_TRACKS[0]!.title,
      state: MUSIC_TRACKS[0]!.artist,
      assets: {
        large_image: "463151407512682502",
        large_text: "YouTube Music",
        small_image: "466593210362232833",
        small_text: "Playing",
      },
      timestamps: {
        start: nowMs,
        end: nowMs + MUSIC_TRACKS[0]!.durationMs,
      },
    });

    const robloxPreset = AMBIENT_PRESENCE_PRESETS.find((p) => p.kind === "roblox-bloxstrap")!;
    const robloxRich = formatPresencePayload(robloxPreset, {
      rich: true,
      nowMs,
      resolvedLargeImage: "mp:external/test-icon",
    });
    expect(robloxRich.activities[0]).toMatchObject({
      type: 0,
      name: "Roblox",
      application_id: "1005469189907173486",
      details: robloxPreset.activity!.details,
      state: expect.stringMatching(/^by /),
      assets: {
        large_image: "mp:external/test-icon",
        small_image: "1562785727673147413",
      },
    });

    const cspPreset = AMBIENT_PRESENCE_PRESETS.find((p) => p.kind === "csp")!;
    const cspRich = formatPresencePayload(cspPreset, { rich: true, nowMs });
    expect(cspRich.activities[0]).toMatchObject({
      type: 0,
      name: "CLIP STUDIO PAINT",
      application_id: "1512449466127483001",
      details: expect.stringMatching(/\.clip$/),
      state: "CLIP STUDIO PAINT EX",
    });

    // Bot mode keeps clean activity without fake details/state/assets/timestamps
    const botYtm = formatPresencePayload(ytmPreset, { rich: false, nowMs });
    expect(botYtm.activities[0]).toEqual({ type: 2, name: "YouTube Music" });
    const botOsu = formatPresencePayload(osuPreset, { rich: false, nowMs });
    expect(botOsu.activities[0]).toEqual({ type: 0, name: "osu!" });
  });

  it("syncs presence.userId, updates presence once ready, advances YouTube Music tracks, and stops on abort", async () => {
    const updates: Array<{ status: string; activities: Array<Record<string, unknown>> }> = [];
    const ac = new AbortController();
    let ready = false;
    let fakeNow = 1_700_000_000_000;
    const presenceState: { userId: string | null } = { userId: null };

    const loopPromise = runAmbientPresenceLoop({
      client: {
        presence: presenceState,
        user: {
          id: "77",
          setPresence: (data) => {
            expect(presenceState.userId).toBe("77");
            updates.push(data);
            if (updates.length >= 2) ac.abort();
          },
        },
      },
      isReady: () => ready,
      config: { enabled: true, min_interval_mins: 20, max_interval_mins: 50 },
      rich: true,
      signal: ac.signal,
      now: () => fakeNow,
      random: () => 0.0,
      sleep: async (ms) => {
        if (!ready) {
          ready = true;
          return;
        }
        fakeNow += ms;
      },
    });

    await loopPromise;
    expect(presenceState.userId).toBe("77");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(["online", "idle", "dnd"]).toContain(updates[0]?.status);
    expect(updates[0]?.activities[0]).toMatchObject({
      type: 2,
      name: "YouTube Music",
      application_id: "463151177836658699",
    });
  });
});
