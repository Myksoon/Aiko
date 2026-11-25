import { describe, expect, it } from "vitest";
import { WorldStoryBook } from "../src/index.js";

describe("WorldStoryBook autoTick stability", () => {
  it("picks deterministically per date+bucket, skips duplicate autoTicks in the same bucket, and advances on next bucket", () => {
    const dayAfternoon = Date.parse("2026-11-24T07:30:00.000Z"); // 14:30 UTC+7 (afternoon)
    const laterSameBucket = Date.parse("2026-11-24T09:30:00.000Z"); // 16:30 UTC+7 (still afternoon, >75m later)
    const eveningBucket = Date.parse("2026-11-24T12:30:00.000Z"); // 19:30 UTC+7 (evening)

    const a = new WorldStoryBook({ store: null, profile: "aiko", publish: () => {} });
    const b = new WorldStoryBook({ store: null, profile: "aiko", publish: () => {} });

    const evA = a.autoTick(dayAfternoon, 420);
    const evB = b.autoTick(dayAfternoon, 420);
    expect(evA).not.toBeNull();
    expect(evA?.what).toBe(evB?.what);

    // Same date+bucket must not generate another auto event even past 75m.
    expect(a.autoTick(laterSameBucket, 420)).toBeNull();

    // Moving to evening generates a new event cleanly.
    const evEvening = a.autoTick(eveningBucket, 420);
    expect(evEvening).not.toBeNull();
    expect(evEvening?.what).not.toBe(evA?.what);

    // Explicit user/LLM world_do acts work regardless of autoTick bucket gating.
    const manual = a.act({ what: "doodling a tiny t-rex", vibe: "cozy" });
    expect(manual.what).toBe("doodling a tiny t-rex");
  });
});
