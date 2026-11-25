import { describe, expect, it } from "vitest";
import { extractHeadings, slugify, stripFrontMatter, toggleTask } from "./markdown";

describe("markdown helpers", () => {
  it("strips front matter and reports the line offset", () => {
    const r = stripFrontMatter("---\ntags: [a]\n---\n# Title\n");
    expect(r.front).toBe("tags: [a]");
    expect(r.body).toBe("# Title\n");
    expect(r.offset).toBe(3);
    expect(stripFrontMatter("# No front").front).toBeNull();
  });

  it("toggles task checkboxes on the right line", () => {
    const src = "- [ ] one\n- [x] two\n  1. [ ] three";
    expect(toggleTask(src, 0)).toBe("- [x] one\n- [x] two\n  1. [ ] three");
    expect(toggleTask(src, 1)).toBe("- [ ] one\n- [ ] two\n  1. [ ] three");
    expect(toggleTask(src, 2)).toBe("- [ ] one\n- [x] two\n  1. [x] three");
    expect(toggleTask(src, 9)).toBe(src);
  });

  it("extracts headings outside code, with source line numbers", () => {
    const src = "---\na: b\n---\n# One\n```\n# not\n```\n## Two ##";
    expect(extractHeadings(src)).toEqual([
      { level: 1, text: "One", line: 3 },
      { level: 2, text: "Two", line: 7 },
    ]);
  });

  it("slugifies headings", () => {
    expect(slugify("Hello, World! Ünïcode 2")).toBe("hello-world-ünïcode-2");
  });
});
