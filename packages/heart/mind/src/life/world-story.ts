// Her own living world & ongoing mini-story (`mind:world_story`): slice-of-life events that run
// in the background and via `world_do`, gently nudging her energy & emotions between lazy/eepy and
// energetic/playful, while selectively forgetting routine own-world events after 2 days (48h) and
// story beats after 3 days (72h) so her memory stays fresh for new stories.

import {
  type ActionResult,
  type Capability,
  defineCapability,
  type ExecContext,
} from "@miyoria/gate/actions";
import { errorMessage, getLogger, SerialQueue } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type Clock,
  Events,
  isJsonObject,
  type JsonValue,
  newId,
  type ProfileId,
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
  type Publish,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";

const log = getLogger("mind.world_story");

export const WORLD_STORY_KEY = "mind:world_story";
export const WORLD_DO_CAPABILITY = "world.do";
export const WORLD_DO_TOOL = "world_do";
export const WORLD_STORY_CONTRIBUTOR = "world_story";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Routine own-world actions fade after 1 hour. */
export const ROUTINE_TTL_MS = 60 * MINUTE_MS;
/** Memorable story beats roll off after 2 hours. */
export const STORY_TTL_MS = 2 * HOUR_MS;
/** Minimum gap between autonomous background world events. */
export const AUTO_TICK_GAP_MS = 60 * MINUTE_MS;
const MAX_EVENTS = 4;
const MAX_TEXT = 160;
const MAX_STORY = 200;

export type WorldVibe = "lazy" | "energetic" | "cozy" | "mishap";

export interface WorldEvent {
  id: string;
  at: string;
  what: string;
  outcome: string;
  vibe: WorldVibe;
  memorable: boolean;
}

export interface WorldStoryState {
  story: { summary: string; updated_at: string } | null;
  events: WorldEvent[];
  last_auto_at: string | null;
}

interface WorldTemplate {
  what: string;
  outcome: string;
  storyHint?: string;
  vibe: WorldVibe;
  memorable: boolean;
}

const TEMPLATES_BY_BUCKET: Record<"morning" | "afternoon" | "evening" | "night", WorldTemplate[]> =
  {
    morning: [
      {
        what: "made iced matcha and sat by the window half-awake",
        outcome: "caffeine kicked in slowly, actually feeling okay today",
        vibe: "cozy",
        memorable: false,
      },
      {
        what: "woke up early with weird burst of energy and tidied my desk",
        outcome: "even wiped down my keyboard and organized cables",
        storyHint: "Trying to keep my desk setup clean for a few days without making a mess again.",
        vibe: "energetic",
        memorable: true,
      },
      {
        what: "curled back under the blanket in my oversized hoodie for a bit",
        outcome: "too comfy to move fast this morning",
        vibe: "lazy",
        memorable: false,
      },
    ],
    afternoon: [
      {
        what: "sorted through old music playlists and found a forgotten banger",
        outcome: "put it on loop while chilling at my desk",
        vibe: "cozy",
        memorable: false,
      },
      {
        what: "binged two episodes of a comfy slice-of-life anime with headphones on",
        outcome: "soft mood, humming the ED to myself",
        vibe: "cozy",
        memorable: false,
      },
      {
        what: "hit a random afternoon slump scrolling indie game demos",
        outcome: "brain is in low-power mode, nothing grabbed me yet",
        vibe: "lazy",
        memorable: false,
      },
      {
        what: "discovered a super upbeat lofi-synth mix and got hyped reorganizing my playlists",
        outcome: "sorted like forty tracks and feel weirdly pumped now",
        storyHint: "Putting together a late-night hangout playlist.",
        vibe: "energetic",
        memorable: true,
      },
    ],
    evening: [
      {
        what: "nearly spilled warm cocoa right next to my mousepad",
        outcome: "saved the keyboard just in time, mild heart attack lol",
        storyHint: "Narrowly avoided a hot cocoa disaster on my desk setup.",
        vibe: "mishap",
        memorable: true,
      },
      {
        what: "started grinding a tricky boss stage in an indie action game",
        outcome: "finally cleared it on attempt 7, kinda wired now",
        storyHint: "Working through a tough indie game run this week.",
        vibe: "energetic",
        memorable: true,
      },
      {
        what: "put rain ambience on and hugged my plushie with the lights dimmed",
        outcome: "super chill and a little sleepy",
        vibe: "lazy",
        memorable: false,
      },
    ],
    night: [
      {
        what: "tinkered with a tiny late-night CSS widget while half-asleep",
        outcome: "center-aligned a div after three tries and called it a win",
        storyHint: "Messing with tiny aesthetic widgets late at night.",
        vibe: "cozy",
        memorable: false,
      },
      {
        what: "got a weird 1 AM second wind and started sketching ideas for a mini-game",
        outcome: "scribbled rough notes everywhere, weirdly locked in",
        storyHint: "Brainstorming a tiny cozy mini-game during late-night hours.",
        vibe: "energetic",
        memorable: true,
      },
      {
        what: "melted into my hoodie listening to quiet lofi beats",
        outcome: "low battery vibes, mostly just existing peacefully",
        vibe: "lazy",
        memorable: false,
      },
    ],
  };

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function isVibe(v: unknown): v is WorldVibe {
  return v === "lazy" || v === "energetic" || v === "cozy" || v === "mishap";
}

function bucketOf(hour: number): keyof typeof TEMPLATES_BY_BUCKET {
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

function dateBucketKey(nowMs: number, offsetMinutes: number): string {
  const local = new Date(nowMs + offsetMinutes * MINUTE_MS);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}:${bucketOf(local.getUTCHours())}`;
}

function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function relativeTime(atIso: string, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - Date.parse(atIso));
  const mins = Math.round(diffMs / MINUTE_MS);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(diffMs / HOUR_MS);
  if (hrs < 36) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export interface WorldStoryBookOptions {
  store: SettingsStore | null;
  profile: ProfileId;
  publish: Publish;
  clock?: Clock;
  offsetMinutes?: number;
}

export class WorldStoryBook {
  readonly #store: SettingsStore | null;
  readonly #profile: ProfileId;
  readonly #publish: Publish;
  readonly #clock: Clock;
  readonly #offsetMinutes: number;
  readonly #writes = new SerialQueue();
  #state: WorldStoryState = { story: null, events: [], last_auto_at: null };

  constructor(options: WorldStoryBookOptions) {
    this.#store = options.store;
    this.#profile = options.profile;
    this.#publish = options.publish;
    this.#clock = options.clock ?? systemClock;
    this.#offsetMinutes = options.offsetMinutes ?? 420;
  }

  #now(): number {
    return this.#clock.now();
  }

  #prune(nowMs = this.#now()): boolean {
    let changed = false;
    const before = this.#state.events.length;
    this.#state.events = this.#state.events
      .filter((e) => {
        const ts = Date.parse(e.at);
        if (Number.isNaN(ts)) return false;
        const ttl = e.memorable ? STORY_TTL_MS : ROUTINE_TTL_MS;
        return nowMs - ts <= ttl;
      })
      .slice(-MAX_EVENTS);
    if (this.#state.events.length !== before) changed = true;

    if (this.#state.story !== null) {
      const ts = Date.parse(this.#state.story.updated_at);
      if (Number.isNaN(ts) || nowMs - ts > STORY_TTL_MS) {
        this.#state.story = null;
        changed = true;
      }
    }
    return changed;
  }

  async load(): Promise<void> {
    if (!this.#store) return;
    try {
      const raw = await this.#store.get(this.#profile, WORLD_STORY_KEY);
      if (isJsonObject(raw)) {
        const storyObj = isJsonObject(raw.story) ? raw.story : null;
        const story =
          storyObj &&
          typeof storyObj.summary === "string" &&
          typeof storyObj.updated_at === "string"
            ? { summary: cut(storyObj.summary, MAX_STORY), updated_at: storyObj.updated_at }
            : null;
        const events: WorldEvent[] = [];
        if (Array.isArray(raw.events)) {
          for (const item of raw.events) {
            if (!isJsonObject(item)) continue;
            if (
              typeof item.id === "string" &&
              typeof item.at === "string" &&
              typeof item.what === "string" &&
              typeof item.outcome === "string" &&
              isVibe(item.vibe)
            ) {
              events.push({
                id: item.id,
                at: item.at,
                what: cut(item.what, MAX_TEXT),
                outcome: cut(item.outcome, MAX_TEXT),
                vibe: item.vibe,
                memorable: item.memorable === true,
              });
            }
          }
        }
        const lastAuto = typeof raw.last_auto_at === "string" ? raw.last_auto_at : null;
        this.#state = { story, events, last_auto_at: lastAuto };
      }
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot load world story state");
    }
    if (this.#prune()) this.#persist();
  }

  #persist(): void {
    const store = this.#store;
    if (!store) return;
    const payload = JSON.parse(JSON.stringify(this.#state)) as JsonValue;
    void this.#writes
      .run(() => store.set(this.#profile, WORLD_STORY_KEY, payload))
      .catch((error: unknown) =>
        log.warn({ err: errorMessage(error) }, "cannot persist world story"),
      );
  }

  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  snapshot(): WorldStoryState {
    if (this.#prune()) this.#persist();
    return {
      story: this.#state.story ? { ...this.#state.story } : null,
      events: this.#state.events.map((e) => ({ ...e })),
      last_auto_at: this.#state.last_auto_at,
    };
  }

  applyVibe(vibe: WorldVibe, cause: string): void {
    switch (vibe) {
      case "lazy":
        this.#publish(Events.SelfNudge, { rest: 0.26, boredom: 0.06, reason: "world:lazy" });
        break;
      case "energetic":
        this.#publish(Events.SelfNudge, {
          rest: -0.24,
          boredom: -0.24,
          curiosity: -0.1,
          play: -0.1,
          reason: "world:energetic",
        });
        this.#publish(Events.SelfFeel, {
          emotion: "joy",
          amount: 0.28,
          cause,
          reason: "world:energetic",
        });
        break;
      case "cozy":
        this.#publish(Events.SelfNudge, { rest: -0.08, boredom: -0.18, reason: "world:cozy" });
        this.#publish(Events.SelfFeel, {
          emotion: "joy",
          amount: 0.16,
          cause,
          reason: "world:cozy",
        });
        break;
      case "mishap":
        this.#publish(Events.SelfNudge, { rest: 0.12, boredom: -0.1, reason: "world:mishap" });
        this.#publish(Events.SelfFeel, {
          emotion: "surprise",
          amount: 0.2,
          cause,
          reason: "world:mishap",
        });
        break;
    }
  }

  act(input: {
    what: string;
    outcome?: string;
    story?: string;
    vibe?: WorldVibe;
    memorable?: boolean;
  }): WorldEvent {
    const nowMs = this.#now();
    this.#prune(nowMs);
    const vibe = input.vibe ?? "cozy";
    const event: WorldEvent = {
      id: newId(),
      at: toTimestamp(nowMs),
      what: cut(input.what, MAX_TEXT),
      outcome: cut(input.outcome?.trim() || "just chilled with it", MAX_TEXT),
      vibe,
      memorable: input.memorable === true,
    };
    this.#state.events.push(event);
    if (this.#state.events.length > MAX_EVENTS) {
      this.#state.events = this.#state.events.slice(-MAX_EVENTS);
    }
    const storyText = input.story?.trim() ?? "";
    if (storyText !== "") {
      this.#state.story = {
        summary: cut(storyText, MAX_STORY),
        updated_at: event.at,
      };
    }
    this.applyVibe(vibe, `${event.what}: ${event.outcome}`);
    this.#persist();
    return { ...event };
  }

  autoTick(nowMs = this.#now(), offsetMinutes = this.#offsetMinutes): WorldEvent | null {
    const pruned = this.#prune(nowMs);
    const bucketKey = dateBucketKey(nowMs, offsetMinutes);
    const lastAutoMs = this.#state.last_auto_at ? Date.parse(this.#state.last_auto_at) : Number.NaN;
    if (
      !Number.isNaN(lastAutoMs) &&
      (nowMs - lastAutoMs < AUTO_TICK_GAP_MS ||
        dateBucketKey(lastAutoMs, offsetMinutes) === bucketKey)
    ) {
      if (pruned) this.#persist();
      return null;
    }
    const localHour = new Date(nowMs + offsetMinutes * MINUTE_MS).getUTCHours();
    const pool = TEMPLATES_BY_BUCKET[bucketOf(localHour)];
    const recentWhats = new Set(this.#state.events.slice(-4).map((e) => e.what));
    const fresh = pool.filter((t) => !recentWhats.has(t.what));
    const choices = fresh.length > 0 ? fresh : pool;
    const picked = choices[stableHash(bucketKey) % choices.length] ?? choices[0];
    if (!picked) return null;

    const firstBoot = this.#state.last_auto_at === null && this.#state.events.length === 0;
    const at = toTimestamp(nowMs);
    this.#state.last_auto_at = at;
    const event: WorldEvent = {
      id: newId(),
      at,
      what: picked.what,
      outcome: picked.outcome,
      vibe: picked.vibe,
      memorable: picked.memorable,
    };
    this.#state.events.push(event);
    if (this.#state.events.length > MAX_EVENTS) {
      this.#state.events = this.#state.events.slice(-MAX_EVENTS);
    }
    if (picked.storyHint) {
      this.#state.story = { summary: cut(picked.storyHint, MAX_STORY), updated_at: at };
    }
    if (!firstBoot || picked.vibe === "cozy") {
      this.applyVibe(picked.vibe, `${event.what}: ${event.outcome}`);
    }
    this.#persist();
    return { ...event };
  }

  contributor(): PromptContributor {
    return {
      key: WORLD_STORY_CONTRIBUTOR,
      contribute: async (_request: PromptRequest): Promise<PromptSection[]> => {
        const nowMs = this.#now();
        const snap = this.snapshot();
        if (snap.story === null && snap.events.length === 0) return [];
        const lines: string[] = [];
        if (snap.story !== null) {
          lines.push(
            `Current mini-story (${relativeTime(snap.story.updated_at, nowMs)}): ${snap.story.summary}`,
          );
        }
        const recent = snap.events.slice(-5);
        if (recent.length > 0) {
          lines.push("Recent things you did on your own (auto-clears every 1-2 hours):");
          for (const e of recent) {
            lines.push(`- [${relativeTime(e.at, nowMs)} | ${e.vibe}] ${e.what} — ${e.outcome}`);
          }
        }
        return [
          {
            key: WORLD_STORY_CONTRIBUTOR,
            title: "Your Recent Activity (auto-clears every 1-2 hours)",
            body: lines.join("\n"),
            order: 25,
          },
        ];
      },
    };
  }
}

const WorldDoArgs = z.object({
  action: z.string().trim().min(1).max(MAX_TEXT),
  outcome: z.string().trim().max(MAX_TEXT).optional(),
  story: z.string().trim().max(MAX_STORY).optional(),
  mood: z.enum(["lazy", "energetic", "cozy", "mishap"]).optional(),
  memorable: z.boolean().optional(),
});
type WorldDoArgs = z.output<typeof WorldDoArgs>;

export function worldDoCapability(book: WorldStoryBook): Capability {
  return defineCapability<WorldDoArgs>({
    name: WORLD_DO_CAPABILITY,
    summary: "在自己的生活世界裡做點小事或推進小故事",
    risk: "low",
    args: WorldDoArgs,
    permission: "chat.talk",
    tool: {
      name: WORLD_DO_TOOL,
      meta: { effect: "act", speed: "instant", group: "mind", core: true },
      description:
        "記錄你在自己生活裡做的一件小事或推進你最近的小故事(泡茶、補番、打遊戲卡關、發呆補眠、寫小東西等),並實際影響你現在的精神與情緒(lazy / energetic / cozy / mishap)。這些只屬於你自己的日常會在 2 到 3 天後自動淡忘,為新的故事騰出空間。",
      properties: {
        action: {
          type: "string",
          description: "你在自己的世界/房間裡剛做或正在做的小事(用英文寫)",
        },
        outcome: {
          type: "string",
          description: "結果怎樣、發生了什麼小插曲(選填)",
        },
        story: {
          type: "string",
          description: "如果這件事推進或開啟了你最近幾天的個人小故事主線,寫一句更新(選填)",
        },
        mood: {
          type: "string",
          enum: ["lazy", "energetic", "cozy", "mishap"],
          description:
            "這件事讓你變得懶洋洋(lazy)、更有精神(energetic)、放鬆(cozy)還是遇到小狀況(mishap)",
        },
        memorable: {
          type: "boolean",
          description: "算不算這幾天的小故事重點(true 留 3 天,false 日常小事留 2 天後自動忘記)",
        },
      },
      required: ["action"],
    },
    async execute(args, _ctx: ExecContext): Promise<ActionResult> {
      const event = book.act({
        what: args.action,
        ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
        ...(args.story !== undefined ? { story: args.story } : {}),
        ...(args.mood !== undefined ? { vibe: args.mood } : {}),
        ...(args.memorable !== undefined ? { memorable: args.memorable } : {}),
      });
      return {
        text: `logged in your world (${event.vibe}, expires in ${event.memorable ? "2 hours" : "1 hour"}): ${event.what} — ${event.outcome}`,
        data: { id: event.id, vibe: event.vibe, memorable: event.memorable },
      };
    },
  }) as Capability;
}
