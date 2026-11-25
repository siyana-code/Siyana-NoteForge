import markdownit, { type MarkdownIt, type StateCore, type StateInline } from "markdown-it";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { IMAGE_EXT, parseWikiTarget, resolveRelative, type Resolver } from "./links";

export interface RenderEnv {
  /** Vault-relative path of the note being rendered. */
  notePath: string;
  resolve: Resolver;
  /** Turns a vault-relative file path into a URL the webview can load. */
  assetUrl: (vaultPath: string) => string;
}

const TAG_BODY = /^[\p{L}\p{N}_\-/]+/u;
const TAG_BOUNDARY = /[\s(\[,;]/;

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** `[[Target#Heading|Alias]]` and `![[image.png]]` */
function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21; /* ! */
  if (embed) pos++;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || inner.includes("[") || inner.includes("\n")) return false;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.meta = { ...parseWikiTarget(inner), embed };
  }
  state.pos = end + 2;
  return true;
}

/** `#tag` and `#nested/tag` (not headings, not "#123"). */
function tagRule(state: StateInline, silent: boolean): boolean {
  const pos = state.pos;
  if (state.src.charCodeAt(pos) !== 0x23 /* # */) return false;
  if (pos > 0 && !TAG_BOUNDARY.test(state.src[pos - 1])) return false;
  const m = TAG_BODY.exec(state.src.slice(pos + 1));
  if (!m) return false;
  const tag = m[0].replace(/^[/-]+|[/-]+$/g, "");
  if (!tag || /^[\d/-]+$/.test(tag)) return false;
  if (!silent) {
    const token = state.push("hashtag", "", 0);
    token.meta = { tag: tag.toLowerCase(), text: m[0] };
  }
  state.pos = pos + 1 + m[0].length;
  return true;
}

/** Turn `[ ] ` / `[x] ` at the start of list items into checkboxes that remember their source line. */
function taskListRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open")
      continue;
    const m = /^\[([ xX])\]\s/.exec(t.content);
    if (!m || !t.children?.length) continue;
    const first = t.children[0];
    if (first.type !== "text") continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("task_checkbox", "", 0);
    box.meta = { checked: m[1] !== " ", line: t.map?.[0] ?? -1 };
    t.children.unshift(box);
    tokens[i - 2].attrJoin("class", "task-item");
  }
}

function createMarkdown(): MarkdownIt {
  const md = markdownit({
    html: true,
    linkify: true,
    typographer: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {
          /* fall through */
        }
      }
      return "";
    },
  });

  md.inline.ruler.before("link", "wikilink", wikilinkRule);
  md.inline.ruler.before("text", "hashtag", tagRule);
  md.core.ruler.after("inline", "task_list", taskListRule);
  md.core.ruler.push("heading_ids", (state) => {
    const seen = new Map<string, number>();
    state.tokens.forEach((t, i) => {
      if (t.type !== "heading_open") return;
      const base = slugify(state.tokens[i + 1]?.content ?? "") || "section";
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      t.attrSet("id", n ? `${base}-${n}` : base);
    });
  });

  md.renderer.rules.wikilink = (tokens, idx, _opts, e) => {
    const env = e as unknown as RenderEnv;
    const { target, heading, alias, embed } = tokens[idx].meta as {
      target: string;
      heading?: string;
      alias?: string;
      embed: boolean;
    };
    if (embed && IMAGE_EXT.test(target)) {
      const path = env.resolve(target) ?? resolveRelative(env.notePath, target) ?? target;
      return `<img src="${escapeHtml(env.assetUrl(path))}" alt="${escapeHtml(alias ?? target)}">`;
    }
    const resolved = env.resolve(target);
    const label = alias || (heading ? `${target} › ${heading}` : target);
    const cls = resolved ? "wikilink" : "wikilink missing";
    const dataPath = resolved ? ` data-note="${escapeHtml(resolved)}"` : "";
    return `<a href="#" class="${cls}" data-target="${escapeHtml(target)}"${dataPath}>${escapeHtml(label)}</a>`;
  };

  md.renderer.rules.hashtag = (tokens, idx) => {
    const { tag, text } = tokens[idx].meta as { tag: string; text: string };
    return `<a href="#" class="tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(text)}</a>`;
  };

  md.renderer.rules.task_checkbox = (tokens, idx) => {
    const { checked, line } = tokens[idx].meta as { checked: boolean; line: number };
    return `<input type="checkbox" class="task" data-line="${line}"${checked ? " checked" : ""}> `;
  };

  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, opts, e, self) => {
    const env = e as unknown as RenderEnv;
    const token = tokens[idx];
    const src = String(token.attrGet("src") ?? "");
    if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) {
      const rel = resolveRelative(env.notePath, safeDecode(src));
      if (rel !== null) token.attrSet("src", env.assetUrl(rel));
    }
    return defaultImage(tokens, idx, opts, e, self);
  };

  md.renderer.rules.link_open = (tokens, idx, opts, e, self) => {
    const env = e as unknown as RenderEnv;
    const token = tokens[idx];
    const href = String(token.attrGet("href") ?? "");
    if (/^(https?:|mailto:)/i.test(href)) {
      token.attrSet("data-external", href);
    } else if (!href.startsWith("#")) {
      const path = safeDecode(href.split("#")[0]);
      if (/\.md$/i.test(path)) {
        const rel = resolveRelative(env.notePath, path);
        if (rel !== null) token.attrSet("data-note", rel);
      }
    }
    return self.renderToken(tokens, idx, opts);
  };

  return md;
}

const md = createMarkdown();

/** Remove a leading YAML front matter block. */
export function stripFrontMatter(src: string): { front: string | null; body: string; offset: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { front: null, body: src, offset: 0 };
  const offset = m[0].split("\n").length - 1;
  return { front: m[1], body: src.slice(m[0].length), offset };
}

const URI_OK = /^(?:(?:https?|mailto|asset|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/** Render Markdown to sanitized HTML. Task checkbox `data-line` values are lines in the original source. */
export function renderMarkdown(src: string, env: RenderEnv): string {
  const { body, offset } = stripFrontMatter(src);
  const tokens = md.parse(body, env as unknown as Record<string, unknown>);
  if (offset) {
    for (const t of tokens) {
      for (const c of t.children ?? []) {
        const meta = c.meta as { line: number } | null;
        if (c.type === "task_checkbox" && meta && meta.line >= 0) meta.line += offset;
      }
    }
  }
  const html = md.renderer.render(tokens, md.options, env as unknown as Record<string, unknown>);
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: URI_OK, ADD_ATTR: ["target"] });
}

/** Toggle the task checkbox on `line` (0-based) of `src`. */
export function toggleTask(src: string, line: number): string {
  const lines = src.split("\n");
  const l = lines[line];
  if (l === undefined) return src;
  lines[line] = l.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/, (_m, pre, mark) => `${pre}[${mark === " " ? "x" : " "}]`);
  return lines.join("\n");
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

/** ATX headings outside fenced code, for the outline panel. */
export function extractHeadings(src: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  const { offset, body } = stripFrontMatter(src);
  body.split("\n").forEach((raw, i) => {
    const line = raw.trimStart();
    if (fence) {
      if (line.startsWith(fence)) fence = null;
      return;
    }
    if (line.startsWith("```") || line.startsWith("~~~")) {
      fence = line.slice(0, 3);
      return;
    }
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + offset });
  });
  return out;
}
