import { describe, expect, it } from "vitest";
import { siteName } from "./site-name";

const page = (head: string) => new DOMParser().parseFromString(`<html><head>${head}</head></html>`, "text/html");

describe("siteName", () => {
  it("is the name the Core tagged the page with, Aiko without one", () => {
    expect(siteName(page('<meta property="og:site_name" content="Kuro" />'))).toBe("Kuro");
    expect(siteName(page('<meta property="og:site_name" content="Aiko" />'))).toBe("Aiko");
    expect(siteName(page(""))).toBe("Aiko");
    expect(siteName(page('<meta property="og:site_name" content="  " />'))).toBe("Aiko");
    expect(siteName(undefined)).toBe("Aiko");
  });
});
