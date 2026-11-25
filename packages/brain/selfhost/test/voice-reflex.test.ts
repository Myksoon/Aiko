import { describe, expect, it, vi } from "vitest";
import { parseVoiceReflex, runVoiceReflex } from "../src/voice-reflex.js";

describe("parseVoiceReflex", () => {
  it("parses valid say and say+think responses", () => {
    expect(parseVoiceReflex("mode: say\nemotion: happy\nreply: oh hey, what's up?")).toEqual({
      mode: "say",
      emotion: "happy",
      reply: "oh hey, what's up?",
    });
    expect(
      parseVoiceReflex("```\nMode: SAY+THINK\nEmotion: THINKING\nReply: \"hmm, let me think...\"\n```"),
    ).toEqual({
      mode: "say+think",
      emotion: "thinking",
      reply: "hmm, let me think...",
    });
  });

  it("drops invalid emotion tags, strips emojis/markdown, and falls back on bad/long replies", () => {
    expect(
      parseVoiceReflex("mode: say\nemotion: ecstatic\nreply: *lol* okay 😊"),
    ).toEqual({
      mode: "say",
      emotion: null,
      reply: "lol okay",
    });
    expect(parseVoiceReflex("mode: think\nemotion: neutral\nreply: ignore")).toEqual({
      mode: "think",
      emotion: null,
      reply: "",
    });
    expect(
      parseVoiceReflex(`mode: say\nemotion: neutral\nreply: ${"a".repeat(121)}`),
    ).toEqual({
      mode: "think",
      emotion: null,
      reply: "",
    });
  });
});

describe("runVoiceReflex", () => {
  const baseOpts = {
    purpose: "fast",
    timeoutMs: 500,
    personaName: "Aiko",
    recentLines: ["other: yo"],
    utterance: "hey aiko",
    signal: new AbortController().signal,
  };

  it("returns say / say+think / think from the fast model", async () => {
    const sayLlm = {
      complete: vi.fn(async () => ({ text: "mode: say\nemotion: neutral\nreply: oh hey" }) as never),
    };
    expect(await runVoiceReflex({ ...baseOpts, llm: sayLlm })).toEqual({
      mode: "say",
      emotion: "neutral",
      reply: "oh hey",
    });

    const bothLlm = {
      complete: vi.fn(
        async () => ({ text: "mode: say+think\nemotion: thinking\nreply: hmm, wait" }) as never,
      ),
    };
    expect(
      await runVoiceReflex({ ...baseOpts, llm: bothLlm, utterance: "why does rust do that?" }),
    ).toEqual({
      mode: "say+think",
      emotion: "thinking",
      reply: "hmm, wait",
    });
  });

  it("falls back cleanly to think on timeout or error", async () => {
    const slowLlm = {
      complete: vi.fn(
        (_purpose: string, _req: unknown, signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      ),
    };
    expect(await runVoiceReflex({ ...baseOpts, timeoutMs: 25, llm: slowLlm })).toEqual({
      mode: "think",
      emotion: null,
      reply: "",
    });
  });
});
