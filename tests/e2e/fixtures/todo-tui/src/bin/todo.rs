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
