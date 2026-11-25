import type { NoteMeta } from "../api";

export interface TreeFolder {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}

export interface TreeNote {
  kind: "note";
  name: string;
  path: string;
  note: NoteMeta;
}

export type TreeNode = TreeFolder | TreeNote;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Build a folder tree from note paths plus (possibly empty) folder paths. Folders sort first. */
export function buildTree(notes: NoteMeta[], folders: string[]): TreeFolder {
  const root: TreeFolder = { kind: "folder", name: "", path: "", children: [] };
  const index = new Map<string, TreeFolder>([["", root]]);

  const ensure = (path: string): TreeFolder => {
    const existing = index.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensure(slash < 0 ? "" : path.slice(0, slash));
    const folder: TreeFolder = { kind: "folder", name: path.slice(slash + 1), path, children: [] };
    parent.children.push(folder);
    index.set(path, folder);
    return folder;
  };

  for (const f of folders) ensure(f);
  for (const note of notes) {
    const slash = note.path.lastIndexOf("/");
    const parent = ensure(slash < 0 ? "" : note.path.slice(0, slash));
    const name = note.path.slice(slash + 1).replace(/\.md$/i, "");
    parent.children.push({ kind: "note", name, path: note.path, note });
  }

  const sort = (f: TreeFolder) => {
    f.children.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : collator.compare(a.name, b.name),
    );
    for (const c of f.children) if (c.kind === "folder") sort(c);
  };
  sort(root);
  return root;
}

/** Score `text` against `query` as an in-order subsequence. Higher is better; null means no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - t.length * 0.1 + (direct === 0 ? 200 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += found === prev + 1 ? 10 : 1;
    if (found === 0 || /[\s/_-]/.test(t[found - 1])) score += 8;
    prev = found;
    ti = found + 1;
  }
  return score - t.length * 0.1;
}
