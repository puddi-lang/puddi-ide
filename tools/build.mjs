import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const prebuilt = process.argv[2] === '--compiler' && process.argv[3];
if (process.argv.length > 2 && (!prebuilt || process.argv.length !== 4)) {
  throw new Error('Usage: node tools/build.mjs [--compiler path/to/compiler.wasm]');
}
if (!prebuilt) {
  run('cargo', [
    'build', '--manifest-path', 'compiler/Cargo.toml', '--release', '--locked',
    '--target', 'wasm32-unknown-unknown',
  ]);
}

const wasm = resolve(prebuilt || 'compiler/target/wasm32-unknown-unknown/release/puddi_ide_compiler.wasm');
const compiler = await readFile(wasm);
await mkdir('compiler/target', { recursive: true });
run('rustc', [
  'compiler/src/formatter.rs', '--edition=2024', '--crate-type=cdylib',
  '--target=wasm32-unknown-unknown', '-Copt-level=z', '-Clto=fat',
  '-Cpanic=abort', '-Cstrip=symbols', '-o', 'compiler/target/formatter.wasm',
]);
const formatter = await readFile('compiler/target/formatter.wasm');

const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const compilerName = `compiler.${digest(compiler)}.wasm`;
const code = async (entry, options = {}) => (await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  external: ['node:*'],
  ...options,
})).outputFiles[0].text;

const runner = await code('web/runtime-worker.js');
const worker = await code('web/compiler-worker.js', {
  define: {
    PUDDI_COMPILER_WASM: JSON.stringify(compilerName),
    PUDDI_RUNNER_CODE: JSON.stringify(runner),
  },
});
const workerName = `compiler-worker.${digest(worker)}.js`;
const app = await code('web/app.js', {
  define: {
    PUDDI_COMPILER_WORKER: JSON.stringify(workerName),
    PUDDI_FORMATTER: JSON.stringify(formatter.toString('base64')),
  },
});
const appName = `app.${digest(app)}.js`;
const html = (await readFile('web/index.html', 'utf8'))
  .replaceAll('__PUDDI_COMPILER_WORKER__', workerName)
  .replaceAll('__PUDDI_APP__', appName);

const script = (await code('web/preview.js', {
  // The opaque preview frame cannot start nested workers.
  define: { 'import.meta.url': '""' },
})).replace(/<\/script/gi, '<\\/script');
const hash = createHash('sha256').update(script).digest('base64');

await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await Promise.all([
  writeFile(`dist/${appName}`, app),
  writeFile(`dist/${workerName}`, worker),
  writeFile('dist/index.html', html),
  cp('web/styles.css', 'dist/styles.css'),
  cp('LICENSE-APACHE', 'dist/LICENSE-APACHE'),
  cp('LICENSE-MIT', 'dist/LICENSE-MIT'),
  writeFile(`dist/${compilerName}`, compiler),
  writeFile(`dist/${compilerName}.gz`, gzipSync(compiler, { level: 9 })),
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
