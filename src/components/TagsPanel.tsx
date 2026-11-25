import { useMemo } from "react";
import type { NoteMeta } from "../api";

interface Props {
  notes: NoteMeta[];
  selected: string | null;
  onSelect(tag: string | null): void;
  onOpen(path: string): void;
}

interface TagNode {
  name: string;
  full: string;
  count: number;
  children: TagNode[];
}

const matchesTag = (noteTags: string[], tag: string) =>
  noteTags.some((t) => t === tag || t.startsWith(tag + "/"));

/** Nest "project/alpha" under "project"; counts include nested tags. */
function buildTagTree(notes: NoteMeta[]): TagNode[] {
  const all = new Set<string>();
  for (const n of notes) for (const t of n.tags) {
    const parts = t.split("/");
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
  }
  const nodes = new Map<string, TagNode>();
  const roots: TagNode[] = [];
  for (const full of [...all].sort()) {
    const node: TagNode = {
      name: full.split("/").pop()!,
      full,
      count: notes.filter((n) => matchesTag(n.tags, full)).length,
      children: [],
    };
    nodes.set(full, node);
    const parent = full.includes("/") ? nodes.get(full.slice(0, full.lastIndexOf("/"))) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

export function TagsPanel({ notes, selected, onSelect, onOpen }: Props) {
  const tree = useMemo(() => buildTagTree(notes), [notes]);
  const tagged = useMemo(
    () => (selected ? notes.filter((n) => matchesTag(n.tags, selected)) : []),
    [notes, selected],
  );

  const render = (n: TagNode, depth: number): React.ReactNode => (
    <li key={n.full}>
      <button
        className={`tag-row ${selected === n.full ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(selected === n.full ? null : n.full)}
      >
        <span>#{n.name}</span>
        <span className="count">{n.count}</span>
      </button>
      {n.children.length > 0 && <ul>{n.children.map((c) => render(c, depth + 1))}</ul>}
    </li>
  );

  return (
    <div className="panel tags-panel">
      {tree.length === 0 ? (
        <p className="empty">No tags yet. Add #tags to your notes.</p>
      ) : (
        <ul className="tag-tree">{tree.map((n) => render(n, 0))}</ul>
      )}
      {selected && (
        <div className="tagged">
          <h4>
            Notes tagged <span className="tag">#{selected}</span>
          </h4>
          <ul className="results">
            {tagged.map((n) => (
              <li key={n.path}>
                <button className="result" onClick={() => onOpen(n.path)}>
                  <span className="result-title">{n.title}</span>
                  <span className="result-path">{n.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
