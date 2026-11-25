import { type LlmRouter, systemMessage, userMessage } from "@miyoria/llm/llm";

export type VoiceReflexMode = "say" | "say+think" | "think";

export interface VoiceReflexResult {
  mode: VoiceReflexMode;
  emotion: string | null;
  reply: string;
}

const VALID_EMOTIONS: ReadonlySet<string> = new Set([
  "neutral",
  "happy",
  "smug",
  "annoyed",
  "angry",
  "embarrassed",
  "sad",
  "surprised",
  "thinking",
]);

const THINK_RESULT: VoiceReflexResult = { mode: "think", emotion: null, reply: "" };
const MAX_REFLEX_CHARS = 120;

/** Clean a spoken reflex line: single-line plain text without markdown, emojis, or outer quotes. */
function cleanSpokenReflex(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[`*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

/**
 * Parses the 3-line key-value format (`mode:`, `emotion:`, `reply:`) returned by the Surface reflex
 * model. Tolerant of code fences or casing variation; falls back safely to `think`.
 */
export function parseVoiceReflex(raw: string): VoiceReflexResult {
  const stripped = raw
    .replace(/^```[^\n]*\r?\n?/gm, "")
    .replace(/```$/gm, "")
    .trim();
  if (stripped === "") return THINK_RESULT;

  const modeMatch = stripped.match(/^\s*mode\s*:\s*(say\+think|say|think)\b/im);
  const modeRaw = modeMatch?.[1]?.toLowerCase() as VoiceReflexMode | undefined;
  if (!modeRaw || modeRaw === "think") return THINK_RESULT;

  const emotionMatch = stripped.match(/^\s*emotion\s*:\s*([a-z]+)/im);
  const emotionRaw = emotionMatch?.[1]?.toLowerCase() ?? null;
  const emotion = emotionRaw !== null && VALID_EMOTIONS.has(emotionRaw) ? emotionRaw : null;

  const replyMatch = stripped.match(/^\s*reply\s*:\s*(.+)$/im);
  const reply = replyMatch?.[1] !== undefined ? cleanSpokenReflex(replyMatch[1]) : "";
  if (reply === "" || [...reply].length > MAX_REFLEX_CHARS) return THINK_RESULT;

  return { mode: modeRaw, emotion, reply };
}

export interface VoiceReflexOptions {
  llm: Pick<LlmRouter, "complete">;
  purpose: string;
  timeoutMs: number;
  personaName: string;
  recentLines: readonly string[];
  utterance: string;
  signal: AbortSignal;
}

/**
 * Runs a fast Surface reflex call ahead of the Deep voice turn. Returns `think` on any error,
 * timeout, or uncertain input so Deep always runs cleanly as fallback.
 */
export async function runVoiceReflex(opts: VoiceReflexOptions): Promise<VoiceReflexResult> {
  const { llm, purpose, timeoutMs, personaName, recentLines, utterance, signal } = opts;
  if (signal.aborted || utterance.trim() === "") return THINK_RESULT;

  const sys = [
    `You are the fast spoken reflex layer for ${personaName}, a chill shy kuudere hanging out in voice chat.`,
    "Decide in 3 short lines whether to speak an immediate reaction BEFORE her main brain finishes thinking:",
    "mode: say | say+think | think",
    "emotion: neutral | happy | smug | annoyed | angry | embarrassed | sad | surprised | thinking",
    "reply: <one short natural spoken line, or empty if think>",
    "Rules:",
    "- `say` ONLY for tiny greetings, one-word acknowledgments, or simple banter needing NO memory, tools, or facts (e.g. 'oh hey', 'lol fair', 'mhm?', 'eh halo', 'iya nih').",
    "- `say+think` for real questions/topics where a 2-7 word natural opening reaction fits while her main brain thinks (e.g. 'hmm, let me think', 'hmm bentar ya', 'eh tunggu bentar').",
    "- `think` if they ask to do/search/remember/play something, or when unsure.",
    "- Strictly match user language: if they speak Indonesian or mixed Indo-English, reply in natural casual spoken Bahasa Indonesia (never snap to English; use pronounceable words, no text abbreviations like yg/gk/bgt/wkwk). If pure English, reply in casual English. Never Chinese/Japanese. Casual lowercase, no markdown, no emoji, no kaomoji.",
  ].join("\n");

  const contextBlock = recentLines.length > 0 ? `Recent:\n${recentLines.join("\n")}\n\n` : "";
  const userText = `${contextBlock}Spoken to you now: ${utterance}`;

  const reqSignal =
    timeoutMs > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal;
  try {
    const res = await llm.complete(
      purpose,
      {
        messages: [systemMessage(sys), userMessage(userText)],
        max_tokens: 48,
        temperature: 0.3,
      },
      reqSignal,
    );
    return parseVoiceReflex(res.text);
  } catch {
    return THINK_RESULT;
  }
}
