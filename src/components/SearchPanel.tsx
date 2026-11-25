import { forwardRef, useEffect, useState } from "react";
import { api, errorMessage, type SearchHit } from "../api";

interface Props {
  query: string;
  setQuery(q: string): void;
  onOpen(path: string): void;
  /** Bumped when the vault changes so results refresh. */
  revision: number;
}

/** Render a backend snippet, turning \u0001..\u0002 markers into <mark>. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("\u0001") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

export const SearchPanel = forwardRef<HTMLInputElement, Props>(function SearchPanel(
  { query, setQuery, onOpen, revision },
  inputRef,
) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .search(query)
        .then((h) => !cancelled && (setHits(h), setError(null)))
        .catch((e) => !cancelled && setError(errorMessage(e)));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, revision]);

  return (
    <div className="panel search-panel">
      <input
        ref={inputRef}
        className="input"
        placeholder="Search all notes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {error && <p className="error">{error}</p>}
      {query.trim() && !hits.length && !error && <p className="empty">No matches.</p>}
      <ul className="results">
        {hits.map((h) => (
          <li key={h.path}>
            <button className="result" onClick={() => onOpen(h.path)}>
              <span className="result-title">{h.title}</span>
              <span className="result-path">{h.path}</span>
              <span className="result-snippet">
                <Snippet text={h.snippet} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});
