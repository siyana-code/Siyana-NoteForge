import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteMeta } from "../api";
import { fuzzyScore } from "../lib/tree";

interface Props {
  notes: NoteMeta[];
  recent: string[];
  onOpen(path: string): void;
  onCreate(name: string): void;
  onClose(): void;
}

export function QuickSwitcher({ notes, recent, onOpen, onCreate, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) {
      const byPath = new Map(notes.map((n) => [n.path, n]));
      const rec = recent.map((p) => byPath.get(p)).filter((n): n is NoteMeta => !!n);
      const rest = [...notes].sort((a, b) => b.mtime - a.mtime).filter((n) => !recent.includes(n.path));
      return [...rec, ...rest].slice(0, 50);
    }
    return notes
      .map((n) => {
        const s = Math.max(fuzzyScore(query, n.title) ?? -Infinity, (fuzzyScore(query, n.path) ?? -Infinity) - 5);
        return { n, s };
      })
      .filter((x) => x.s > -Infinity)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.n);
  }, [notes, recent, query]);

  const exact = results.some((n) => n.title.toLowerCase() === query.trim().toLowerCase());
  const canCreate = query.trim().length > 0 && !exact;
  const total = results.length + (canCreate ? 1 : 0);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (i: number, forceCreate = false) => {
    if (forceCreate || i >= results.length) {
      if (query.trim()) onCreate(query.trim());
    } else onOpen(results[i].path);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (total ? (i + 1) % total : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (total ? (i - 1 + total) % total : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(index, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="input large"
          autoFocus
          placeholder="Find or create a note…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <ul className="switcher-list" ref={listRef}>
          {results.map((n, i) => (
            <li key={n.path}>
              <button className={i === index ? "active" : ""} onMouseEnter={() => setIndex(i)} onClick={() => choose(i)}>
                <span className="result-title">{n.title}</span>
                <span className="result-path">{n.path}</span>
              </button>
            </li>
          ))}
          {canCreate && (
            <li>
              <button
                className={index === results.length ? "active" : ""}
                onMouseEnter={() => setIndex(results.length)}
                onClick={() => choose(results.length, true)}
              >
                <span className="result-title">Create “{query.trim()}”</span>
                <span className="result-path">Shift+Enter</span>
              </button>
            </li>
          )}
        </ul>
        <div className="modal-hint">↑↓ to navigate · Enter to open · Shift+Enter to create · Esc to close</div>
      </div>
    </div>
  );
}
