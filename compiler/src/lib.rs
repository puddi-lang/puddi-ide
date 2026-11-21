//! A browser entry point for the pinned Puddi compiler.
#![allow(dead_code)]

#[path = "../upstream/src/ast.rs"] mod ast;
#[path = "../upstream/src/codegen.rs"] mod codegen;
#[path = "../upstream/src/derive.rs"] mod derive;
#[path = "../upstream/src/diag.rs"] mod diag;
#[path = "../upstream/src/driver.rs"] mod driver;
#[path = "../upstream/src/elab.rs"] mod elab;
#[path = "../upstream/src/exhaust.rs"] mod exhaust;
#[path = "../upstream/src/ir.rs"] mod ir;
#[path = "../upstream/src/lexer.rs"] mod lexer;
#[path = "../upstream/src/numeric.rs"] mod numeric;
#[path = "../upstream/src/parser.rs"] mod parser;
#[path = "../upstream/src/program.rs"] mod program;
#[path = "../upstream/src/tools.rs"] mod tools;
#[path = "../upstream/src/types.rs"] mod types;
#[path = "../upstream/src/wit.rs"] mod wit;

use std::{cell::RefCell, collections::HashSet};

use diag::{Diag, SourceMap};
use driver::{Mode, UserFile};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Action {
    Check,
    Run,
    Format,
}

#[derive(Deserialize)]
struct File {
    name: String,
    text: String,
}

#[derive(Deserialize)]
struct Request {
    action: Action,
    files: Vec<File>,
}

#[derive(Serialize)]
struct Diagnostic {
    severity: &'static str,
    message: String,
    file: Option<String>,
    line: Option<usize>,
    column: Option<usize>,
    notes: Vec<String>,
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    diagnostics: Vec<Diagnostic>,
    formatted: Option<String>,
}

impl Response {
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            diagnostics: vec![Diagnostic {
                severity: "error",
                message: message.into(),
                file: None,
                line: None,
                column: None,
                notes: Vec::new(),
            }],
            formatted: None,
        }
    }
}

#[derive(Default)]
struct Buffers {
    input: Vec<u8>,
    response: Vec<u8>,
    wasm: Vec<u8>,
}

thread_local! {
    static BUFFERS: RefCell<Buffers> = RefCell::new(Buffers::default());
}

// The worker writes into input_ptr, calls execute, and copies the resulting
// slices before its next request. Rust retains ownership of all three buffers.
#[unsafe(no_mangle)]
pub extern "C" fn input_ptr(len: usize) -> *mut u8 {
    BUFFERS.with_borrow_mut(|b| {
        b.input.resize(len, 0);
        b.input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn execute() {
    BUFFERS.with_borrow_mut(|b| {
        let (response, wasm) = match serde_json::from_slice(&b.input) {
            Ok(request) => process(request),
            Err(error) => (Response::error(error.to_string()), Vec::new()),
        };
        b.response = serde_json::to_vec(&response).expect("serialize response");
        b.wasm = wasm;
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn response_ptr() -> *const u8 {
    BUFFERS.with_borrow(|b| b.response.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn response_len() -> usize {
    BUFFERS.with_borrow(|b| b.response.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_ptr() -> *const u8 {
    BUFFERS.with_borrow(|b| b.wasm.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_len() -> usize {
    BUFFERS.with_borrow(|b| b.wasm.len())
}

fn module_name(name: &str) -> Option<String> {
    let module = name.strip_suffix(".pud")?;
    module.split('/').all(|part| {
        let mut chars = part.bytes();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == b'_')
    }).then(|| module.replace('/', "."))
}

fn diagnostic(map: &SourceMap, diag: Diag) -> Diagnostic {
    let location = map.files.get(diag.span.file as usize)
        .filter(|file| !file.path.starts_with('<'))
        .map(|file| {
            let mut offset = (diag.span.lo as usize).min(file.text.len());
            while !file.text.is_char_boundary(offset) {
                offset -= 1;
            }
            let before = &file.text[..offset];
            let line = before.bytes().filter(|&b| b == b'\n').count() + 1;
            // CodeMirror positions count UTF-16 code units, like JavaScript.
            let column = before.rsplit('\n').next().unwrap_or("").encode_utf16().count() + 1;
            (file.path.clone(), line, column)
        });
    Diagnostic {
        severity: if diag.warning { "warning" } else { "error" },
        message: diag.msg,
        file: location.as_ref().map(|(name, _, _)| name.clone()),
        line: location.as_ref().map(|(_, line, _)| *line),
        column: location.as_ref().map(|(_, _, column)| *column),
        notes: diag.notes,
    }
}

fn process(request: Request) -> (Response, Vec<u8>) {
    if matches!(request.action, Action::Format) {
        let formatted = request.files.first().map(|file| tools::format(&file.text));
        return (Response { ok: true, diagnostics: Vec::new(), formatted }, Vec::new());
    }

    let mut names = HashSet::new();
    let mut files = Vec::new();
    for file in request.files {
        let Some(module) = module_name(&file.name) else {
            return (Response::error(format!("Invalid module path: {}", file.name)), Vec::new());
        };
        if !names.insert(module.clone()) {
            return (Response::error(format!("Duplicate module: {module}")), Vec::new());
        }
        files.push(UserFile {
            module,
            pkg: program::Pkg::User,
            prefix: String::new(),
            aliases: Default::default(),
            display: file.name,
            text: file.text,
        });
    }
    if !names.contains("main") {
        return (Response::error("Add a main.pud file to the workspace"), Vec::new());
    }

    let run = matches!(request.action, Action::Run);
    let mode = if run { Mode::Build } else { Mode::Check };
    let mut map = SourceMap::default();
    match driver::compile(&mut map, files, "main", "browser", mode, None) {
        Ok(result) if run && !result.has_main => {
            (Response::error("Define fn main() in main.pud to run this program"), Vec::new())
        }
        Ok(result) => (
            Response {
                ok: true,
                diagnostics: result.warnings.into_iter().map(|d| diagnostic(&map, d)).collect(),
                formatted: None,
            },
            result.wasm,
        ),
        Err(errors) => (
            Response {
                ok: false,
                diagnostics: errors.into_iter().map(|d| diagnostic(&map, d)).collect(),
                formatted: None,
            },
            Vec::new(),
        ),
    }
}
