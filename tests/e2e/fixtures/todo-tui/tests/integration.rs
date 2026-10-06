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

#[test]
fn test_done_on_empty_list_is_noop() {
    let mut list = Vec::new();

    // No items, so no id can ever match: report failure, do not panic.
    assert!(!done(&mut list, 1));
    assert!(list.is_empty());
}

#[test]
fn test_done_and_remove_unknown_id_report_false() {
    let mut list = Vec::new();
    add(&mut list, "kept");

    // A known id exists, but unknown ids must still report `false` without
    // mutating the list.
    assert!(!done(&mut list, 12345));
    assert!(!remove(&mut list, 12345));
    assert_eq!(list.len(), 1);
    assert!(!list[0].done);
}

#[test]
fn test_add_empty_string_still_allocates_id() {
    let mut list = Vec::new();

    let first = add(&mut list, "");
    assert_eq!(first, 1);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].text, "");

    // An empty description does not stall id allocation.
    let second = add(&mut list, "");
    assert_eq!(second, 2);
    assert_eq!(list.len(), 2);
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

#[test]
fn test_cli_add_then_done_then_list_shows_marked_item() {
    let dir = temp_path("cli-mark").with_extension("d");
    assert!(std::fs::create_dir_all(&dir).is_ok());

    let add_out = run_todo(&dir, &["add", "ship it"]);
    assert!(add_out.status.success());

    let done_out = run_todo(&dir, &["done", "1"]);
    assert!(done_out.status.success());

    let list_out = run_todo(&dir, &["list"]);
    assert!(list_out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&list_out.stdout).trim(),
        "[x] 1 ship it"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_cli_list_on_empty_store_exits_success() {
    let dir = temp_path("cli-empty").with_extension("d");
    assert!(std::fs::create_dir_all(&dir).is_ok());

    let list_out = run_todo(&dir, &["list"]);
    assert!(list_out.status.success());
    // No items yet, so nothing is printed and the store is not created.
    assert!(String::from_utf8_lossy(&list_out.stdout).trim().is_empty());
    assert!(!dir.join("todos.json").exists());

    let _ = std::fs::remove_dir_all(&dir);
}
