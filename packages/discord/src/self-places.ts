// `PlaceDirectory` for the Discord user-account adapter (`discord.js-selfbot-v13`).

import type { PlaceDirectory, PlaceRoom, PlaceRoomKind, PlaceSpace } from "@miyoria/types";
import { PLATFORM } from "./mapping.js";
import { type ChannelView, type GuildView, placeRooms } from "./places.js";

export interface SelfPlaceChannelLike {
  id: string;
  name?: string;
  type: string | number;
  parentId?: string | null;
  position?: number;
  permissionsFor?(member: unknown): { has(perm: string): boolean } | null;
}

export interface SelfPlaceGuildLike {
  id: string;
  name: string;
  me?: unknown;
  members?: { me?: unknown };
  channels: { cache: { values(): Iterable<SelfPlaceChannelLike> } };
}

export interface SelfPlacesClientLike {
  guilds: { cache: { values(): Iterable<SelfPlaceGuildLike> } };
}

function selfViewKind(type: string | number): ChannelView["kind"] {
  switch (type) {
    case "GUILD_TEXT":
    case "GUILD_NEWS":
    case 0:
    case 5:
      return "text";
    case "GUILD_VOICE":
    case "GUILD_STAGE_VOICE":
    case 2:
    case 13:
      return "voice";
    case "GUILD_PUBLIC_THREAD":
    case "GUILD_PRIVATE_THREAD":
    case "GUILD_NEWS_THREAD":
    case 10:
    case 11:
    case 12:
      return "thread";
    case "GUILD_CATEGORY":
    case 4:
      return "category";
    default:
      return null;
  }
}

export function selfGuildViews(client: SelfPlacesClientLike): GuildView[] {
  const out: GuildView[] = [];
  for (const guild of client.guilds.cache.values()) {
    const me = guild.me ?? guild.members?.me ?? null;
    const channels: ChannelView[] = [];
    for (const channel of guild.channels.cache.values()) {
      const kind = selfViewKind(channel.type);
      if (kind === null) continue;
      const perms = me && channel.permissionsFor ? channel.permissionsFor(me) : null;
      const view = perms?.has("VIEW_CHANNEL") ?? false;
      const use =
        kind === "voice"
          ? (perms?.has("CONNECT") ?? false)
          : kind === "thread"
            ? (perms?.has("SEND_MESSAGES_IN_THREADS") ?? false)
            : (perms?.has("SEND_MESSAGES") ?? false);
      channels.push({
        id: channel.id,
        name: channel.name ?? channel.id,
        kind,
        parent: channel.parentId ?? null,
        position: typeof channel.position === "number" ? channel.position : 0,
        view,
        use,
      });
    }
    out.push({ id: guild.id, name: guild.name, channels });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export class SelfDiscordPlaces implements PlaceDirectory {
  readonly platform = PLATFORM;

  constructor(
    readonly client: SelfPlacesClientLike,
    readonly isReady: () => boolean,
  ) {}

  ready(): boolean {
    return this.isReady();
  }

  spaces(): PlaceSpace[] {
    if (!this.isReady()) return [];
    return [...this.client.guilds.cache.values()]
      .map((g) => ({ platform: PLATFORM, id: g.id, name: g.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  rooms(options?: { space?: string; kind?: PlaceRoomKind }): PlaceRoom[] {
    if (!this.isReady()) return [];
    return placeRooms(selfGuildViews(this.client), options);
  }
}
