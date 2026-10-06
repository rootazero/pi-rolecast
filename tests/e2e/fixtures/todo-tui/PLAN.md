# PLAN — Rust CLI `todo` (fixture crate at `tests/e2e/fixtures/todo-tui/`)

Source of truth: the task spec. Design note (`DESIGN.md`) was not present when this
plan was written, so the spec below is inferred directly from the dispatch brief and
from the fixture's own profile (`tests/e2e/fixtures/todo-tui/.pi/rolecast.yaml`).

## Outcome contract (what must be true at the end)

- Single binary crate, `edition = "2021"`, **zero third-party dependencies** (no
  `[dependencies]` section at all).
- Binary `todo` (`src/bin/todo.rs`) supporting `add <text>`, `list`, `done <id>`,
  `remove <id>`.
- State persists to `./todos.json` **relative to the process CWD**.
- Library `todo` (`src/lib.rs`) exposing **pure** `add` / `done` / `remove` over
  `TodoList`; no I/O inside those three functions.
- `tests/integration.rs` with ≥3 tests (this plan ships 6).
- All gates exit 0:
  - `cargo check --message-format short --all-targets`
  - `cargo test`
  - `cargo clippy --all-targets -- -D warnings`  (and `cargo clippy -- -D warnings`)

## Non-negotiables that constrain every file (from `.pi/rolecast.yaml`)

`forbidden_patterns` scan the written source. The code below is already clean for all
three; **do not introduce any of these while adapting it**:

| Forbidden | Note |
|---|---|
| `#[allow(` | never silence a diagnostic |
| `.unwrap()` | `unwrap_or(0)` / `unwrap_or_else(...)` are fine — the regex is literally `\.unwrap\(\)` |
| `todo!()` | implement, do not stub |

Verify with:
```
grep -rnE '#\[allow\(|\.unwrap\(\)|todo!\(\)' src tests Cargo.toml   # expect: no output
```

## Deviation from the dispatch brief (read before implementing)

The brief asked for the persistence helpers to be `pub(crate) fn load` / `pub(crate)
fn save`, **and** for `src/bin/todo.rs` to read the store "via lib's `load()`".
Those two requirements are mutually exclusive: `src/bin/todo.rs` is a **separate crate
root**, so a `pub(crate)` item in `src/lib.rs` is unreachable from it (crate-private =
crate root only). Resolution:

- `add` / `done` / `remove` stay the pure public domain API (unchanged from the brief).
- `load` / `save` are **`pub`** (documented as the persistence boundary) so the CLI can
  call them. This keeps *all* JSON handling in one module instead of duplicating it in
  the binary. The alternative (`pub(crate)` + the CLI doing its own `fs::read_to_string`
  / `fs::write`) would duplicate the parser and the error type.

This is the only intentional deviation. Everything else follows the brief verbatim.

## Preconditions in the fixture directory (existing scaffold)

The directory already contains a placeholder scaffold that MUST be cleared first,
otherwise a stale target shadows this build:

- `Cargo.toml` (placeholder, package `todo-tui`) → **overwrite** (Step 1).
- `src/lib.rs` (2 comment lines) → **overwrite** (Step 2).
- `src/main.rs` (placeholder `fn main`) → **delete** (Step 0). If left in place it is
  silently shadowed by the explicit `[[bin]] name = "todo"` (verified: cargo does not
  error), but it is dead code a reviewer will flag.
- `tests/smoke.rs` (comment-only placeholder) → **delete** (Step 0); `tests/integration.rs`
  replaces it.
- `Cargo.lock` (pins package name `todo-tui`) → leave it; cargo rewrites the entry
  automatically on the first build.
- `.pi/` (rolecast profile + agent files) and `.gitignore` → **do not touch**.

---

## Step 0: clear the scaffold

  Files: `tests/e2e/fixtures/todo-tui/`
  Contract: `src/main.rs` and `tests/smoke.rs` no longer exist; `src/` contains only
            `lib.rs`; `tests/` is empty.
  Verify: `ls src tests` from the crate root shows only `src: lib.rs` (and `bin` after
          Step 3) and `tests:` empty (or absent).

```bash
cd tests/e2e/fixtures/todo-tui
rm -f src/main.rs tests/smoke.rs
```

---

## Step 1: `Cargo.toml`

  Files: `tests/e2e/fixtures/todo-tui/Cargo.toml`
  Contract: package `todo`, edition 2021, one explicit binary target `todo` at
            `src/bin/todo.rs`, library `todo` auto-discovered at `src/lib.rs`, and **no
            `[dependencies]` table**.
  Verify: `cargo metadata --no-deps --format-version 1 | python3 -c "import json,sys;d=json.load(sys.stdin);print([(t['name'],t['kind'],t['src_path']) for p in d['packages'] for t in p['targets']])"`
          prints exactly `[('todo', ['lib'], '.../src/lib.rs'), ('todo', ['bin'], '.../src/bin/todo.rs')]`.

```toml
[package]
name = "todo"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "todo"
path = "src/bin/todo.rs"
```

---

## Step 2: `src/lib.rs`

  Files: `tests/e2e/fixtures/todo-tui/src/lib.rs`
  Contract:
   - `pub struct TodoItem { pub id: u64, pub text: String, pub done: bool }`
     (`#[derive(Debug, Clone, PartialEq, Eq)]`).
   - `pub type TodoList = Vec<TodoItem>;`
   - `pub enum TodoError { Io(std::io::Error), Parse(String) }` + `Display` + `Error` +
     `From<io::Error>`.
   - `pub fn add(list: &mut TodoList, text: &str) -> u64` — id is
     `list.iter().map(|item| item.id).max().unwrap_or(0) + 1`, then push; returns the id.
   - `pub fn done(list: &mut TodoList, id: u64) -> bool` — `true` if found (idempotent),
     `false` otherwise.
   - `pub fn remove(list: &mut TodoList, id: u64) -> bool` — `retain`, `true` if the
     length changed.
   - `pub fn load(path: &Path) -> Result<TodoList, TodoError>` — missing file ⇒ empty
     list (not an error).
   - `pub fn save(path: &Path, items: &[TodoItem]) -> Result<(), TodoError>`.
   - Manual JSON via `std::fmt::Write`; no serde, no deps. Escapes `" \ \n \r \t` and
     control chars; the reader is a small scanner, not a full JSON parser (the writer
     and reader are a matched pair).
   - No I/O in `add` / `done` / `remove`. Only one `unwrap_or(0)` (on `Iterator::max`,
     not on a `Result`) — permitted by the non-negotiables.
  Verify: `cargo check` exits 0; the Step-4 round-trip test passes.

```rust
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
```

---

## Step 3: `src/bin/todo.rs`

  Files: `tests/e2e/fixtures/todo-tui/src/bin/todo.rs`
  Contract:
   - `fn main() -> std::process::ExitCode`.
   - `const STORE: &str = "todos.json";` — a **relative** path, so it resolves against the
     process CWD.
   - Parses `std::env::args()`, loads via `todo::load(store)`, `match`es on `args[1]`:
     - `add <text>` → `added {id}: {text}`, then `save`.
     - `list` → one line per item, `[x]` / `[ ]` prefix: `[ ] 1 buy milk`.
     - `done <id>` → `marked {id} done`, or `no such id: {id}` on **stderr** with exit 1.
     - `remove <id>` → `removed {id}`, or `no such id: {id}` on stderr with exit 1.
     - unknown/missing subcommand → usage on stderr, exit 2.
   - Writes back to `./todos.json` on every mutating op (`add`, `done`, `remove`).
  Verify: the CLI round-trip test in Step 4 passes; manual smoke test in Step 5.

```rust
//! `todo` — a tiny file-backed todo manager.
//!
//! ```text
//! todo add <text>
//! todo list
//! todo done <id>
//! todo remove <id>
//! ```
//!
//! State lives in `./todos.json`, relative to the current working directory.

use std::path::Path;
use std::process::ExitCode;

use todo::{add, done, load, remove, save, TodoList};

/// Name of the store, resolved against the process working directory.
const STORE: &str = "todos.json";

/// Exit code used for usage errors.
const USAGE_EXIT: u8 = 2;
/// Exit code used for I/O and domain errors.
const FAILURE_EXIT: u8 = 1;

fn usage() -> ExitCode {
    eprintln!("usage: todo <add <text> | list | done <id> | remove <id>>");
    ExitCode::from(USAGE_EXIT)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let Some(command) = args.get(1) else {
        return usage();
    };

    let store = Path::new(STORE);
    let mut items: TodoList = match load(store) {
        Ok(items) => items,
        Err(err) => {
            eprintln!("error: cannot read {STORE}: {err}");
            return ExitCode::from(FAILURE_EXIT);
        }
    };

    match command.as_str() {
        "add" => {
            let text = match args.get(2) {
                Some(text) => text.as_str(),
                None => {
                    eprintln!("usage: todo add <text>");
                    return ExitCode::from(USAGE_EXIT);
                }
            };
            let id = add(&mut items, text);
            match save(store, &items) {
                Ok(()) => {
                    println!("added {id}: {text}");
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("error: cannot write {STORE}: {err}");
                    ExitCode::from(FAILURE_EXIT)
                }
            }
        }
        "list" => {
            for item in &items {
                let mark = if item.done { "[x]" } else { "[ ]" };
                println!("{mark} {} {}", item.id, item.text);
            }
            ExitCode::SUCCESS
        }
        "done" => {
            let id = match args.get(2).and_then(|raw| raw.parse::<u64>().ok()) {
                Some(id) => id,
                None => {
                    eprintln!("usage: todo done <id>");
                    return ExitCode::from(USAGE_EXIT);
                }
            };
            if !done(&mut items, id) {
                eprintln!("no such id: {id}");
                return ExitCode::from(FAILURE_EXIT);
            }
            match save(store, &items) {
                Ok(()) => {
                    println!("marked {id} done");
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("error: cannot write {STORE}: {err}");
                    ExitCode::from(FAILURE_EXIT)
                }
            }
        }
        "remove" => {
            let id = match args.get(2).and_then(|raw| raw.parse::<u64>().ok()) {
                Some(id) => id,
                None => {
                    eprintln!("usage: todo remove <id>");
                    return ExitCode::from(USAGE_EXIT);
                }
            };
            if !remove(&mut items, id) {
                eprintln!("no such id: {id}");
                return ExitCode::from(FAILURE_EXIT);
            }
            match save(store, &items) {
                Ok(()) => {
                    println!("removed {id}");
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("error: cannot write {STORE}: {err}");
                    ExitCode::from(FAILURE_EXIT)
                }
            }
        }
        _ => usage(),
    }
}
```

---

## Step 4: `tests/integration.rs`

  Files: `tests/e2e/fixtures/todo-tui/tests/integration.rs`
  Contract: 6 integration tests, all against the **library** except the last, which drives
            the compiled binary via `env!("CARGO_BIN_EXE_todo")` and asserts state
            round-trips through `./todos.json` across separate process invocations:
   - `test_add_assigns_ids_and_appends`
   - `test_done_marks_matching_id` (covers idempotency + unknown id)
   - `test_remove_deletes_matching_id` (covers the no-op path)
   - `test_save_and_load_round_trip_json` (exercises the JSON escaping path)
   - `test_load_missing_file_is_empty`
   - `test_cli_round_trips_state_through_todos_json` (add → list → done → list → done 42
     (error) → remove → list, each in a fresh `Command::new(...)`)
  Every test uses a CWD/temp path unique per test (pid + nanos) so `cargo test`'s parallel
  runner cannot race.
  Verify: `cargo test` reports `6 passed`.

```rust
//! Behavioural tests for the `todo` library and CLI.
//!
//! The library tests exercise the pure `add` / `done` / `remove` API and the
//! JSON round trip. The final test drives the compiled binary through
//! `./todos.json` in a throwaway working directory.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use todo::{add, done, load, remove, save, TodoItem};

/// A unique path under the system temp directory for this test run.
fn temp_path(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let mut path = std::env::temp_dir();
    path.push(format!(
        "todo-test-{}-{tag}-{nanos}.json",
        std::process::id()
    ));
    path
}

#[test]
fn test_add_assigns_ids_and_appends() {
    let mut list = Vec::new();

    let first = add(&mut list, "write plan");
    let second = add(&mut list, "review plan");

    assert_eq!(first, 1);
    assert_eq!(second, 2);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].text, "write plan");
    assert_eq!(list[1].text, "review plan");
    assert!(list.iter().all(|item| !item.done));
}

#[test]
fn test_done_marks_matching_id() {
    let mut list = Vec::new();
    add(&mut list, "first");
    let target = add(&mut list, "second");

    assert!(done(&mut list, target));
    assert!(!list[0].done);
    assert!(list[1].done);

    // Marking the same item twice is a no-op success.
    assert!(done(&mut list, target));
    assert!(list[1].done);

    // Unknown ids are reported, not panicked on.
    assert!(!done(&mut list, 999));
}

#[test]
fn test_remove_deletes_matching_id() {
    let mut list = Vec::new();
    let doomed = add(&mut list, "throw away");
    add(&mut list, "keep");

    assert!(remove(&mut list, doomed));
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].text, "keep");

    // Removing the same id again reports "nothing to do".
    assert!(!remove(&mut list, doomed));
}

#[test]
fn test_save_and_load_round_trip_json() {
    let path = temp_path("round-trip");
    let mut list: Vec<TodoItem> = Vec::new();
    add(&mut list, "plain");
    let escaping = add(&mut list, "quote \" backslash \\ newline \n tab \t");
    done(&mut list, escaping);

    assert!(save(&path, &list).is_ok());
    match load(&path) {
        Ok(loaded) => assert_eq!(loaded, list),
        Err(err) => panic!("load failed: {err}"),
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn test_load_missing_file_is_empty() {
    let path = temp_path("missing");
    match load(&path) {
        Ok(loaded) => assert!(loaded.is_empty()),
        Err(err) => panic!("load of a missing file failed: {err}"),
    }
}

/// Run the compiled binary in `dir` and capture its output.
fn run_todo(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_todo"))
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap_or_else(|err| panic!("failed to spawn todo: {err}"))
}

#[test]
fn test_cli_round_trips_state_through_todos_json() {
    let dir = temp_path("cli");
    let dir = dir.with_extension("d");
    assert!(std::fs::create_dir_all(&dir).is_ok());

    let add_out = run_todo(&dir, &["add", "buy milk"]);
    assert!(add_out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&add_out.stdout).trim(),
        "added 1: buy milk"
    );

    let list_out = run_todo(&dir, &["list"]);
    assert!(list_out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&list_out.stdout).trim(),
        "[ ] 1 buy milk"
    );

    let done_out = run_todo(&dir, &["done", "1"]);
    assert!(done_out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&done_out.stdout).trim(),
        "marked 1 done"
    );

    let list_out = run_todo(&dir, &["list"]);
    assert_eq!(
        String::from_utf8_lossy(&list_out.stdout).trim(),
        "[x] 1 buy milk"
    );

    let missing_out = run_todo(&dir, &["done", "42"]);
    assert!(!missing_out.status.success());
    assert!(String::from_utf8_lossy(&missing_out.stderr).contains("no such id"));

    let remove_out = run_todo(&dir, &["remove", "1"]);
    assert!(remove_out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&remove_out.stdout).trim(),
        "removed 1"
    );

    let list_out = run_todo(&dir, &["list"]);
    assert!(String::from_utf8_lossy(&list_out.stdout).trim().is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}
```

---

## Step 5: Verification

  Files: none (read-only)
  Contract: all gates exit 0 from the crate root.

Run, from `tests/e2e/fixtures/todo-tui/`:

```bash
cd tests/e2e/fixtures/todo-tui

# 1. compile gate (same flags the e2e profile uses)
cargo check --message-format short --all-targets       # exit 0

# 2. test gate — expect "6 passed; 0 failed"
cargo test                                             # exit 0

# 3. lint gate — the brief's form
cargo clippy --all-targets -- -D warnings              # exit 0

# 3b. lint gate — the form in .pi/rolecast.yaml
cargo clippy -- -D warnings                            # exit 0

# 4. non-negotiables scan — expect NO output
grep -rnE '#\[allow\(|\.unwrap\(\)|todo!\(\)' src tests Cargo.toml
```

### Formatting

**NEVER run `cargo fmt -- <file>`.** That flag is not single-file: `cargo fmt` ignores the
path argument as a scope filter and formats the whole workspace, dirtying unrelated files
(observed previously: ~99 files touched by one invocation). If formatting is needed at all,
use bare `rustfmt` on one file at a time:

```bash
rustfmt --edition 2021 src/lib.rs
rustfmt --edition 2021 src/bin/todo.rs
rustfmt --edition 2021 tests/integration.rs
```

The three files in this plan are already `rustfmt --edition 2021` clean — verified with
`rustfmt --edition 2021 --check <file>` returning no diff — so formatting is a no-op. If a
rustfmt run does produce a diff, keep it `rustfmt`-only; do not fall back to `cargo fmt`.

### Manual smoke test (optional, not a gate)

```bash
cd "$(mktemp -d)"
todo add 'buy milk'          # added 1: buy milk
todo add 'second'
todo list                   # [ ] 1 buy milk / [ ] 2 second
todo done 1                 # marked 1 done
todo list                   # [x] 1 buy milk / [ ] 2 second
cat todos.json              # [\n  {"id":1,"text":"buy milk","done":true},\n  {"id":2,...}\n]
todo remove 1               # removed 1
todo done 42; echo "exit=$?" # no such id: 42 (stderr), exit=1
```

---

## Change surface summary

| File | Action | Lines |
|---|---|---|
| `src/main.rs` | delete (scaffold) | — |
| `tests/smoke.rs` | delete (scaffold) | — |
| `Cargo.toml` | overwrite | 7 |
| `src/lib.rs` | overwrite | ~273 |
| `src/bin/todo.rs` | create | ~121 |
| `tests/integration.rs` | create | ~137 |

**Files to create/modify: 4** (`Cargo.toml`, `src/lib.rs`, `src/bin/todo.rs`,
`tests/integration.rs`), plus 2 scaffold deletions.
