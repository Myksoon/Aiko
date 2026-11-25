import { describe, expect, it } from "vitest";
import { cjkRefusal } from "../src/outlet.js";

describe("cjkRefusal", () => {
  const aikoLang = { primary: "en", secondary: ["id"] };

  it("blocks Chinese prose for non-CJK profiles", () => {
    const res = cjkRefusal("喔對，我本來是想傳那張像素自畫像的第二版給你看", aikoLang);
    expect(res).not.toBeNull();
    expect(res).toContain("forbidden");
  });

  it("allows English, Indonesian, kaomoji, and known CJK participant names", () => {
    expect(cjkRefusal("still up, still not it lol", aikoLang)).toBeNull();
    expect(cjkRefusal("bentar lemme check ya, wkwk", aikoLang)).toBeNull();
    expect(cjkRefusal("lowkey tired (´-ω-｀) (*/ω＼*)", aikoLang)).toBeNull();
    expect(cjkRefusal("yo 光 check this out", aikoLang, ["光"])).toBeNull();
    expect(cjkRefusal("wait 光 did u fix it yet?", aikoLang, ["光"])).toBeNull();
  });

  it("allows CJK when primary or secondary language includes zh/ja/ko", () => {
    const text = "喔對，我本來是想傳那張像素自畫像的第二版給你看";
    expect(cjkRefusal(text, { primary: "zh-TW", secondary: [] })).toBeNull();
    expect(cjkRefusal(text, { primary: "ja", secondary: [] })).toBeNull();
    expect(cjkRefusal(text, { primary: "en", secondary: ["zh"] })).toBeNull();
  });
});
