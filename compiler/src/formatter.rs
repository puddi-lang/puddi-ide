//! A small standalone Wasm build of Puddi's formatter.
#![allow(dead_code)]

#[path = "../upstream/src/tools.rs"]
mod tools;

use std::cell::RefCell;

#[derive(Default)]
struct Buffers {
    input: Vec<u8>,
    output: String,
}

thread_local! {
    static BUFFERS: RefCell<Buffers> = RefCell::new(Buffers::default());
}

#[unsafe(no_mangle)]
pub extern "C" fn input_ptr(len: usize) -> *mut u8 {
    BUFFERS.with_borrow_mut(|b| {
        b.input.resize(len, 0);
        b.input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn format_source() {
    BUFFERS.with_borrow_mut(|b| {
        let source = std::str::from_utf8(&b.input).expect("source is UTF-8");
        b.output = tools::format(source);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const u8 {
    BUFFERS.with_borrow(|b| b.output.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn output_len() -> usize {
    BUFFERS.with_borrow(|b| b.output.len())
}
