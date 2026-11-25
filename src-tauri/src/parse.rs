//! Markdown scanning: title, tags, wikilinks and relative Markdown links.
//!
//! This is deliberately a lightweight line scanner rather than a full
//! CommonMark parser: it only needs to find metadata, and it must be fast
//! enough to re-run on every save.

use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkKind {
    /// `[[Target]]`, `[[Target#Heading|Alias]]`, `![[Embed]]`
    Wiki,
    /// `[text](relative/path.md)`
    Markdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawLink {
    /// Link target as written (heading/alias stripped, `%20` decoded).
    pub target: String,
    pub kind: LinkKind,
    /// The source line the link appears on, used as backlink context.
    pub context: String,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub title: Option<String>,
    /// Lowercased, deduplicated, in order of first appearance.
    pub tags: Vec<String>,
    pub links: Vec<RawLink>,
    /// Text indexed for full-text search (front matter removed).
    pub body: String,
}

static WIKI_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"!?\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|[^\[\]\n]*)?\]\]").unwrap()
});
static MD_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)"#).unwrap());
static TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\s(\[,;])#([\p{L}\p{N}_\-/]+)").unwrap());
static INLINE_CODE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]*`").unwrap());

pub fn parse(content: &str) -> Parsed {
    let mut out = Parsed::default();
    let (front, body) = split_front_matter(content);
    if let Some(front) = front {
        parse_front_matter(front, &mut out);
    }
    out.body = body.to_string();

    let mut fence: Option<&str> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(marker) = fence {
            if trimmed.starts_with(marker) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }

        if out.title.is_none() {
            if let Some(h) = trimmed.strip_prefix("# ") {
                let h = h.trim().trim_end_matches('#').trim();
                if !h.is_empty() {
                    out.title = Some(h.to_string());
                }
            }
        }

        // Blank out inline code so `#include` or `[[x]]` inside it is ignored.
        let scan = INLINE_CODE_RE.replace_all(line, |c: &regex::Captures| " ".repeat(c[0].len()));
        let context = line.trim().to_string();

        for cap in WIKI_RE.captures_iter(&scan) {
            let target = cap[1].trim();
            if !target.is_empty() {
                out.links.push(RawLink {
                    target: target.to_string(),
                    kind: LinkKind::Wiki,
                    context: context.clone(),
                });
            }
        }

        for cap in MD_LINK_RE.captures_iter(&scan) {
            let raw = &cap[1];
            if raw.contains("://") || raw.starts_with("mailto:") || raw.starts_with('#') {
                continue;
            }
            let path = raw.split('#').next().unwrap_or("");
            let path = percent_decode(path);
            if path.to_ascii_lowercase().ends_with(".md") {
                out.links.push(RawLink {
                    target: path,
                    kind: LinkKind::Markdown,
                    context: context.clone(),
                });
            }
        }

        // Headings ("# Title") never match because the regex requires a
        // non-space character directly after '#'.
        for cap in TAG_RE.captures_iter(&scan) {
            push_tag(&mut out.tags, &cap[1]);
        }
    }
    out
}

fn push_tag(tags: &mut Vec<String>, raw: &str) {
    let tag = raw.trim_matches(|c| c == '/' || c == '-').to_lowercase();
    // A tag needs at least one non-digit so "#1" or "#2024" aren't tags.
    if tag.is_empty()
        || tag
            .chars()
            .all(|c| c.is_ascii_digit() || c == '/' || c == '-')
    {
        return;
    }
    if !tags.contains(&tag) {
        tags.push(tag);
    }
}

/// Returns (front matter, rest). Front matter must start on the first line.
fn split_front_matter(content: &str) -> (Option<&str>, &str) {
    let rest = match content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    {
        Some(r) => r,
        None => return (None, content),
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let t = line.trim_end();
        if t == "---" || t == "..." {
            let front = &rest[..offset];
            let body = &rest[offset + line.len()..];
            return (Some(front), body);
        }
        offset += line.len();
    }
    (None, content)
}

fn parse_front_matter(front: &str, out: &mut Parsed) {
    let mut in_tag_list = false;
    for line in front.lines() {
        if in_tag_list {
            if let Some(item) = line.trim_start().strip_prefix("- ") {
                push_tag(&mut out.tags, unquote(item.trim()).trim_start_matches('#'));
                continue;
            }
            in_tag_list = false;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        match key.as_str() {
            "title" if !value.is_empty() => out.title = Some(unquote(value).to_string()),
            "tags" | "tag" => {
                if value.is_empty() {
                    in_tag_list = true;
                } else {
                    let inner = value.trim_start_matches('[').trim_end_matches(']');
                    for t in inner.split([',', ' ']) {
                        push_tag(&mut out.tags, unquote(t.trim()).trim_start_matches('#'));
                    }
                }
            }
            _ => {}
        }
    }
}

fn unquote(s: &str) -> &str {
    s.trim_matches(|c| c == '"' || c == '\'')
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Normalised key used to match a link target against a note:
/// lowercase, forward slashes, no leading "./" or "/", no ".md".
pub fn link_key(s: &str) -> String {
    let mut k = s.trim().replace('\\', "/").to_lowercase();
    while let Some(r) = k.strip_prefix("./") {
        k = r.to_string();
    }
    let k = k.trim_start_matches('/');
    k.strip_suffix(".md").unwrap_or(k).to_string()
}

/// Resolve a relative Markdown link against the directory of `src`
/// (both vault-relative, forward slashes). Returns None if it escapes the vault.
pub fn resolve_relative(src: &str, target: &str) -> Option<String> {
    let mut parts: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        let mut p: Vec<&str> = src.split('/').collect();
        p.pop();
        p
    };
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_from_heading() {
        let p = parse("intro\n# Hello World\n## Sub");
        assert_eq!(p.title.as_deref(), Some("Hello World"));
    }

    #[test]
    fn front_matter_title_and_tags() {
        let p = parse("---\ntitle: \"My Note\"\ntags: [Rust, notes]\n---\n# Heading\n#inline");
        assert_eq!(p.title.as_deref(), Some("My Note"));
        assert_eq!(p.tags, vec!["rust", "notes", "inline"]);
        assert!(!p.body.contains("title:"));
    }

    #[test]
    fn front_matter_tag_list() {
        let p = parse("---\ntags:\n  - one\n  - \"two/three\"\nother: x\n---\nbody");
        assert_eq!(p.tags, vec!["one", "two/three"]);
    }

    #[test]
    fn tags_ignore_headings_numbers_and_code() {
        let p =
            parse("# Title\n#tag-a and #Tag-A, #2024 `#nope`\n```\n#also-nope\n```\n(#nested/tag)");
        assert_eq!(p.tags, vec!["tag-a", "nested/tag"]);
    }

    #[test]
    fn wikilinks_with_alias_and_heading() {
        let p = parse("See [[Other Note#Part|alias]] and ![[image.png]] and [[ Spaced ]]");
        let t: Vec<_> = p.links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(t, vec!["Other Note", "image.png", "Spaced"]);
        assert!(p.links.iter().all(|l| l.kind == LinkKind::Wiki));
        assert_eq!(
            p.links[0].context,
            "See [[Other Note#Part|alias]] and ![[image.png]] and [[ Spaced ]]"
        );
    }

    #[test]
    fn markdown_links_only_local_md() {
        let p = parse("[a](../x/My%20Note.md#h) [b](https://e.com/a.md) [c](pic.png) [d](<y.md>)");
        let t: Vec<_> = p.links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(t, vec!["../x/My Note.md", "y.md"]);
    }

    #[test]
    fn links_in_code_ignored() {
        let p = parse("```\n[[hidden]]\n```\n`[[inline]]` [[shown]]");
        assert_eq!(p.links.len(), 1);
        assert_eq!(p.links[0].target, "shown");
    }

    #[test]
    fn keys_and_relative_resolution() {
        assert_eq!(link_key("./Folder\\My Note.MD"), "folder/my note");
        assert_eq!(
            resolve_relative("a/b/c.md", "../d.md").as_deref(),
            Some("a/d.md")
        );
        assert_eq!(
            resolve_relative("a/c.md", "/top.md").as_deref(),
            Some("top.md")
        );
        assert_eq!(resolve_relative("c.md", "../../x.md"), None);
    }
}
