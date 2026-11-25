// Gateway event bridge for the Discord user-account chat adapter (`discord.js-selfbot-v13`).
// No interactions/slash commands and no voice connection management — text chat only.

import { ReplySinkKey, type UserResolver, UserResolverKey } from "@miyoria/commands";
import { errorMessage, getLogger, type ModuleContext } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  AttachmentSourceKey,
  Events as BusEvents,
  type ContextKind,
  ModerationKey,
  PlacesKey,
  type PlatformHistories,
  type PlatformSinks,
  PresencePrivacyKey,
  type QuotedMessage,
  type ReactionEvent,
  toTimestamp,
} from "@miyoria/types";
import { ActivityType } from "discord.js";
import { type EmojiLike, EmojiTable, EmojiUsage, serverEmoji } from "./emoji.js";
import {
  type Ambient,
  type AmbientPlaces,
  ambientChannel,
  ambientFor,
  type ChannelIds,
  messageAllowed,
  perGuild,
} from "./gate.js";
import {
  account,
  componentsText,
  contextKey,
  displayName,
  hasContent,
  incomingMessage,
  type MentionsLike,
  type MessageLike,
  mentionNames,
  PLATFORM,
  quotedMessage,
  type UserLike,
  type UserNames,
  unnamedUsers,
} from "./mapping.js";
import {
  type ActivityLike,
  type GuildMemberLike,
  memberUpdate,
  type PresenceLike,
  presenceUpdate,
  type VoiceStateLike,
  voiceStateUpdate,
} from "./presence.js";
import { DiscordUserResolver, type ResolverClientLike } from "./resolver.js";
import type { DiscordSelfConfig } from "./self-config.js";
import {
  findCachedMember,
  normalizeMessageLike,
  SelfDiscordHistory,
  type SelfFetchedLike,
  type SelfHistoryClientLike,
} from "./self-history.js";
import { SelfDiscordSink, type SelfSinkClientLike } from "./self-sink.js";
import {
  type ServerSticker,
  type StickerSourceLike,
  StickerTable,
  StickerUsage,
  serverSticker,
} from "./stickers.js";

const log = getLogger("discord.self");

const MAX_KIND_CACHE = 10_000;
const MAX_NAME_LOOKUPS = 5;

export interface SelfGuildLike {
  id: string;
  name?: string | null;
  available?: boolean;
  members: {
    fetch?(): Promise<unknown>;
    cache: {
      get?(id: string): GuildMemberLike | undefined;
      values(): Iterable<GuildMemberLike>;
    };
  };
  presences: { cache: { values(): Iterable<SelfPresenceLike> } };
  voiceStates: { cache: { values(): Iterable<VoiceStateLike> } };
  emojis?: { cache: { values(): Iterable<EmojiLike> } };
  stickers?: { cache: { values(): Iterable<StickerSourceLike> } };
}

export interface SelfPresenceLike extends Omit<PresenceLike, "activities"> {
  activities: readonly (Omit<ActivityLike, "type"> & { type: ActivityType | string | number })[];
}

export interface SelfMessageLike extends SelfFetchedLike {
  channel: {
    id: string;
    type: string | number;
    parentId?: string | null;
    messages?: { cache: { get(id: string): SelfFetchedLike | undefined } };
  };
  guild?: SelfGuildLike | null;
  fetchReference?(): Promise<SelfFetchedLike>;
}

export interface SelfTypingLike {
  channel: { id: string; type: string | number; parentId?: string | null };
  guild: { id: string } | null;
  user: { id: string };
}

export interface SelfReactionLike {
  emoji: { name: string | null; id: string | null };
  message: { id: string; channelId: string; guildId: string | null };
}

export interface SelfClientLike {
  user: { id: string; username: string } | null;
  guilds: {
    cache: { values(): Iterable<SelfGuildLike>; get(id: string): SelfGuildLike | undefined };
  };
  channels: {
    cache: { get(id: string): { type?: string | number } | undefined };
    fetch(id: string): Promise<{ type?: string | number } | null>;
  };
  users: { cache: { get(id: string): UserLike | undefined } };
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export function selfKindOf(type: string | number | undefined): ContextKind {
  switch (type) {
    case "GUILD_PUBLIC_THREAD":
    case "GUILD_PRIVATE_THREAD":
    case "GUILD_NEWS_THREAD":
    case 10:
    case 11:
    case 12:
      return "thread";
    case "DM":
    case "GROUP_DM":
    case 1:
    case 3:
      return "dm";
    default:
      return "channel";
  }
}

export function selfActivityType(type: ActivityType | string | number): ActivityType {
  if (typeof type === "number") return type;
  switch (type) {
    case "PLAYING":
      return ActivityType.Playing;
    case "STREAMING":
      return ActivityType.Streaming;
    case "LISTENING":
      return ActivityType.Listening;
    case "WATCHING":
      return ActivityType.Watching;
    case "CUSTOM":
      return ActivityType.Custom;
    case "COMPETING":
      return ActivityType.Competing;
    default:
      return ActivityType.Playing;
  }
}

export class SelfShared {
  readonly selfIds: Set<string>;
  ready = false;
  sink: SelfDiscordSink | null = null;
  history: SelfDiscordHistory | null = null;
  readonly #kinds = new Map<string, ContextKind>();
  readonly emoji = new EmojiTable();
  readonly emojiUsage = new EmojiUsage();
  readonly stickers = new StickerTable();
  readonly stickerUsage = new StickerUsage();

  constructor(
    readonly config: DiscordSelfConfig,
    selfIds: Iterable<string>,
    readonly sinks: PlatformSinks | null,
    readonly histories: PlatformHistories | null = null,
    readonly places: AmbientPlaces | null = null,
  ) {
    this.selfIds = new Set(selfIds);
  }

  ambient(guild: string, ids: ChannelIds): Ambient {
    try {
      return ambientFor(this.config as never, this.places, guild, ids);
    } catch (error) {
      log.warn(
        { guild, error: errorMessage(error) },
        "cannot read the server's gate; it stays closed",
      );
      return { ambient_text: "allowlist", ambient_channels: [], ambient_follow: null };
    }
  }

  kind(channel: string): ContextKind | undefined {
    return this.#kinds.get(channel);
  }

  rememberKind(channel: string, kind: ContextKind): void {
    if (this.#kinds.size >= MAX_KIND_CACHE) this.#kinds.clear();
    this.#kinds.set(channel, kind);
  }
}

export class SelfGatewayBridge {
  constructor(
    private readonly ctx: ModuleContext,
    private readonly shared: SelfShared,
  ) {}

  attach(client: SelfClientLike): void {
    client.on("ready", (() => this.guard("ready", () => this.onReady(client))) as never);
    client.on("messageCreate", ((msg: SelfMessageLike) =>
      this.guard("message", () => this.onMessage(client, msg))) as never);
    client.on("typingStart", ((typing: SelfTypingLike) =>
      this.guard("typing", () => this.onTyping(client, typing))) as never);
    client.on("messageReactionAdd", ((
      reaction: SelfReactionLike,
      user: {
        id: string;
        bot?: boolean | null;
        username?: string | null;
        globalName?: string | null;
      },
    ) => this.guard("reaction", () => this.onReaction(client, reaction, user, true))) as never);
    client.on("messageReactionRemove", ((
      reaction: SelfReactionLike,
      user: {
        id: string;
        bot?: boolean | null;
        username?: string | null;
        globalName?: string | null;
      },
    ) => this.guard("reaction", () => this.onReaction(client, reaction, user, false))) as never);
    client.on("threadCreate", ((thread: { id: string; type: string | number }) => {
      this.shared.rememberKind(thread.id, selfKindOf(thread.type));
    }) as never);
    client.on("presenceUpdate", ((_old: unknown, presence: SelfPresenceLike) =>
      this.guard("presence", () => this.onPresence(presence, false))) as never);
    client.on("voiceStateUpdate", ((oldState: VoiceStateLike, newState: VoiceStateLike) =>
      this.guard("voice state", () => this.onVoiceState(newState, false, oldState))) as never);
    client.on("guildMemberAdd", ((member: GuildMemberLike) =>
      this.guard("member", () => this.onMember(member, false))) as never);
    client.on("guildMemberUpdate", ((_old: unknown, member: GuildMemberLike) =>
      this.guard("member", () => this.onMember(member, false))) as never);
    client.on("guildMemberRemove", ((member: GuildMemberLike) =>
      this.guard("member", () => this.onMember(member, true))) as never);
    client.on("guildCreate", ((guild: SelfGuildLike) =>
      this.guard("guild snapshot", () => this.snapshotGuild(guild))) as never);
    client.on("guildDelete", ((guild: SelfGuildLike) => this.left(guild)) as never);
    client.on("emojiCreate", ((emoji: EmojiLike & { guild: { id: string } }) =>
      this.onEmoji(emoji.guild.id, emoji, false)) as never);
    client.on("emojiUpdate", ((_old: unknown, emoji: EmojiLike & { guild: { id: string } }) =>
      this.onEmoji(emoji.guild.id, emoji, false)) as never);
    client.on("emojiDelete", ((emoji: EmojiLike & { guild: { id: string } }) =>
      this.onEmoji(emoji.guild.id, emoji, true)) as never);
    client.on("stickerCreate", ((sticker: StickerSourceLike & { guildId?: string | null }) =>
      this.onSticker(sticker.guildId ?? null, sticker, false)) as never);
    client.on("stickerUpdate", ((
      _old: unknown,
      sticker: StickerSourceLike & { guildId?: string | null },
    ) => this.onSticker(sticker.guildId ?? null, sticker, false)) as never);
    client.on("stickerDelete", ((sticker: StickerSourceLike & { guildId?: string | null }) =>
      this.onSticker(sticker.guildId ?? null, sticker, true)) as never);
  }

  private guard(what: string, body: () => void | Promise<void>): void {
    void Promise.resolve()
      .then(body)
      .catch((error: unknown) => {
        log.warn({ handler: what, error: errorMessage(error) }, "self gateway handler failed");
      });
  }

  onSticker(guild: string | null, sticker: StickerSourceLike, removed: boolean): void {
    if (guild === null) return;
    if (removed) {
      if (sticker.id) this.shared.stickers.remove(guild, sticker.id);
      return;
    }
    const s = serverSticker(sticker);
    if (s) this.shared.stickers.upsert(guild, s);
  }

  onEmoji(guild: string, emoji: EmojiLike, removed: boolean): void {
    if (removed) {
      if (emoji.id) this.shared.emoji.remove(guild, emoji.id);
      return;
    }
    const e = serverEmoji(emoji);
    if (e) this.shared.emoji.upsert(guild, e);
  }

  left(guild: SelfGuildLike): void {
    this.shared.emoji.dropGuild(guild.id);
    this.shared.stickers.dropGuild(guild.id);
    if (guild.available === false) return;
    try {
      this.ctx.services.get(PlacesKey)?.left(PLATFORM, guild.id);
    } catch (error) {
      log.warn({ guild: guild.id, error: errorMessage(error) }, "cannot record a server she left");
    }
  }

  seen(guild: SelfGuildLike): void {
    try {
      this.ctx.services.get(PlacesKey)?.seen(PLATFORM, guild.id, guild.name ?? null);
    } catch (error) {
      log.warn({ guild: guild.id, error: errorMessage(error) }, "cannot record a server she is in");
    }
  }

  async snapshotGuild(guild: SelfGuildLike): Promise<void> {
    this.seen(guild);
    if (guild.emojis) {
      const list = [...guild.emojis.cache.values()].map(serverEmoji).filter((e) => e !== null);
      this.shared.emoji.setGuild(guild.id, list);
    }
    if (guild.stickers) {
      const list = [...guild.stickers.cache.values()]
        .map(serverSticker)
        .filter((s): s is ServerSticker => s !== null);
      this.shared.stickers.setGuild(guild.id, list);
    }
    if (this.shared.config.presence_intents) {
      for (const member of guild.members.cache.values()) this.onMember(member, false);
      for (const presence of guild.presences.cache.values()) this.onPresence(presence, true);
    }
    for (const state of guild.voiceStates.cache.values()) this.onVoiceState(state, true);
  }

  presenceAllowed(who: AccountRef): boolean {
    if (this.shared.selfIds.has(who.id)) return false;
    return this.ctx.services.get(PresencePrivacyKey)?.presenceAllowed(who) ?? false;
  }

  onPresence(presence: SelfPresenceLike, initial: boolean): void {
    const mapped: PresenceLike = {
      userId: presence.userId,
      guild: presence.guild,
      status: presence.status,
      user: presence.user ?? null,
      member: presence.member ?? null,
      activities: presence.activities.map((a) => ({
        name: a.name,
        type: selfActivityType(a.type),
        details: a.details ?? null,
        state: a.state ?? null,
        url: a.url ?? null,
        timestamps: a.timestamps ?? null,
        emoji: a.emoji ?? null,
      })),
    };
    const update = presenceUpdate(mapped, initial);
    if (update === null || !this.presenceAllowed(update.account)) return;
    this.ctx.publish(BusEvents.PlatformPresence, update);
  }

  async onReaction(
    client: SelfClientLike,
    reaction: SelfReactionLike,
    user: {
      id: string;
      bot?: boolean | null;
      username?: string | null;
      globalName?: string | null;
    },
    added: boolean,
  ): Promise<void> {
    if (this.shared.selfIds.has(user.id) || user.bot) return;
    const message = reaction.message;
    const emoji = reaction.emoji.name ?? reaction.emoji.id ?? "";
    if (emoji === "") return;
    const guild = message.guildId ? client.guilds.cache.get(message.guildId) : undefined;
    const member = findCachedMember(guild, user.id);
    const kind = await this.channelKind(client, message.guildId ?? null, message.channelId);
    const event: ReactionEvent = {
      message: {
        context: contextKey(message.guildId ?? null, message.channelId, kind),
        id: message.id,
      },
      account: account(user.id),
      display_name: member?.nickname?.trim() || user.globalName?.trim() || user.username || null,
      emoji,
      added,
      at: toTimestamp(Date.now()),
    };
    this.ctx.publish(BusEvents.PlatformReaction, event);
  }

  onVoiceState(
    state: VoiceStateLike,
    initial: boolean,
    old: Pick<VoiceStateLike, "channelId"> | null = null,
  ): void {
    if (state.channelId !== null && (initial || old?.channelId !== state.channelId)) {
      const member = state.member ?? null;
      if (member?.user) this.memberActed(state.guild.id, member.user, member.nickname ?? null);
    }
    this.ctx.publish(BusEvents.PlatformVoiceState, voiceStateUpdate(state, initial));
  }

  memberActed(guild: string | null, user: UserLike | null | undefined, nick: string | null): void {
    if (guild === null || !user || user.bot === true || this.shared.selfIds.has(user.id)) return;
    const places = this.ctx.services.get(PlacesKey);
    if (places === undefined) return;
    try {
      const space = places.ofGuild(PLATFORM, guild)?.id ?? places.seen(PLATFORM, guild, null);
      places.memberSeen(space, account(user.id), displayName(user, nick), user.username || null);
    } catch (error) {
      log.warn({ guild, error: errorMessage(error) }, "cannot record a server's member");
    }
  }

  onMember(member: GuildMemberLike, left: boolean): void {
    if (!left && member.user) {
      this.memberActed(member.guild.id, member.user, member.nickname ?? null);
    }
    this.ctx.publish(BusEvents.PlatformMember, memberUpdate(member, left));
  }

  private async onTyping(client: SelfClientLike, typing: SelfTypingLike): Promise<void> {
    const parent = typing.channel.parentId ?? null;
    const ids = { channel: typing.channel.id, parent };
    if (typing.guild && !ambientChannel(this.shared.ambient(typing.guild.id, ids), ids)) {
      return;
    }
    const kind = await this.channelKind(
      client,
      typing.guild?.id ?? null,
      typing.channel.id,
      typing.channel.type,
    );
    this.ctx.publish(BusEvents.PlatformTyping, {
      context: contextKey(typing.guild?.id ?? null, typing.channel.id, kind),
      account: account(typing.user.id),
    });
  }

  private onReady(client: SelfClientLike): void {
    const selfUser = client.user;
    if (!selfUser) return;
    const selfId = selfUser.id;
    log.info(
      { user: selfUser.username, id: selfId, guilds: [...client.guilds.cache.values()].length },
      "discord self chat ready",
    );
    this.shared.selfIds.add(selfId);
    const others = [...this.shared.selfIds]
      .filter((id) => id !== selfId)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    for (const id of [selfId, ...others]) {
      this.ctx.publish(BusEvents.PlatformReady, { platform: PLATFORM, self_account: account(id) });
    }
    const emojiConfig = this.shared.config.emoji;
    const stickerConfig = this.shared.config.stickers;
    const emoji = perGuild(this.shared as never, (c) => c.emoji);
    const stickers = perGuild(this.shared as never, (c) => c.stickers);
    const sink = new SelfDiscordSink(
      client as unknown as SelfSinkClientLike,
      () => this.ctx.services.get(ModerationKey),
      {
        table: this.shared.emoji,
        usage: this.shared.emojiUsage,
        enabled: (guild) => emoji.enabled(guild),
        limits: () => emojiConfig,
      },
      {
        source: () => this.ctx.services.get(AttachmentSourceKey),
        maxBytes: () => this.shared.config.max_upload_bytes,
      },
      {
        table: this.shared.stickers,
        usage: this.shared.stickerUsage,
        enabled: (guild) => stickers.enabled(guild),
        limits: () => stickerConfig,
        now: () => this.ctx.clock.now(),
      },
    );
    const history = new SelfDiscordHistory(
      client as unknown as SelfHistoryClientLike,
      this.shared.selfIds,
    );
    this.shared.sink = sink;
    this.shared.history = history;
    this.shared.sinks?.register(sink);
    this.shared.histories?.register(history);
    this.ctx.provide(ReplySinkKey, sink);
    this.ctx.provide(
      UserResolverKey,
      new DiscordUserResolver(client as unknown as ResolverClientLike) as UserResolver,
    );
    this.shared.ready = true;
    for (const guild of client.guilds.cache.values()) {
      this.guard("guild snapshot", () => this.snapshotGuild(guild));
    }
  }

  private async onMessage(client: SelfClientLike, msg: SelfMessageLike): Promise<void> {
    if (msg.type !== "DEFAULT" && msg.type !== "REPLY" && msg.type !== 0 && msg.type !== 19) {
      return;
    }
    const guild = msg.guild ?? (msg.guildId ? client.guilds.cache.get(msg.guildId) : undefined);
    const norm = normalizeMessageLike(msg, findCachedMember(guild, msg.author.id));
    if (!hasContent(norm)) return;
    const kind = await this.channelKind(client, msg.guildId, msg.channelId, msg.channel?.type);
    const parent = await repliedMessage(msg);
    const names = await userNamesOf(client, msg, this.shared.selfIds.has(msg.author.id));
    const repliedAuthorId = parent?.author?.id ?? msg.mentions.repliedUser?.id ?? null;
    const data = incomingMessage(
      norm,
      kind,
      this.shared.selfIds,
      repliedAuthorId,
      quoted(parent, guild),
      names,
    );
    const ids = {
      channel: msg.channelId,
      parent: msg.channel?.parentId ?? null,
    };
    const rules = msg.guildId === null ? this.shared.config : this.shared.ambient(msg.guildId, ids);
    if (!messageAllowed(rules, data, msg.guildId, ids, this.shared.selfIds)) return;
    this.ctx.publish(BusEvents.PlatformMessageCreated, data);
  }

  private async channelKind(
    client: SelfClientLike,
    guild: string | null,
    channel: string,
    known?: string | number,
  ): Promise<ContextKind> {
    if (guild === null) return "dm";
    const remembered = this.shared.kind(channel);
    if (remembered) return remembered;
    let type = known ?? client.channels.cache.get(channel)?.type;
    if (type === undefined) {
      try {
        type = (await client.channels.fetch(channel))?.type;
      } catch (error) {
        log.debug({ channel, error: errorMessage(error) }, "cannot resolve channel kind");
        return "channel";
      }
    }
    const kind = type === undefined ? "channel" : selfKindOf(type);
    this.shared.rememberKind(channel, kind);
    return kind;
  }
}

type SelfParentLike = Partial<SelfFetchedLike> & { author?: { id: string } | null };

async function repliedMessage(msg: SelfMessageLike): Promise<SelfParentLike | null> {
  const ref = msg.reference?.messageId;
  if (!ref) return null;
  const cached = msg.channel.messages?.cache.get(ref);
  if (cached) return cached;
  if (typeof msg.fetchReference === "function") {
    try {
      return await msg.fetchReference();
    } catch (error) {
      log.debug({ message: msg.id, error: errorMessage(error) }, "cannot fetch replied message");
    }
  }
  if (msg.mentions.repliedUser) {
    return { id: ref, author: { id: msg.mentions.repliedUser.id, username: "" } };
  }
  return null;
}

async function userNamesOf(
  client: SelfClientLike,
  msg: SelfMessageLike,
  self: boolean,
): Promise<UserNames | null> {
  const text = msg.content.trim() === "" ? componentsText(msg.components) : msg.content;
  const missing = unnamedUsers(text, mentionNames(msg.mentions as unknown as MentionsLike));
  if (missing.length === 0) return null;
  const names = new Map<string, string>();
  const guild = msg.guild ?? (msg.guildId ? client.guilds.cache.get(msg.guildId) : undefined);
  for (const id of missing.slice(0, MAX_NAME_LOOKUPS)) {
    const member = findCachedMember(guild, id);
    void self;
    const user = member?.user ?? client.users.cache.get(id) ?? null;
    if (user !== null) {
      names.set(id, displayName(user, member?.nickname ?? null));
    }
  }
  return (id) => names.get(id) ?? null;
}

function quoted(parent: SelfParentLike | null, guild?: SelfGuildLike | null): QuotedMessage | null {
  if (parent === null || typeof parent.content !== "string" || !parent.author) return null;
  try {
    const fallback = parent.author.id ? findCachedMember(guild, parent.author.id) : null;
    return quotedMessage(normalizeMessageLike(parent as SelfFetchedLike, fallback));
  } catch (error) {
    log.debug({ error: errorMessage(error) }, "cannot read replied message");
    return null;
  }
}
