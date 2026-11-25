---
tags: [noteforge, getting-started]
---
# Welcome to NoteForge

NoteForge keeps your notes as plain **Markdown files** in this folder. Nothing
leaves your computer, and any other editor can open these files too.

## The basics

- **New note:** `Ctrl+N`
- **Quick switcher:** `Ctrl+O` jumps to any note by name
- **Full-text search:** `Ctrl+Shift+F`, or use the search tab in the sidebar
- **Toggle preview:** `Ctrl+E` cycles between edit, split and preview
- **Graph view:** `Ctrl+G`

## Linking notes

Type `[[` to link to another note, for example [[Ideas]]. If the note does
not exist yet, clicking the link creates it. Every note shows its
**backlinks**, the notes that link to it, in the right-hand panel.

You can also use ordinary Markdown links like [this one](Welcome.md).

## Tags

Add tags anywhere in the text, like #noteforge or #project/alpha. You can
also list them in the front matter at the top of the file. Browse them in the
**Tags** tab of the sidebar.

## Markdown

- [x] Task lists
- [ ] Tables, code blocks and more

```rust
fn main() {
    println!("Code blocks are highlighted");
}
```

| Feature  | Shortcut       |
| -------- | -------------- |
| Search   | `Ctrl+Shift+F` |
| Graph    | `Ctrl+G`       |
