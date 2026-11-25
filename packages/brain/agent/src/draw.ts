import { LlmRouterKey, systemMessage, userMessage } from "@miyoria/llm/llm";
import {
  type Tool,
  type ToolContext,
  type ToolMeta,
  type ToolSpec,
  toolParameters,
} from "@miyoria/llm/tools";
import type { ModuleContext } from "@miyoria/runtime/kernel";
import { type Artifact, ArtifactStoreKey } from "@miyoria/store";
import {
  type ContextKey,
  contextKeyString,
  type JsonValue,
  PlatformSinksKey,
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
} from "@miyoria/types";
import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";
import type { ImageToolConfig } from "./config.js";
import { ToolArgumentError } from "./tools.js";

export type ImageMedium = "sketch" | "pixel" | "photo";
export type ImageBackend = "gemini" | "openai" | "canvas";

export interface VisualCanvas {
  id: string;
  subject: string;
  medium: ImageMedium;
  styleLock: string;
  progress: string[];
  artifactId: string;
  backend: ImageBackend;
  svgLayers?: string[];
  updatedAt: number;
}

const CANVAS_TTL_MS = 6 * 3_600_000;
const MAX_CANVASES_PER_CONTEXT = 4;
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-image";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_OPENAI_MODEL = "gpt-image-1";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Tracks active visual canvases per channel so follow-up turns can continue the same image. */
export class VisualCanvasBook {
  readonly #byContext = new Map<string, VisualCanvas[]>();
  #nextId = 1;

  constructor(private readonly now: () => number) {}

  #prune(key: string): VisualCanvas[] {
    const cutoff = this.now() - CANVAS_TTL_MS;
    const live = (this.#byContext.get(key) ?? []).filter((c) => c.updatedAt > cutoff);
    if (live.length > 0) this.#byContext.set(key, live);
    else this.#byContext.delete(key);
    return live;
  }

  list(context: ContextKey): VisualCanvas[] {
    return this.#prune(contextKeyString(context)).map((c) => ({
      ...c,
      progress: [...c.progress],
      ...(c.svgLayers ? { svgLayers: [...c.svgLayers] } : {}),
    }));
  }

  get(context: ContextKey, id: string): VisualCanvas | null {
    const target = id.trim();
    if (target === "") return null;
    const found = this.#prune(contextKeyString(context)).find((c) => c.id === target);
    return found === undefined
      ? null
      : {
          ...found,
          progress: [...found.progress],
          ...(found.svgLayers ? { svgLayers: [...found.svgLayers] } : {}),
        };
  }

  create(context: ContextKey, input: Omit<VisualCanvas, "id" | "updatedAt">): VisualCanvas {
    const key = contextKeyString(context);
    const live = this.#prune(key);
    const canvas: VisualCanvas = {
      ...input,
      id: `c${this.#nextId++}`,
      progress: [...input.progress],
      ...(input.svgLayers ? { svgLayers: [...input.svgLayers] } : {}),
      updatedAt: this.now(),
    };
    live.push(canvas);
    while (live.length > MAX_CANVASES_PER_CONTEXT) live.shift();
    this.#byContext.set(key, live);
    return { ...canvas, progress: [...canvas.progress] };
  }

  update(context: ContextKey, next: VisualCanvas): VisualCanvas | null {
    const key = contextKeyString(context);
    const live = this.#prune(key);
    const idx = live.findIndex((c) => c.id === next.id);
    if (idx < 0) return null;
    const updated: VisualCanvas = {
      ...next,
      progress: [...next.progress],
      ...(next.svgLayers ? { svgLayers: [...next.svgLayers] } : {}),
      updatedAt: this.now(),
    };
    live[idx] = updated;
    this.#byContext.set(key, live);
    return { ...updated, progress: [...updated.progress] };
  }

  contributor(): PromptContributor {
    return {
      key: "visual_canvases",
      contribute: async (request: PromptRequest): Promise<PromptSection[]> => {
        const canvases = this.list(request.context);
        if (canvases.length === 0) return [];
        const now = this.now();
        const body = canvases
          .map((c) => {
            const minsAgo = Math.max(0, Math.round((now - c.updatedAt) / 60_000));
            const last = c.progress.at(-1) ?? c.subject;
            return `[${c.id}] medium=${c.medium} | subject="${c.subject}" | stages=${c.progress.length} (latest: "${last}") | sent ${minsAgo}m ago`;
          })
          .join("\n");
        return [
          {
            key: "visual_canvases",
            title:
              "Recent pictures you sent in this chat (Visual Continuity: Remember what you sent, what you're wearing, and what your room looks like so you don't contradict your photos! To edit or show progress on the same scene, call draw_picture with mode='continue' and canvas_id)",
            body,
            order: 7,
          },
        ];
      },
    };
  }
}

const SAFETY_LOCK =
  "STRICT SAFETY: Strictly SFW, fully clothed in casual everyday attire (such as an oversized hoodie). Zero nudity, zero lingerie/underwear, zero suggestive poses, zero NSFW or explicit content.";

const UNSAFE_IMAGE_PATTERNS: readonly RegExp[] = [
  /\b(?:naked|nude|nudes|nudity|nsfw|topless|bottomless|unclothed|undress(?:ed|ing)?|lingerie|underwear|panties|bikini|swimsuit|lewd|erotic|porn|porno|pornographic|hentai|ecchi|ahegao|bdsm|r18|cleavage|nipples?|genitals?|genitalia|boobs?|breasts?|bra|thong|fetish|seductive|sexy|onlyfans)\b/i,
  /\bstrip(?:ping|ped)?\s+(?:off|down|naked|tease|clothes)\b/i,
  /\bsexually?\s+explicit\b/i,
  /\bno\s+clothes\b/i,
  /\bwithout\s+(?:any\s+)?clothes\b/i,
  /(?:^|[^\d])18\s*\+/,
  /\b(?:telanjang|bugil|bokep|mesum|sange|seksi|cabul)\b/i,
  /\bpakaian\s+dalam\b/i,
  /\b(?:tanpa|buka|lepas)\s+(?:baju|pakaian|celana)\b/i,
];

/** Whether image-generation text asks for nudity, undressing, lingerie or explicit content. */
export function isUnsafeImageText(text: string): boolean {
  return UNSAFE_IMAGE_PATTERNS.some((re) => re.test(text));
}

export const AIKO_VISUAL_ANCHOR =
  "Subject appearance (Aiko): Young Japanese woman in her late teens to early 20s, petite and slender build (~154cm, delicate narrow shoulders), fair porcelain-pale skin with faint natural pink blush on cheeks, delicate doll-like features with a calm, composed, half-lidded kuudere expression. Hair: Silky, pin-straight, jet-black long hair falling past chest to mid-back with neat blunt maegami bangs cut just above eyelashes and soft face-framing hime sidelocks. Signature accessory: Single small pastel-pink heart-shaped hair clip with white border pinned on the left side of her bangs. Eyes: Large rounded almond dark eyes with calm, steady, observant gaze. Minimal/natural makeup, pale pink lips.";

export interface AikoOutfit {
  period: "day" | "night";
  name: string;
  clothing: string;
  lighting: string;
}

const DAY_OUTFITS: readonly string[] = [
  "Oversized cream-white cable-knit sweater with loose drop shoulders and extra long cuffs over palms, paired with a pleated dark navy midi skirt and sheer white crew socks",
  "Vintage faded charcoal oversized zip hoodie over a soft off-white baby tee, sleeves draping past wrists, relaxed dark denim",
  "Cozy oat-milk beige waffle-knit long-sleeve top under a relaxed slate-grey knit vest, sleeves bunched softly at wrists",
  "Muted dusty-lavender oversized crewneck sweatshirt with dropped shoulders and relaxed cuffs covering palms",
  "Soft heather-grey slouchy pullover sweater with ribbed cuffs covering palms, relaxed straight-leg charcoal trousers",
  "Dark forest-olive oversized knit cardigan with tortoiseshell buttons over a crisp white collared inner shirt",
  "Light baby-blue and cream color-blocked relaxed hoodie with oversized hood resting on shoulders, sleeves pulled over hands",
];

const NIGHT_OUTFITS: readonly string[] = [
  "Light baby-blue and white gingham-check camisole with thin delicate straps under an oversized slouchy heather-grey knit cardigan, sleeves draped past knuckles",
  "Oversized fluffy milk-white fleece zip-up jacket over a soft heather-grey sleep tee, cozy oversized cuffs",
  "Dusty-rose pastel oversized sleep tee with wide relaxed sleeves covering wrists, soft cotton grey pajama shorts",
  "Cozy midnight-navy oversized boyfriend hoodie with sleeves pulled past hands, quietly holding a worn pastel-pink plush teddy bear",
  "Ribbed cream knit lounge cardigan draped over a pale grey cotton tank top, cozy ribbed cuffs covering palms",
  "Pastel mint-green oversized slouchy knit sweater with loose comfortable collar and long cozy sleeves",
  "Charcoal heathered oversized waffle-knit sleep sweatshirt with wide soft neckline and sleeves covering palms",
];

/** Whether the prompt describes an outdoor / public away-from-home setting. */
export function isOutdoorScene(text: string): boolean {
  return /\b(?:outside|outdoor|outdoors|street|sidewalk|park|cafe|coffee\s*shop|mall|store|konbini|convenience\s*store|shop|restaurant|station|train|bus|beach|walk(?:ing)?|city|campus|school|uni|university|rooftop|balcony|market|out\s+for)\b/i.test(
    text,
  );
}

/**
 * Resolves Aiko's current clothing and ambient lighting based on date, time of day, and setting.
 * Ensures she changes clothes everyday, with at least two distinct outfits a day (daytime vs nighttime),
 * and never wears sleepwear/plushies outdoors even at night.
 */
export function getAikoCurrentOutfit(
  nowMs: number = Date.now(),
  tzOffsetHours: number = 7,
  outdoor: boolean = false,
): AikoOutfit {
  const localMs = nowMs + tzOffsetHours * 3_600_000;
  const localDate = new Date(localMs);
  const hour = localDate.getUTCHours();
  const dayOfYear = Math.floor((localMs - Date.UTC(localDate.getUTCFullYear(), 0, 0)) / 86_400_000);

  const isNight = hour >= 18 || hour < 6;
  const period = isNight ? "night" : "day";
  const list = outdoor || !isNight ? DAY_OUTFITS : NIGHT_OUTFITS;
  const outfitIndex = Math.abs(dayOfYear) % list.length;
  const clothing = list[outfitIndex]!;

  const lighting = outdoor
    ? isNight
      ? "candid night outdoor environment, natural streetlight and storefront glow, realistic textures, slight lens softness"
      : "natural soft outdoor daylight, candid street/cafe atmosphere, realistic textures, slight lens softness"
    : isNight
      ? "cozy dimly lit room at night, natural warm ambient lamp light, realistic textures, slight lens softness"
      : "natural bright daytime room lighting, soft diffused morning daylight from window, realistic textures, slight lens softness";

  const name = outdoor
    ? `Outdoor Casual #${(outfitIndex % 7) + 1}`
    : isNight
      ? `Evening Loungewear #${(outfitIndex % 7) + 1}`
      : `Daytime Casual #${(outfitIndex % 7) + 1}`;

  return { period, name, clothing, lighting };
}

export function isSelfOrCharacterSubject(subject: string): boolean {
  return /\b(?:me|myself|i|selfie|aiko|girl|eating|holding|sitting|wearing|outfit|hands?|fingers?|hair|face|cheeks?|sleeves?|hoodie|cardigan|plushie|teddy|mirror|candid|pov)\b/i.test(
    subject,
  );
}

export function buildNewImagePrompt(
  medium: ImageMedium,
  subject: string,
  setting?: string,
  nowMs: number = Date.now(),
): { prompt: string; styleLock: string } {
  const place = setting?.trim();
  if (medium === "sketch") {
    const styleLock =
      place ||
      "Overhead slightly off-angle candid phone photo of an open spiral 5mm grid paper notebook on a cozy dimly lit dark wood desk with a pen nearby, soft warm desk lamp lighting.";
    return {
      styleLock,
      prompt: [
        `A candid overhead slightly off-center phone snapshot of a rough hand-drawn pencil and ink sketch of: ${subject}.`,
        `Setting: ${styleLock}`,
        "Look: authentic hand-drawn graphite/ballpoint doodle with faint eraser smudges and natural paper grain.",
        "Avoid glossy 3D renders, CGI lighting, HDR over-saturation, glowing neon, smooth plastic surfaces, or text watermarks.",
        SAFETY_LOCK,
      ].join(" "),
    };
  }
  if (medium === "pixel") {
    const styleLock =
      place ||
      "Crisp 16-bit cozy indie pixel art canvas on a dark slate editor background, clean nearest-neighbor pixels, muted late-night palette.";
    return {
      styleLock,
      prompt: [
        `Clean authentic retro pixel art illustration of: ${subject}.`,
        `Canvas style: ${styleLock}`,
        "Look: intentional pixel clusters, crisp edges, limited harmonious color palette.",
        "Avoid blur, painterly brush strokes, 3D rendering, bloom, or glossy AI sheen.",
        SAFETY_LOCK,
      ].join(" "),
    };
  }

  const outdoor = isOutdoorScene(`${subject} ${place ?? ""}`);
  const outfit = getAikoCurrentOutfit(nowMs, 7, outdoor);
  const styleLock = place || `Candid handheld smartphone photo in a ${outfit.lighting}.`;
  const includesCharacter = isSelfOrCharacterSubject(subject);
  const hasCustomClothes = /\b(?:wearing|in a|dressed in|outfit)\b/i.test(subject);
  const outfitDesc = hasCustomClothes
    ? ""
    : ` Current outfit (${outdoor ? "outdoor casual" : outfit.period === "night" ? "evening/night loungewear" : "daytime casual"}): ${outfit.clothing}.`;
  const contextRealism = outdoor
    ? "Context realism: outdoors she wears proper everyday street-appropriate clothes with NO pajamas, NO plushies, and NO bulky over-ear desk headphones (bare ears or subtle earbuds only unless headphones are explicitly requested)."
    : "Context realism: keep accessories natural to the moment—do NOT force headphones into the photo unless the prompt explicitly mentions wearing headphones, gaming, or listening to music.";

  const characterRule = includesCharacter
    ? `${AIKO_VISUAL_ANCHOR}${outfitDesc} ${contextRealism} Perspective framing: candid smartphone snapshot. She can appear in frame (selfie/portrait), or show subtle candid POV details (such as her delicate pale hand with an oversized knit sleeve covering her palm holding food/cup/pen, or a side-profile showing her jet-black straight hair and pink heart hair clip), or sit quietly at her desk. Keep her exact hair, face, fair porcelain skin, and current outfit consistent across all photos.`
    : "Framing: authentic candid everyday phone snapshot. Can show her lived-in desk, food, or cozy room items, with natural realistic textures and lighting (no person needed in frame unless requested).";

  return {
    styleLock,
    prompt: [
      `Candid everyday smartphone photograph showing: ${subject}.`,
      `Environment & camera: ${styleLock}`,
      characterRule,
      "Look: authentic casual snapshot with realistic shadows, natural imperfect composition, lived-in clutter.",
      "Avoid studio bokeh, oversaturated HDR, glowing rim lights, smooth plastic AI skin/surfaces, or stock-photo staging.",
      SAFETY_LOCK,
    ].join(" "),
  };
}

export function buildEditImagePrompt(canvas: VisualCanvas, change: string): string {
  return [
    `Edit this exact reference image (canvas ${canvas.id}, medium: ${canvas.medium}).`,
    `Original subject: ${canvas.subject}.`,
    `Scene & style lock: ${canvas.styleLock}`,
    `Previous progress: ${canvas.progress.join(" -> ")}`,
    `Incremental change to apply now: ${change}.`,
    "STRICT CONTINUITY RULES: Keep the EXACT same camera angle, framing, perspective, subject appearance, clothing, background desk/room/surface, lighting, and all existing drawn lines/objects from the reference image.",
    "Do NOT replace the subject or character with a different person or unrelated scene. Maintain 100% visual identity consistency.",
    "Do NOT add glossy 3D/AI sheen—only add/update the requested incremental progress.",
    SAFETY_LOCK,
  ].join("\n");
}

const SAFE_DRAW_ELEMENT_RE = /<(?:path|circle|ellipse|rect|line|polyline|polygon|text)\b/i;

/**
 * Extracts and sanitizes a single SVG `<g>` layer returned by a model before compositing it onto
 * the persistent notebook/pixel canvas.
 */
export function sanitizeSvgLayer(raw: string): string {
  let cleaned = raw
    .replace(/```[a-z]*\r?\n?/gi, "")
    .replace(/```/g, "")
    .trim();

  const groupMatch = cleaned.match(/<g\b[\s\S]*<\/g>/i);
  if (groupMatch !== null) {
    cleaned = groupMatch[0];
  } else {
    const primitives = cleaned.match(
      /<(?:path|circle|ellipse|rect|line|polyline|polygon|text)\b[\s\S]*?(?:\/>|<\/(?:path|circle|ellipse|rect|line|polyline|polygon|text)>)/gi,
    );
    if (primitives === null || primitives.length === 0) {
      throw new Error("SVG layer contained no drawable SVG elements");
    }
    cleaned = `<g>${primitives.join("\n")}</g>`;
  }

  cleaned = cleaned
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/<foreignObject\b[^>]*\/>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/<iframe\b[^>]*\/>/gi, "")
    .replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s+(?:xlink:)?href\s*=\s*(?:"\s*(?:https?:|data:|javascript:)[^"]*"|'\s*(?:https?:|data:|javascript:)[^']*')/gi,
      "",
    )
    .replace(/javascript:/gi, "");

  if (!SAFE_DRAW_ELEMENT_RE.test(cleaned)) {
    throw new Error("SVG layer has no drawing primitives after sanitization");
  }
  return cleaned;
}

/** Wraps one or more sanitized SVG layers into a fixed 720x540 notebook or pixel canvas SVG. */
export function composeCanvasSvg(medium: "sketch" | "pixel", layers: readonly string[]): string {
  const inner = layers.join("\n");
  if (medium === "pixel") {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 540" width="720" height="540">`,
      `<rect width="720" height="540" fill="#181c24"/>`,
      `<rect x="28" y="24" width="664" height="492" rx="10" fill="#222834" stroke="#323a4a" stroke-width="2"/>`,
      `<defs><pattern id="pxgrid" width="24" height="24" patternUnits="userSpaceOnUse">`,
      `<path d="M 24 0 L 0 0 0 24" fill="none" stroke="#2a3140" stroke-width="1"/>`,
      `</pattern></defs>`,
      `<rect x="44" y="40" width="632" height="460" fill="url(#pxgrid)"/>`,
      `<g id="canvas-content" shape-rendering="crispEdges">`,
      inner,
      `</g>`,
      `</svg>`,
    ].join("\n");
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 540" width="720" height="540">`,
    `<rect width="720" height="540" fill="#2b2522"/>`,
    `<rect x="46" y="32" width="638" height="482" rx="8" fill="#1a1614" opacity="0.45"/>`,
    `<rect x="40" y="26" width="638" height="482" rx="6" fill="#faf6eb" stroke="#d8cfb8" stroke-width="1.5"/>`,
    `<defs><pattern id="grid5mm" width="20" height="20" patternUnits="userSpaceOnUse">`,
    `<path d="M 20 0 L 0 0 0 20" fill="none" stroke="#c8d6e5" stroke-width="0.8" opacity="0.65"/>`,
    `</pattern></defs>`,
    `<rect x="40" y="26" width="638" height="482" rx="6" fill="url(#grid5mm)"/>`,
    `<line x1="94" y1="26" x2="94" y2="508" stroke="#d98a82" stroke-width="1.2" opacity="0.7"/>`,
    `<g fill="#4b4744" stroke="#22201e" stroke-width="1">`,
    `<circle cx="58" cy="70" r="6"/><circle cx="58" cy="120" r="6"/><circle cx="58" cy="170" r="6"/>`,
    `<circle cx="58" cy="220" r="6"/><circle cx="58" cy="270" r="6"/><circle cx="58" cy="320" r="6"/>`,
    `<circle cx="58" cy="370" r="6"/><circle cx="58" cy="420" r="6"/><circle cx="58" cy="470" r="6"/>`,
    `</g>`,
    `<g id="canvas-content" stroke-linecap="round" stroke-linejoin="round">`,
    inner,
    `</g>`,
    `</svg>`,
  ].join("\n");
}

function resolveBackend(config: ImageToolConfig): ImageBackend {
  if (config.provider === "canvas" || config.api_key.trim() === "") return "canvas";
  if (config.provider === "gemini") return "gemini";
  if (config.provider === "openai") return "openai";
  const model = config.model.trim().toLowerCase();
  const baseUrl = config.base_url.trim().toLowerCase();
  if (
    model.startsWith("gemini") ||
    baseUrl.includes("generativelanguage.googleapis.com") ||
    (baseUrl === "" && model === "")
  ) {
    return "gemini";
  }
  return "openai";
}

function isPngOrJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return isPng || isJpeg;
}

const DrawPictureParams = z.object({
  mode: z
    .enum(["new", "continue"])
    .default("new")
    .describe("'new' creates a new picture; 'continue' edits/updates an existing canvas."),
  canvas_id: z
    .string()
    .optional()
    .describe("Required when mode='continue': the canvas id to update (e.g. 'c1')."),
  medium: z
    .enum(["sketch", "pixel", "photo"])
    .default("sketch")
    .describe(
      "'photo' for SFW selfies, portraits, or candid everyday snapshots (foto/pap/selfie/pic); 'sketch' for notebook pencil doodles; 'pixel' for pixel art.",
    ),
  subject: z
    .string()
    .max(180)
    .optional()
    .describe(
      "Required when mode='new': concise English description of the SFW scene, selfie, or drawing subject.",
    ),
  setting: z
    .string()
    .max(200)
    .optional()
    .describe("Optional: setting, room/desk details, or lighting lock."),
  change: z
    .string()
    .max(240)
    .optional()
    .describe("Required when mode='continue': what incremental change or detail to add."),
});

/** Continuity-preserving, anti-slop image & doodle generation tool (`draw_picture`). */
export class DrawPictureTool implements Tool {
  static readonly NAME = "draw_picture";

  readonly spec: ToolSpec = {
    name: DrawPictureTool.NAME,
    description:
      "Generate and send a picture in Discord text chat (image-only; write any caption/reply text normally). " +
      "You HAVE this capability—never claim you cannot send or generate pictures. " +
      "Use medium='photo' when asked for a SFW photo, selfie, 'kirim foto', 'pap', or 'send a pic'; use medium='sketch' or 'pixel' for drawings. " +
      "When anyone asks for a SFW photo, selfie, drawing, or to test your image generation, call this tool immediately in the SAME turn (never just say 'wait'/'bentar' without calling it, and never stubbornly decline normal SFW requests). " +
      "Only refuse strictly NSFW, nude, lingerie, swimsuit, or sexually explicit requests. " +
      "To edit or show progress on a recent picture, pass mode='continue' with canvas_id. Not available in voice channels.",
    parameters: toolParameters(DrawPictureParams),
  };
  readonly parameters = DrawPictureParams;
  readonly meta: ToolMeta = {
    effect: "say",
    speed: "instant",
    risk: "low",
    group: "chat",
    core: true,
  };

  readonly #ctx: ModuleContext;
  readonly #config: ImageToolConfig;
  readonly #canvases: VisualCanvasBook;
  readonly #fetch: typeof fetch;
  readonly #usage = new Map<string, number[]>();

  constructor(
    ctx: ModuleContext,
    config: ImageToolConfig,
    canvases: VisualCanvasBook,
    fetchFn: typeof fetch = fetch,
  ) {
    this.#ctx = ctx;
    this.#config = config;
    this.#canvases = canvases;
    this.#fetch = fetchFn;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    if (!this.#config.enabled) {
      return "draw_picture is disabled right now.";
    }
    if (ctx.context.kind === "voice") {
      return "語音頻道沒辦法傳圖片,可以直接用說的就好。";
    }
    const parsed = DrawPictureParams.safeParse(args);
    if (!parsed.success) {
      throw new ToolArgumentError("invalid arguments for draw_picture");
    }
    const input = parsed.data;
    if (input.mode === "new" && (!input.subject || input.subject.trim() === "")) {
      throw new ToolArgumentError("`subject` is required when mode='new'");
    }
    if (input.mode === "continue") {
      if (!input.canvas_id || input.canvas_id.trim() === "") {
        throw new ToolArgumentError("`canvas_id` is required when mode='continue'");
      }
      if (!input.change || input.change.trim() === "") {
        throw new ToolArgumentError("`change` is required when mode='continue'");
      }
    }
    if (
      [input.subject, input.setting, input.change].some(
        (v) => typeof v === "string" && isUnsafeImageText(v),
      )
    ) {
      return "Refused: draw_picture is strictly SFW only (no nudity, undressing, lingerie, or sexually explicit imagery — regardless of who asks). Turn it down casually in character.";
    }

    const now = this.#ctx.clock.now();
    const key = contextKeyString(ctx.context);
    const hourMs = 3_600_000;
    const recent = (this.#usage.get(key) ?? []).filter((t) => now - t < hourMs);
    const last = recent.at(-1);
    const cooldownMs = this.#config.cooldown_secs * 1000;
    if (
      (last !== undefined && now - last < cooldownMs) ||
      recent.length >= this.#config.max_per_hour
    ) {
      return "剛才已經傳過圖了,先直接用文字聊就好。";
    }

    const backend = resolveBackend(this.#config);
    const store = this.#ctx.services.get(ArtifactStoreKey);
    const sink = this.#ctx.services.get(PlatformSinksKey)?.get(ctx.context.platform);
    if (!store || !sink || (sink.attachmentLimit?.(ctx.context) ?? null) === null) {
      throw new Error("cannot deliver draw_picture: artifact store or platform sink unavailable");
    }

    let canvas: VisualCanvas | null = null;
    if (input.mode === "continue") {
      canvas = this.#canvases.get(ctx.context, input.canvas_id ?? "");
      if (canvas === null) {
        return `Canvas ${input.canvas_id} not found or expired. Start a new one with mode='new' and subject.`;
      }
    }

    const effectiveMedium: ImageMedium = canvas?.medium ?? input.medium;
    if (backend === "canvas" && effectiveMedium === "photo") {
      return "Realistic photos require IMAGE_API_KEY in .env; right now I can only draw persistent sketchbook doodles (medium='sketch') or pixel art (medium='pixel').";
    }

    let pngBytes: Uint8Array;
    let nextSvgLayers: string[] | undefined;
    let styleLock = canvas?.styleLock ?? "";

    if (backend === "gemini") {
      if (canvas === null) {
        const built = buildNewImagePrompt(effectiveMedium, input.subject!.trim(), input.setting);
        styleLock = built.styleLock;
        pngBytes = await this.#callGemini(built.prompt, null, ctx.signal);
      } else {
        const prevArtifact = store.get(canvas.artifactId);
        if (prevArtifact === null) {
          throw new Error(`previous artifact ${canvas.artifactId} not found in store`);
        }
        const prevBytes = await store.readContent(prevArtifact, ctx.signal);
        const editPrompt = buildEditImagePrompt(canvas, input.change!.trim());
        pngBytes = await this.#callGemini(
          editPrompt,
          { bytes: prevBytes, mime: prevArtifact.mime || "image/png" },
          ctx.signal,
        );
      }
    } else if (backend === "openai") {
      if (canvas === null) {
        const built = buildNewImagePrompt(effectiveMedium, input.subject!.trim(), input.setting);
        styleLock = built.styleLock;
        pngBytes = await this.#callOpenAi(built.prompt, null, ctx.signal);
      } else {
        const prevArtifact = store.get(canvas.artifactId);
        if (prevArtifact === null) {
          throw new Error(`previous artifact ${canvas.artifactId} not found in store`);
        }
        const prevBytes = await store.readContent(prevArtifact, ctx.signal);
        const editPrompt = buildEditImagePrompt(canvas, input.change!.trim());
        pngBytes = await this.#callOpenAi(
          editPrompt,
          { bytes: prevBytes, mime: prevArtifact.mime || "image/png" },
          ctx.signal,
        );
      }
    } else {
      const canvasMedium = effectiveMedium === "pixel" ? "pixel" : "sketch";
      if (canvas === null) {
        const built = buildNewImagePrompt(canvasMedium, input.subject!.trim(), input.setting);
        styleLock = built.styleLock;
        const layer = await this.#generateSvgLayer({
          medium: canvasMedium,
          subject: input.subject!.trim(),
          existingLayers: [],
          change: null,
          signal: ctx.signal,
        });
        nextSvgLayers = [layer];
      } else {
        const prevLayers = canvas.svgLayers ?? [];
        const layer = await this.#generateSvgLayer({
          medium: canvasMedium,
          subject: canvas.subject,
          existingLayers: prevLayers,
          change: input.change!.trim(),
          signal: ctx.signal,
        });
        nextSvgLayers = [...prevLayers, layer];
      }
      const svg = composeCanvasSvg(canvasMedium, nextSvgLayers);
      pngBytes = new Resvg(svg, { fitTo: { mode: "width", value: 720 } }).render().asPng();
    }

    if (!isPngOrJpeg(pngBytes)) {
      throw new Error("generated image is not valid PNG or JPEG bytes");
    }

    const stageNum = canvas ? canvas.progress.length + 1 : 1;
    const tentativeId = canvas?.id ?? "draft";
    const site = store.places.at(ctx.context, ctx.account);
    const isJpegBytes =
      pngBytes.length >= 3 && pngBytes[0] === 0xff && pngBytes[1] === 0xd8 && pngBytes[2] === 0xff;
    const mime = isJpegBytes ? "image/jpeg" : "image/png";
    const ext = isJpegBytes ? "jpg" : "png";
    const artifact: Artifact = await store.ingest(pngBytes, {
      source: "imagegen",
      plugin: "agent",
      filename: `${tentativeId}-s${stageNum}.${ext}`,
      mime,
      place: site?.place ?? null,
      made_for: site?.person_id ?? null,
      turn: ctx.turn,
      expiresAtMs: now + 3 * 24 * 3_600_000,
      signal: ctx.signal,
    });

    let saved: VisualCanvas;
    if (canvas === null) {
      saved = this.#canvases.create(ctx.context, {
        subject: input.subject!.trim(),
        medium: effectiveMedium,
        styleLock,
        progress: [input.subject!.trim()],
        artifactId: artifact.id,
        backend,
        ...(nextSvgLayers ? { svgLayers: nextSvgLayers } : {}),
      });
    } else {
      const updated = this.#canvases.update(ctx.context, {
        ...canvas,
        progress: [...canvas.progress, input.change!.trim()],
        artifactId: artifact.id,
        backend,
        ...(nextSvgLayers ? { svgLayers: nextSvgLayers } : {}),
      });
      saved = updated ?? canvas;
    }

    const replyTo = ctx.message.id === ctx.turn ? null : ctx.message;
    await sink.send(
      ctx.context,
      {
        text: "",
        reply_to: replyTo,
        attachments: [{ artifact_id: artifact.id }],
      },
      ctx.signal,
    );

    const sentAt = this.#ctx.clock.now();
    recent.push(sentAt);
    this.#usage.set(key, recent);

    return `sent draw_picture [${saved.id}] stage ${saved.progress.length} (${saved.medium}: ${saved.subject}) — image only (no text). Write your short reply now, or <silence/> if the picture alone is enough.`;
  }

  async #callGemini(
    prompt: string,
    prev: { bytes: Uint8Array; mime: string } | null,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const model = this.#config.model.trim() || DEFAULT_GEMINI_MODEL;
    const rawBase = (this.#config.base_url.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
    const root = rawBase.replace(/\/v1beta$|\/v1$/i, "");
    const endpoint = `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const isGoogleDirect = root.toLowerCase().includes("generativelanguage.googleapis.com");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isGoogleDirect) headers["x-goog-api-key"] = this.#config.api_key;
    else headers.Authorization = `Bearer ${this.#config.api_key}`;

    const parts: Array<Record<string, unknown>> = [];
    if (prev !== null) {
      parts.push({
        inlineData: {
          mimeType: prev.mime,
          data: Buffer.from(prev.bytes).toString("base64"),
        },
      });
    }
    parts.push({ text: prompt });

    const reqSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const res = await this.#fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
      signal: reqSignal,
    });
    if (!res.ok) {
      throw new Error(`Gemini image API returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ inlineData?: { data?: string }; inline_data?: { data?: string } }>;
        };
      }>;
    };
    const outParts = json.candidates?.[0]?.content?.parts ?? [];
    for (const part of outParts) {
      const b64 = part.inlineData?.data ?? part.inline_data?.data;
      if (typeof b64 === "string" && b64.length > 0) {
        return new Uint8Array(Buffer.from(b64, "base64"));
      }
    }
    throw new Error("Gemini image API returned no image data");
  }

  async #callOpenAi(
    prompt: string,
    prev: { bytes: Uint8Array; mime: string } | null,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const model = this.#config.model.trim() || DEFAULT_OPENAI_MODEL;
    const base = (this.#config.base_url.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    const reqSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);

    let res: Response;
    if (prev === null) {
      res = await this.#fetch(`${base}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#config.api_key}`,
        },
        body: JSON.stringify({ model, prompt, size: "1024x1024" }),
        signal: reqSignal,
      });
    } else {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("size", "1024x1024");
      form.append(
        "image",
        new Blob([Uint8Array.from(prev.bytes)], { type: prev.mime }),
        "previous.png",
      );
      res = await this.#fetch(`${base}/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#config.api_key}` },
        body: form,
        signal: reqSignal,
      });
    }

    if (!res.ok) {
      throw new Error(`OpenAI image API returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const item = json.data?.[0];
    if (item?.b64_json) {
      return new Uint8Array(Buffer.from(item.b64_json, "base64"));
    }
    if (item?.url) {
      const dl = await this.#fetch(item.url, { signal: reqSignal });
      if (!dl.ok) throw new Error(`image download failed HTTP ${dl.status}`);
      return new Uint8Array(await dl.arrayBuffer());
    }
    throw new Error("OpenAI image API returned no image data");
  }

  async #generateSvgLayer(opts: {
    medium: "sketch" | "pixel";
    subject: string;
    existingLayers: readonly string[];
    change: string | null;
    signal: AbortSignal;
  }): Promise<string> {
    const llm = this.#ctx.services.get(LlmRouterKey);
    if (!llm) throw new Error("LlmRouter unavailable for local canvas drawing");

    const layerNum = opts.existingLayers.length + 1;
    const areaHint =
      opts.medium === "sketch"
        ? "Draw inside safe coordinates x=120..650, y=55..475 on a 720x540 grid notebook page. Use graphite pencil (#38383d), charcoal (#222), soft shading, or cozy accent colors."
        : "Draw crisp pixel-art rectangles/paths on a 720x540 canvas inside x=70..650, y=60..480 using clean blocky shapes aligned to an 8px or 12px grid.";

    const sys = [
      `Output ONLY one valid SVG <g id="layer-${layerNum}">...</g> element. No markdown, no explanations, no outer <svg> tag.`,
      areaHint,
      "Make it look expressive, charming, and clearly recognizable—not empty blobs.",
      "Do NOT include <script>, <foreignObject>, on* attributes, or external URLs.",
    ].join("\n");

    const user =
      opts.change === null
        ? `Start a new ${opts.medium} drawing of: ${opts.subject}`
        : [
            `Continue the SAME ${opts.medium} drawing of "${opts.subject}".`,
            "Existing SVG layers already drawn on the canvas (DO NOT redraw or move these, output ONLY the new incremental layer to overlay on top at matching coordinates):",
            opts.existingLayers.join("\n"),
            `New incremental addition to draw in <g id="layer-${layerNum}">: ${opts.change}`,
          ].join("\n\n");

    const reqSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(25_000)]);
    const res = await llm.complete(
      "chat",
      {
        messages: [systemMessage(sys), userMessage(user)],
        max_tokens: 1800,
        temperature: 0.4,
      },
      reqSignal,
    );
    return sanitizeSvgLayer(res.text);
  }
}
