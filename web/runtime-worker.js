import { load } from '../compiler/upstream/src/runtime.mjs';

self.addEventListener('message', async ({ data }) => {
  if (data?.kind !== 'run') return;
  const { id, bytes } = data;
  const send = (kind, fields) => self.postMessage({ id, kind, ...fields });
  let lines = 0;
  try {
    const program = await load(bytes, {
      output(fd, text) {
        if (++lines < 500) send('line', { fd, text: text.slice(0, 8000) });
        else if (lines === 500) send('line', { fd: 2, text: 'Output limit reached' });
      },
    });
    send('exit', { code: await program.run() });
  } catch (error) {
    const message = error instanceof WebAssembly.CompileError
      ? 'This browser could not compile the Wasm module\nTry a browser with WasmGC support'
      : error.message;
    send('failure', { message });
  }
});
