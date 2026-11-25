import { useMemo } from "react";
import type { Backlink, NoteMeta } from "../api";
import { extractHeadings } from "../lib/markdown";
import { buildResolver, parseWikiTarget } from "../lib/links";
import { Icon } from "./Icon";

interface Props {
  content: string;
  note: NoteMeta | undefined;
  notes: NoteMeta[];
  backlinks: Backlink[];
  onOpen(path: string): void;
  onOpenTarget(target: string): void;
  onTag(tag: string): void;
  onHeading(line: number): void;
}

/** Highlight [[links]] in a backlink's context line. */
function Context({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[[") ? (
          <mark key={i}>{parseWikiTarget(p.slice(2, -2)).alias ?? parseWikiTarget(p.slice(2, -2)).target}</mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function Inspector({ content, note, notes, backlinks, onOpen, onOpenTarget, onTag, onHeading }: Props) {
  const headings = useMemo(() => extractHeadings(content), [content]);
  const outgoing = useMemo(() => {
    const resolve = buildResolver(notes.map((n) => n.path));
    const seen = new Map<string, { target: string; resolved: boolean }>();
    for (const m of content.matchAll(/\[\[([^\[\]|#\n]+)/g)) {
      const target = m[1].trim();
      const key = target.toLowerCase();
      if (!seen.has(key)) seen.set(key, { target, resolved: resolve(target) !== null });
    }
    return [...seen.values()];
  }, [content, notes]);
  const minLevel = Math.min(...headings.map((h) => h.level), 6);

  return (
    <aside className="inspector">
      <section>
        <h4>
          <Icon name="link" size={14} /> Backlinks <span className="count">{backlinks.length}</span>
        </h4>
        {backlinks.length === 0 ? (
          <p className="empty">No other notes link here yet.</p>
        ) : (
          <ul className="results">
            {backlinks.map((b, i) => (
              <li key={b.path + i}>
                <button className="result" onClick={() => onOpen(b.path)}>
                  <span className="result-title">{b.title}</span>
                  <span className="result-snippet">
                    <Context text={b.context} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {outgoing.length > 0 && (
        <section>
          <h4>
            <Icon name="arrow-right" size={14} /> Outgoing links <span className="count">{outgoing.length}</span>
          </h4>
          <ul className="chips">
            {outgoing.map((o) => (
              <li key={o.target}>
                <button
                  className={`chip ${o.resolved ? "" : "missing"}`}
                  title={o.resolved ? "Open note" : "Note doesn't exist yet. Click to create it."}
                  onClick={() => onOpenTarget(o.target)}
                >
                  {o.target}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {note && note.tags.length > 0 && (
        <section>
          <h4>
            <Icon name="tag" size={14} /> Tags
          </h4>
          <ul className="chips">
            {note.tags.map((t) => (
              <li key={t}>
                <button className="chip tag" onClick={() => onTag(t)}>
                  #{t}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {headings.length > 0 && (
        <section>
          <h4>
            <Icon name="list" size={14} /> Outline
          </h4>
          <ul className="outline">
            {headings.map((h, i) => (
              <li key={i} style={{ paddingLeft: (h.level - minLevel) * 12 }}>
                <button onClick={() => onHeading(h.line)}>{h.text}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
