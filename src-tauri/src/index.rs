//! In-memory SQLite index over the vault: note metadata, FTS5 full-text
//! search, tags and links. The Markdown files on disk are the source of
//! truth; the index is rebuilt when a vault is opened and kept in sync by
//! the file watcher.

use crate::parse::{self, LinkKind};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

const SCHEMA: &str = r#"
CREATE TABLE notes (
    path     TEXT PRIMARY KEY,
    path_key TEXT NOT NULL,
    stem_key TEXT NOT NULL,
    title    TEXT NOT NULL,
    mtime    INTEGER NOT NULL
);
CREATE INDEX notes_path_key ON notes(path_key);
CREATE INDEX notes_stem_key ON notes(stem_key);
CREATE VIRTUAL TABLE fts USING fts5(
    path UNINDEXED, title, body,
    tokenize = "unicode61 remove_diacritics 2",
    prefix = '2 3'
);
CREATE TABLE links (
    src        TEXT NOT NULL,
    target_key TEXT NOT NULL,
    target     TEXT NOT NULL,
    kind       INTEGER NOT NULL,
    context    TEXT NOT NULL
);
CREATE INDEX links_src ON links(src);
CREATE INDEX links_target ON links(target_key);
CREATE TABLE tags (
    path TEXT NOT NULL,
    tag  TEXT NOT NULL
);
CREATE INDEX tags_path ON tags(path);
CREATE INDEX tags_tag ON tags(tag);
"#;

const KIND_WIKI: i64 = 0;
const KIND_MD: i64 = 1;

/// Joins `links l` to the notes they resolve to (`n`). Wikilinks match a
/// note's full path or bare file name; Markdown links only the full path.
const RESOLVED_LINKS: &str = "
    SELECT l.src AS src, n.path AS dst, l.context AS context FROM links l
        JOIN notes n ON n.path_key = l.target_key
    UNION
    SELECT l.src, n.path, l.context FROM links l
        JOIN notes n ON l.kind = 0 AND n.stem_key = l.target_key
";

#[derive(Debug, Serialize, Clone)]
pub struct NoteMeta {
    pub path: String,
    pub title: String,
    pub mtime: i64,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// Snippet with matches wrapped in \u{1} ... \u{2}.
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct Backlink {
    pub path: String,
    pub title: String,
    pub context: String,
}

#[derive(Debug, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    /// Number of links touching this node; used for sizing.
    pub degree: i64,
}

#[derive(Debug, Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

pub struct Index {
    conn: Connection,
}

/// `folder/My Note.md` -> ("folder/my note", "my note")
fn keys_for(path: &str) -> (String, String) {
    let path_key = parse::link_key(path);
    let stem_key = path_key.rsplit('/').next().unwrap_or(&path_key).to_string();
    (path_key, stem_key)
}

fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

impl Index {
    pub fn new() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    /// Insert or replace a note. `path` is vault-relative with forward slashes.
    pub fn upsert(&mut self, path: &str, content: &str, mtime: i64) -> rusqlite::Result<()> {
        let parsed = parse::parse(content);
        let (path_key, stem_key) = keys_for(path);
        let title = parsed
            .title
            .clone()
            .unwrap_or_else(|| stem(path).to_string());

        let tx = self.conn.transaction()?;
        Self::delete_in(&tx, path)?;
        tx.execute(
            "INSERT INTO notes(path, path_key, stem_key, title, mtime) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![path, path_key, stem_key, title, mtime],
        )?;
        tx.execute(
            "INSERT INTO fts(path, title, body) VALUES (?1, ?2, ?3)",
            params![path, title, parsed.body],
        )?;
        {
            let mut ins = tx.prepare(
                "INSERT INTO links(src, target_key, target, kind, context) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for link in &parsed.links {
                let (key, kind) = match link.kind {
                    LinkKind::Wiki => (parse::link_key(&link.target), KIND_WIKI),
                    LinkKind::Markdown => match parse::resolve_relative(path, &link.target) {
                        Some(p) => (parse::link_key(&p), KIND_MD),
                        None => continue,
                    },
                };
                ins.execute(params![path, key, link.target, kind, link.context])?;
            }
            let mut ins = tx.prepare("INSERT INTO tags(path, tag) VALUES (?1, ?2)")?;
            for tag in &parsed.tags {
                ins.execute(params![path, tag])?;
            }
        }
        tx.commit()
    }

    pub fn remove(&mut self, path: &str) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        Self::delete_in(&tx, path)?;
        tx.commit()
    }

    fn delete_in(tx: &rusqlite::Transaction, path: &str) -> rusqlite::Result<()> {
        tx.execute("DELETE FROM notes WHERE path = ?1", [path])?;
        tx.execute("DELETE FROM fts WHERE path = ?1", [path])?;
        tx.execute("DELETE FROM links WHERE src = ?1", [path])?;
        tx.execute("DELETE FROM tags WHERE path = ?1", [path])?;
        Ok(())
    }

    /// path -> mtime for every indexed note.
    pub fn mtimes(&self) -> rusqlite::Result<HashMap<String, i64>> {
        let mut st = self.conn.prepare("SELECT path, mtime FROM notes")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    pub fn list_notes(&self) -> rusqlite::Result<Vec<NoteMeta>> {
        let mut tags: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut st = self
                .conn
                .prepare("SELECT path, tag FROM tags ORDER BY rowid")?;
            let rows =
                st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (p, t) = row?;
                tags.entry(p).or_default().push(t);
            }
        }
        let mut st = self
            .conn
            .prepare("SELECT path, title, mtime FROM notes ORDER BY path COLLATE NOCASE")?;
        let rows = st.query_map([], |r| {
            Ok(NoteMeta {
                path: r.get(0)?,
                title: r.get(1)?,
                mtime: r.get(2)?,
                tags: Vec::new(),
            })
        })?;
        rows.map(|r| {
            r.map(|mut n| {
                n.tags = tags.remove(&n.path).unwrap_or_default();
                n
            })
        })
        .collect()
    }

    pub fn search(&self, query: &str, limit: usize) -> rusqlite::Result<Vec<SearchHit>> {
        let Some(fts_query) = to_fts_query(query) else {
            return Ok(Vec::new());
        };
        let mut st = self.conn.prepare(
            "SELECT path, title, snippet(fts, 2, char(1), char(2), '…', 16)
             FROM fts WHERE fts MATCH ?1
             ORDER BY bm25(fts, 0.0, 8.0, 1.0) LIMIT ?2",
        )?;
        let rows = st.query_map(params![fts_query, limit as i64], |r| {
            Ok(SearchHit {
                path: r.get(0)?,
                title: r.get(1)?,
                snippet: r.get(2)?,
            })
        })?;
        rows.collect()
    }

    pub fn backlinks(&self, path: &str) -> rusqlite::Result<Vec<Backlink>> {
        let sql = format!(
            "SELECT r.src, n.title, r.context FROM ({RESOLVED_LINKS}) r
             JOIN notes n ON n.path = r.src
             WHERE r.dst = ?1 AND r.src != ?1
             ORDER BY n.title COLLATE NOCASE"
        );
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map([path], |r| {
            Ok(Backlink {
                path: r.get(0)?,
                title: r.get(1)?,
                context: r.get(2)?,
            })
        })?;
        rows.collect()
    }

    pub fn tags(&self) -> rusqlite::Result<Vec<TagCount>> {
        let mut st = self
            .conn
            .prepare("SELECT tag, COUNT(DISTINCT path) FROM tags GROUP BY tag ORDER BY tag")?;
        let rows = st.query_map([], |r| {
            Ok(TagCount {
                tag: r.get(0)?,
                count: r.get(1)?,
            })
        })?;
        rows.collect()
    }

    pub fn graph(&self) -> rusqlite::Result<Graph> {
        let mut edges = Vec::new();
        {
            let sql = format!("SELECT DISTINCT src, dst FROM ({RESOLVED_LINKS}) WHERE src != dst");
            let mut st = self.conn.prepare(&sql)?;
            let rows = st.query_map([], |r| {
                Ok(GraphEdge {
                    source: r.get(0)?,
                    target: r.get(1)?,
                })
            })?;
            for e in rows {
                edges.push(e?);
            }
        }
        let mut degree: BTreeMap<&str, i64> = BTreeMap::new();
        for e in &edges {
            *degree.entry(&e.source).or_default() += 1;
            *degree.entry(&e.target).or_default() += 1;
        }
        let mut st = self.conn.prepare("SELECT path, title FROM notes")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut nodes = Vec::new();
        for row in rows {
            let (id, title) = row?;
            let d = degree.get(id.as_str()).copied().unwrap_or(0);
            nodes.push(GraphNode {
                id,
                title,
                degree: d,
            });
        }
        Ok(Graph { nodes, edges })
    }

    /// Notes containing a wikilink that resolves to `path`, with the exact
    /// target strings they used. Used to rewrite links on rename.
    pub fn wiki_referrers(&self, path: &str) -> rusqlite::Result<Vec<(String, String)>> {
        let (path_key, stem_key) = keys_for(path);
        let mut st = self.conn.prepare(
            "SELECT DISTINCT src, target FROM links
             WHERE kind = 0 AND (target_key = ?1 OR target_key = ?2)",
        )?;
        let rows = st.query_map(params![path_key, stem_key], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// How many notes share this file name (case-insensitive)?
    pub fn stem_count(&self, path: &str) -> rusqlite::Result<i64> {
        let (_, stem_key) = keys_for(path);
        self.conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE stem_key = ?1",
            [stem_key],
            |r| r.get(0),
        )
    }
}

/// Turn free text into a safe FTS5 query: every term is quoted (so user
/// input can't inject FTS syntax) and prefix-matched; terms are ANDed.
fn to_fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-'))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Index {
        let mut ix = Index::new().unwrap();
        ix.upsert(
            "Home.md",
            "# Home\nWelcome. See [[Ideas]] and [[projects/Rust Notes|rust]]. #start",
            1,
        )
        .unwrap();
        ix.upsert(
            "Ideas.md",
            "# Ideas\nBack to [Home](Home.md). #brainstorm #start",
            2,
        )
        .unwrap();
        ix.upsert(
            "projects/Rust Notes.md",
            "Ownership and borrowing. [[Ideas#Top]]",
            3,
        )
        .unwrap();
        ix
    }

    #[test]
    fn list_and_titles() {
        let ix = sample();
        let notes = ix.list_notes().unwrap();
        assert_eq!(notes.len(), 3);
        let rust = notes
            .iter()
            .find(|n| n.path == "projects/Rust Notes.md")
            .unwrap();
        assert_eq!(rust.title, "Rust Notes");
        let home = notes.iter().find(|n| n.path == "Home.md").unwrap();
        assert_eq!(home.tags, vec!["start"]);
    }

    #[test]
    fn backlinks_resolve_wiki_and_markdown() {
        let ix = sample();
        let bl: Vec<_> = ix
            .backlinks("Ideas.md")
            .unwrap()
            .into_iter()
            .map(|b| b.path)
            .collect();
        assert_eq!(bl, vec!["Home.md", "projects/Rust Notes.md"]);
        let bl: Vec<_> = ix
            .backlinks("Home.md")
            .unwrap()
            .into_iter()
            .map(|b| b.path)
            .collect();
        assert_eq!(bl, vec!["Ideas.md"]);
    }

    #[test]
    fn search_prefix_and_snippet() {
        let ix = sample();
        let hits = ix.search("borrow", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "projects/Rust Notes.md");
        assert!(hits[0].snippet.contains('\u{1}'));
        // FTS syntax in input must not error.
        assert!(ix.search("\"unbalanced AND (", 10).is_ok());
    }

    #[test]
    fn tags_and_graph() {
        let ix = sample();
        let tags = ix.tags().unwrap();
        assert_eq!(tags.iter().find(|t| t.tag == "start").unwrap().count, 2);
        let g = ix.graph().unwrap();
        assert_eq!(g.nodes.len(), 3);
        assert_eq!(g.edges.len(), 4);
    }

    #[test]
    fn upsert_replaces_and_remove() {
        let mut ix = sample();
        ix.upsert("Home.md", "no links now", 5).unwrap();
        assert!(ix
            .backlinks("Ideas.md")
            .unwrap()
            .iter()
            .all(|b| b.path != "Home.md"));
        ix.remove("Ideas.md").unwrap();
        assert!(ix.search("brainstorm", 10).unwrap().is_empty());
        assert_eq!(ix.list_notes().unwrap().len(), 2);
    }

    #[test]
    fn referrers_for_rename() {
        let ix = sample();
        let mut r = ix.wiki_referrers("Ideas.md").unwrap();
        r.sort();
        assert_eq!(
            r,
            vec![
                ("Home.md".to_string(), "Ideas".to_string()),
                ("projects/Rust Notes.md".to_string(), "Ideas".to_string())
            ]
        );
    }
}
