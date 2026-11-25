import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, type Backlink, type GraphData, type NoteMeta, type VaultInfo } from "./api";
import { buildResolver, dirOf, joinPath, pathForNewNote, stemOf } from "./lib/links";
import { toggleTask } from "./lib/markdown";
import { buildTree } from "./lib/tree";
import { Editor, type EditorHandle } from "./components/Editor";
import { Preview } from "./components/Preview";
import { FileTree, type TreeActions } from "./components/FileTree";
import { SearchPanel } from "./components/SearchPanel";
import { TagsPanel } from "./components/TagsPanel";
import { Inspector } from "./components/Inspector";
import { GraphView } from "./components/GraphView";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { PromptDialog, type PromptRequest } from "./components/PromptDialog";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { Icon } from "./components/Icon";

type ViewMode = "edit" | "split" | "preview";
type SidebarTab = "files" | "search" | "tags";
type Theme = "system" | "light" | "dark";
type SaveState = "saved" | "dirty" | "saving" | "error";

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`noteforge:${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`noteforge:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

const SAVE_DELAY = 600;

export default function App() {
  const [booting, setBooting] = useState(true);
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [revision, setRevision] = useState(0);

  const [viewMode, setViewMode] = useState<ViewMode>(() => store.get("viewMode", "split"));
  const [sidebarOpen, setSidebarOpen] = useState(() => store.get("sidebarOpen", true));
  const [inspectorOpen, setInspectorOpen] = useState(() => store.get("inspectorOpen", true));
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("files");
  const [theme, setTheme] = useState<Theme>(() => store.get("theme", "system"));
  const [expanded, setExpandedState] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [vaultMenu, setVaultMenu] = useState(false);
  const [nav, setNav] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const [recent, setRecent] = useState<string[]>([]);

  const editorRef = useRef<EditorHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const currentRef = useRef<string | null>(null);
  currentRef.current = current;
  /** Content we last read from or wrote to disk for the current note. */
  const saved = useRef("");
  const pending = useRef<{ path: string; content: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  // ---- persistence of UI prefs ----------------------------------------
  useEffect(() => store.set("viewMode", viewMode), [viewMode]);
  useEffect(() => store.set("sidebarOpen", sidebarOpen), [sidebarOpen]);
  useEffect(() => store.set("inspectorOpen", inspectorOpen), [inspectorOpen]);
  useEffect(() => {
    store.set("theme", theme);
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setExpanded = useCallback(
    (next: Set<string>) => {
      setExpandedState(next);
      if (vault) store.set(`expanded:${vault.path}`, [...next]);
    },
    [vault],
  );

  // ---- vault ------------------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      const snap = await api.snapshot();
      setNotes(snap.notes);
      setFolders(snap.folders);
    } catch (e) {
      showToast(errorMessage(e));
    }
  }, [showToast]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setSaveState("saving");
    try {
      await api.write(p.path, p.content);
      if (currentRef.current === p.path) saved.current = p.content;
      setSaveState(pending.current ? "dirty" : "saved");
      void refresh();
    } catch (e) {
      // Keep the edit queued so the next flush retries it.
      pending.current ??= p;
      setSaveState("error");
      showToast(`Couldn't save: ${errorMessage(e)}`);
    }
  }, [refresh, showToast]);

  const openNote = useCallback(
    async (path: string, opts: { history?: boolean } = {}) => {
      await flush();
      try {
        const text = await api.read(path);
        saved.current = text;
        setCurrent(path);
        setContent(text);
        setSaveState("saved");
        setRecent((r) => [path, ...r.filter((p) => p !== path)].slice(0, 20));
        if (opts.history !== false) {
          setNav((n) => {
            const stack = [...n.stack.slice(0, n.index + 1), path].slice(-100);
            return { stack, index: stack.length - 1 };
          });
        }
        if (vault) store.set(`lastNote:${vault.path}`, path);
        // Reveal in tree.
        const parts = dirOf(path).split("/").filter(Boolean);
        if (parts.length) {
          setExpandedState((ex) => {
            const next = new Set(ex);
            parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join("/")));
            return next;
          });
        }
      } catch (e) {
        showToast(errorMessage(e));
      }
    },
    [flush, showToast, vault],
  );

  const loadVault = useCallback(
    async (path: string, create: boolean) => {
      await flush();
      try {
        const info = await api.openVault(path, create);
        setVault(info);
        setNotes(info.notes);
        setFolders(info.folders);
        setOpenError(null);
        setCurrent(null);
        setContent("");
        setNav({ stack: [], index: -1 });
        setRecent([]);
        setExpandedState(new Set(store.get<string[]>(`expanded:${info.path}`, [])));
        const last = store.get<string | null>(`lastNote:${info.path}`, null);
        const first =
          (last && info.notes.find((n) => n.path === last)?.path) ??
          info.notes.find((n) => n.path === "Welcome.md")?.path ??
          info.notes[0]?.path;
        if (first) {
          const text = await api.read(first);
          saved.current = text;
          setCurrent(first);
          setContent(text);
          setNav({ stack: [first], index: 0 });
        }
      } catch (e) {
        setOpenError(`Couldn't open ${path}: ${errorMessage(e)}`);
        setVault(null);
      }
    },
    [flush],
  );

  useEffect(() => {
    api
      .lastVault()
      .then((p) => (p ? loadVault(p, false) : undefined))
      .catch(() => {})
      .finally(() => setBooting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow changes made outside the app (other editors, sync tools, git).
  useEffect(() => {
    if (!vault) return;
    const unlisten = api.onVaultChanged(async (report) => {
      await refresh();
      setRevision((r) => r + 1);
      const cur = currentRef.current;
      if (!cur || pending.current) return;
      if (report.removed.includes(cur)) {
        setCurrent(null);
        setContent("");
        showToast(`${stemOf(cur)} was removed outside NoteForge`);
      } else if (report.changed.includes(cur)) {
        const text = await api.read(cur).catch(() => null);
        if (text !== null && text !== saved.current && currentRef.current === cur && !pending.current) {
          saved.current = text;
          setContent(text);
        }
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [vault, refresh, showToast]);

  // Save before the window closes.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async () => {
      await flush();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [flush]);

  // Window title.
  useEffect(() => {
    const note = current ? stemOf(current) : null;
    const title = [note, vault?.name, "NoteForge"].filter(Boolean).join(" — ");
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [current, vault]);

  // Backlinks for the open note.
  useEffect(() => {
    if (!current) return setBacklinks([]);
    let cancelled = false;
    api
      .backlinks(current)
      .then((b) => !cancelled && setBacklinks(b))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [current, notes, revision]);

  // Graph data while the graph is visible.
  useEffect(() => {
    if (!showGraph) return;
    api.graph().then(setGraphData).catch((e) => showToast(errorMessage(e)));
  }, [showGraph, notes, showToast]);

  // ---- editing -----------------------------------------------------------
  const onChange = useCallback(
    (value: string) => {
      const path = currentRef.current;
      if (!path) return;
      setContent(value);
      if (value === saved.current && !pending.current) return;
      pending.current = { path, content: value };
      setSaveState("dirty");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY);
    },
    [flush],
  );

  const resolve = useMemo(() => buildResolver(notes.map((n) => n.path)), [notes]);
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const askName = (req: Omit<PromptRequest, "resolve">) =>
    new Promise<string | null>((resolvePrompt) =>
      setPrompt({
        ...req,
        resolve: (v) => {
          setPrompt(null);
          resolvePrompt(v);
        },
      }),
    );

  const createNote = useCallback(
    async (dir: string, name?: string) => {
      try {
        const path = await api.createNote(dir, name);
        await refresh();
        await openNote(path);
        setViewMode((m) => (m === "preview" ? "split" : m));
        window.setTimeout(() => editorRef.current?.focus(), 50);
      } catch (e) {
        showToast(errorMessage(e));
      }
    },
    [openNote, refresh, showToast],
  );

  const newNoteFlow = useCallback(
    async (dir?: string) => {
      const targetDir = dir ?? (currentRef.current ? dirOf(currentRef.current) : "");
      const name = await askName({
        title: "New note",
        label: targetDir ? `In ${targetDir}/` : "In the vault root",
        initial: "Untitled",
        confirm: "Create",
      });
      if (name) await createNote(targetDir, name.replace(/\.md$/i, ""));
    },
    [createNote],
  );

  /** Open the note a [[target]] points to, creating it if needed. */
  const openTarget = useCallback(
    async (target: string) => {
      const found = resolve(target);
      if (found) return openNote(found);
      const path = pathForNewNote(target);
      await createNote(dirOf(path), stemOf(path));
    },
    [resolve, openNote, createNote],
  );

  const showTag = useCallback((tag: string) => {
    setSidebarOpen(true);
    setSidebarTab("tags");
    setSelectedTag(tag);
  }, []);

  const renamePath = useCallback(
    async (from: string, to: string) => {
      await flush();
      try {
        const updated = await api.rename(from, to, true);
        const cur = currentRef.current;
        if (cur === from) setCurrent(to);
        else if (cur && cur.startsWith(from + "/")) setCurrent(to + cur.slice(from.length));
        await refresh();
        setRevision((r) => r + 1);
        const fresh = currentRef.current === from ? to : currentRef.current;
        if (fresh && updated.includes(fresh)) {
          const text = await api.read(fresh);
          saved.current = text;
          setContent(text);
        }
        if (updated.length) {
          showToast(`Updated links in ${updated.length} note${updated.length === 1 ? "" : "s"}`);
        }
      } catch (e) {
        showToast(errorMessage(e));
      }
    },
    [flush, refresh, showToast],
  );

  const treeActions: TreeActions = {
    open: (p) => void openNote(p),
    newNote: (dir) => void newNoteFlow(dir),
    async newFolder(dir) {
      const name = await askName({ title: "New folder", initial: "New folder", confirm: "Create" });
      if (!name) return;
      try {
        const path = joinPath(dir, name);
        await api.createFolder(path);
        await refresh();
        setExpanded(new Set([...expanded, dir, path].filter(Boolean)));
      } catch (e) {
        showToast(errorMessage(e));
      }
    },
    async rename(path, isFolder) {
      const oldName = isFolder ? path.split("/").pop()! : stemOf(path);
      const name = await askName({
        title: isFolder ? "Rename folder" : "Rename note",
        label: isFolder ? undefined : "Links to this note in other notes will be updated.",
        initial: oldName,
        confirm: "Rename",
      });
      if (!name || name === oldName) return;
      const to = joinPath(dirOf(path), isFolder ? name : `${name.replace(/\.md$/i, "")}.md`);
      await renamePath(path, to);
    },
    async remove(path, isFolder) {
      const ok = await ask(
        `Move “${isFolder ? path : stemOf(path)}”${isFolder ? " and everything in it" : ""} to the vault's .trash folder?`,
        { title: "Move to trash", kind: "warning", okLabel: "Move to trash" },
      );
      if (!ok) return;
      try {
        const cur = currentRef.current;
        if (cur && (cur === path || cur.startsWith(path + "/"))) {
          pending.current = null;
          window.clearTimeout(timer.current);
          setCurrent(null);
          setContent("");
        }
        await api.trash(path);
        await refresh();
      } catch (e) {
        showToast(errorMessage(e));
      }
    },
    async move(from, toDir) {
      const name = from.split("/").pop()!;
      const to = joinPath(toDir, name);
      if (to === from || toDir === from || toDir.startsWith(from + "/")) return;
      await renamePath(from, to);
    },
  };

  const goHistory = useCallback(
    (delta: number) => {
      const i = nav.index + delta;
      if (i < 0 || i >= nav.stack.length) return;
      setNav({ ...nav, index: i });
      void openNote(nav.stack[i], { history: false });
    },
    [nav, openNote],
  );

  const pickVault = async () => {
    setVaultMenu(false);
    const dir = await openDialog({ directory: true, multiple: false, title: "Open vault" });
    if (typeof dir === "string") await loadVault(dir, false);
  };

  const closeVault = async () => {
    setVaultMenu(false);
    await flush();
    await api.closeVault();
    setVault(null);
    setCurrent(null);
    setNotes([]);
  };

  // ---- keyboard shortcuts -------------------------------------------------
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (!vault) return;
    if (prompt || showSwitcher) return; // let dialogs handle their own keys
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && k === "n") (e.preventDefault(), void newNoteFlow());
    else if (mod && !e.shiftKey && (k === "o" || k === "p")) (e.preventDefault(), setShowSwitcher(true));
    else if (mod && e.shiftKey && k === "f") {
      e.preventDefault();
      setSidebarOpen(true);
      setSidebarTab("search");
      window.setTimeout(() => searchRef.current?.focus(), 0);
    } else if (mod && k === "e") {
      e.preventDefault();
      setViewMode((m) => (m === "edit" ? "split" : m === "split" ? "preview" : "edit"));
    } else if (mod && k === "g") (e.preventDefault(), setShowGraph((g) => !g));
    else if (mod && k === "\\") (e.preventDefault(), setSidebarOpen((s) => !s));
    else if (mod && k === "s") (e.preventDefault(), void flush());
    else if (e.altKey && e.key === "ArrowLeft") (e.preventDefault(), goHistory(-1));
    else if (e.altKey && e.key === "ArrowRight") (e.preventDefault(), goHistory(1));
    else if (e.key === "Escape" && showGraph && !showSwitcher && !prompt) setShowGraph(false);
  };
  useEffect(() => {
    // Capture phase, so app shortcuts win over the editor's own bindings (e.g. Ctrl+G = find next).
    const h = (e: KeyboardEvent) => {
      keys.current(e);
      if (e.defaultPrevented) e.stopPropagation();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  // ---- render -------------------------------------------------------------
  const tree = useMemo(() => buildTree(notes, folders), [notes, folders]);
  const currentMeta = notes.find((n) => n.path === current);
  const allTags = useMemo(() => [...new Set(notes.flatMap((n) => n.tags))].sort(), [notes]);
  const linkTargets = useCallback(() => {
    const stems = new Map<string, number>();
    for (const n of notesRef.current) stems.set(stemOf(n.path).toLowerCase(), (stems.get(stemOf(n.path).toLowerCase()) ?? 0) + 1);
    return notesRef.current.map((n) => {
      const stem = stemOf(n.path);
      const ambiguous = (stems.get(stem.toLowerCase()) ?? 0) > 1;
      return {
        label: ambiguous ? n.path.replace(/\.md$/i, "") : stem,
        detail: n.title !== stem ? n.title : dirOf(n.path) || undefined,
      };
    });
  }, []);
  const tagNamesRef = useRef(allTags);
  tagNamesRef.current = allTags;
  const tagNames = useCallback(() => tagNamesRef.current, []);
  const words = useMemo(() => (content.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length, [content]);

  if (booting) return <div className="boot" />;
  if (!vault) return <WelcomeScreen error={openError} onOpen={(p, c) => void loadVault(p, c)} />;

  const themeIcon = theme === "system" ? "monitor" : theme === "light" ? "sun" : "moon";
  const nextTheme: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";

  return (
    <div className={`app ${sidebarOpen ? "" : "no-sidebar"} ${inspectorOpen && current ? "" : "no-inspector"}`}>
      {sidebarOpen && (
        <aside className="sidebar">
          <header className="vault-header">
            <button className="vault-name" onClick={() => setVaultMenu((v) => !v)} title={vault.path}>
              <Icon name="vault" />
              <span>{vault.name}</span>
              <Icon name="chevron-down" size={12} />
            </button>
            <button className="btn ghost icon-btn" title="New note (Ctrl+N)" onClick={() => void newNoteFlow()}>
              <Icon name="file-plus" />
            </button>
            <button className="btn ghost icon-btn" title="New folder" onClick={() => treeActions.newFolder("")}>
              <Icon name="folder-plus" />
            </button>
            {vaultMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setVaultMenu(false)} />
                <div className="menu vault-menu">
                  <button onClick={() => void pickVault()}>Open another vault…</button>
                  <button
                    onClick={() => {
                      setVaultMenu(false);
                      void api.rescan().then(refresh);
                    }}
                  >
                    Rescan files
                  </button>
                  <hr />
                  <button onClick={() => void closeVault()}>Close vault</button>
                </div>
              </>
            )}
          </header>
          <nav className="sidebar-tabs">
            {(
              [
                ["files", "files", "Files"],
                ["search", "search", "Search (Ctrl+Shift+F)"],
                ["tags", "tag", "Tags"],
              ] as const
            ).map(([id, icon, label]) => (
              <button
                key={id}
                className={sidebarTab === id ? "active" : ""}
                title={label}
                onClick={() => setSidebarTab(id)}
              >
                <Icon name={icon} />
              </button>
            ))}
          </nav>
          <div className="sidebar-body">
            {sidebarTab === "files" && (
              <FileTree
                root={tree}
                current={current}
                expanded={expanded}
                setExpanded={setExpanded}
                actions={treeActions}
              />
            )}
            {sidebarTab === "search" && (
              <SearchPanel
                ref={searchRef}
                query={searchQuery}
                setQuery={setSearchQuery}
                onOpen={(p) => void openNote(p)}
                revision={revision}
              />
            )}
            {sidebarTab === "tags" && (
              <TagsPanel notes={notes} selected={selectedTag} onSelect={setSelectedTag} onOpen={(p) => void openNote(p)} />
            )}
          </div>
          <footer className="sidebar-footer">
            <span className="muted">{notes.length} notes</span>
            <span className="spacer" />
            <button className="btn ghost icon-btn" title="Graph view (Ctrl+G)" onClick={() => setShowGraph(true)}>
              <Icon name="graph" />
            </button>
            <button className="btn ghost icon-btn" title={`Theme: ${theme}`} onClick={() => setTheme(nextTheme)}>
              <Icon name={themeIcon} />
            </button>
          </footer>
        </aside>
      )}

      <main className="main">
        <header className="toolbar">
          <button className="btn ghost icon-btn" title="Toggle sidebar (Ctrl+\)" onClick={() => setSidebarOpen((s) => !s)}>
            <Icon name="panel-left" />
          </button>
          <button className="btn ghost icon-btn" title="Back (Alt+←)" disabled={nav.index <= 0} onClick={() => goHistory(-1)}>
            <Icon name="arrow-left" />
          </button>
          <button
            className="btn ghost icon-btn"
            title="Forward (Alt+→)"
            disabled={nav.index >= nav.stack.length - 1}
            onClick={() => goHistory(1)}
          >
            <Icon name="arrow-right" />
          </button>
          <div className="breadcrumb" title={current ?? ""}>
            {current ? (
              <>
                {dirOf(current) && <span className="muted">{dirOf(current).split("/").join(" / ")} / </span>}
                <button className="crumb" onClick={() => treeActions.rename(current, false)} title="Rename">
                  {stemOf(current)}
                </button>
              </>
            ) : (
              <span className="muted">No note open</span>
            )}
          </div>
          <span className="spacer" />
          <button className="btn ghost switcher-btn" onClick={() => setShowSwitcher(true)} title="Quick switcher">
            <Icon name="search" size={14} /> <span>Go to note</span> <kbd>Ctrl O</kbd>
          </button>
          <div className="segmented" role="group" aria-label="View mode (Ctrl+E)">
            {(
              [
                ["edit", "edit", "Editor only"],
                ["split", "columns", "Editor and preview"],
                ["preview", "eye", "Preview only"],
              ] as const
            ).map(([m, icon, label]) => (
              <button key={m} className={viewMode === m ? "active" : ""} title={label} onClick={() => setViewMode(m)}>
                <Icon name={icon} />
              </button>
            ))}
          </div>
          <button
            className={`btn ghost icon-btn ${inspectorOpen ? "on" : ""}`}
            title="Backlinks & outline"
            onClick={() => setInspectorOpen((v) => !v)}
          >
            <Icon name="panel-right" />
          </button>
        </header>

        {current ? (
          <div className={`workspace mode-${viewMode}`}>
            {viewMode !== "preview" && (
              <section className="pane editor-pane">
                <Editor
                  ref={editorRef}
                  docId={current}
                  value={content}
                  onChange={onChange}
                  onOpenLink={(t) => void openTarget(t)}
                  linkTargets={linkTargets}
                  tagNames={tagNames}
                />
              </section>
            )}
            {viewMode !== "edit" && (
              <section className="pane preview-pane">
                <Preview
                  source={content}
                  notePath={current}
                  vaultRoot={vault.path}
                  tags={currentMeta?.tags ?? []}
                  resolve={resolve}
                  onOpenNote={(p) => void openNote(p)}
                  onOpenTarget={(t) => void openTarget(t)}
                  onTag={showTag}
                  onToggleTask={(line) => onChange(toggleTask(content, line))}
                />
              </section>
            )}
          </div>
        ) : (
          <div className="empty-main">
            <h2>No note open</h2>
            <p className="muted">Pick a note from the sidebar, or start a new one.</p>
            <div className="welcome-actions">
              <button className="btn primary" onClick={() => void newNoteFlow("")}>
                New note <kbd>Ctrl N</kbd>
              </button>
              <button className="btn" onClick={() => setShowSwitcher(true)}>
                Go to note <kbd>Ctrl O</kbd>
              </button>
            </div>
          </div>
        )}

        <footer className="statusbar">
          {current && (
            <>
              <span>{words.toLocaleString()} words</span>
              <span>{content.length.toLocaleString()} characters</span>
              <span>
                {backlinks.length} backlink{backlinks.length === 1 ? "" : "s"}
              </span>
            </>
          )}
          <span className="spacer" />
          {current && <span className={`save-state ${saveState}`}>{{ saved: "Saved", dirty: "Edited", saving: "Saving…", error: "Not saved" }[saveState]}</span>}
        </footer>

        {showGraph && graphData && (
          <GraphView
            key={theme}
            data={graphData}
            current={current}
            onOpen={(p) => {
              void openNote(p);
            }}
            onClose={() => setShowGraph(false)}
          />
        )}
      </main>

      {inspectorOpen && current && (
        <Inspector
          content={content}
          note={currentMeta}
          notes={notes}
          backlinks={backlinks}
          onOpen={(p) => void openNote(p)}
          onOpenTarget={(t) => void openTarget(t)}
          onTag={showTag}
          onHeading={(line) => {
            if (viewMode === "preview") setViewMode("split");
            window.setTimeout(() => editorRef.current?.gotoLine(line), 0);
          }}
        />
      )}

      {showSwitcher && (
        <QuickSwitcher
          notes={notes}
          recent={recent}
          onClose={() => setShowSwitcher(false)}
          onOpen={(p) => {
            setShowSwitcher(false);
            void openNote(p);
          }}
          onCreate={(name) => {
            setShowSwitcher(false);
            void openTarget(name);
          }}
        />
      )}
      {prompt && <PromptDialog req={prompt} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
