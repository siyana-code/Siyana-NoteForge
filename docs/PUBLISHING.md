# Publishing NoteForge

The main store target is **Flathub**, which feeds GNOME Software, KDE
Discover and most other Linux app stores. Native packages also go to GitHub
Releases.

App ID: `io.github.siyana_code.NoteForge`. Flathub replaces the `-` in the
GitHub org name `siyana-code` with `_`. Flathub verifies `io.github.*` IDs
against the GitHub org, so the repository must stay under
`github.com/siyana-code`.

## 1. Before the first submission

- [ ] Make the repository **public**. Flathub builds from public source.
- [ ] Add real screenshots at `docs/screenshots/editor.png` and
      `docs/screenshots/graph.png`, on the `main` branch. The metainfo file
      links to them.
- [ ] Check `packaging/linux/io.github.siyana_code.NoteForge.metainfo.xml`:
      summary, description, and the release version and date.
- [ ] Tag the release: `git tag v0.1.0 && git push origin v0.1.0`.
      This also runs the GitHub release workflow.

## 2. Generate offline sources

Flathub builds have no network access, so every npm package and Rust crate
has to be listed in the manifest:

```bash
./packaging/flatpak/generate-sources.sh
```

This writes `packaging/flatpak/cargo-sources.json` and
`packaging/flatpak/node-sources.json`. Run it again whenever
`package-lock.json` or `Cargo.lock` change.

## 3. Test the Flatpak locally

```bash
./packaging/flatpak/build-local.sh
flatpak run io.github.siyana_code.NoteForge
```

Run the Flathub linter before submitting:

```bash
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest packaging/flatpak/io.github.siyana_code.NoteForge.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo
```

(Install the linter with `flatpak install flathub org.flatpak.Builder`.)

## 4. Submit to Flathub

1. Fork https://github.com/flathub/flathub and branch from `new-pr`.
2. Add these files to the root of the fork:
   - `io.github.siyana_code.NoteForge.yml` (from `packaging/flatpak/`)
   - `cargo-sources.json`
   - `node-sources.json`
3. In the manifest's git source, pin the release with `commit:` as well as
   `tag:`.
4. Open a pull request against `flathub/flathub:new-pr`, titled
   "Add io.github.siyana_code.NoteForge".
5. Answer the reviewers. They will ask about `--filesystem=home`. NoteForge
   needs real paths because it watches the vault for external changes and
   renames files when it updates links. The document portal only grants
   access to individual files, which can't support that.
6. After the PR is merged, Flathub creates
   `github.com/flathub/io.github.siyana_code.NoteForge`. Ship future
   releases as PRs to that repo.
7. Verify the app on Flathub so it gets the verified checkmark. Sign in at
   flathub.org with the GitHub account that has admin rights on
   `siyana-code`.

## 5. Each new release

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and
   `src-tauri/tauri.conf.json`.
2. Add a `<release>` entry to the metainfo file.
3. Tag and push the release (`vX.Y.Z`).
4. Regenerate the sources if any dependencies changed.
5. Open a PR on `flathub/io.github.siyana_code.NoteForge` that updates the
   `tag`/`commit` and the sources files.
