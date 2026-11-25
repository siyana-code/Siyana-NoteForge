import { describe, expect, it } from "vitest";
import { buildTree, fuzzyScore } from "./tree";

const note = (path: string) => ({ path, title: path, mtime: 0, tags: [] });

describe("buildTree", () => {
  it("nests notes and keeps empty folders, folders first", () => {
    const root = buildTree([note("b.md"), note("x/y/c.md"), note("a.md")], ["empty", "x"]);
    expect(root.children.map((c) => c.name)).toEqual(["empty", "x", "a", "b"]);
    const x = root.children[1];
    expect(x.kind === "folder" && x.children[0].kind === "folder" && x.children[0].path).toBe("x/y");
  });
});

describe("fuzzyScore", () => {
  it("prefers substring and prefix matches", () => {
    expect(fuzzyScore("zzz", "notes")).toBeNull();
    expect(fuzzyScore("nt", "notes")).not.toBeNull();
    expect(fuzzyScore("not", "notes")!).toBeGreaterThan(fuzzyScore("not", "my notes")!);
    expect(fuzzyScore("mn", "my notes")!).toBeGreaterThan(fuzzyScore("mn", "lemon")!);
  });
});
