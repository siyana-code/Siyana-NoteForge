//! A vault is a folder of Markdown files. This module owns all filesystem
//! access and keeps the [`Index`] in sync with disk.

use crate::index::Index;
use regex::{Captures, Regex};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use walkdir::{DirEntry, WalkDir};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("index error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("already exists: {0}")]
    Exists(String),
    #[error("no vault is open")]
    NoVault,
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Folder inside the vault where deleted notes are moved.
pub const TRASH_DIR: &str = ".trash";

#[derive(Debug, Default, serde::Serialize, Clone)]
pub struct SyncReport {
    pub changed: Vec<String>,
    pub removed: Vec<String>,
}

pub struct Vault {
    pub root: PathBuf,
    pub index: Mutex<Index>,
}

fn is_hidden(e: &DirEntry) -> bool {
    e.depth() > 0
        && e.file_name()
            .to_str()
            .map(|s| s.starts_with('.') || s == "node_modules")
            .unwrap_or(false)
}

fn is_markdown(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn mtime_of(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Vault {
    pub fn open(root: PathBuf) -> Result<Self> {
        if !root.is_dir() {
            return Err(Error::InvalidPath(root.display().to_string()));
        }
        let root = root.canonicalize()?;
        let vault = Self {
            root,
            index: Mutex::new(Index::new()?),
        };
        vault.sync()?;
        Ok(vault)
    }

    /// Convert a vault-relative path from the frontend into an absolute
    /// path, rejecting anything that could escape the vault.
    pub fn abs(&self, rel: &str) -> Result<PathBuf> {
        let p = Path::new(rel);
        if rel.is_empty() {
            return Ok(self.root.clone());
        }
        for c in p.components() {
            if !matches!(c, Component::Normal(_)) {
                return Err(Error::InvalidPath(rel.to_string()));
            }
        }
        Ok(self.root.join(p))
    }

    fn rel(&self, abs: &Path) -> Option<String> {
        let r = abs.strip_prefix(&self.root).ok()?;
        let s = r.to_str()?.replace('\\', "/");
        Some(s)
    }

    fn walk(&self) -> impl Iterator<Item = DirEntry> + '_ {
        WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !is_hidden(e))
            .filter_map(|e| e.ok())
    }

    /// Reconcile the index with disk: (re)index files whose mtime changed and
    /// drop files that no longer exist.
    pub fn sync(&self) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        let mut index = self.index.lock().unwrap();
        let known = index.mtimes()?;
        let mut seen = HashSet::new();
        for entry in self.walk() {
            if !entry.file_type().is_file() || !is_markdown(entry.path()) {
                continue;
            }
            let Some(rel) = self.rel(entry.path()) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else { continue };
            let mtime = mtime_of(&meta);
            if known.get(&rel) != Some(&mtime) {
                match fs::read_to_string(entry.path()) {
                    Ok(content) => {
                        index.upsert(&rel, &content, mtime)?;
                        report.changed.push(rel.clone());
                    }
                    Err(_) => continue, // unreadable / non-UTF-8: skip
                }
            }
            seen.insert(rel);
        }
        for path in known.keys() {
            if !seen.contains(path) {
                index.remove(path)?;
                report.removed.push(path.clone());
            }
        }
        Ok(report)
    }

    /// All non-hidden folders, vault-relative, so empty folders show up in the tree.
    pub fn folders(&self) -> Vec<String> {
        self.walk()
            .filter(|e| e.depth() > 0 && e.file_type().is_dir())
            .filter_map(|e| self.rel(e.path()))
            .collect()
    }

    pub fn read(&self, rel: &str) -> Result<String> {
        Ok(fs::read_to_string(self.abs(rel)?)?)
    }

    pub fn write(&self, rel: &str, content: &str) -> Result<()> {
        let abs = self.abs(rel)?;
        if !is_markdown(&abs) {
            return Err(Error::InvalidPath(rel.to_string()));
        }
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent)?;
        }
        // Write atomically so a crash never leaves a half-written note.
        let tmp = abs.with_extension("md.noteforge-tmp");
        fs::write(&tmp, content)?;
        fs::rename(&tmp, &abs)?;
        let mtime = mtime_of(&fs::metadata(&abs)?);
        self.index.lock().unwrap().upsert(rel, content, mtime)?;
        Ok(())
    }

    /// Create a new note in `dir` named `name` (or "Untitled", "Untitled 1", ...).
    pub fn create_note(
        &self,
        dir: &str,
        name: Option<&str>,
        content: Option<&str>,
    ) -> Result<String> {
        let base = name
            .map(|n| n.trim().trim_end_matches(".md").to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Untitled".to_string());
        if base.contains('/') || base.contains('\\') {
            return Err(Error::InvalidPath(base));
        }
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{}/", dir.trim_end_matches('/'))
        };
        let mut rel = format!("{prefix}{base}.md");
        let mut n = 1;
        while self.abs(&rel)?.exists() {
            if name.is_some() {
                return Err(Error::Exists(rel));
            }
            rel = format!("{prefix}{base} {n}.md");
            n += 1;
        }
        let default = format!("# {}\n\n", base);
        self.write(&rel, content.unwrap_or(&default))?;
        Ok(rel)
    }

    pub fn create_folder(&self, rel: &str) -> Result<()> {
        let abs = self.abs(rel)?;
        if abs.exists() {
            return Err(Error::Exists(rel.to_string()));
        }
        fs::create_dir_all(abs)?;
        Ok(())
    }

    /// Rename/move a note or folder. For notes, optionally rewrite
    /// `[[wikilinks]]` in other notes that pointed at the old name.
    /// Returns the notes whose content was rewritten.
    pub fn rename(&self, from: &str, to: &str, update_links: bool) -> Result<Vec<String>> {
        let src = self.abs(from)?;
        let dst = self.abs(to)?;
        if from == to {
            return Ok(Vec::new());
        }
        // Allow case-only renames on case-insensitive filesystems.
        if dst.exists() && !from.eq_ignore_ascii_case(to) {
            return Err(Error::Exists(to.to_string()));
        }
        let is_note = src.is_file();
        if is_note && !is_markdown(&dst) {
            return Err(Error::InvalidPath(to.to_string()));
        }
        let referrers = if is_note && update_links {
            self.index.lock().unwrap().wiki_referrers(from)?
        } else {
            Vec::new()
        };
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&src, &dst)?;
        self.sync()?;

        let mut updated = Vec::new();
        if !referrers.is_empty() {
            let new_stem = to
                .rsplit('/')
                .next()
                .unwrap_or(to)
                .trim_end_matches(".md")
                .to_string();
            let new_full = to.trim_end_matches(".md").to_string();
            // Prefer the short form unless it would be ambiguous.
            let unique = self.index.lock().unwrap().stem_count(to)? <= 1;
            let mut by_src: std::collections::BTreeMap<String, Vec<String>> = Default::default();
            for (s, target) in referrers {
                // A note that links to itself was just moved.
                let s = if s == from { to.to_string() } else { s };
                by_src.entry(s).or_default().push(target);
            }
            for (path, targets) in by_src {
                let content = match self.read(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let mut out = content.clone();
                for target in targets {
                    let replacement = if target.contains('/') || !unique {
                        &new_full
                    } else {
                        &new_stem
                    };
                    out = rewrite_wikilinks(&out, &target, replacement);
                }
                if out != content {
                    self.write(&path, &out)?;
                    updated.push(path);
                }
            }
        }
        Ok(updated)
    }

    /// Move a note or folder into the vault's `.trash` folder.
    pub fn trash(&self, rel: &str) -> Result<()> {
        let src = self.abs(rel)?;
        if !src.exists() {
            return Err(Error::InvalidPath(rel.to_string()));
        }
        let mut dst = self.root.join(TRASH_DIR).join(rel);
        if dst.exists() {
            let stamp = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let name = format!("{} ({stamp})", dst.file_name().unwrap().to_string_lossy());
            dst.set_file_name(name);
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&src, &dst)?;
        self.sync()?;
        Ok(())
    }
}

/// Replace `[[old...]]` targets with `new`, keeping `#heading` and `|alias`.
fn rewrite_wikilinks(content: &str, old: &str, new: &str) -> String {
    let re = Regex::new(&format!(
        r"(?i)(!?\[\[)\s*{}\s*((?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\])",
        regex::escape(old)
    ))
    .expect("escaped regex is valid");
    re.replace_all(content, |c: &Captures| format!("{}{}{}", &c[1], new, &c[2]))
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_with(files: &[(&str, &str)]) -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        for (p, c) in files {
            let abs = dir.path().join(p);
            fs::create_dir_all(abs.parent().unwrap()).unwrap();
            fs::write(abs, c).unwrap();
        }
        let v = Vault::open(dir.path().to_path_buf()).unwrap();
        (dir, v)
    }

    #[test]
    fn rejects_escaping_paths() {
        let (_d, v) = vault_with(&[]);
        assert!(v.abs("../etc/passwd").is_err());
        assert!(v.abs("/etc/passwd").is_err());
        assert!(v.abs("a/./b.md").is_ok());
    }

    #[test]
    fn scans_and_skips_hidden() {
        let (_d, v) = vault_with(&[
            ("a.md", "# A"),
            (".trash/x.md", "x"),
            ("sub/b.md", "b"),
            ("img.png", ""),
        ]);
        let notes = v.index.lock().unwrap().list_notes().unwrap();
        let paths: Vec<_> = notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, vec!["a.md", "sub/b.md"]);
        assert_eq!(v.folders(), vec!["sub"]);
    }

    #[test]
    fn create_unique_names() {
        let (_d, v) = vault_with(&[]);
        assert_eq!(v.create_note("", None, None).unwrap(), "Untitled.md");
        assert_eq!(v.create_note("", None, None).unwrap(), "Untitled 1.md");
        assert!(v.create_note("", Some("Untitled"), None).is_err());
        assert_eq!(
            v.create_note("dir", Some("X"), Some("hi")).unwrap(),
            "dir/X.md"
        );
        assert_eq!(v.read("dir/X.md").unwrap(), "hi");
    }

    #[test]
    fn rename_rewrites_links() {
        let (_d, v) = vault_with(&[
            ("Old.md", "# Old\nself [[Old]]"),
            (
                "a.md",
                "see [[Old]], [[old#H|alias]] and ![[Old]] but not [[Older]]",
            ),
        ]);
        let updated = v.rename("Old.md", "folder/New.md", true).unwrap();
        assert_eq!(updated, vec!["a.md", "folder/New.md"]);
        assert_eq!(
            v.read("a.md").unwrap(),
            "see [[New]], [[New#H|alias]] and ![[New]] but not [[Older]]"
        );
        assert_eq!(v.read("folder/New.md").unwrap(), "# Old\nself [[New]]");
        let bl = v.index.lock().unwrap().backlinks("folder/New.md").unwrap();
        assert_eq!(bl.len(), 1);
    }

    #[test]
    fn trash_moves_and_unindexes() {
        let (d, v) = vault_with(&[("a.md", "a")]);
        v.trash("a.md").unwrap();
        assert!(d.path().join(".trash/a.md").exists());
        assert!(v.index.lock().unwrap().list_notes().unwrap().is_empty());
    }

    #[test]
    fn sync_detects_external_changes() {
        let (d, v) = vault_with(&[("a.md", "a")]);
        fs::write(d.path().join("b.md"), "#new").unwrap();
        fs::remove_file(d.path().join("a.md")).unwrap();
        let r = v.sync().unwrap();
        assert_eq!(r.changed, vec!["b.md"]);
        assert_eq!(r.removed, vec!["a.md"]);
    }
}
