import { ArtifactStoreKey } from "@miyoria/store";
import { PlatformSinksKey } from "@miyoria/types";
import { describe, expect, it, vi } from "vitest";
import { AnimeGifTool } from "../src/index.js";

const textCtx = { platform: "discord", scope: "g", channel: "100", kind: "channel" } as const;
const voiceCtx = { platform: "discord", scope: "g", channel: "200", kind: "voice" } as const;

const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]); // GIF89a...

function setup(nowMs = 1_000_000) {
  let now = nowMs;
  const sent: Array<{ text?: string; attachments?: unknown[] }> = [];
  const store = {
    places: { at: () => ({ place: "g", person_id: "p1" }) },
    ingest: async () => ({ id: "art-1" }),
  };
  const sinks = new Map([
    [
      "discord",
      {
        attachmentLimit: () => 8 * 1024 * 1024,
        send: async (_context: unknown, message: { text?: string; attachments?: unknown[] }) => {
          sent.push(message);
        },
      },
    ],
  ]);
  const services = new Map<unknown, unknown>([
    [ArtifactStoreKey, store],
    [PlatformSinksKey, sinks],
  ]);
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const target = typeof url === "string" ? url : url.toString();
    if (!target.endsWith(".gif")) {
      return new Response(JSON.stringify({ results: [{ url: "https://nekos.best/api/v2/shrug/1.gif" }] }), {
        status: 200,
      });
    }
    return new Response(GIF_BYTES, { status: 200 });
  });
  const tool = new AnimeGifTool(
    { clock: { now: () => now }, services: { get: (k: unknown) => services.get(k) } } as never,
    fetchFn as unknown as typeof fetch,
  );
  const callCtx = (context: typeof textCtx | typeof voiceCtx = textCtx) =>
    ({
      turn: "01M862TURN",
      context,
      account: { platform: "discord", id: "u1" },
      message: { context, id: "112233445566778899" },
      signal: new AbortController().signal,
    }) as never;
  return {
    tool,
    sent,
    fetchFn,
    callCtx,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("anime_gif", () => {
  it("exposes only reaction in its schema (no caption field)", () => {
    const { tool } = setup();
    const params = tool.spec.parameters as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(params.properties ?? {})).toEqual(["reaction"]);
    expect(params.required).toEqual(["reaction"]);
  });

  it("sends GIF-only (empty text) even if extra fields are passed, so reply text never duplicates", async () => {
    const { tool, sent, callCtx } = setup();
    const out = await tool.call(callCtx(), { reaction: "shrug", caption: "ignored text" });
    expect(out).toContain("sent anime_gif (shrug)");
    expect(out).toContain("GIF only");
    expect(sent).toEqual([
      {
        text: "",
        reply_to: { context: textCtx, id: "112233445566778899" },
        attachments: [{ artifact_id: "art-1" }],
      },
    ]);
  });

  it("refuses in voice channels without calling nekos.best", async () => {
    const { tool, sent, fetchFn, callCtx } = setup();
    const out = await tool.call(callCtx(voiceCtx), { reaction: "shrug" });
    expect(out).toContain("語音頻道不用傳 GIF");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("enforces the 35s per-channel cooldown", async () => {
    const { tool, sent, callCtx, advance } = setup();
    await tool.call(callCtx(), { reaction: "shrug" });
    advance(20_000);
    const blocked = await tool.call(callCtx(), { reaction: "smug" });
    expect(blocked).toContain("剛才已經傳過 GIF 了");
    expect(sent).toHaveLength(1);
    advance(16_000);
    const allowed = await tool.call(callCtx(), { reaction: "smug" });
    expect(allowed).toContain("sent anime_gif (smug)");
    expect(sent).toHaveLength(2);
  });
});
