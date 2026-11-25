// `SelfDiscordSink`: executes output actions through the user account's `discord.js-selfbot-v13` Client.
//
// No embeds and no Components V2 (user accounts cannot send Components V2; `ReplySink` methods
// format `CommandReply` into readable plain text with any attached files).

import type { CommandReply, ReplySink, SendCardOptions } from "@miyoria/commands";
import {
  type AccountRef,
  AttachmentError,
  type AttachmentFile,
  type ContextKey,
  contextKeyString,
  type MessageRef,
  type ModerationService,
  type OutgoingMessage,
  type PlatformId,
  type PlatformSink,
  type SentMessage,
  safeOutgoing,
} from "@miyoria/types";
import {
  type EmojiLimits,
  reactionEmoji,
  renderEmoji,
  uncodeEmoji,
} from "./emoji.js";
import { PLATFORM, snowflake } from "./mapping.js";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  type DiscordOutgoing,
  DiscordSendError,
  MAX_MESSAGE_FILES,
  type SinkAttachments,
  type SinkEmoji,
  type SinkStickers,
} from "./sink.js";
import {
  renderStickers,
  type ServerSticker,
  type StickerLimits,
} from "./stickers.js";
import { MAX_MESSAGE_LEN, splitMessage } from "./split.js";

const MAX_VOICE_STATUS = 500;
const ENTITY_TOO_LARGE = 40005;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const INVALID_STICKER = 50081;
const STICKER_REFUSED: ReadonlySet<number> = new Set([
  INVALID_STICKER,
  MISSING_PERMISSIONS,
  MISSING_ACCESS,
]);

export interface SelfSendFile {
  attachment: Buffer;
  name: string;
}

export interface SelfSendOptions {
  content?: string;
  allowedMentions?: { parse: string[]; roles: string[]; repliedUser: boolean };
  reply?: { messageReference: string; failIfNotExists: boolean };
  files?: SelfSendFile[];
  stickers?: string[];
  flags?: string[];
}

export interface SelfTextChannelLike {
  id: string;
  name?: string;
  send(options: SelfSendOptions): Promise<{ id: string }>;
  sendTyping?(): Promise<unknown>;
  messages?: {
    react?(messageId: string, emoji: string): Promise<unknown>;
    edit?(messageId: string, options: { content?: string; allowedMentions?: unknown }): Promise<unknown>;
  };
}

export interface SelfSinkClientLike {
  channels: {
    cache: { get(id: string): unknown };
    fetch(id: string): Promise<unknown>;
  };
  guilds?: {
    cache: { get(id: string): { name?: string } | undefined };
    fetch(id: string): Promise<{ name?: string } | null>;
  };
  users?: {
    createDM(userId: string): Promise<{ id: string }>;
  };
  api?: {
    channels(id: string): {
      "voice-status"?: { put(opts: { data: { status: string } }): Promise<unknown> };
    };
  };
}

function channelOf(context: ContextKey): string {
  if (context.platform !== PLATFORM) {
    throw new DiscordSendError(`context \`${contextKeyString(context)}\` is not a Discord context`);
  }
  return snowflake(context.channel, "channel");
}

function discordCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

function nameOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("name" in value)) return null;
  return typeof value.name === "string" && value.name.trim() !== "" ? value.name : null;
}

async function inContext<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new DiscordSendError(what, { cause: error });
  }
}

/** Converts a `CommandReply` into readable plain text for accounts that cannot use Components V2. */
export function plainTextOfReply(reply: CommandReply): string {
  if (reply.text.trim() !== "") return reply.text.trim();
  const card = reply.card;
  if (!card) return "";
  const lines: string[] = [];
  if (card.title) lines.push(`**${card.title}**`);
  for (const block of card.blocks) {
    switch (block.type) {
      case "text":
      case "muted":
      case "section":
        if (block.text.trim() !== "") lines.push(block.text.trim());
        break;
      case "separator":
        lines.push("---");
        break;
      default:
        break;
    }
  }
  return lines.join("\n").trim();
}

export class SelfDiscordSink implements PlatformSink, ReplySink {
  readonly platform: PlatformId = PLATFORM;
  readonly #client: SelfSinkClientLike;
  readonly #moderation: () => ModerationService | undefined;
  readonly #emoji: SinkEmoji | null;
  readonly #attachments: SinkAttachments | null;
  readonly #stickers: SinkStickers | null;

  constructor(
    client: SelfSinkClientLike,
    moderation: () => ModerationService | undefined = () => undefined,
    emoji: SinkEmoji | null = null,
    attachments: SinkAttachments | null = null,
    stickers: SinkStickers | null = null,
  ) {
    this.#client = client;
    this.#moderation = moderation;
    this.#emoji = emoji;
    this.#attachments = attachments;
    this.#stickers = stickers;
  }

  attachmentLimit(context: ContextKey): number | null {
    if (context.platform !== PLATFORM) return null;
    const attachments = this.#attachments;
    if (attachments === null || attachments.source() === undefined) return null;
    const max = attachments.maxBytes();
    return Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_UPLOAD_BYTES;
  }

  async #fetchChannel(channelId: string): Promise<SelfTextChannelLike> {
    const cached = this.#client.channels.cache.get(channelId);
    const ch = (cached ?? (await this.#client.channels.fetch(channelId))) as Partial<SelfTextChannelLike> | null;
    if (!ch || typeof ch.send !== "function") {
      throw new DiscordSendError(`channel ${channelId} is not sendable`);
    }
    return ch as SelfTextChannelLike;
  }

  async #resolve(
    context: ContextKey,
    message: OutgoingMessage,
    signal?: AbortSignal,
  ): Promise<AttachmentFile[]> {
    const wanted = message.attachments ?? [];
    if (wanted.length === 0) return [];
    const limit = this.attachmentLimit(context);
    const source = this.#attachments?.source();
    if (limit === null || source === undefined) {
      throw new AttachmentError("unavailable", "attachments cannot be sent from here");
    }
    if (wanted.length > MAX_MESSAGE_FILES) {
      throw new AttachmentError(
        "too_many",
        `a Discord message takes at most ${MAX_MESSAGE_FILES} files`,
      );
    }
    const files: AttachmentFile[] = [];
    let left = limit;
    for (const { artifact_id } of wanted) {
      const file = await source.open(artifact_id, context, { maxBytes: left, signal });
      if (file.data.length > left) {
        throw new AttachmentError(
          "too_large",
          `the files are over the ${limit} bytes one message can carry there`,
        );
      }
      left -= file.data.length;
      files.push(file);
    }
    return files;
  }

  #withEmoji(context: ContextKey, text: string): string {
    const emoji = this.#emoji;
    const limits: EmojiLimits = emoji?.limits() ?? {
      per_message: 1,
      window_messages: 3,
      max_in_window: 1,
    };
    if (emoji === null || context.scope === null || !emoji.enabled(context.scope)) {
      return uncodeEmoji(text);
    }
    const guild = context.scope;
    const rendered = renderEmoji(
      text,
      (name) => emoji.table.get(guild, name),
      emoji.usage.recent(context.channel),
      limits,
    );
    emoji.usage.record(context.channel, rendered.used);
    return rendered.text;
  }

  #withStickers(
    context: ContextKey,
    text: string,
  ): { text: string; sticker: ServerSticker | null } {
    const stickers = this.#stickers;
    const guild = context.scope;
    const on = stickers !== null && guild !== null && stickers.enabled(guild);
    const now = stickers?.now() ?? 0;
    const limits: StickerLimits = stickers?.limits() ?? {
      window_messages: 1,
      max_in_window: 0,
      per_hour: 0,
    };
    const rendered = renderStickers(
      text,
      on ? (name) => stickers.table.get(guild, name) : null,
      stickers?.usage.recent(context.channel) ?? [],
      on ? stickers.usage.sentInHour(context.channel, now) : 0,
      limits,
    );
    if (on) stickers.usage.record(context.channel, rendered.sticker?.id ?? null, now);
    return rendered;
  }

  async send(
    context: ContextKey,
    message: OutgoingMessage,
    signal?: AbortSignal,
  ): Promise<SentMessage> {
    const channelId = channelOf(context);
    const files = await this.#resolve(context, message, signal);
    const safe = safeOutgoing(this.#moderation(), { path: "reply", text: message.text, context });
    const { text, sticker } = this.#withStickers(context, safe.text);
    const chunks = splitMessage(this.#withEmoji(context, text), MAX_MESSAGE_LEN);
    if (chunks.length === 0 && (files.length > 0 || sticker !== null)) chunks.push("");
    if (chunks.length === 0) throw new DiscordSendError("cannot send an empty message");

    const channel = await inContext(`fetching channel ${contextKeyString(context)}`, () =>
      this.#fetchChannel(channelId),
    );
    const last = chunks.length - 1;
    let replyToId = message.reply_to ? snowflake(message.reply_to.id, "message") : null;
    const quiet = (message as DiscordOutgoing).proactive === true;
    let first: string | null = null;

    for (const [index, chunk] of chunks.entries()) {
      signal?.throwIfAborted();
      const upload = index === 0 ? files : [];
      const opts: SelfSendOptions = {
        ...(chunk === "" ? {} : { content: chunk }),
        allowedMentions: { parse: ["users"], roles: [], repliedUser: false },
        ...(quiet ? { flags: ["SUPPRESS_NOTIFICATIONS"] } : {}),
      };
      if (replyToId !== null) {
        opts.reply = { messageReference: replyToId, failIfNotExists: false };
        replyToId = null;
      }
      if (upload.length > 0) {
        opts.files = upload.map((f) => ({
          attachment: Buffer.from(f.data),
          name: f.filename,
        }));
      }
      if (sticker !== null && index === last) {
        opts.stickers = [sticker.id];
      }

      const sent = await inContext(`sending message to ${contextKeyString(context)}`, async () => {
        try {
          try {
            return await channel.send(opts);
          } catch (error) {
            const refused = STICKER_REFUSED.has(discordCode(error) ?? 0);
            if (opts.stickers === undefined || !refused) throw error;
            const retry: SelfSendOptions = { ...opts };
            delete retry.stickers;
            if (chunk === "" && upload.length === 0) throw error;
            return await channel.send(retry);
          }
        } catch (error) {
          const code = discordCode(error);
          if (upload.length === 0) throw error;
          if (code === ENTITY_TOO_LARGE) {
            throw new AttachmentError("too_large", "Discord says the upload is too large", {
              cause: error,
            });
          }
          if (code === MISSING_PERMISSIONS || code === MISSING_ACCESS) {
            throw new AttachmentError("platform", "she may not attach files in that channel", {
              cause: error,
            });
          }
          throw error;
        }
      });
      first ??= sent.id;
    }

    const id = first as string;
    return safe.blocked === null ? { context, id } : { context, id, blocked: safe.blocked };
  }

  async react(message: MessageRef, emoji: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const channelId = channelOf(message.context);
    const id = snowflake(message.id, "message");
    const guild = message.context.scope;
    const table = this.#emoji?.table ?? null;
    const resolved = reactionEmoji(emoji, (name) =>
      table !== null && guild !== null ? table.get(guild, name) : undefined,
    );
    await inContext(
      `reacting to message ${message.id} in ${contextKeyString(message.context)}`,
      async () => {
        const channel = await this.#fetchChannel(channelId);
        if (typeof channel.messages?.react !== "function") {
          throw new DiscordSendError("channel messages cannot react");
        }
        await channel.messages.react(id, resolved);
      },
    );
  }

  async setVoiceStatus(context: ContextKey, status: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const channelId = channelOf(context);
    const put = this.#client.api?.channels(channelId)["voice-status"]?.put;
    if (!put) return;
    const safe = safeOutgoing(this.#moderation(), { path: "aside", text: status, context });
    const text = [...safe.text.trim()].slice(0, MAX_VOICE_STATUS).join("");
    await inContext(`setting the voice status of ${contextKeyString(context)}`, () =>
      put({ data: { status: text } }),
    );
  }

  async typing(context: ContextKey, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const channelId = channelOf(context);
    await inContext(`typing in ${contextKeyString(context)}`, async () => {
      const channel = await this.#fetchChannel(channelId);
      await channel.sendTyping?.();
    });
  }

  mention(account: AccountRef): string | null {
    return account.platform === PLATFORM && /^[0-9]{1,20}$/.test(account.id)
      ? `<@${account.id}>`
      : null;
  }

  async openDm(account: AccountRef, signal?: AbortSignal): Promise<ContextKey> {
    signal?.throwIfAborted();
    if (account.platform !== PLATFORM) {
      throw new DiscordSendError(`account \`${account.platform}:${account.id}\` is not on Discord`);
    }
    const recipient = snowflake(account.id, "user");
    const createDM = this.#client.users?.createDM;
    if (!createDM) throw new DiscordSendError("client cannot open DMs");
    const dm = await inContext(`opening a DM with ${recipient}`, () => createDM(recipient));
    return { platform: PLATFORM, scope: null, channel: dm.id, kind: "dm" };
  }

  async sendDirect(
    account: AccountRef,
    reply: CommandReply,
    signal?: AbortSignal,
  ): Promise<MessageRef> {
    const context = await this.openDm(account, signal);
    return this.sendCard(context, reply, signal);
  }

  async sendCard(
    context: ContextKey,
    reply: CommandReply,
    signal?: AbortSignal,
    options?: SendCardOptions,
  ): Promise<MessageRef> {
    signal?.throwIfAborted();
    const channelId = channelOf(context);
    const channel = await inContext(`fetching channel ${contextKeyString(context)}`, () =>
      this.#fetchChannel(channelId),
    );
    const plain = plainTextOfReply(reply);
    const chunks = splitMessage(plain, MAX_MESSAGE_LEN);
    const files: SelfSendFile[] = (reply.files ?? []).map((f) => ({
      name: f.name,
      attachment: typeof f.data === "string" ? Buffer.from(f.data) : Buffer.from(f.data),
    }));
    if (chunks.length === 0 && files.length > 0) chunks.push("");
    if (chunks.length === 0) throw new DiscordSendError("cannot send an empty reply");

    const to = options?.replyTo ?? null;
    let replyToId =
      to !== null &&
      to.context.platform === PLATFORM &&
      to.context.kind !== "voice" &&
      to.context.channel === channelId &&
      /^[0-9]{1,20}$/.test(to.id)
        ? to.id
        : null;

    let first: string | null = null;
    for (const [index, chunk] of chunks.entries()) {
      const upload = index === 0 ? files : [];
      const opts: SelfSendOptions = {
        ...(chunk === "" ? {} : { content: chunk }),
        allowedMentions: { parse: [], roles: [], repliedUser: false },
        ...(replyToId ? { reply: { messageReference: replyToId, failIfNotExists: false } } : {}),
        ...(upload.length > 0 ? { files: upload } : {}),
      };
      replyToId = null;
      const sent = await inContext(`sending reply to ${contextKeyString(context)}`, () =>
        channel.send(opts),
      );
      first ??= sent.id;
    }
    return { context, id: first as string };
  }

  async editCard(message: MessageRef, reply: CommandReply, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const channelId = channelOf(message.context);
    const channel = await this.#fetchChannel(channelId);
    const edit = channel.messages?.edit;
    if (!edit) return;
    const plain = plainTextOfReply(reply);
    if (plain === "") return;
    await inContext(`editing reply in ${contextKeyString(message.context)}`, () =>
      edit(snowflake(message.id, "message"), {
        content: splitMessage(plain, MAX_MESSAGE_LEN)[0] ?? plain,
        allowedMentions: { parse: [], roles: [], repliedUser: false },
      }),
    );
  }

  async describe(context: ContextKey, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    if (context.platform !== PLATFORM) return null;
    try {
      const chId = snowflake(context.channel, "channel");
      const ch =
        this.#client.channels.cache.get(chId) ?? (await this.#client.channels.fetch(chId));
      const channelName = nameOf(ch);
      if (context.scope === null || !this.#client.guilds) return channelName;
      const gId = snowflake(context.scope, "guild");
      const guild =
        this.#client.guilds.cache.get(gId) ?? (await this.#client.guilds.fetch(gId));
      const guildName = nameOf(guild);
      if (guildName === null) return channelName;
      return channelName === null ? guildName : `${guildName} / ${channelName}`;
    } catch {
      return null;
    }
  }
}
