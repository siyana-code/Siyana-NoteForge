// Dev-only stand-in for the Rust backend, so the UI can be run and inspected
// in a plain browser (`npm run dev`, then open http://localhost:1420).
// It is only loaded when the page is not running inside Tauri.
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { buildResolver, stemOf } from "../lib/links";
import { stripFrontMatter } from "../lib/markdown";

const seed: Record<string, string> = {
  "Welcome.md": `---
tags: [noteforge, getting-started]
---
# Welcome to NoteForge

NoteForge keeps your notes as plain **Markdown files**. Link ideas with [[Ideas]],
plan in [[projects/Rust Notes|Rust notes]], or review the [[Reading List]].

- [x] Install NoteForge
- [ ] Write the first note #todo
- [ ] Explore the graph view

\`\`\`rust
fn main() {
    println!("Code blocks are highlighted");
}
\`\`\`

| Feature | Shortcut |
| ------- | -------- |
| Search  | \`Ctrl+Shift+F\` |
| Graph   | \`Ctrl+G\` |
`,
  "Ideas.md": `# Ideas

A scratchpad for #brainstorm sessions. Back to [[Welcome]].

- Offline sync between devices, see [[projects/Sync Design]]
- Daily notes in [[journal/2026-11-24]]
- Something that does not exist yet: [[Someday Maybe]]
`,
  "Reading List.md": `# Reading List

#reading #books

1. *How to Take Smart Notes* (on [[Ideas|note-taking]])
2. *The Rust Programming Language* (see [[projects/Rust Notes]])
`,
  "projects/Rust Notes.md": `# Rust Notes

#project/noteforge #rust

Ownership and borrowing are the core ideas. Related: [[Ideas]], [[projects/Sync Design]].
`,
  "projects/Sync Design.md": `# Sync Design

#project/noteforge

Files stay the source of truth; the index is rebuilt from disk. See [[Rust Notes]].
`,
  "journal/2026-11-24.md": `# Monday 24 November

Worked on the graph view. #journal Linked from [[Ideas]], and see [[Welcome]].
`,
};

const notes = new Map(Object.entries(seed));
const mtimes = new Map([...notes.keys()].map((p, i) => [p, Date.now() - i * 60_000]));
const extraFolders = new Set<string>(["archive"]);

const TAG_RE = /(?:^|[\s(\[,;])#([\p{L}\p{N}_\-/]+)/gu;
const WIKI_RE = /!?\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\]/g;

function meta(path: string) {
  const src = notes.get(path)!;
  const { front, body } = stripFrontMatter(src);
  const tags = new Set<string>();
  const fm = front?.match(/tags:\s*\[([^\]]*)\]/);
  fm?.[1].split(",").forEach((t) => t.trim() && tags.add(t.trim().toLowerCase()));
  for (const m of body.matchAll(TAG_RE)) if (!/^\d+$/.test(m[1])) tags.add(m[1].toLowerCase());
  const title = /^# (.+)$/m.exec(body)?.[1].trim() ?? stemOf(path);
  return { path, title, mtime: mtimes.get(path)!, tags: [...tags] };
}

function links() {
  const resolve = buildResolver([...notes.keys()]);
  const out: { src: string; dst: string; context: string }[] = [];
  for (const [src, content] of notes) {
    for (const line of content.split("\n")) {
      for (const m of line.matchAll(WIKI_RE)) {
        const dst = resolve(m[1]);
        if (dst) out.push({ src, dst, context: line.trim() });
      }
    }
  }
  return out;
}

function folders() {
  const set = new Set(extraFolders);
  for (const p of notes.keys()) {
    const parts = p.split("/").slice(0, -1);
    parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join("/")));
  }
  return [...set].sort();
}

function snapshot() {
  return {
    path: "/home/demo/Documents/NoteForge",
    name: "NoteForge",
    notes: [...notes.keys()].sort().map(meta),
    folders: folders(),
  };
}

type Args = Record<string, unknown>;

const handlers: Record<string, (a: Args) => unknown> = {
  get_last_vault: () => "/home/demo/Documents/NoteForge",
  get_recent_vaults: () => ["/home/demo/Documents/NoteForge"],
  default_vault_path: () => "/home/demo/Documents/NoteForge",
  open_vault: () => snapshot(),
  close_vault: () => null,
  vault_snapshot: () => snapshot(),
  rescan: () => ({ changed: [], removed: [] }),
  read_note: (a) => {
    const c = notes.get(a.path as string);
    if (c === undefined) throw `not found: ${a.path}`;
    return c;
  },
  write_note: (a) => {
    notes.set(a.path as string, a.content as string);
    mtimes.set(a.path as string, Date.now());
    return null;
  },
  create_note: (a) => {
    const dir = a.dir as string;
    const name = (a.name as string | null) ?? "Untitled";
    const path = dir ? `${dir}/${name}.md` : `${name}.md`;
    if (notes.has(path)) throw `already exists: ${path}`;
    notes.set(path, (a.content as string | null) ?? `# ${name}\n\n`);
    mtimes.set(path, Date.now());
    return path;
  },
  create_folder: (a) => (extraFolders.add(a.path as string), null),
  rename_path: (a) => {
    const from = a.from as string;
    const to = a.to as string;
    for (const p of [...notes.keys()]) {
      if (p === from || p.startsWith(from + "/")) {
        notes.set(to + p.slice(from.length), notes.get(p)!);
        mtimes.set(to + p.slice(from.length), Date.now());
        notes.delete(p);
      }
    }
    return [];
  },
  trash_path: (a) => {
    for (const p of [...notes.keys()]) if (p === a.path || p.startsWith(a.path + "/")) notes.delete(p);
    extraFolders.delete(a.path as string);
    return null;
  },
  search: (a) => {
    const terms = String(a.query).toLowerCase().split(/\s+/).filter(Boolean);
    return [...notes.entries()]
      .filter(([, c]) => terms.every((t) => c.toLowerCase().includes(t)))
      .map(([path, c]) => {
        const i = c.toLowerCase().indexOf(terms[0]);
        const start = Math.max(0, i - 40);
        const snippet =
          "…" + c.slice(start, i) + "\u0001" + c.slice(i, i + terms[0].length) + "\u0002" + c.slice(i + terms[0].length, i + 80) + "…";
        return { path, title: meta(path).title, snippet: snippet.replace(/\n/g, " ") };
      });
  },
  backlinks: (a) =>
    links()
      .filter((l) => l.dst === a.path && l.src !== a.path)
      .map((l) => ({ path: l.src, title: meta(l.src).title, context: l.context })),
  tags: () => [],
  graph: () => {
    const edges = new Map<string, { source: string; target: string }>();
    for (const l of links()) if (l.src !== l.dst) edges.set(`${l.src}>${l.dst}`, { source: l.src, target: l.dst });
    const degree = new Map<string, number>();
    for (const e of edges.values()) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    return {
      nodes: [...notes.keys()].map((id) => ({ id, title: meta(id).title, degree: degree.get(id) ?? 0 })),
      edges: [...edges.values()],
    };
  },
  "plugin:dialog|ask": () => true,
  "plugin:dialog|open": () => null,
  "plugin:opener|open_url": () => null,
};

export function installMockBackend() {
  mockWindows("main");
  mockConvertFileSrc("linux");
  mockIPC(
    (cmd, payload) => {
      const h = handlers[cmd];
      if (h) return h((payload ?? {}) as Args);
      if (cmd.startsWith("plugin:window|")) return null;
      console.warn("[mock] unhandled command", cmd, payload);
      return null;
    },
    { shouldMockEvents: true },
  );
}
