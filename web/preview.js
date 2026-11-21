import { load } from '../compiler/upstream/src/runtime.mjs';

const send = (kind, fields = {}) => window.parent.postMessage({ from: 'puddi-preview', kind, ...fields }, '*');

window.addEventListener('message', async event => {
  if (event.source !== window.parent || event.data?.kind !== 'run-preview') return;
  const { id, wasm } = event.data;
  try {
    const instance = await load(wasm, {
      output: (fd, text) => send('line', { id, fd, text }),
    });
    send('exit', { id, code: await instance.run() });
  } catch (error) {
    send('failure', { id, message: error.message });
  }
}, { once: true });

send('ready');
