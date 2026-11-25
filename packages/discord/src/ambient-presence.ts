// Rotating Discord Rich Presence & status updates while the text bot or self-chat module is
// active (never touches voice-node). Supports both authentic rich presence payloads on user
// accounts (osu!lazer, Bloxstrap Roblox, CLIP STUDIO PAINT, YouTube Music, native games) and clean
// bot-safe status/activities on discord.js v14.

import { RichPresence } from "@lng2004/discord.js-selfbot-v13";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { PromptContributor, PromptRequest, PromptSection } from "@miyoria/types";
import { z } from "zod";

const log = getLogger("discord.presence.ambient");

export const AmbientPresenceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  min_interval_mins: z.number().int().positive().default(20),
  max_interval_mins: z.number().int().positive().default(50),
});

export type AmbientPresenceConfig = z.output<typeof AmbientPresenceConfigSchema>;

export type AmbientStatus = "online" | "idle" | "dnd";

/** Numeric ActivityType values supported by both discord.js v14 and discord.js-selfbot-v13. */
export const ACTIVITY_PLAYING = 0;
export const ACTIVITY_LISTENING = 2;
export const ACTIVITY_WATCHING = 3;
export const ACTIVITY_CUSTOM = 4;

/** Verified Discord Application IDs and uploaded asset snowflakes. */
const OSU_LAZER_APP_ID = "1216669957799018608";
const OSU_LOGO_LAZER_ASSET = "1252834872297259048";
const OSU_MODE_STANDARD_ASSET = "1216675677709795328";
const OSU_MODE_MANIA_ASSET = "1216675677894475917";

const BLOXSTRAP_APP_ID = "1005469189907173486";
const BLOXSTRAP_ROBLOX_ASSET = "1562785727673147413";

const YOUTUBE_MUSIC_APP_ID = "463151177836658699";
const YOUTUBE_MUSIC_LOGO_ASSET = "463151407512682502"; // ytm_lg
const YOUTUBE_MUSIC_PLAY_ASSET = "466593210362232833"; // play

const CSP_APP_ID = "1512449466127483001";
const STARDEW_APP_ID = "359509387670192128";
const MINECRAFT_APP_ID = "1402418491272986635";

export interface MusicTrackPreset {
  title: string;
  artist: string;
  durationMs: number;
}

/** Verified real music tracks (durations queried live) for YouTube Music listening presence. */
export const MUSIC_TRACKS: readonly MusicTrackPreset[] = [
  { title: "アイドル", artist: "YOASOBI", durationMs: 211733 },
  { title: "夜に駆ける", artist: "YOASOBI", durationMs: 258840 },
  { title: "ただ君に晴れ", artist: "Yorushika", durationMs: 198971 },
  { title: "晴る", artist: "Yorushika", durationMs: 272622 },
  { title: "TAIDADA", artist: "ZUTOMAYO", durationMs: 223700 },
  { title: "Inside Joke", artist: "ZUTOMAYO", durationMs: 254533 },
  { title: "Shinunoga E-Wa", artist: "Fujii Kaze", durationMs: 185573 },
  { title: "Kirari", artist: "Fujii Kaze", durationMs: 227893 },
  { title: "From The Start", artist: "Laufey", durationMs: 169573 },
  { title: "Lover Girl", artist: "Laufey", durationMs: 164400 },
  { title: "Ditto", artist: "NewJeans", durationMs: 185506 },
  { title: "New Jeans", artist: "NewJeans", durationMs: 108986 },
  { title: "the perfect pair", artist: "beabadoobee", durationMs: 177533 },
  { title: "death bed (coffee for your head)", artist: "Powfu, beabadoobee", durationMs: 173333 },
  { title: "Feather", artist: "Nujabes, Cise Starr, Akin Yai", durationMs: 175693 },
  { title: "Lady Brown", artist: "Nujabes, Cise Starr", durationMs: 199160 },
  { title: "SLOW DANCING IN THE DARK", artist: "Joji", durationMs: 209273 },
  { title: "Glimpse of Us", artist: "Joji", durationMs: 233453 },
];

export interface OsuMapPreset {
  details?: string;
  state: "Clicking circles" | "Smashing keys" | "Choosing a beatmap" | "Idle";
  modeAsset: string;
  modeText: string;
}

export const OSU_MAPS: readonly OsuMapPreset[] = [
  {
    details: "YOASOBI - Yoru ni Kakeru [Insane]",
    state: "Clicking circles",
    modeAsset: OSU_MODE_STANDARD_ASSET,
    modeText: "osu!",
  },
  {
    details: "Yorushika - Tada Kimi ni Hare [Hard]",
    state: "Clicking circles",
    modeAsset: OSU_MODE_STANDARD_ASSET,
    modeText: "osu!",
  },
  {
    details: "Kenshi Yonezu - Kick Back [Insane]",
    state: "Clicking circles",
    modeAsset: OSU_MODE_STANDARD_ASSET,
    modeText: "osu!",
  },
  {
    details: "REOL - No title [Lust's Insane]",
    state: "Clicking circles",
    modeAsset: OSU_MODE_STANDARD_ASSET,
    modeText: "osu!",
  },
  {
    details: "cYsmix - Triangles [4K Hard]",
    state: "Smashing keys",
    modeAsset: OSU_MODE_MANIA_ASSET,
    modeText: "osu!mania",
  },
  {
    details: "Camellia - GHOST [4K Normal]",
    state: "Smashing keys",
    modeAsset: OSU_MODE_MANIA_ASSET,
    modeText: "osu!mania",
  },
  {
    state: "Choosing a beatmap",
    modeAsset: OSU_MODE_STANDARD_ASSET,
    modeText: "osu!",
  },
  {
    state: "Idle",
    modeAsset: OSU_MODE_STANDARD_ASSET,
    modeText: "osu!",
  },
];

export interface RichActivityPreset {
  type: 0 | 2;
  name: string;
  applicationId?: string;
  details?: string;
  state?: string;
  assets?: {
    large_image?: string;
    large_text?: string;
    small_image?: string;
    small_text?: string;
  };
  externalLargeImageUrl?: string;
}

export interface AmbientPresencePreset {
  kind: "spotify" | "youtube-music" | "osu" | "roblox-bloxstrap" | "csp" | "native-game" | "idle";
  status: AmbientStatus;
  lateNight: boolean;
  activity: RichActivityPreset | null;
  idleNote?: string;
}

export const AMBIENT_PRESENCE_PRESETS: readonly AmbientPresencePreset[] = [
  // ---- Music (~30%: YouTube Music & Spotify; index 0 kept as YouTube Music) ----
  {
    kind: "youtube-music",
    status: "online",
    lateNight: true,
    activity: {
      type: ACTIVITY_LISTENING,
      name: "YouTube Music",
      applicationId: YOUTUBE_MUSIC_APP_ID,
    },
  },
  {
    kind: "youtube-music",
    status: "idle",
    lateNight: true,
    activity: {
      type: ACTIVITY_LISTENING,
      name: "YouTube Music",
      applicationId: YOUTUBE_MUSIC_APP_ID,
    },
  },
  {
    kind: "spotify",
    status: "online",
    lateNight: false,
    activity: {
      type: ACTIVITY_LISTENING,
      name: "Spotify",
    },
  },
  {
    kind: "spotify",
    status: "online",
    lateNight: true,
    activity: {
      type: ACTIVITY_LISTENING,
      name: "Spotify",
    },
  },
  {
    kind: "spotify",
    status: "idle",
    lateNight: true,
    activity: {
      type: ACTIVITY_LISTENING,
      name: "Spotify",
    },
  },
  {
    kind: "spotify",
    status: "online",
    lateNight: false,
    activity: {
      type: ACTIVITY_LISTENING,
      name: "Spotify",
    },
  },
  // ---- No Game / Chilling, Eating, Going Outside (~40%) ----
  {
    kind: "idle",
    status: "online",
    lateNight: false,
    activity: null,
    idleNote: "just chilling and scrolling on her phone",
  },
  {
    kind: "idle",
    status: "online",
    lateNight: true,
    activity: null,
    idleNote: "curled up chilling in her room",
  },
  {
    kind: "idle",
    status: "online",
    lateNight: false,
    activity: null,
    idleNote: "eating a meal and relaxing",
  },
  {
    kind: "idle",
    status: "online",
    lateNight: true,
    activity: null,
    idleNote: "grabbing late-night snacks and a warm drink",
  },
  {
    kind: "idle",
    status: "idle",
    lateNight: false,
    activity: null,
    idleNote: "went outside for a bit to get fresh air or food",
  },
  {
    kind: "idle",
    status: "idle",
    lateNight: false,
    activity: null,
    idleNote: "out running errands / stepped outside",
  },
  {
    kind: "idle",
    status: "idle",
    lateNight: false,
    activity: null,
    idleNote: "just hanging out away from games",
  },
  {
    kind: "idle",
    status: "dnd",
    lateNight: true,
    activity: null,
    idleNote: "resting in bed, taking a break",
  },
  // ---- Games & Drawing (~30%, occasional rather than constant) ----
  {
    kind: "osu",
    status: "online",
    lateNight: false,
    activity: {
      type: ACTIVITY_PLAYING,
      name: "osu!",
      applicationId: OSU_LAZER_APP_ID,
    },
  },
  {
    kind: "roblox-bloxstrap",
    status: "online",
    lateNight: false,
    activity: {
      type: ACTIVITY_PLAYING,
      name: "Roblox",
      applicationId: BLOXSTRAP_APP_ID,
      details: "Natural Disaster Survival",
      state: "by Stickmasterluke ☑️",
      assets: {
        large_image: BLOXSTRAP_ROBLOX_ASSET,
        large_text: "Natural Disaster Survival",
        small_image: BLOXSTRAP_ROBLOX_ASSET,
        small_text: "Roblox",
      },
      externalLargeImageUrl:
        "https://tr.rbxcdn.com/180DAY-ac1c764a99cfae201fd4fe916170a218/512/512/Image/Png/noFilter",
    },
  },
  {
    kind: "roblox-bloxstrap",
    status: "online",
    lateNight: true,
    activity: {
      type: ACTIVITY_PLAYING,
      name: "Roblox",
      applicationId: BLOXSTRAP_APP_ID,
      details: "DOORS 👁️",
      state: "by LSPLASH ☑️",
      assets: {
        large_image: BLOXSTRAP_ROBLOX_ASSET,
        large_text: "DOORS 👁️",
        small_image: BLOXSTRAP_ROBLOX_ASSET,
        small_text: "Roblox",
      },
      externalLargeImageUrl:
        "https://tr.rbxcdn.com/180DAY-162de85b0d395c94c02f367b52dc5ddd/512/512/Image/Png/noFilter",
    },
  },
  {
    kind: "roblox-bloxstrap",
    status: "online",
    lateNight: false,
    activity: {
      type: ACTIVITY_PLAYING,
      name: "Roblox",
      applicationId: BLOXSTRAP_APP_ID,
      details: "🍕Work at a Pizza Place",
      state: "by Dued1 ☑️",
      assets: {
        large_image: BLOXSTRAP_ROBLOX_ASSET,
        large_text: "🍕Work at a Pizza Place",
        small_image: BLOXSTRAP_ROBLOX_ASSET,
        small_text: "Roblox",
      },
      externalLargeImageUrl:
        "https://tr.rbxcdn.com/180DAY-ae06e2703a3f516a9946173e656912c0/512/512/Image/Png/noFilter",
    },
  },
  {
    kind: "csp",
    status: "online",
    lateNight: false,
    activity: {
      type: ACTIVITY_PLAYING,
      name: "CLIP STUDIO PAINT",
      applicationId: CSP_APP_ID,
      details: "sketch_02.clip",
      state: "CLIP STUDIO PAINT EX",
    },
  },
  {
    kind: "native-game",
    status: "online",
    lateNight: true,
    activity: {
      type: ACTIVITY_PLAYING,
      name: "Stardew Valley",
      applicationId: STARDEW_APP_ID,
    },
  },
  {
    kind: "native-game",
    status: "online",
    lateNight: false,
    activity: {
      type: ACTIVITY_PLAYING,
      name: "Minecraft",
      applicationId: MINECRAFT_APP_ID,
    },
  },
];

export interface PickedPresence {
  index: number;
  preset: AmbientPresencePreset;
}

/** Picks an ambient preset biased by local time (UTC+7), never repeating `previousIndex`. */
export function pickAmbientPresence(
  nowMs: number,
  previousIndex: number | null = null,
  random: () => number = Math.random,
  tzOffsetHours = 7,
): PickedPresence {
  const localHour = new Date(nowMs + tzOffsetHours * 3_600_000).getUTCHours();
  const isLateNight = localHour >= 23 || localHour < 6;

  let candidates = AMBIENT_PRESENCE_PRESETS.map((preset, index) => ({ preset, index })).filter(
    (item) => item.index !== previousIndex,
  );
  if (isLateNight) {
    const cozy = candidates.filter((c) => c.preset.lateNight);
    if (cozy.length > 0 && random() < 0.75) candidates = cozy;
  }
  const pick = candidates[Math.floor(random() * candidates.length) % candidates.length]!;
  return pick;
}

export interface PresenceClientLike {
  token?: string | null;
  api?: unknown;
  presence?: { userId?: string | null } | null;
  user: {
    id?: string;
    setPresence(data: {
      status: AmbientStatus;
      activities: Array<Record<string, unknown>>;
    }): unknown;
  } | null;
}

export interface AmbientPresenceSnapshot {
  status: AmbientStatus;
  activityType: 0 | 2 | 3 | 4 | null;
  activityName: string | null;
  details: string | null;
  state: string | null;
  startedAt: number;
  idleNote?: string | null;
}

export const AMBIENT_PRESENCE_CONTRIBUTOR = "discord_presence";

/** Prompt contributor exposing Aiko's current live Discord presence/activity. */
export function ambientPresenceContributor(
  getCurrent: () => AmbientPresenceSnapshot | null,
  now: () => number = () => Date.now(),
): PromptContributor {
  return {
    key: AMBIENT_PRESENCE_CONTRIBUTOR,
    contribute: async (_request: PromptRequest): Promise<PromptSection[]> => {
      const snap = getCurrent();
      if (snap === null) return [];
      let body: string;
      if (snap.activityName !== null) {
        const verb =
          snap.activityType === ACTIVITY_LISTENING
            ? "Listening to"
            : snap.activityType === ACTIVITY_WATCHING
              ? "Watching"
              : "Playing";
        const extra = [snap.details, snap.state].filter(Boolean).join(" — ");
        const minsAgo = Math.max(0, Math.round((now() - snap.startedAt) / 60_000));
        body =
          `Your live Discord profile currently shows: ${verb} ${snap.activityName}` +
          `${extra ? ` (${extra})` : ""} (status: ${snap.status}, started ${minsAgo}m ago). ` +
          `Background context only: ONLY mention this if someone directly asks what you're doing or playing (never deny it); do NOT bring it up unprompted or repeat it in normal chat.`;
      } else {
        const activityNote = snap.idleNote ? `currently ${snap.idleNote}` : "just hanging out";
        body =
          `Your live Discord profile currently shows: ${snap.status}, not playing any game or music right now (${activityNote}). ` +
          `Background context only: only mention if someone asks what you're up to, never repeat it across turns.`;
      }
      return [
        {
          key: AMBIENT_PRESENCE_CONTRIBUTOR,
          title: "Your Current Discord Status & Activity",
          body,
          order: 4,
        },
      ];
    },
  };
}

export interface AmbientPresenceLoopOptions {
  client: PresenceClientLike;
  isReady: () => boolean;
  config: AmbientPresenceConfig;
  /** True for user accounts (passes application_id, assets, timestamps); false keeps bot-safe fields. */
  rich: boolean;
  signal: AbortSignal;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onUpdate?: (snapshot: AmbientPresenceSnapshot) => void;
}

export interface FormatPresenceOptions {
  rich: boolean;
  nowMs: number;
  sessionStartMs?: number;
  trackIndex?: number;
  osuIndex?: number;
  resolvedLargeImage?: string;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function pickDifferentIndex(length: number, prev: number | null, random: () => number): number {
  if (length <= 1) return 0;
  let idx = Math.floor(random() * length) % length;
  if (idx === prev) idx = (idx + 1) % length;
  return idx;
}

// discord.js-selfbot-v13 initializes ClientPresence with userId=null; syncing it to client.user.id
// ensures _patch builds RichPresence (serializing snake_case application_id + assets) rather than Activity.
function syncPresenceUserId(client: PresenceClientLike): void {
  if (client.presence && client.user?.id && client.presence.userId !== client.user.id) {
    client.presence.userId = client.user.id;
  }
}

export function formatPresencePayload(
  preset: AmbientPresencePreset,
  options: FormatPresenceOptions,
): { status: AmbientStatus; activities: Array<Record<string, unknown>> } {
  const {
    rich,
    nowMs,
    sessionStartMs = nowMs,
    trackIndex = 0,
    osuIndex = 0,
    resolvedLargeImage,
  } = options;

  if (preset.activity === null) {
    return { status: preset.status, activities: [] };
  }

  if (!rich) {
    return {
      status: preset.status,
      activities: [{ type: preset.activity.type, name: preset.activity.name }],
    };
  }

  if (preset.kind === "youtube-music" || preset.kind === "spotify") {
    const track =
      MUSIC_TRACKS[
        ((trackIndex % MUSIC_TRACKS.length) + MUSIC_TRACKS.length) % MUSIC_TRACKS.length
      ]!;
    const isSpotify = preset.kind === "spotify";
    return {
      status: preset.status,
      activities: [
        {
          type: ACTIVITY_LISTENING,
          name: isSpotify ? "Spotify" : "YouTube Music",
          ...(isSpotify ? {} : { application_id: YOUTUBE_MUSIC_APP_ID }),
          details: track.title,
          state: track.artist,
          timestamps: { start: nowMs, end: nowMs + track.durationMs },
          ...(isSpotify
            ? {}
            : {
                assets: {
                  large_image: YOUTUBE_MUSIC_LOGO_ASSET,
                  large_text: "YouTube Music",
                  small_image: YOUTUBE_MUSIC_PLAY_ASSET,
                  small_text: "Playing",
                },
              }),
        },
      ],
    };
  }

  if (preset.kind === "osu") {
    const map = OSU_MAPS[((osuIndex % OSU_MAPS.length) + OSU_MAPS.length) % OSU_MAPS.length]!;
    return {
      status: preset.status,
      activities: [
        {
          type: ACTIVITY_PLAYING,
          name: "osu!",
          application_id: OSU_LAZER_APP_ID,
          ...(map.details ? { details: map.details } : {}),
          state: map.state,
          timestamps: { start: sessionStartMs },
          assets: {
            large_image: OSU_LOGO_LAZER_ASSET,
            large_text: "aikodayoo (rank #148,291)",
            small_image: map.modeAsset,
            small_text: map.modeText,
          },
        },
      ],
    };
  }

  const { type, name, applicationId, details, state, assets } = preset.activity;
  const resolvedAssets = assets
    ? {
        ...assets,
        ...(resolvedLargeImage ? { large_image: resolvedLargeImage } : {}),
      }
    : undefined;

  return {
    status: preset.status,
    activities: [
      {
        type,
        name,
        ...(applicationId ? { application_id: applicationId } : {}),
        ...(details ? { details } : {}),
        ...(state ? { state } : {}),
        ...(resolvedAssets ? { assets: resolvedAssets } : {}),
        timestamps: { start: sessionStartMs },
      },
    ],
  };
}

async function resolveExternalAsset(
  client: PresenceClientLike,
  applicationId: string | undefined,
  url: string | undefined,
  cache: Map<string, string>,
): Promise<string | undefined> {
  if (!applicationId || !url) return undefined;
  const cached = cache.get(url);
  if (cached !== undefined) return cached;
  if (!client.token || !client.api) return undefined;
  try {
    const res = await RichPresence.getExternal(client as never, applicationId, url);
    const ext = res?.[0]?.external_asset_path;
    if (!ext) return undefined;
    const formatted = ext.startsWith("mp:") ? ext : `mp:${ext}`;
    cache.set(url, formatted);
    return formatted;
  } catch (error) {
    log.debug(
      { url, error: errorMessage(error) },
      "could not resolve external RPC image, using fallback asset",
    );
    return undefined;
  }
}

export async function runAmbientPresenceLoop(options: AmbientPresenceLoopOptions): Promise<void> {
  const {
    client,
    isReady,
    config,
    rich,
    signal,
    now = () => Date.now(),
    random = Math.random,
    sleep = abortableSleep,
    onUpdate,
  } = options;
  if (!config.enabled) return;

  while (!signal.aborted && (!isReady() || client.user === null)) {
    await sleep(1_000, signal);
  }

  let prevIndex: number | null = null;
  let prevTrack: number | null = null;
  let prevOsu: number | null = null;
  const externalCache = new Map<string, string>();
  const minMins = Math.max(1, config.min_interval_mins);
  const maxMins = Math.max(minMins, config.max_interval_mins);

  while (!signal.aborted) {
    const sessionStartMs = now();
    const { index, preset } = pickAmbientPresence(sessionStartMs, prevIndex, random);
    prevIndex = index;

    const mins = minMins + random() * (maxMins - minMins);
    const sessionDurationMs = Math.round(mins * 60_000);
    const sessionEndMs = sessionStartMs + sessionDurationMs;

    if (rich && (preset.kind === "youtube-music" || preset.kind === "spotify")) {
      const serviceName = preset.kind === "spotify" ? "Spotify" : "YouTube Music";
      let remaining = sessionDurationMs;
      while (!signal.aborted && remaining > 0) {
        const ts = now();
        const trackIndex = pickDifferentIndex(MUSIC_TRACKS.length, prevTrack, random);
        prevTrack = trackIndex;
        const track = MUSIC_TRACKS[trackIndex]!;
        if (isReady() && client.user !== null) {
          try {
            syncPresenceUserId(client);
            const payload = formatPresencePayload(preset, {
              rich: true,
              nowMs: ts,
              sessionStartMs,
              trackIndex,
            });
            await Promise.resolve(client.user.setPresence(payload));
            onUpdate?.({
              status: preset.status,
              activityType: ACTIVITY_LISTENING,
              activityName: serviceName,
              details: track.title,
              state: track.artist,
              startedAt: ts,
            });
            log.info(
              {
                status: preset.status,
                activity: serviceName,
                details: track.title,
                state: track.artist,
                rich,
              },
              "updated ambient discord presence",
            );
          } catch (error) {
            log.warn(
              { error: errorMessage(error), activity: serviceName },
              "failed to update ambient discord presence",
            );
          }
        }
        const waitMs = Math.min(track.durationMs, remaining);
        await sleep(waitMs, signal);
        remaining = sessionEndMs - now();
      }
      continue;
    }

    if (rich && preset.kind === "osu") {
      let remaining = sessionDurationMs;
      while (!signal.aborted && remaining > 0) {
        const ts = now();
        const osuIndex = pickDifferentIndex(OSU_MAPS.length, prevOsu, random);
        prevOsu = osuIndex;
        const map = OSU_MAPS[osuIndex]!;
        if (isReady() && client.user !== null) {
          try {
            syncPresenceUserId(client);
            const payload = formatPresencePayload(preset, {
              rich: true,
              nowMs: ts,
              sessionStartMs,
              osuIndex,
            });
            await Promise.resolve(client.user.setPresence(payload));
            onUpdate?.({
              status: preset.status,
              activityType: ACTIVITY_PLAYING,
              activityName: "osu!",
              details: map.details ?? null,
              state: map.state,
              startedAt: sessionStartMs,
            });
            log.info(
              {
                status: preset.status,
                activity: "osu!",
                details: map.details ?? null,
                state: map.state,
                rich,
              },
              "updated ambient discord presence",
            );
          } catch (error) {
            log.warn(
              { error: errorMessage(error), activity: "osu!" },
              "failed to update ambient discord presence",
            );
          }
        }
        const mapStepMs = Math.round((2.5 + random() * 2.0) * 60_000);
        await sleep(Math.min(mapStepMs, remaining), signal);
        remaining = sessionEndMs - now();
      }
      continue;
    }

    if (isReady() && client.user !== null) {
      try {
        syncPresenceUserId(client);
        const resolvedLargeImage = rich
          ? await resolveExternalAsset(
              client,
              preset.activity?.applicationId,
              preset.activity?.externalLargeImageUrl,
              externalCache,
            )
          : undefined;
        const payload = formatPresencePayload(preset, {
          rich,
          nowMs: sessionStartMs,
          sessionStartMs,
          resolvedLargeImage,
        });
        await Promise.resolve(client.user.setPresence(payload));
        onUpdate?.({
          status: preset.status,
          activityType: preset.activity?.type ?? null,
          activityName: preset.activity?.name ?? null,
          details: rich ? (preset.activity?.details ?? null) : null,
          state: rich ? (preset.activity?.state ?? null) : null,
          startedAt: sessionStartMs,
          idleNote: preset.idleNote ?? null,
        });
        log.info(
          {
            status: preset.status,
            activity: preset.activity?.name ?? null,
            details: rich ? (preset.activity?.details ?? null) : null,
            state: rich ? (preset.activity?.state ?? null) : null,
            rich,
          },
          "updated ambient discord presence",
        );
      } catch (error) {
        log.warn(
          { error: errorMessage(error), activity: preset.activity?.name ?? null },
          "failed to update ambient discord presence",
        );
      }
    }

    await sleep(sessionDurationMs, signal);
  }
}
