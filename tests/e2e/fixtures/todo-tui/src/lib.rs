//! Pure core for the `todo` command-line todo manager.
//!
//! The three operations that define the domain — [`add`], [`done`], and
//! [`remove`] — are pure: they mutate the [`TodoList`] they are handed and
//! never touch the filesystem. Persistence is isolated in [`load`] and
//! [`save`] so the CLI owns every I/O decision (path, error reporting).
//!
//! The on-disk format is a hand-rolled JSON array of objects:
//!
//! ```json
//! [
//!   {"id":1,"text":"buy milk","done":false}
//! ]
//! ```

use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::Path;

/// A single todo entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItem {
    /// Stable, monotonically assigned identifier.
    pub id: u64,
    /// Free-form description supplied by the user.
    pub text: String,
    /// Whether the item has been completed.
    pub done: bool,
}

/// The full collection, in insertion order.
pub type TodoList = Vec<TodoItem>;

/// Everything that can go wrong while loading or saving the todo file.
#[derive(Debug)]
pub enum TodoError {
    /// The todo file could not be read or written.
    Io(io::Error),
    /// The todo file exists but is not in the expected JSON shape.
    Parse(String),
}

impl std::fmt::Display for TodoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TodoError::Io(err) => write!(f, "io error: {err}"),
            TodoError::Parse(msg) => write!(f, "parse error: {msg}"),
        }
    }
}

impl std::error::Error for TodoError {}

impl From<io::Error> for TodoError {
    fn from(err: io::Error) -> Self {
        TodoError::Io(err)
    }
}

/// Append `text` to `list` and return the freshly assigned id.
///
/// Ids are `max(existing) + 1`, so they stay unique even after removals.
pub fn add(list: &mut TodoList, text: &str) -> u64 {
    let id = list.iter().map(|item| item.id).max().unwrap_or(0) + 1;
    list.push(TodoItem {
        id,
        text: text.to_string(),
        done: false,
    });
    id
}

/// Mark the item with `id` as done.
///
/// Returns `true` when an item was found (including when it was already
/// done — the operation is idempotent), `false` when no such id exists.
pub fn done(list: &mut TodoList, id: u64) -> bool {
    match list.iter_mut().find(|item| item.id == id) {
        Some(item) => {
            item.done = true;
            true
        }
        None => false,
    }
}

/// Delete the item with `id`.
///
/// Returns `true` when an item was removed, `false` when no such id exists.
pub fn remove(list: &mut TodoList, id: u64) -> bool {
    let before = list.len();
    list.retain(|item| item.id != id);
    list.len() != before
}

/// Read a [`TodoList`] from `path`.
///
/// A missing file is not an error: it is treated as an empty list, which
/// makes the first `todo add` self-initialising.
pub fn load(path: &Path) -> Result<TodoList, TodoError> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(TodoError::Io(err)),
    };
    parse_items(&raw)
}

/// Write `items` to `path` as JSON, creating or truncating the file.
pub fn save(path: &Path, items: &[TodoItem]) -> Result<(), TodoError> {
    let json = to_json(items);
    fs::write(path, json)?;
    Ok(())
}

/// Serialise `items` to the on-disk JSON representation.
fn to_json(items: &[TodoItem]) -> String {
    let mut out = String::from("[");
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('\n');
        // Writing into a `String` cannot fail, but the trait still returns a
        // `Result`, so the value is discarded explicitly.
        let _ = write!(
            out,
            "  {{\"id\":{},\"text\":{},\"done\":{}}}",
            item.id,
            json_string(&item.text),
            item.done
        );
    }
    out.push_str("\n]\n");
    out
}

/// Escape `value` as a JSON string literal, including the quotes.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", ch as u32);
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// Parse the JSON array produced by [`to_json`].
fn parse_items(raw: &str) -> Result<TodoList, TodoError> {
    let chars: Vec<char> = raw.chars().collect();
    let mut items = TodoList::new();
    let mut cursor = 0;
    while cursor < chars.len() {
        if chars[cursor] == '{' {
            let start = cursor;
            let mut depth = 0usize;
            let mut in_string = false;
            let mut escaped = false;
            while cursor < chars.len() {
                let ch = chars[cursor];
                if in_string {
                    if escaped {
                        escaped = false;
                    } else if ch == '\\' {
                        escaped = true;
                    } else if ch == '"' {
                        in_string = false;
                    }
                } else {
                    match ch {
                        '"' => in_string = true,
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                cursor += 1;
            }
            if cursor >= chars.len() {
                return Err(TodoError::Parse("unterminated object".to_string()));
            }
            let object: String = chars[start..=cursor].iter().collect();
            items.push(parse_item(&object)?);
        } else if chars[cursor] == ']' {
            break;
        }
        cursor += 1;
    }
    Ok(items)
}

/// Parse a single `{"id":..,"text":..,"done":..}` object.
fn parse_item(object: &str) -> Result<TodoItem, TodoError> {
    Ok(TodoItem {
        id: parse_id(object)?,
        text: parse_text(object)?,
        done: parse_done(object)?,
    })
}

/// Everything after `key` in `object`, with leading whitespace removed.
fn after<'a>(object: &'a str, key: &str) -> Result<&'a str, TodoError> {
    match object.split_once(key) {
        Some((_, rest)) => Ok(rest.trim_start()),
        None => Err(TodoError::Parse(format!("missing field {key}"))),
    }
}

fn parse_id(object: &str) -> Result<u64, TodoError> {
    let rest = after(object, "\"id\":")?;
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    digits
        .parse::<u64>()
        .map_err(|err| TodoError::Parse(format!("invalid id: {err}")))
}

fn parse_done(object: &str) -> Result<bool, TodoError> {
    let rest = after(object, "\"done\":")?;
    if rest.starts_with("true") {
        Ok(true)
    } else if rest.starts_with("false") {
        Ok(false)
    } else {
        Err(TodoError::Parse("invalid done flag".to_string()))
    }
}

fn parse_text(object: &str) -> Result<String, TodoError> {
    let rest = after(object, "\"text\":")?;
    let mut chars = rest.chars();
    if chars.next() != Some('"') {
        return Err(TodoError::Parse("invalid text field".to_string()));
    }
    let mut out = String::new();
    let mut escaped = false;
    for ch in chars {
        if escaped {
            out.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '"' => '"',
                '\\' => '\\',
                other => other,
            });
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Ok(out);
        } else {
            out.push(ch);
        }
    }
    Err(TodoError::Parse("unterminated text field".to_string()))
}
