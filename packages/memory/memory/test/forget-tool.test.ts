import { SqliteStore } from "@miyoria/store";
import { newId, type Timestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ForgetMemoryTool, MemoryEngine, memoryConfig, memoryFilter } from "../src/index.js";
import { memoryTables } from "../src/tables.js";
import { acct, guildCtx, profile, T0_MS, t0 } from "./helpers.js";

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

describe("ForgetMemoryTool", () => {
  it("requires confirmation in a new message, deletes matching records, and leaves a timestamped meta-memory", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [memoryTables] });
    stores.push(store);
    const tables = store.plugin(memoryTables);
    const ctx = guildCtx("g1", "c1");
    const OWEN = acct("2");
    const owen = await store.people.upsertAccount(OWEN, "Owen");

    await tables.upsert({
      id: newId(),
      profile: profile(),
      kind: "fact",
      scope: { type: "global" },
      subjects: [owen],
      content: "Owen loves spicy ramen",
      tokens: "owen loves spicy ramen",
      embedding: null,
      importance: 0.7,
      confidence: 0.9,
      created_at: t0() as Timestamp,
      updated_at: t0() as Timestamp,
      last_accessed: null,
      access_count: 0,
      source_context: ctx,
      source: { account: OWEN, name: "Owen" },
      origin: "told",
      source_events: [],
      due: null,
      done: false,
      superseded_by: null,
    });

    const engine = new MemoryEngine(profile(), memoryConfig(), tables, { people: store.people });
    const tool = new ForgetMemoryTool(engine, { now: () => T0_MS }, () => null, 420);
    const toolCtx = (msgId: string) =>
      ({
        turn: "turn-1",
        context: ctx,
        account: OWEN,
        message: { context: ctx, id: msgId },
        priority: "direct",
        signal: new AbortController().signal,
      }) as never;

    // 1. Initial request asks for confirmation and deletes nothing.
    const first = await tool.call(toolCtx("msg-1"), { topic: "ramen", confirm: false });
    expect(first).toContain("CONFIRMATION REQUIRED");
    expect((await tables.list(profile(), memoryFilter(20))).length).toBe(1);

    // 2. Trying confirm=true inside the same message is still blocked.
    const sameTurn = await tool.call(toolCtx("msg-1"), { topic: "ramen", confirm: true });
    expect(sameTurn).toContain("CONFIRMATION REQUIRED");
    expect((await tables.list(profile(), memoryFilter(20))).length).toBe(1);

    // 3. Confirming in a subsequent message deletes the record and writes a sanitized meta-episode.
    const confirmed = await tool.call(toolCtx("msg-2"), { topic: "ramen", confirm: true });
    expect(confirmed).toContain("Deleted 1 memory item(s)");

    const remaining = await tables.list(profile(), memoryFilter(20));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.kind).toBe("episode");
    expect(remaining[0]?.content).toContain("asked me to forget something");
    expect(remaining[0]?.content.toLowerCase()).not.toContain("ramen");
  });
});
