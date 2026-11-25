// `PlatformHistory` for the Discord user-account adapter (`discord.js-selfbot-v13`).

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type {
  ContextKey,
  HistoryQuery,
  IncomingMessage,
  MessageRef,
  PlatformHistory,
  PlatformId,
  QuotedMessage,
} from "@miyoria/types";
import {
  displayName,
  hasContent,
  incomingMessage,
  type MentionsLike,
  type MessageLike,
  PLATFORM,
  quotedMessage,
  type ReferenceLike,
  type UserLike,
} from "./mapping.js";

const log = getLogger("discord.self.history");

export const SELF_MAX_FETCH = 100;

export interface SelfFetchedLike extends Omit<MessageLike, "reference"> {
  type: string | number;
  reference?: (Omit<ReferenceLike, "type"> & { type?: string | number | null }) | null;
  mentions: MentionsLike & { repliedUser?: { id: string } | null };
}

interface SelfFetchedList {
  values(): Iterable<SelfFetchedLike>;
}

export interface SelfMessageManagerLike {
  fetch(
    options: string | { limit: number; before?: string; after?: string },
  ): Promise<SelfFetchedLike | SelfFetchedList>;
  cache: { get(id: string): SelfFetchedLike | undefined };
}

export interface SelfCachedMemberLike {
  id?: string;
  nickname?: string | null;
  user?: UserLike | null;
}

export interface SelfGuildMembersLike {
  members?: {
    cache?: {
      get?(id: string): SelfCachedMemberLike | undefined;
      values?(): Iterable<SelfCachedMemberLike>;
    };
  };
}

export interface SelfHistoryClientLike {
  channels: { fetch(id: string): Promise<unknown> };
  users?: { cache: { get(id: string): UserLike | undefined } };
  guilds?: { cache: { get(id: string): SelfGuildMembersLike | undefined } };
}

export function findCachedMember(
  guild: SelfGuildMembersLike | null | undefined,
  userId: string,
): SelfCachedMemberLike | null {
  const cache = guild?.members?.cache;
  if (!cache) return null;
  const direct = cache.get?.(userId);
  if (direct) return direct;
  for (const member of cache.values?.() ?? []) {
    if (member.id === userId || member.user?.id === userId) return member;
  }
  return null;
}

function isList(value: SelfFetchedLike | SelfFetchedList): value is SelfFetchedList {
  return typeof (value as Partial<SelfFetchedList>).values === "function";
}

function readable(m: SelfFetchedLike): boolean {
  const isNormal = m.type === "DEFAULT" || m.type === "REPLY" || m.type === 0 || m.type === 19;
  return isNormal && hasContent(normalizeMessageLike(m));
}

function readableParent(m: SelfFetchedLike): boolean {
  if (readable(m)) return true;
  const isCmd =
    m.type === "APPLICATION_COMMAND" ||
    m.type === "CONTEXT_MENU_COMMAND" ||
    m.type === 20 ||
    m.type === 23;
  return isCmd && hasContent(normalizeMessageLike(m));
}

export function normalizeReference(
  ref: (Omit<ReferenceLike, "type"> & { type?: string | number | null }) | null | undefined,
): ReferenceLike | null {
  if (!ref) return null;
  const type = ref.type === "FORWARD" || ref.type === 1 ? 1 : 0;
  return {
    messageId: ref.messageId ?? null,
    channelId: ref.channelId ?? null,
    guildId: ref.guildId ?? null,
    type,
  };
}

export function normalizeMessageLike(
  m: SelfFetchedLike,
  fallbackMember?: { nickname?: string | null } | null,
): MessageLike {
  const embeds = m.embeds ?? null;
  return {
    id: m.id,
    channelId: m.channelId,
    guildId: m.guildId,
    author: m.author,
    member: m.member ?? fallbackMember ?? null,
    content: m.content,
    createdTimestamp: m.createdTimestamp,
    mentions: m.mentions,
    attachments: m.attachments,
    stickers: m.stickers ?? null,
    embeds,
    reference: normalizeReference(m.reference),
    messageSnapshots: m.messageSnapshots ?? null,
    components: m.components ?? null,
  };
}

export class SelfDiscordHistory implements PlatformHistory {
  readonly platform: PlatformId = PLATFORM;

  constructor(
    private readonly client: SelfHistoryClientLike,
    private readonly selfIds: ReadonlySet<string>,
  ) {}

  async recent(
    context: ContextKey,
    query: HistoryQuery,
    signal?: AbortSignal,
  ): Promise<IncomingMessage[]> {
    const limit = Math.min(Math.max(Math.trunc(query.limit), 0), SELF_MAX_FETCH);
    if (limit === 0) return [];
    const manager = await this.#manager(context.channel);
    signal?.throwIfAborted();
    if (manager === null) return [];
    const result = await manager.fetch(
      query.after != null
        ? { limit, after: query.after }
        : query.before === null
          ? { limit }
          : { limit, before: query.before },
    );
    signal?.throwIfAborted();
    if (!isList(result)) return [];
    return [...result.values()]
      .filter(readable)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => this.#map(m, context, manager));
  }

  async fetch(ref: MessageRef, signal?: AbortSignal): Promise<IncomingMessage | null> {
    const manager = await this.#manager(ref.context.channel);
    signal?.throwIfAborted();
    if (manager === null) return null;
    let found: SelfFetchedLike | SelfFetchedList;
    try {
      found = manager.cache.get(ref.id) ?? (await manager.fetch(ref.id));
    } catch (error) {
      log.warn(
        { channel: ref.context.channel, message: ref.id, error: errorMessage(error) },
        "cannot fetch the replied-to message",
      );
      return null;
    }
    signal?.throwIfAborted();
    if (isList(found)) return null;
    if (!readableParent(found)) {
      log.info({ message: ref.id, type: found.type }, "the replied-to message has nothing to read");
      return null;
    }
    return this.#map(found, ref.context, manager);
  }

  async #manager(channel: string): Promise<SelfMessageManagerLike | null> {
    let fetched: unknown;
    try {
      fetched = await this.client.channels.fetch(channel);
    } catch (error) {
      log.debug({ channel, error: errorMessage(error) }, "cannot fetch channel for history");
      return null;
    }
    const messages = (fetched as { messages?: SelfMessageManagerLike } | null)?.messages;
    return messages && typeof messages.fetch === "function" ? messages : null;
  }

  #map(m: SelfFetchedLike, context: ContextKey, manager: SelfMessageManagerLike): IncomingMessage {
    const guild = m.guildId ? this.client.guilds?.cache.get(m.guildId) : undefined;
    const norm = normalizeMessageLike(m, findCachedMember(guild, m.author.id));
    const parentId = norm.reference?.messageId ?? null;
    const parent = parentId === null ? undefined : manager.cache.get(parentId);
    let referenced: QuotedMessage | null = null;
    if (parent) {
      try {
        referenced = quotedMessage(
          normalizeMessageLike(parent, findCachedMember(guild, parent.author.id)),
        );
      } catch {
        referenced = null;
      }
    }
    const repliedAuthor = m.mentions.repliedUser?.id ?? parent?.author.id ?? null;
    const users = this.client.users?.cache;
    const names =
      users === undefined && guild === undefined
        ? null
        : (id: string) => {
            const member = findCachedMember(guild, id);
            const user = member?.user ?? users?.get(id);
            if (user) return displayName(user, member?.nickname ?? null);
            const nick = member?.nickname?.trim();
            return nick || null;
          };
    return incomingMessage(norm, context.kind, this.selfIds, repliedAuthor, referenced, names);
  }
}
