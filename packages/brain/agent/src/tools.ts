// Built-in tools. The interface lives in `@miyoria/llm/tools`.

import {
  type Tool,
  type ToolContext,
  type ToolMeta,
  type ToolSpec,
  toolParameters,
} from "@miyoria/llm/tools";
import type { ModuleContext } from "@miyoria/runtime/kernel";
import { ArtifactStoreKey } from "@miyoria/store";
import {
  ActionSinkKey,
  contextKeyString,
  isJsonObject,
  type JsonValue,
  MouthKey,
  newAction,
  PlatformSinksKey,
  textLane,
} from "@miyoria/types";
import { z } from "zod";
import { DEFAULT_NOTE_MINUTES, MAX_NOTE_MINUTES, MAX_NOTES, type WorkingNotes } from "./notes.js";
import { charCount } from "./util.js";

/** Longest emoji (or custom emoji reference such as `name:123`) `react` accepts. */
const MAX_EMOJI_LEN = 64;

export class ToolArgumentError extends Error {
  override readonly name = "ToolArgumentError";
}

/** Reactions one `react` call may add (Discord itself allows many per message). */
export const MAX_REACTIONS = 5;

const ReactParams = z.object({
  emoji: z.string().describe("一個 emoji,例如 👍、😤、🐋;伺服器表情寫 :名字:").optional(),
  emojis: z
    .array(z.string())
    .describe(`要一起按的幾個 emoji(最多 ${MAX_REACTIONS} 個),按順序加上去`)
    .optional(),
});

/** Built-in `react`: adds emoji reactions to the triggering message. */
export class ReactTool implements Tool {
  static readonly NAME = "react";

  readonly spec: ToolSpec = {
    name: ReactTool.NAME,
    description:
      "對觸發這次對話的那則訊息加上 emoji 反應。只想表達情緒、不需要多說話時可以只按反應然後輸出 <silence/>。" +
      `Discord 一則訊息可以按很多個不同的反應:想按好幾個就用 emojis 列出來(最多 ${MAX_REACTIONS} 個)。`,
    parameters: toolParameters(ReactParams),
  };
  readonly parameters = ReactParams;
  readonly meta: ToolMeta = {
    effect: "say",
    speed: "instant",
    risk: "low",
    group: "chat",
    core: true,
  };

  readonly #ctx: ModuleContext;

  constructor(ctx: ModuleContext) {
    this.#ctx = ctx;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const single = isJsonObject(args) ? args.emoji : undefined;
    const many = isJsonObject(args) ? args.emojis : undefined;
    const raw: (JsonValue | undefined)[] = [single, ...(Array.isArray(many) ? many : [])];
    const emoji: string[] = [];
    for (const item of raw) {
      if (item === undefined || item === null) continue;
      const one = typeof item === "string" ? item.trim() : "";
      if (one === "" || charCount(one) > MAX_EMOJI_LEN) {
        throw new ToolArgumentError("each `emoji` must be a single emoji");
      }
      if (!emoji.includes(one)) emoji.push(one);
    }
    if (emoji.length === 0) throw new ToolArgumentError("give an `emoji` (or `emojis`)");
    if (emoji.length > MAX_REACTIONS) {
      throw new ToolArgumentError(`at most ${MAX_REACTIONS} emoji in one call`);
    }
    // A turn nobody's message woke (a glance, a timer, the world, a result) carries a placeholder
    // message whose id is the turn's own: no platform message to react to. Said to her instead of
    // sent, where the platform would refuse the id ("invalid Discord message id").
    if (ctx.message.id === ctx.turn) {
      throw new ToolArgumentError(
        "there is no message to react to in this turn (nobody's message woke you); say it instead",
      );
    }
    const sink = this.#ctx.services.require(ActionSinkKey);
    for (const one of emoji) {
      const action = newAction(
        textLane(ctx.context),
        ctx.priority,
        { type: "react", message: ctx.message, emoji: one },
        { turn: ctx.turn },
      );
      await sink.submit(action);
    }
    return `reacted with ${emoji.join(" ")}`;
  }
}

const KeepNoteParams = z.object({
  text: z.string().describe("要記的內容"),
  minutes: z.int().describe(`留多久(1 到 ${MAX_NOTE_MINUTES} 分鐘,通常省略)`).optional(),
});

/** Built-in `keep_note`: something from this turn she wants to keep for the rest of the conversation. */
export class KeepNoteTool implements Tool {
  static readonly NAME = "keep_note";

  readonly spec: ToolSpec = {
    name: KeepNoteTool.NAME,
    description:
      "工具結果(搜尋、歌詞、網頁、計算)的全文下一回合就看不到了,最多剩幾行摘要。之後這段對話還會用到全文的," +
      "用你自己的話記下重點(最多 600 字,例如歌詞的那幾句、查到的數字),之後每一回合都看得到;" +
      `預設留 ${DEFAULT_NOTE_MINUTES} 分鐘,每段對話最多 ${MAX_NOTES} 則,多了最舊的會被擠掉。用不到就不要記。`,
    parameters: toolParameters(KeepNoteParams),
  };
  readonly parameters = KeepNoteParams;
  readonly meta: ToolMeta = {
    effect: "act",
    speed: "instant",
    risk: "low",
    group: "notes",
    core: true,
  };

  constructor(private readonly notes: WorkingNotes) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const text = isJsonObject(args) && typeof args.text === "string" ? args.text.trim() : "";
    if (text === "") throw new ToolArgumentError("`text` is empty");
    const minutes =
      isJsonObject(args) && typeof args.minutes === "number" ? args.minutes : undefined;
    const note = this.notes.keep(ctx.context, text, minutes);
    return `記下了 [${note.id}],接下來 ${note.minutes} 分鐘這段對話都看得到。`;
  }
}

const DropNoteParams = z.object({ id: z.string().describe("筆記代號") });

/** Built-in `drop_note`: a working note she no longer needs. */
export class DropNoteTool implements Tool {
  static readonly NAME = "drop_note";

  readonly spec: ToolSpec = {
    name: DropNoteTool.NAME,
    description: "丟掉一則你在這段對話記下、已經用不到的筆記(填方括號裡的代號,例如 n3)。",
    parameters: toolParameters(DropNoteParams),
  };
  readonly parameters = DropNoteParams;
  readonly meta: ToolMeta = { effect: "act", speed: "instant", risk: "low", group: "notes" };

  constructor(private readonly notes: WorkingNotes) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const id = isJsonObject(args) && typeof args.id === "string" ? args.id : "";
    return this.notes.drop(ctx.context, id) ? `丟掉了 ${id}。` : `沒有 ${id} 這則筆記。`;
  }
}

export const ANIME_GIF_REACTIONS = [
  "smile",
  "happy",
  "blush",
  "pout",
  "smug",
  "shrug",
  "yawn",
  "sleep",
  "bored",
  "stare",
  "wave",
  "poke",
  "confused",
  "wink",
  "sip",
  "think",
  "nod",
  "nope",
  "pat",
  "hug",
  "cry",
  "laugh",
  "shocked",
  "facepalm",
  "thumbsup",
  "teehee",
  "lurk",
  "nya",
] as const;

const GIF_COOLDOWN_MS = 35_000;
const GIF_HOUR_MS = 3_600_000;
const GIF_MAX_PER_HOUR = 18;
const GIF_MAX_BYTES = 8 * 1024 * 1024;

const AnimeGifParams = z.object({
  reaction: z
    .enum(ANIME_GIF_REACTIONS)
    .describe("動畫表情類別,挑最貼合當下情緒的一個"),
});

function isGifBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const h = String.fromCharCode(
    bytes[0] ?? 0,
    bytes[1] ?? 0,
    bytes[2] ?? 0,
    bytes[3] ?? 0,
    bytes[4] ?? 0,
    bytes[5] ?? 0,
  );
  return h === "GIF87a" || h === "GIF89a";
}

/** Sends a cute SFW anime reaction GIF from nekos.best into text chat. */
export class AnimeGifTool implements Tool {
  static readonly NAME = "anime_gif";

  readonly spec: ToolSpec = {
    name: AnimeGifTool.NAME,
    description:
      "在文字頻道只傳一張可愛的動畫反應 GIF 表達當下心情(不含文字,要說的話請另外直接打字;例如害羞 blush、得意 smug、打哈欠 yawn、鼓臉 pout、無奈 shrug)。偶爾情緒對了再用,不要每則都傳;語音頻道不用。",
    parameters: toolParameters(AnimeGifParams),
  };
  readonly parameters = AnimeGifParams;
  readonly meta: ToolMeta = {
    effect: "say",
    speed: "instant",
    risk: "low",
    group: "chat",
    core: true,
  };

  readonly #ctx: ModuleContext;
  readonly #fetch: typeof fetch;
  readonly #usage = new Map<string, number[]>();

  constructor(ctx: ModuleContext, fetchFn: typeof fetch = fetch) {
    this.#ctx = ctx;
    this.#fetch = fetchFn;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    if (ctx.context.kind === "voice") {
      return "語音頻道不用傳 GIF,直接用說的就好。";
    }
    const parsed = AnimeGifParams.safeParse(args);
    if (!parsed.success) {
      throw new ToolArgumentError("give a valid `reaction` from ANIME_GIF_REACTIONS");
    }
    const { reaction } = parsed.data;
    const now = this.#ctx.clock.now();
    const key = contextKeyString(ctx.context);
    const recent = (this.#usage.get(key) ?? []).filter((t) => now - t < GIF_HOUR_MS);
    const last = recent.at(-1);
    if ((last !== undefined && now - last < GIF_COOLDOWN_MS) || recent.length >= GIF_MAX_PER_HOUR) {
      return "剛才已經傳過 GIF 了,這次直接打字就好。";
    }

    const reqSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(6_000)]);
    const apiRes = await this.#fetch(`https://nekos.best/api/v2/${reaction}`, {
      headers: { "User-Agent": "Miyoria/1.0" },
      signal: reqSignal,
    });
    if (!apiRes.ok) {
      throw new Error(`anime_gif API returned HTTP ${apiRes.status}`);
    }
    const json = (await apiRes.json()) as { results?: Array<{ url?: string }> };
    const gifUrl = json.results?.[0]?.url ?? "";
    if (!gifUrl.startsWith("https://") || !gifUrl.toLowerCase().endsWith(".gif")) {
      throw new Error("anime_gif API returned no valid .gif url");
    }

    const store = this.#ctx.services.get(ArtifactStoreKey);
    const sink = this.#ctx.services.get(PlatformSinksKey)?.get(ctx.context.platform);
    if (store && sink && (sink.attachmentLimit?.(ctx.context) ?? null) !== null) {
      const imgRes = await this.#fetch(gifUrl, {
        headers: { "User-Agent": "Miyoria/1.0" },
        signal: reqSignal,
      });
      if (!imgRes.ok) {
        throw new Error(`anime_gif download returned HTTP ${imgRes.status}`);
      }
      const bytes = new Uint8Array(await imgRes.arrayBuffer());
      if (bytes.length === 0 || bytes.length > GIF_MAX_BYTES || !isGifBytes(bytes)) {
        throw new Error("downloaded anime_gif is invalid or too large");
      }
      const site = store.places.at(ctx.context, ctx.account);
      const artifact = await store.ingest(bytes, {
        source: "render",
        plugin: "agent",
        filename: `${reaction}.gif`,
        mime: "image/gif",
        place: site?.place ?? null,
        made_for: site?.person_id ?? null,
        turn: ctx.turn,
        signal: ctx.signal,
      });
      const replyTo = ctx.message.id === ctx.turn ? null : ctx.message;
      await sink.send(
        ctx.context,
        {
          text: "",
          reply_to: replyTo,
          attachments: [{ artifact_id: artifact.id }],
        },
        ctx.signal,
      );
    } else {
      const mouth = this.#ctx.services.get(MouthKey);
      if (!mouth) {
        throw new Error("cannot deliver anime_gif: no mouth or platform sink");
      }
      await mouth.say({
        context: ctx.context,
        text: gifUrl,
        turn: ctx.turn,
        source: "self",
      });
    }

    recent.push(now);
    this.#usage.set(key, recent);
    return `sent anime_gif (${reaction}) — GIF only (no text). Write your short reply now, or <silence/> if the GIF alone is enough.`;
  }
}

// ---- tenor_gif ---------------------------------------------------------------------------------

const TENOR_GIF_COOLDOWN_MS = 35_000;
const TENOR_GIF_HOUR_MS = 3_600_000;
const TENOR_GIF_MAX_PER_HOUR = 12;
const TENOR_GIF_MAX_BYTES = 8 * 1024 * 1024;

const TenorGifParams = z.object({
  query: z
    .string()
    .min(1)
    .max(150)
    .describe(
      "Short search term for the GIF mood or meme (e.g. 'that's crazy', 'michael scott no', 'lady gaga applause', 'mind blown'). Be specific — treat it like you're searching Tenor in Discord.",
    ),
});

/**
 * Sends a meme or viral reaction GIF via Discord's built-in GIF search API.
 * Uses DISCORD_BOT_TOKEN for authentication (no separate Tenor key required).
 */
export class TenorGifTool implements Tool {
  static readonly NAME = "tenor_gif";

  readonly spec: ToolSpec = {
    name: TenorGifTool.NAME,
    description:
      "在文字頻道搜尋並傳送一張迷因或網路熱門反應 GIF (透過 Discord 內建 GIF 搜尋)。用於適合迷因/搞笑/荒謬的時刻,而不是動漫反應表情。每次只傳一張,傳完就收。語音頻道不用。",
    parameters: toolParameters(TenorGifParams),
  };
  readonly parameters = TenorGifParams;
  readonly meta: ToolMeta = {
    effect: "say",
    speed: "instant",
    risk: "low",
    group: "chat",
    core: true,
  };

  readonly #ctx: ModuleContext;
  readonly #botToken: string;
  readonly #fetch: typeof fetch;
  readonly #usage = new Map<string, number[]>();

  constructor(ctx: ModuleContext, botToken: string, fetchFn: typeof fetch = fetch) {
    this.#ctx = ctx;
    this.#botToken = botToken;
    this.#fetch = fetchFn;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    if (ctx.context.kind === "voice") {
      return "語音頻道不用傳 GIF,直接用說的就好。";
    }
    const parsed = TenorGifParams.safeParse(args);
    if (!parsed.success) {
      throw new ToolArgumentError("give a valid `query` string");
    }
    const { query } = parsed.data;
    const now = this.#ctx.clock.now();
    const key = contextKeyString(ctx.context);
    const recent = (this.#usage.get(key) ?? []).filter((t) => now - t < TENOR_GIF_HOUR_MS);
    const last = recent.at(-1);
    if (
      (last !== undefined && now - last < TENOR_GIF_COOLDOWN_MS) ||
      recent.length >= TENOR_GIF_MAX_PER_HOUR
    ) {
      return "剛才已經傳過 GIF 了,這次直接打字就好。";
    }

    const reqSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(6_000)]);
    const url = new URL("https://discord.com/api/v10/gifs/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "20");
    url.searchParams.set("media_format", "gif");

    const apiRes = await this.#fetch(url.toString(), {
      headers: {
        Authorization: `Bot ${this.#botToken}`,
        "User-Agent": "DiscordBot (https://github.com/miyoria, 1.0)",
      },
      signal: reqSignal,
    });
    if (!apiRes.ok) {
      throw new Error(`discord gifs/search API returned HTTP ${apiRes.status}`);
    }
    type DiscordGifItem = {
      id?: string;
      title?: string;
      url?: string;
      src?: string;
    };
    const results = ((await apiRes.json()) as DiscordGifItem[]) ?? [];
    if (!Array.isArray(results) || results.length === 0) {
      return `找不到符合 "${query}" 的 GIF，這次直接打字就好。`;
    }
    // Pick a random one from the returned top results for variety.
    const pick = results[Math.floor(Math.random() * Math.min(results.length, 10))];
    const gifUrl = pick?.src || pick?.url || "";
    if (!gifUrl.startsWith("https://")) {
      throw new Error("discord gifs/search returned no valid gif url");
    }

    const store = this.#ctx.services.get(ArtifactStoreKey);
    const sink = this.#ctx.services.get(PlatformSinksKey)?.get(ctx.context.platform);
    if (store && sink && (sink.attachmentLimit?.(ctx.context) ?? null) !== null) {
      const imgRes = await this.#fetch(gifUrl, {
        headers: { "User-Agent": "Miyoria/1.0" },
        signal: reqSignal,
      });
      if (!imgRes.ok) {
        throw new Error(`tenor_gif download returned HTTP ${imgRes.status}`);
      }
      const bytes = new Uint8Array(await imgRes.arrayBuffer());
      if (bytes.length === 0 || bytes.length > TENOR_GIF_MAX_BYTES || !isGifBytes(bytes)) {
        throw new Error("downloaded tenor_gif is invalid or too large");
      }
      const site = store.places.at(ctx.context, ctx.account);
      const artifact = await store.ingest(bytes, {
        source: "render",
        plugin: "agent",
        filename: `gif-${query.slice(0, 32).replace(/\s+/g, "-")}.gif`,
        mime: "image/gif",
        place: site?.place ?? null,
        made_for: site?.person_id ?? null,
        turn: ctx.turn,
        signal: ctx.signal,
      });
      const replyTo = ctx.message.id === ctx.turn ? null : ctx.message;
      await sink.send(
        ctx.context,
        {
          text: "",
          reply_to: replyTo,
          attachments: [{ artifact_id: artifact.id }],
        },
        ctx.signal,
      );
    } else {
      const mouth = this.#ctx.services.get(MouthKey);
      if (!mouth) {
        throw new Error("cannot deliver tenor_gif: no mouth or platform sink");
      }
      await mouth.say({
        context: ctx.context,
        text: gifUrl,
        turn: ctx.turn,
        source: "self",
      });
    }

    recent.push(now);
    this.#usage.set(key, recent);
    return `sent tenor_gif ("${query}") — GIF only (no text). Write your short reply now, or <silence/> if the GIF alone is enough.`;
  }
}
