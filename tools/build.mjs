import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const prebuilt = process.argv[2] === '--compiler' && process.argv[3];
if (process.argv.length > 2 && (!prebuilt || process.argv.length !== 4)) {
  throw new Error('Usage: node tools/build.mjs [--compiler path/to/compiler.wasm]');
}
if (!prebuilt) {
  const cargo = spawnSync('cargo', [
    'build', '--manifest-path', 'compiler/Cargo.toml', '--release', '--locked',
    '--target', 'wasm32-unknown-unknown',
  ], { stdio: 'inherit' });
  if (cargo.error) throw cargo.error;
  if (cargo.status !== 0) process.exit(cargo.status ?? 1);
}
const wasm = resolve(prebuilt || 'compiler/target/wasm32-unknown-unknown/release/puddi_ide_compiler.wasm');

await rm('dist', { recursive: true, force: true });
await mkdir('dist');
const preview = await build({
  entryPoints: ['web/preview.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  external: ['node:*'],
  // The opaque preview frame cannot start nested workers.
  define: { 'import.meta.url': '""' },
});
const script = preview.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const hash = createHash('sha256').update(script).digest('base64');
await Promise.all([
  build({ entryPoints: ['web/app.js'], outfile: 'dist/app.js', bundle: true, format: 'esm', minify: true }),
  cp('web/index.html', 'dist/index.html'),
  cp('web/styles.css', 'dist/styles.css'),
  cp('web/compiler-worker.js', 'dist/compiler-worker.js'),
  cp('compiler/upstream/src/runtime.mjs', 'dist/puddi-runtime.mjs'),
  cp('LICENSE-APACHE', 'dist/LICENSE-APACHE'),
  cp('LICENSE-MIT', 'dist/LICENSE-MIT'),
  cp(wasm, 'dist/compiler.wasm'),
  writeFile('dist/.nojekyll', ''),
  writeFile('dist/preview.html', `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src https: http:; base-uri 'none'; form-action 'none'">
<title>Puddi preview</title>
<style>body{margin:24px;background:white;color:#17232a;font:16px/1.5 system-ui}button,input{font:inherit}</style>
<body><main id="app"></main><script type="module">${script}</script></body>
</html>`),
]);
