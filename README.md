# Puddi IDE

[Open the IDE](https://puddi-lang.github.io/puddi-ide/) · [Puddi documentation](https://puddi-lang.github.io/puddi-docs/) · [简体中文文档](https://puddi-lang.github.io/puddi-docs/zh-CN/)

Write, check, format and run Puddi in a browser with WebAssembly GC support. The editor supports multiple modules, clickable compiler diagnostics, console output and an isolated preview for programs that use `std.dom`. Workspaces and edited examples are saved in this browser. Source files can be imported or downloaded, and successful runs make the generated core Wasm module available for download.

Drag the divider or use its arrow keys to resize the results pane on wide screens. The workspace sidebar, results panel and line wrapping preferences are saved in this browser. On narrow screens, switch between Editor and Results in the toolbar. Selecting a diagnostic opens its source file and jumps to the reported location.

The browser uses the real Puddi v0.1.0 toolchain, pinned as a Git submodule and compiled to WebAssembly. Format uses a small standalone build of the upstream formatter. On the first visit, the published IDE downloads the compressed compiler from jsDelivr or one of its mirrors, checks its SHA-256 digest and saves the verified Wasm in the browser's origin private file system (OPFS). Later visits load that file into the compiler worker. Browsers that block OPFS can use the compiler for the current tab. The console and preview runners load with the IDE, and repeat actions on unchanged files can reuse the most recent result.

Browsers configured for Simplified Chinese (`zh-CN`, `zh-Hans` or `zh-Hans-CN`) try [JSDMirror](https://cdn.jsdmirror.com/) and [渺软公益 CDN](https://cdn.onmicrosoft.cn/) before jsDelivr. Other browsers try jsDelivr first. A timed-out download or a failed integrity check automatically advances to the next source.

The JavaScript runtime comes from the same compiler revision. The IDE targets the browser and compiles local source files with the browser standard library. Packages with Git dependencies, WASI components and plugins should use [the `pud` CLI](https://puddi-lang.github.io/puddi-docs/toolchain/pud.html).

| Shortcut | Action |
|---|---|
| Ctrl or Command + Enter | Run |
| Ctrl or Command + Shift + Enter | Check |
| Ctrl or Command + Shift + F | Format current file |

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

Use a full commit containing both `compiler.<hash>.wasm` and `compiler.<hash>.wasm.gz` as the jsDelivr source for a production build. For a new compiler revision, publish those two assets to `gh-pages` first. Build the IDE using the exact Wasm bytes from that commit:

```sh
node tools/build.mjs --compiler /path/to/compiler.wasm --cdn-ref <published-commit>
```

Local builds omit `--cdn-ref` and serve the compiler alongside the app. The published compiler worker uses the same pinned commit on every CDN and rejects redirects.

## License

MIT or Apache 2.0, matching the Puddi compiler.
