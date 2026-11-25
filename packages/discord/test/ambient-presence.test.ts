import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LISTENING,
  ACTIVITY_PLAYING,
  AMBIENT_PRESENCE_CONTRIBUTOR,
  AMBIENT_PRESENCE_PRESETS,
  type AmbientPresenceSnapshot,
  ambientPresenceContributor,
} from "../src/ambient-presence.js";

describe("ambientPresenceContributor", () => {
  it("returns empty array when snapshot is null", async () => {
    const contributor = ambientPresenceContributor(() => null);
    expect(contributor.key).toBe(AMBIENT_PRESENCE_CONTRIBUTOR);
    const sections = await contributor.contribute({} as never);
    expect(sections).toEqual([]);
  });

  it("formats osu! playing snapshot with map details, state, and age", async () => {
    const start = 1_000_000;
    const snap: AmbientPresenceSnapshot = {
      status: "online",
      activityType: ACTIVITY_PLAYING,
      activityName: "osu!",
      details: "YOASOBI - Yoru ni Kakeru [Insane]",
      state: "Clicking circles",
      startedAt: start,
    };
    const contributor = ambientPresenceContributor(
      () => snap,
      () => start + 5 * 60_000,
    );
    const sections = await contributor.contribute({} as never);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.body).toContain("Playing osu!");
    expect(sections[0]!.body).toContain("YOASOBI - Yoru ni Kakeru [Insane] — Clicking circles");
    expect(sections[0]!.body).toContain("started 5m ago");
    expect(sections[0]!.body).toContain("never deny it");
  });

  it("formats YouTube Music listening snapshot with track title and artist", async () => {
    const now = 2_000_000;
    const snap: AmbientPresenceSnapshot = {
      status: "idle",
      activityType: ACTIVITY_LISTENING,
      activityName: "YouTube Music",
      details: "Ditto",
      state: "NewJeans",
      startedAt: now,
    };
    const contributor = ambientPresenceContributor(
      () => snap,
      () => now,
    );
    const sections = await contributor.contribute({} as never);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.body).toContain("Listening to YouTube Music (Ditto — NewJeans)");
  });

  it("formats idle snapshot cleanly", async () => {
    const snap: AmbientPresenceSnapshot = {
      status: "dnd",
      activityType: null,
      activityName: null,
      details: null,
      state: null,
      startedAt: 1_000_000,
    };
    const contributor = ambientPresenceContributor(() => snap);
    const sections = await contributor.contribute({} as never);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.body).toContain("dnd, not playing any game or music right now");
  });

  it("has no Aseprite preset in AMBIENT_PRESENCE_PRESETS", () => {
    const names = AMBIENT_PRESENCE_PRESETS.map((p) => p.activity?.name).filter(Boolean);
    expect(names).not.toContain("Aseprite");
  });
});
