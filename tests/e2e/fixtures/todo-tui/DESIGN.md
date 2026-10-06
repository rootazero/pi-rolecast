# todo-tui design

## Crate layout

Decision: keep `tests/e2e/fixtures/todo-tui/` as one Cargo package, edition 2021, with no third-party dependencies. It should build a library target named `todo` and a binary target named `todo`:

- `src/lib.rs`: data model, pure list mutations, pure JSON encode/decode helpers, shared error type.
- `src/bin/todo.rs`: `std::env::args()` parsing, command dispatch, `./todos.json` filesystem I/O, stderr reporting, exit codes.
- `tests/integration.rs`: library tests plus one binary persistence round-trip test.

The library must not perform filesystem I/O. The binary owns `std::env::current_dir()`, path selection, file existence checks, reads, and writes.

## Data model

```rust
pub struct TodoItem {
    pub id: u64,
    pub text: String,
    pub done: bool,
}

pub struct TodoList(pub Vec<TodoItem>);
```

Using `Vec<TodoItem>` directly is acceptable where it keeps signatures simpler.

## Library API

Required pure mutations:

```rust
pub fn add(list: &mut Vec<TodoItem>, text: &str) -> u64;
pub fn done(list: &mut Vec<TodoItem>, id: u64) -> bool;
pub fn remove(list: &mut Vec<TodoItem>, id: u64) -> bool;
```

`add` returns `list.iter().map(|i| i.id).max().unwrap_or(0) + 1`, then appends the new item with `done: false`. `done` returns true only when the id exists and is marked. `remove` returns true only when an item was removed.

## CLI surface

`src/bin/todo.rs` supports:

- `todo add <text...>`: join remaining args with spaces, mutate, save.
- `todo list`: print all items; no save.
- `todo done <id>`: parse `u64`, mark, save, or report not found.
- `todo remove <id>`: remove, save, or report not found.

State is `std::env::current_dir()?.join("todos.json")`. On startup, read it if present; otherwise start with an empty list. Every mutating command writes the full file back.

## JSON schema

```json
{"items":[{"id":1,"text":"...","done":false}]}
```

Do not add `serde` or `serde_json`. Prefer a small `std::fmt::Write` serializer that escapes strings and emits the fixed object/array shape. A matching tiny parser may accept only this schema and return a JSON error for malformed input; no recursion is needed beyond the item array.

## Error handling

```rust
pub enum TodoError {
    Io(std::io::Error),
    Json(String),
    NotFound(u64),
}

pub type Result<T> = std::result::Result<T, TodoError>;
```

The binary maps I/O and parse failures into `TodoError`, prints errors to stderr, and exits with code 1. Library mutation functions do not return `Result` because missing ids are represented by `false`.

## Testing strategy

Integration tests should call the library directly for add/done/remove happy paths and unknown-id false returns. Add one CLI round-trip test using:

```rust
std::process::Command::new(env!("CARGO_BIN_EXE_todo"))
```

Run the binary in a temporary current directory made with `std`, then assert `todos.json` persists across separate invocations.

## Clippy-cleanliness checklist

- No `#[allow(...)]` anywhere.
- No third-party dependencies.
- No `unwrap()` on filesystem I/O.
- `cargo check`, `cargo test`, and `cargo clippy --all-targets -- -D warnings` must pass.

## Options considered

- `serde_json`: rejected because the fixture must have zero third-party deps.
- Manual `String` concatenation: rejected in favor of `std::fmt::Write` for clearer, incremental output.
- Filesystem logic in the library: rejected so `todo` remains pure and easy to test.
