import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, EditorSelection, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  placeholder,
  rectangularSelection,
  dropCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownConfig } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { styleTags, tags as t } from "@lezer/highlight";

export interface EditorHandle {
  focus(): void;
  /** Move the cursor to the start of a 0-based line and scroll it into view. */
  gotoLine(line: number): void;
}

interface Props {
  /** Changing this resets the editor (new undo history). */
  docId: string;
  value: string;
  onChange(value: string): void;
  /** Called with a wikilink target when the user Ctrl+clicks it. */
  onOpenLink(target: string): void;
  linkTargets: () => { label: string; detail?: string }[];
  tagNames: () => string[];
}

/** Treat a leading `---` YAML block as front matter, not a setext heading + rule. */
const frontMatter: MarkdownConfig = {
  defineNodes: [{ name: "FrontMatter", block: true }],
  props: [styleTags({ FrontMatter: t.meta })],
  parseBlock: [
    {
      name: "FrontMatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.text.trimEnd() !== "---") return false;
        // Front matter starts with a YAML key; a lone "---" before prose is a rule.
        if (!/^[\w-]+\s*:/.test(cx.peekLine())) return false;
        while (cx.nextLine()) {
          const text = line.text.trimEnd();
          if (text === "---" || text === "...") {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("FrontMatter", 0, cx.prevLineEnd()));
        return true;
      },
    },
  ],
};

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700", color: "var(--text-strong)" },
  { tag: t.heading2, fontSize: "1.35em", fontWeight: "700", color: "var(--text-strong)" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "650", color: "var(--text-strong)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650", color: "var(--text-strong)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", color: "var(--code-text)" },
  { tag: [t.processingInstruction, t.meta], color: "var(--text-faint)" },
  { tag: t.quote, color: "var(--text-muted)", fontStyle: "italic" },
  { tag: t.list, color: "var(--accent)" },
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--text-faint)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-func)" },
  { tag: [t.typeName, t.className], color: "var(--syn-type)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-editor)", lineHeight: "1.65", padding: "24px 0 40vh" },
  ".cm-content": { maxWidth: "760px", margin: "0 auto", padding: "0 32px", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--match)" },
  ".cm-placeholder": { color: "var(--text-faint)" },
  ".cm-panels": { backgroundColor: "var(--bg-elevated)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button": { fontFamily: "inherit" },
  ".cm-tooltip": { backgroundColor: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "8px", overflow: "hidden" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "white" },
  ".cm-completionDetail": { color: "var(--text-faint)", marginLeft: "1em", fontStyle: "normal" },
});

/** Wrap the selection in `mark` (or insert an empty pair). */
function wrap(mark: string) {
  return (view: EditorView) => {
    view.dispatch(
      view.state.changeByRange((range) => {
        const text = view.state.sliceDoc(range.from, range.to);
        const insert = mark + text + mark;
        return {
          changes: { from: range.from, to: range.to, insert },
          range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
        };
      }),
    );
    return true;
  };
}

/** Find the [[target]] around document position `pos`, if any. */
function wikilinkAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const re = /\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\]/g;
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!;
    if (pos >= from && pos <= from + m[0].length) return m[1].trim();
  }
  return null;
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Keep callbacks fresh without rebuilding the editor.
  const live = useRef(props);
  live.current = props;

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    gotoLine(line) {
      const v = view.current;
      if (!v) return;
      const l = v.state.doc.line(Math.min(Math.max(line + 1, 1), v.state.doc.lines));
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 40 }) });
      v.focus();
    },
  }));

  useEffect(() => {
    const linkCompletion = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/\[\[[^\[\]|#\n]*$/);
      if (!m) return null;
      const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
      const close = after === "]]" ? "" : "]]";
      return {
        from: m.from + 2,
        options: live.current.linkTargets().map((o) => ({ ...o, type: "text", apply: o.label + close })),
        validFor: /^[^\[\]|#\n]*$/,
      };
    };
    const tagCompletion = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|[\s(,;])#[\p{L}\p{N}_\-/]*$/u);
      if (!m) return null;
      const hash = m.text.indexOf("#");
      return {
        from: m.from + hash + 1,
        options: live.current.tagNames().map((label) => ({ label, type: "keyword" })),
        validFor: /^[\p{L}\p{N}_\-/]*$/u,
      };
    };

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      autocompletion({ override: [linkCompletion, tagCompletion], icons: false }),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true, extensions: [frontMatter] }),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      placeholder("Start writing… type [[ to link a note, # to tag it"),
      theme,
      keymap.of([
        { key: "Mod-b", run: wrap("**") },
        { key: "Mod-i", run: wrap("*") },
        { key: "Mod-Shift-x", run: wrap("~~") },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) live.current.onChange(u.state.doc.toString());
      }),
      EditorView.domEventHandlers({
        mousedown(e, v) {
          if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          const target = pos == null ? null : wikilinkAt(v, pos);
          if (!target) return false;
          e.preventDefault();
          live.current.onOpenLink(target);
          return true;
        },
      }),
    ];

    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: live.current.value, extensions }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Rebuild only when switching documents.
  }, [props.docId]);

  // Apply external changes (e.g. file edited elsewhere, task toggled in preview).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    const next = props.value;
    if (current === next) return;
    // Replace only the differing middle so the cursor and scroll position survive.
    let start = 0;
    while (start < current.length && start < next.length && current[start] === next[start]) start++;
    let endA = current.length;
    let endB = next.length;
    while (endA > start && endB > start && current[endA - 1] === next[endB - 1]) {
      endA--;
      endB--;
    }
    v.dispatch({ changes: { from: start, to: endA, insert: next.slice(start, endB) } });
  }, [props.value]);

  return <div className="editor" ref={host} />;
});
