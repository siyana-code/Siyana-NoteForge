# NoteForge

A local-first Markdown knowledge manager for Linux. It has wikilinks,
backlinks, tags, full-text search, a live preview and a graph view.

Your notes are plain `.md` files in a folder you choose, called a *vault*.
There's no account, no cloud and no lock-in, and any other editor can open the
same files.

![NoteForge editor](docs/screenshots/editor.png)

## Features

- **Wikilinks:** type `[[` to link a note, with autocomplete. Clicking a link
  to a note that doesn't exist yet creates it. `[[Note#Heading|alias]]` and
  `![[image.png]]` embeds also work.
- **Backlinks:** every note shows which notes link to it, with the line of
  context around each link.
- **Tags:** use `#tag` or `#nested/tag` anywhere in the text, or list them in
  YAML front matter. You can browse them as a tree.
- **Full-text search:** an SQLite FTS5 index, with prefix matching and
  highlighted snippets.
- **Live preview:** edit-only, split, or preview-only views. The preview
  supports code highlighting, tables and task lists, and you can tick tasks
  directly in it.
- **Graph view:** an interactive, force-directed map of your notes. It has a
  local mode that shows only the neighbourhood of the current note.
- **Safe renames:** renaming or moving a note rewrites the `[[links]]` that
  point to it.
- **External edits:** NoteForge picks up files changed by other editors, git
  or sync tools.
- **Light and dark themes.** By default it follows the system theme.

## Keyboard shortcuts

| Action                      | Shortcut           |
| --------------------------- | ------------------ |
| New note                    | `Ctrl+N`           |
| Quick switcher (find/create)| `Ctrl+O` / `Ctrl+P`|
| Search all notes            | `Ctrl+Shift+F`     |
| Cycle edit / split / preview| `Ctrl+E`           |
| Graph view                  | `Ctrl+G`           |
| Toggle sidebar              | `Ctrl+\`           |
| Back / forward              | `Alt+←` / `Alt+→`  |
| Bold / italic               | `Ctrl+B` / `Ctrl+I`|
| Follow link in editor       | `Ctrl+Click`       |
| Find in note                | `Ctrl+F`           |

## How it works

| Layer    | Technology                                                                   |
| -------- | ---------------------------------------------------------------------------- |
| Shell    | [Tauri 2](https://tauri.app) (Rust + the system WebKitGTK)                   |
| Backend  | Rust: in-memory SQLite (FTS5) index, `notify` file watcher                   |
| Frontend | React + TypeScript, CodeMirror 6, markdown-it, d3-force                      |

The files on disk are always the source of truth. NoteForge rebuilds the
index whenever it opens a vault and updates it on every save or external
change. Deleted notes are moved to a `.trash` folder inside the vault, not
erased.

```
src/                 React UI
  components/        Editor, Preview, FileTree, GraphView, …
  lib/               Link resolution, Markdown rendering, tree helpers
src-tauri/src/
  parse.rs           Extracts titles, tags and links from Markdown
  index.rs           SQLite index: search, backlinks, tags, graph
  vault.rs           Filesystem access, sync, rename with link rewriting
  lib.rs             Tauri commands and the file watcher
packaging/           Flatpak manifest, desktop entry, AppStream metadata
```

## Development

Requirements: Node 22+, Rust (stable), and the Tauri system libraries:

```bash
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev
```

```bash
npm install
npm run tauri dev
```

Tests and checks:

```bash
npm test && npm run typecheck
cd src-tauri && cargo test && cargo clippy --all-targets
```

Build `.deb`, `.rpm` and AppImage packages into `src-tauri/target/release/bundle/`:

```bash
npm run tauri build
```

## Distribution

- **Flathub:** see [docs/PUBLISHING.md](docs/PUBLISHING.md).
- **GitHub Releases:** pushing a `v*` tag runs
  [release.yml](.github/workflows/release.yml), which attaches `.deb`, `.rpm`
  and AppImage builds to a draft release.

## License

[MIT](LICENSE) © 2026 Siyana
