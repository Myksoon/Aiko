import { describe, expect, it } from "vitest";
import { activityBlock } from "../../agent/src/self-block.js";
import { extractDiscordActivity } from "../src/prompt.js";

const textCtx = { platform: "discord", scope: "g", channel: "100", kind: "channel" } as const;

describe("live discord activity in <now>", () => {
  it("extracts playing and listening activities and returns null for idle", () => {
    expect(
      extractDiscordActivity(
        "Your live Discord profile currently shows: Playing osu! (YOASOBI - Yoru ni Kakeru [Insane] — Clicking circles) (status: online, started 5m ago). If someone asks...",
      ),
    ).toBe("Playing osu! (YOASOBI - Yoru ni Kakeru [Insane] — Clicking circles)");

    expect(
      extractDiscordActivity(
        "Your live Discord profile currently shows: Listening to YouTube Music (Ditto — NewJeans) (status: idle, started 0m ago).",
      ),
    ).toBe("Listening to YouTube Music (Ditto — NewJeans)");

    expect(
      extractDiscordActivity(
        "Your live Discord profile currently shows: dnd, not playing any game or music right now (just hanging out).",
      ),
    ).toBeNull();
  });

  it("replaces 沒有在做別的事 with discordActivity when activity is idle", () => {
    const line = activityBlock({
      context: textCtx,
      now: 1_000_000,
      activity: {
        presence: { type: "out" },
        broadcast: { type: "off" },
        activity: { type: "idle", phase: "idle", target: null },
      } as never,
      discordActivity: "Playing osu! (YOASOBI - Yoru ni Kakeru [Insane])",
    });
    expect(line).toContain("正在 Playing osu! (YOASOBI - Yoru ni Kakeru [Insane])");
    expect(line).not.toContain("沒有在做別的事");
  });

  it("keeps 沒有在做別的事 when discordActivity is absent", () => {
    const line = activityBlock({
      context: textCtx,
      now: 1_000_000,
      activity: {
        presence: { type: "out" },
        broadcast: { type: "off" },
        activity: { type: "idle", phase: "idle", target: null },
      } as never,
    });
    expect(line).toContain("沒有在做別的事");
  });
});
