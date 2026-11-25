import { memo, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdown, stripFrontMatter } from "../lib/markdown";
import type { Resolver } from "../lib/links";

interface Props {
  source: string;
  notePath: string;
  vaultRoot: string;
  tags: string[];
  resolve: Resolver;
  onOpenNote(path: string): void;
  onOpenTarget(target: string): void;
  onTag(tag: string): void;
  onToggleTask(line: number): void;
}

export const Preview = memo(function Preview(props: Props) {
  const { source, notePath, vaultRoot, resolve } = props;
  const html = useMemo(
    () =>
      renderMarkdown(source, {
        notePath,
        resolve,
        assetUrl: (p) => convertFileSrc(`${vaultRoot}/${p}`),
      }),
    [source, notePath, vaultRoot, resolve],
  );
  const hasFront = useMemo(() => stripFrontMatter(source).front !== null, [source]);

  const onClick = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLInputElement && el.classList.contains("task")) {
      e.preventDefault();
      props.onToggleTask(Number(el.dataset.line));
      return;
    }
    const a = el.closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.external) void openUrl(a.dataset.external);
    else if (a.dataset.tag) props.onTag(a.dataset.tag);
    else if (a.dataset.note) props.onOpenNote(a.dataset.note);
    else if (a.dataset.target) props.onOpenTarget(a.dataset.target);
    else {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#") && href.length > 1) {
        document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: "smooth" });
      }
    }
  };

  return (
    <div className="preview-scroll">
      <article className="preview markdown-body" onClick={onClick}>
        {hasFront && props.tags.length > 0 && (
          <div className="front-tags">
            {props.tags.map((t) => (
              <a key={t} href="#" className="tag" data-tag={t}>
                #{t}
              </a>
            ))}
          </div>
        )}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    </div>
  );
});
