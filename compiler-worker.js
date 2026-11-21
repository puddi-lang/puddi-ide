import { load } from './puddi-runtime.mjs';

let compiler;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function getCompiler() {
  if (!compiler) {
    const response = await fetch(new URL('./compiler.wasm', import.meta.url));
    if (!response.ok) throw new Error('Could not load the Puddi compiler');
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
    compiler = instance.exports;
  }
  return compiler;
}

function execute(wasm, request) {
  const input = encoder.encode(JSON.stringify(request));
  const inputPtr = wasm.input_ptr(input.length);
  new Uint8Array(wasm.memory.buffer, inputPtr, input.length).set(input);
  wasm.execute();
  const buffer = wasm.memory.buffer;
  const result = JSON.parse(decoder.decode(new Uint8Array(buffer, wasm.response_ptr(), wasm.response_len())));
  const bytes = new Uint8Array(buffer, wasm.wasm_ptr(), wasm.wasm_len()).slice();
  return { ...result, bytes };
}

self.addEventListener('message', async ({ data }) => {
  if (!['check', 'run', 'format'].includes(data?.action)) return;
  const { id, action, files, preview } = data;
  const send = (kind, fields = {}, transfer = []) => self.postMessage({ id, kind, ...fields }, transfer);
  try {
    const start = performance.now();
    const { bytes, ...result } = execute(await getCompiler(), { action, files });
    if (!result.ok || action !== 'run') {
      send('result', { ...result, elapsed: performance.now() - start });
      return;
    }
    // Keep the original bytes until the runtime has instantiated them.
    const download = bytes.slice().buffer;
    send('compiled', { diagnostics: result.diagnostics, elapsed: performance.now() - start, wasm: download }, [download]);
    if (preview) return;
    let lines = 0;
    const instance = await load(bytes, {
      output(fd, text) {
        if (++lines < 500) send('line', { fd, text: text.slice(0, 8000) });
        else if (lines === 500) send('line', { fd: 2, text: 'Output limit reached' });
      },
    });
    send('exit', { code: await instance.run() });
  } catch (error) {
    const message = error instanceof WebAssembly.CompileError
      ? 'This browser could not compile the Wasm module\nTry a browser with WasmGC support'
      : error.message;
    send('failure', { message });
  }
});
