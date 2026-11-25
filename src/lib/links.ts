// Link resolution rules, mirrored from src-tauri/src/parse.rs so the UI can
// resolve [[links]] instantly without a round-trip.

/** Lowercase, forward slashes, no leading "./" or "/", no ".md". */
export function linkKey(s: string): string {
  let k = s.trim().replace(/\\/g, "/").toLowerCase();
  while (k.startsWith("./")) k = k.slice(2);
  k = k.replace(/^\/+/, "");
  return k.endsWith(".md") ? k.slice(0, -3) : k;
}

/** "folder/My Note.md" -> "My Note" */
export function stemOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/** "folder/My Note.md" -> "folder" ("" for the vault root) */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Resolve `target` relative to the folder containing `from`. Null if it escapes the vault. */
export function resolveRelative(from: string, target: string): string | null {
  const parts = target.startsWith("/") ? [] : dirOf(from).split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

export type Resolver = (target: string) => string | null;

/**
 * Build a resolver for wikilink targets. A target matches a note's full
 * path (without .md) or its bare file name; when several notes share a
 * name, the one with the shortest path wins.
 */
export function buildResolver(paths: string[]): Resolver {
  const byPath = new Map<string, string>();
  const byStem = new Map<string, string>();
  const sorted = [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const p of sorted) {
    const key = linkKey(p);
    byPath.set(key, p);
    const stem = key.split("/").pop()!;
    if (!byStem.has(stem)) byStem.set(stem, p);
  }
  return (target) => {
    const key = linkKey(target);
    return byPath.get(key) ?? byStem.get(key) ?? null;
  };
}

/** Split "Note#Heading|Alias" into its parts. */
export function parseWikiTarget(inner: string): { target: string; heading?: string; alias?: string } {
  let rest = inner;
  let alias: string | undefined;
  const bar = rest.indexOf("|");
  if (bar >= 0) {
    alias = rest.slice(bar + 1).trim();
    rest = rest.slice(0, bar);
  }
  let heading: string | undefined;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    heading = rest.slice(hash + 1).trim();
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), heading, alias };
}

/** File name characters that are unsafe on common filesystems. */
const UNSAFE = /[\\:*?"<>|\u0000-\u001f]/g;

/** The vault path a new note should get when created from a dangling [[target]]. */
export function pathForNewNote(target: string): string {
  const clean = target
    .replace(UNSAFE, "-")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
  return `${clean || "Untitled"}.md`;
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i;
