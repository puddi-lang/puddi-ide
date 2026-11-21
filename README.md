# Puddi IDE

[Open the IDE](https://puddi-lang.github.io/puddi-ide/) · [Puddi documentation](https://puddi-lang.github.io/puddi-docs/) · [简体中文文档](https://puddi-lang.github.io/puddi-docs/zh-CN/)

Write, check, format and run Puddi in a browser with WebAssembly GC support. The editor supports multiple modules, clickable compiler diagnostics, console output and an isolated preview for programs that use `std.dom`. Workspaces and edited examples are saved in this browser. Source files can be imported or downloaded, and successful runs make the generated core Wasm module available for download.

The browser uses the real Puddi v0.1.0 toolchain, pinned as a Git submodule and compiled to WebAssembly. Format uses a small standalone build of the upstream formatter. Check and Run use a compressed compiler that starts loading in parallel with the editor and stays in browser cache across visits. The runner ships with the compiler worker, and repeat actions on unchanged files can reuse the most recent result.

The JavaScript runtime comes from the same compiler revision. The IDE targets the browser and compiles local source files with the browser standard library. Packages with Git dependencies, WASI components and plugins should use [the `pud` CLI](https://puddi-lang.github.io/puddi-docs/toolchain/pud.html).

| Shortcut | Action |
|---|---|
| Ctrl or Command + Enter | Run |
| Ctrl or Command + Shift + Enter | Check |

## Build

Use Node.js 22 or newer, stable Rust with `wasm32-unknown-unknown`, and Git.

```sh
git clone --recurse-submodules https://github.com/puddi-lang/puddi-ide.git
cd puddi-ide
rustup target add wasm32-unknown-unknown
npm ci
npm run build
python3 -m http.server --directory dist 8000
```

Open `http://localhost:8000`. If the compiler has already been built with the pinned sources, run `node tools/build.mjs --compiler /path/to/compiler.wasm` to reuse it. This still builds the standalone formatter with `rustc`.

## Publish

GitHub Pages serves the root of `gh-pages`. Build `dist/` first, then publish its contents, including `.nojekyll`, to that branch. Keep source changes on `main`. The JavaScript entry points and compiler carry content hashes in their filenames so a cached HTML page keeps loading the assets from its own release. Retain the previous deployment’s named assets during rollout. The IDE uses relative asset URLs so it also works under the repository path on GitHub Pages.

## License

MIT or Apache 2.0, matching the Puddi compiler.
