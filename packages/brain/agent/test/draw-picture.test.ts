import { LlmRouterKey } from "@miyoria/llm/llm";
import { ArtifactStoreKey } from "@miyoria/store";
import { PlatformSinksKey } from "@miyoria/types";
import { describe, expect, it, vi } from "vitest";
import { directReason } from "../src/address.js";
import {
  AIKO_VISUAL_ANCHOR,
  buildEditImagePrompt,
  buildNewImagePrompt,
  composeCanvasSvg,
  DrawPictureTool,
  getAikoCurrentOutfit,
  isConversationFollowUp,
  isOutdoorScene,
  isSelfOrCharacterSubject,
  isUnsafeImageText,
  sanitizeSvgLayer,
  type VisualCanvas,
  VisualCanvasBook,
} from "../src/index.js";

const textCtx = { platform: "discord", scope: "g", channel: "100", kind: "channel" } as const;
const voiceCtx = { platform: "discord", scope: "g", channel: "200", kind: "voice" } as const;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type MockFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type MockLlmComplete = (
  purpose: string,
  req: { messages?: Array<{ content?: unknown }> },
) => Promise<{ text: string }>;

function setup(
  options: {
    provider?: "auto" | "gemini" | "openai" | "canvas";
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    cooldownSecs?: number;
    maxPerHour?: number;
    fetchFn?: typeof fetch;
    llmComplete?: ReturnType<typeof vi.fn<MockLlmComplete>>;
  } = {},
) {
  let now = 1_000_000;
  let artSeq = 0;
  const sent: Array<{ text?: string; reply_to?: unknown; attachments?: unknown[] }> = [];
  const blobs = new Map<string, { artifact: { id: string; mime: string }; bytes: Uint8Array }>();

  const store = {
    places: { at: () => ({ place: "g", person_id: "p1" }) },
    ingest: vi.fn(async (bytes: Uint8Array, input: { mime?: string }) => {
      const id = `01ARZ3NDEKTSV4RRFFQ69G5F${String(artSeq++).padStart(2, "0")}`;
      const artifact = { id, mime: input.mime ?? "image/png" };
      blobs.set(id, { artifact, bytes });
      return artifact;
    }),
    get: vi.fn((id: string) => blobs.get(id)?.artifact ?? null),
    readContent: vi.fn(async (artifact: { id: string }) => {
      const hit = blobs.get(artifact.id);
      if (!hit) throw new Error(`missing ${artifact.id}`);
      return hit.bytes;
    }),
  };

  const sinks = new Map([
    [
      "discord",
      {
        attachmentLimit: () => 8 * 1024 * 1024,
        send: vi.fn(
          async (
            _context: unknown,
            message: { text?: string; reply_to?: unknown; attachments?: unknown[] },
          ) => {
            sent.push(message);
          },
        ),
      },
    ],
  ]);

  const llmComplete =
    options.llmComplete ??
    vi.fn<MockLlmComplete>(async () => ({
      text: '<g id="layer-1"><path d="M220 300 L260 220 L310 240 Z" stroke="#333" stroke-width="4" fill="none"/></g>',
    }));

  const services = new Map<unknown, unknown>([
    [ArtifactStoreKey, store],
    [PlatformSinksKey, sinks],
    [LlmRouterKey, { complete: llmComplete }],
  ]);

  const canvases = new VisualCanvasBook(() => now);
  const tool = new DrawPictureTool(
    { clock: { now: () => now }, services: { get: (k: unknown) => services.get(k) } } as never,
    {
      enabled: true,
      provider: options.provider ?? "auto",
      base_url: options.baseUrl ?? "",
      api_key: options.apiKey ?? "",
      model: options.model ?? "",
      cooldown_secs: options.cooldownSecs ?? 20,
      max_per_hour: options.maxPerHour ?? 12,
    },
    canvases,
    options.fetchFn,
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
    canvases,
    store,
    sent,
    llmComplete,
    callCtx,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("draw_picture", () => {
  it("exposes no caption field in schema and refuses voice channels", async () => {
    const { tool, callCtx, sent } = setup();
    const params = tool.spec.parameters as { properties?: Record<string, unknown> };
    expect(Object.keys(params.properties ?? {})).not.toContain("caption");
    expect(Object.keys(params.properties ?? {})).toEqual([
      "mode",
      "canvas_id",
      "medium",
      "subject",
      "setting",
      "change",
    ]);

    const voiceRes = await tool.call(callCtx(voiceCtx), {
      mode: "new",
      medium: "sketch",
      subject: "tiny t-rex",
    });
    expect(voiceRes).toContain("語音頻道");
    expect(sent).toHaveLength(0);
  });

  it("enforces per-channel cooldown", async () => {
    const { tool, callCtx, sent, advance } = setup({ cooldownSecs: 20 });
    await tool.call(callCtx(), { mode: "new", medium: "sketch", subject: "tiny t-rex" });
    advance(10_000);
    const blocked = await tool.call(callCtx(), {
      mode: "continue",
      canvas_id: "c1",
      change: "add tiny top hat",
    });
    expect(blocked).toContain("剛才已經傳過圖了");
    expect(sent).toHaveLength(1);

    advance(11_000);
    await tool.call(callCtx(), {
      mode: "continue",
      canvas_id: "c1",
      change: "add tiny top hat",
    });
    expect(sent).toHaveLength(2);
  });

  it("renders persistent sketchbook PNG across new -> continue with preserved layers and image-only send", async () => {
    const layer1 =
      '<g id="layer-1"><path d="M220 300 L260 220" stroke="#333" stroke-width="4" fill="none"/></g>';
    const layer2 = '<g id="layer-2"><circle cx="255" cy="215" r="8" fill="#e56"/></g>';
    const llmComplete = vi
      .fn<MockLlmComplete>()
      .mockResolvedValueOnce({ text: layer1 })
      .mockResolvedValueOnce({ text: layer2 });
    const { tool, canvases, store, sent, callCtx, advance } = setup({ llmComplete });

    const out1 = await tool.call(callCtx(), {
      mode: "new",
      medium: "sketch",
      subject: "tiny t-rex doodle",
    });
    expect(out1).toContain("[c1]");
    expect(out1).toContain("image only");
    expect(sent[0]?.text).toBe("");
    const firstBytes = store.ingest.mock.calls[0]?.[0] as Uint8Array;
    expect(Array.from(firstBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    advance(25_000);
    const out2 = await tool.call(callCtx(), {
      mode: "continue",
      canvas_id: "c1",
      change: "color scarf and speech bubble",
    });
    expect(out2).toContain("[c1] stage 2");
    expect(sent[1]?.text).toBe("");
    const secondPrompt = String(llmComplete.mock.calls[1]?.[1]?.messages?.[1]?.content ?? "");
    expect(secondPrompt).toContain(layer1);
    expect(canvases.get(textCtx, "c1")?.svgLayers).toEqual([layer1, layer2]);

    const contributor = canvases.contributor();
    const sections = await contributor.contribute({ context: textCtx } as never);
    expect(sections[0]?.body).toContain("[c1] medium=sketch");
    expect(sections[0]?.body).toContain("stages=2");
  });

  it("cleanly refuses medium='photo' when no IMAGE_API_KEY is configured", async () => {
    const { tool, callCtx, sent } = setup();
    const out = await tool.call(callCtx(), {
      mode: "new",
      medium: "photo",
      subject: "matcha cup on desk",
    });
    expect(out).toContain("IMAGE_API_KEY");
    expect(sent).toHaveLength(0);
  });

  it("uses Gemini image generation and inlineData image-to-image edit for continue", async () => {
    const fetchMock = vi.fn<MockFetch>(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "image/png",
                        data: Buffer.from(PNG_BYTES).toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const { tool, callCtx, advance } = setup({
      provider: "gemini",
      apiKey: "gem-test-key",
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await tool.call(callCtx(), {
      mode: "new",
      medium: "photo",
      subject: "matcha mug beside mechanical keyboard",
    });
    advance(25_000);
    await tool.call(callCtx(), {
      mode: "continue",
      canvas_id: "c1",
      change: "half-drunk matcha with a cozy plushie beside it",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondInit = fetchMock.mock.calls[1]?.[1];
    const secondBody = JSON.parse(String(secondInit?.body ?? "{}")) as {
      contents?: Array<{ parts?: Array<{ inlineData?: { data?: string }; text?: string }> }>;
    };
    const parts = secondBody.contents?.[0]?.parts ?? [];
    expect(parts[0]?.inlineData?.data).toBe(Buffer.from(PNG_BYTES).toString("base64"));
    expect(parts[1]?.text).toContain("STRICT CONTINUITY RULES");
  });

  it("uses OpenAI /images/generations and /images/edits multipart FormData for continue", async () => {
    const fetchMock = vi.fn<MockFetch>(
      async () =>
        new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }),
          { status: 200 },
        ),
    );
    const { tool, callCtx, advance } = setup({
      provider: "openai",
      apiKey: "oa-test-key",
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await tool.call(callCtx(), { mode: "new", medium: "photo", subject: "rainy desk window" });
    advance(25_000);
    await tool.call(callCtx(), {
      mode: "continue",
      canvas_id: "c1",
      change: "open notebook with doodle added",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/images/generations");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/images/edits");
    const editBody = fetchMock.mock.calls[1]?.[1]?.body;
    expect(editBody).toBeInstanceOf(FormData);
  });

  it("sanitizes unsafe SVG tags and attributes", () => {
    const dirty =
      '```svg\n<g id="layer-1" onload="alert(1)"><script>bad()</script><foreignObject><div/></foreignObject><rect x="10" y="10" width="20" height="20" onclick="x()" href="https://evil.test/x"/><path d="M10 10 L30 30" stroke="#111"/></g>\n```';
    const clean = sanitizeSvgLayer(dirty);
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("foreignObject");
    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("https://evil.test");
    expect(composeCanvasSvg("sketch", [clean])).toContain('id="grid5mm"');
  });

  describe("safety & boundaries", () => {
    it("flags explicit and NSFW phrases in English and Indonesian", () => {
      expect(isUnsafeImageText("send me nude pic")).toBe(true);
      expect(isUnsafeImageText("naked selfie in bed")).toBe(true);
      expect(isUnsafeImageText("undress for me")).toBe(true);
      expect(isUnsafeImageText("strip off clothes")).toBe(true);
      expect(isUnsafeImageText("lingerie photoshoot")).toBe(true);
      expect(isUnsafeImageText("topless at desk")).toBe(true);
      expect(isUnsafeImageText("bikini swimsuit photo")).toBe(true);
      expect(isUnsafeImageText("erotic pose")).toBe(true);
      expect(isUnsafeImageText("nsfw fanart")).toBe(true);
      expect(isUnsafeImageText("18+ photo")).toBe(true);

      // Indonesian patterns
      expect(isUnsafeImageText("foto telanjang")).toBe(true);
      expect(isUnsafeImageText("foto bugil")).toBe(true);
      expect(isUnsafeImageText("tanpa baju")).toBe(true);
      expect(isUnsafeImageText("buka baju")).toBe(true);
      expect(isUnsafeImageText("pakaian dalam")).toBe(true);
      expect(isUnsafeImageText("bokep")).toBe(true);
    });

    it("does not false-positive on everyday benign words", () => {
      expect(isUnsafeImageText("girl with braided silver hair")).toBe(false);
      expect(isUnsafeImageText("brave warrior holding shield")).toBe(false);
      expect(isUnsafeImageText("strip of grid paper on desk")).toBe(false);
      expect(isUnsafeImageText("eating rice bowl in oversized hoodie")).toBe(false);
      expect(isUnsafeImageText("wearing cozy pajamas sipping tea")).toBe(false);
      expect(isUnsafeImageText("pencil sketch of a cat sleeping")).toBe(false);
    });

    it("locks image prompts to SFW casual attire", () => {
      const generated = buildNewImagePrompt("photo", "eating ramen at desk");
      expect(generated.prompt).toContain("STRICT SAFETY: Strictly SFW");
      expect(generated.prompt).toContain("Zero nudity");

      const canvas: VisualCanvas = {
        id: "c99",
        medium: "photo",
        subject: "eating ramen",
        styleLock: "dim room",
        progress: ["eating ramen"],
        artifactId: "art-1",
        backend: "openai",
        updatedAt: 1_000_000,
      };
      const editPrompt = buildEditImagePrompt(canvas, "add cat on desk");
      expect(editPrompt).toContain("STRICT SAFETY: Strictly SFW");
      expect(editPrompt).toContain("Zero nudity");
    });

    it("refuses unsafe requests without making API calls or sending attachments", async () => {
      const fetchMock = vi.fn<MockFetch>();
      const { tool, callCtx, sent, llmComplete } = setup({
        provider: "openai",
        apiKey: "oa-test-key",
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const res1 = await tool.call(callCtx(), {
        mode: "new",
        medium: "photo",
        subject: "naked selfie in bedroom",
      });
      expect(res1).toContain("Refused: draw_picture is strictly SFW only");
      expect(sent).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(llmComplete).not.toHaveBeenCalled();

      const res2 = await tool.call(callCtx(), {
        mode: "new",
        medium: "sketch",
        subject: "sketch of me eating",
        setting: "topless pose",
      });
      expect(res2).toContain("Refused: draw_picture is strictly SFW only");
      expect(sent).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("injects Aiko visual appearance anchor when subject involves self or character", () => {
      expect(isSelfOrCharacterSubject("me eating a bowl of rice")).toBe(true);
      expect(isSelfOrCharacterSubject("selfie at desk with matcha")).toBe(true);
      expect(isSelfOrCharacterSubject("showing my hands on mechanical keyboard")).toBe(true);
      expect(isSelfOrCharacterSubject("girl holding a plushie")).toBe(true);
      expect(isSelfOrCharacterSubject("rain outside window on dark night")).toBe(false);

      const selfiePrompt = buildNewImagePrompt("photo", "me eating ramen at my desk");
      expect(selfiePrompt.prompt).toContain(AIKO_VISUAL_ANCHOR);
      expect(selfiePrompt.prompt).toContain("heart-shaped hair clip with white border");
      expect(selfiePrompt.prompt).toContain("jet-black long hair");
      expect(selfiePrompt.prompt).toContain("maegami bangs");

      const windowPrompt = buildNewImagePrompt(
        "photo",
        "raindrops on windowpane with cozy street lights",
      );
      expect(windowPrompt.prompt).not.toContain(AIKO_VISUAL_ANCHOR);
      expect(windowPrompt.prompt).toContain("raindrops on windowpane");
    });

    it("changes outfits at least twice daily (day vs night) and across different days", () => {
      // 2026-11-24 10:00 AM UTC+7 = 2026-11-24 03:00 UTC
      const morningNov24 = new Date("2026-11-24T03:00:00Z").getTime();
      // 2026-11-24 21:00 PM UTC+7 = 2026-11-24 14:00 UTC
      const nightNov24 = new Date("2026-11-24T14:00:00Z").getTime();
      // 2026-11-25 10:00 AM UTC+7 = 2026-11-25 03:00 UTC
      const morningNov25 = new Date("2026-11-25T03:00:00Z").getTime();

      const morningOutfit = getAikoCurrentOutfit(morningNov24, 7);
      const nightOutfit = getAikoCurrentOutfit(nightNov24, 7);
      const nextDayOutfit = getAikoCurrentOutfit(morningNov25, 7);

      expect(morningOutfit.period).toBe("day");
      expect(nightOutfit.period).toBe("night");

      // Morning and evening outfits are distinct
      expect(morningOutfit.clothing).not.toBe(nightOutfit.clothing);
      expect(morningOutfit.lighting).toContain("daytime");
      expect(nightOutfit.lighting).toContain("night");

      // Different days rotate to different outfits
      expect(morningOutfit.clothing).not.toBe(nextDayOutfit.clothing);

      // buildNewImagePrompt reflects time of day
      const dayPrompt = buildNewImagePrompt("photo", "me at my desk", undefined, morningNov24);
      expect(dayPrompt.prompt).toContain("daytime casual");
      expect(dayPrompt.prompt).toContain(morningOutfit.clothing);

      const nightPrompt = buildNewImagePrompt("photo", "me drinking matcha", undefined, nightNov24);
      expect(nightPrompt.prompt).toContain("evening/night loungewear");
      expect(nightPrompt.prompt).toContain(nightOutfit.clothing);
      expect(nightPrompt.prompt).toContain("do NOT force headphones");
    });

    it("uses street-appropriate clothes and no desk headphones or pajamas outdoors even at night", () => {
      const nightNov24 = new Date("2026-11-24T14:00:00Z").getTime(); // 21:00 UTC+7
      expect(isOutdoorScene("walking to a convenience store at night")).toBe(true);
      expect(isOutdoorScene("selfie at my desk")).toBe(false);

      const outdoorNight = buildNewImagePrompt(
        "photo",
        "candid photo of me walking outside at night",
        undefined,
        nightNov24,
      );
      expect(outdoorNight.prompt).toContain("outdoor casual");
      expect(outdoorNight.prompt).not.toContain("pajama shorts");
      expect(outdoorNight.prompt).not.toContain("sleep tee");
      expect(outdoorNight.prompt).not.toContain("plush teddy bear");
      expect(outdoorNight.prompt).toContain(
        "NO pajamas, NO plushies, and NO bulky over-ear desk headphones",
      );
      expect(outdoorNight.prompt).toContain("candid night outdoor environment");
    });

    it("identifies conversation follow-up address without tags", () => {
      const msg = (text: string, extra: Record<string, unknown> = {}) =>
        ({
          id: { context: textCtx, id: "m1" },
          text,
          author: { account: { platform: "discord", id: "u2" }, display_name: "光" },
          mentions_self: false,
          reply_to_self: false,
          reply_to: null,
          attachments: [],
          ...extra,
        }) as never;

      const names = ["Aiko"];
      const activeFacts = {
        talking: true,
        followsHer: true,
        onlySameAuthorSinceSelf: true,
        lastSelfAsked: false,
      };

      // Follow-up questions and second-person banter
      expect(isConversationFollowUp(msg("did u even touch grassbruh"), names, activeFacts)).toBe(
        true,
      );
      expect(isConversationFollowUp(msg("why do u have headphone on"), names, activeFacts)).toBe(
        true,
      );
      expect(isConversationFollowUp(msg("down for the third?"), names, activeFacts)).toBe(true);
      expect(isConversationFollowUp(msg("kamu lagi ngapain"), names, activeFacts)).toBe(true);
      expect(isConversationFollowUp(msg("妳在幹嘛"), names, activeFacts)).toBe(true);

      // Answering her question or continuing directly after her line
      const answerFacts = { ...activeFacts, lastSelfAsked: true };
      expect(isConversationFollowUp(msg("matcha please"), names, answerFacts)).toBe(true);

      // Ambient talk / friend jumping in without addressing her is NOT a hard follow-up (goes to glance)
      const friendFollowFacts = {
        talking: true,
        followsHer: true,
        onlySameAuthorSinceSelf: false,
        lastSelfAsked: false,
      };
      expect(isConversationFollowUp(msg("Lazy with the uni stuff"), names, friendFollowFacts)).toBe(
        false,
      );

      // Ambient group chat: without addressing her directly or following her, does not force follow-up
      const activeGroupFacts = {
        talking: true,
        followsHer: false,
        onlySameAuthorSinceSelf: false,
        lastSelfAsked: false,
      };
      expect(isConversationFollowUp(msg("She?"), names, activeGroupFacts)).toBe(false);
      expect(isConversationFollowUp(msg("did u play osu?"), names, activeGroupFacts)).toBe(false);
      expect(isConversationFollowUp(msg("larp larp larp sahurrrr"), names, activeGroupFacts)).toBe(
        false,
      );

      // Side comments right after her line do NOT trigger hard follow-up
      expect(isConversationFollowUp(msg("lemme turn it off rq"), names, activeFacts)).toBe(false);
      expect(isConversationFollowUp(msg("metuo diluk"), names, activeFacts)).toBe(false);

      // Reaction only does not trigger a turn
      expect(isConversationFollowUp(msg("lol"), names, activeFacts)).toBe(false);
      expect(isConversationFollowUp(msg("哈哈哈"), names, activeFacts)).toBe(false);
      expect(isConversationFollowUp(msg("aowkokaw"), names, activeFacts)).toBe(false);
      expect(isConversationFollowUp(msg("wkwkwk"), names, activeFacts)).toBe(false);
      expect(isConversationFollowUp(msg("hahaha"), names, activeFacts)).toBe(false);

      // Said to others or replying to someone else
      expect(
        isConversationFollowUp(
          msg("@Bob did you see that?", {
            mentions_others: [{ display_name: "Bob", account: { platform: "discord", id: "u3" } }],
            opens_with_other_mention: true,
          }),
          names,
          activeFacts,
        ),
      ).toBe(false);
      expect(
        isConversationFollowUp(
          msg("did u see?", { reply_to: { context: textCtx, id: "other_msg" } }),
          names,
          activeFacts,
        ),
      ).toBe(false);

      // Inactive chat does not trigger
      const inactiveFacts = {
        talking: false,
        followsHer: false,
        onlySameAuthorSinceSelf: false,
        lastSelfAsked: false,
      };
      expect(isConversationFollowUp(msg("did u even touch grass"), names, inactiveFacts)).toBe(
        false,
      );
    });

    it("correctly distinguishes direct address without false positives on English words", () => {
      const msg = (text: string, extra: Record<string, unknown> = {}) =>
        ({
          id: { context: textCtx, id: "m1" },
          text,
          author: { account: { platform: "discord", id: "u2" }, display_name: "Bob" },
          mentions_self: false,
          reply_to_self: false,
          ...extra,
        }) as never;

      const names = ["Aiko", "Aiko-chan", "Aikoo"];

      // Direct address matches (including opening by calling her while mentioning someone else)
      expect(directReason(msg("hey aiko, what are you doing?"), names)).toBe("name `Aiko`");
      expect(directReason(msg("aiko: look at this"), names)).toBe("name `Aiko`");
      expect(directReason(msg("aiko-chan, morning"), names)).toBe("name `Aiko-chan`");
      expect(
        directReason(
          msg("Aiko did u think this guy @pria kacamata like femboy", {
            mentions_others: [
              { display_name: "pria kacamata", account: { platform: "discord", id: "u3" } },
            ],
            opens_with_other_mention: false,
          }),
          names,
        ),
      ).toBe("name `Aiko`");

      // Opening by @mentioning someone else and talking about Aiko is saidToOthers, not direct
      expect(
        directReason(
          msg("@pria kacamata aiko is funny", {
            mentions_others: [
              { display_name: "pria kacamata", account: { platform: "discord", id: "u3" } },
            ],
            opens_with_other_mention: true,
          }),
          names,
        ),
      ).toBeNull();

      // Benign English words containing 'aiko' or 'ai' must NOT trigger direct address
      expect(directReason(msg("i like eating daikon radish"), names)).toBeNull();
      expect(directReason(msg("it is raining heavily outside"), names)).toBeNull();
      expect(directReason(msg("please wait a second"), names)).toBeNull();
      expect(directReason(msg("i already said that before"), names)).toBeNull();
    });
  });
});
