import { describe, expect, it } from "vitest";
import { buildResolver, linkKey, parseWikiTarget, pathForNewNote, resolveRelative } from "./links";

describe("links", () => {
  it("normalises keys like the backend", () => {
    expect(linkKey("./Folder\\My Note.MD")).toBe("folder/my note");
  });

  it("resolves by path or stem, preferring the shortest path", () => {
    const r = buildResolver(["deep/nested/Ideas.md", "Ideas.md", "projects/Rust.md"]);
    expect(r("ideas")).toBe("Ideas.md");
    expect(r("deep/nested/Ideas")).toBe("deep/nested/Ideas.md");
    expect(r("Rust")).toBe("projects/Rust.md");
    expect(r("missing")).toBeNull();
  });

  it("parses heading and alias", () => {
    expect(parseWikiTarget("Note#Part|Shown")).toEqual({ target: "Note", heading: "Part", alias: "Shown" });
    expect(parseWikiTarget(" Note ")).toEqual({ target: "Note", heading: undefined, alias: undefined });
  });

  it("resolves relative paths", () => {
    expect(resolveRelative("a/b/c.md", "../d.png")).toBe("a/d.png");
    expect(resolveRelative("c.md", "../x.md")).toBeNull();
  });

  it("makes safe file names for new notes", () => {
    expect(pathForNewNote("Meeting: 1/2")).toBe("Meeting- 1/2.md");
    expect(pathForNewNote("../../etc")).toBe("etc.md");
    expect(pathForNewNote("  ")).toBe("Untitled.md");
  });
});
