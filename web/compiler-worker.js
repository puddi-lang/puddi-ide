let compilerPromise;
let engine = { state: 'loading' };
let current;
let runner;
let runnerUrl;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const recent = new Map();
let lastSuccessfulRun;

function send(kind, id, fields = {}, transfer = []) {
  self.postMessage({ kind, id, ...fields }, transfer);
}

function showEngine(state, percent) {
  engine = { state, percent };
  send('engine', null, engine);
}

async function instantiateCompiler(response, compressed, reportProgress) {
  if (!response.ok || !response.body) throw new Error('Could not download the Puddi compiler');

  const total = Number(response.headers.get('content-length'));
  let received = 0;
  let lastPercent = 0;
  const progress = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      const percent = total ? Math.min(100, Math.floor(received / total * 100)) : 0;
      if (percent >= lastPercent + 5) {
        showEngine(percent === 100 ? 'starting' : 'loading', percent);
        lastPercent = percent;
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (lastPercent < 100) showEngine('starting');
    },
  });
  const incoming = reportProgress ? response.body.pipeThrough(progress) : response.body;
  const wasm = compressed ? incoming.pipeThrough(new DecompressionStream('gzip')) : incoming;
  const module = new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
  const { instance } = await WebAssembly.instantiateStreaming(module);
  return instance.exports;
}

async function loadCompiler() {
  const compressed = typeof DecompressionStream === 'function';
  const filename = compressed ? `${PUDDI_COMPILER_WASM}.gz` : PUDDI_COMPILER_WASM;
  const url = new URL(filename, import.meta.url).href;
  const cache = await self.caches?.open('puddi-ide-compiler-v1').catch(() => undefined);
  const cached = await cache?.match(url).catch(() => undefined);
  if (cached) {
    showEngine('starting');
    try {
      const wasm = await instantiateCompiler(cached, compressed, false);
      showEngine('ready');
      return wasm;
    } catch {
      await cache.delete(url).catch(() => {});
    }
  }

  showEngine('loading');
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const copy = cache && response.ok ? response.clone() : undefined;
  const wasm = await instantiateCompiler(response, compressed, true);
  if (copy) await cache.put(url, copy).catch(() => {});
  showEngine('ready');
  return wasm;
}

function getCompiler() {
  compilerPromise ??= loadCompiler().catch(error => {
    compilerPromise = undefined;
    showEngine('offline');
    throw error;
  });
  return compilerPromise;
}

function execute(wasm, action, files) {
  const sourceKey = JSON.stringify(files);
  const cached = recent.get(action);
  if (cached?.sourceKey === sourceKey) return cached;
  if (action === 'check' && lastSuccessfulRun?.sourceKey === sourceKey) {
    return { ...lastSuccessfulRun, bytes: new Uint8Array() };
  }

  const input = encoder.encode(JSON.stringify({ action, files }));
  const inputPtr = wasm.input_ptr(input.length);
  new Uint8Array(wasm.memory.buffer, inputPtr, input.length).set(input);
  wasm.execute();
  const buffer = wasm.memory.buffer;
  const result = JSON.parse(decoder.decode(new Uint8Array(buffer, wasm.response_ptr(), wasm.response_len())));
  const bytes = new Uint8Array(buffer, wasm.wasm_ptr(), wasm.wasm_len()).slice();
  const response = { ...result, bytes, sourceKey };
  recent.set(action, response);
  if (action === 'run') lastSuccessfulRun = result.ok ? response : undefined;
  return response;
}

function getRunner() {
  if (runner) return runner;
  // The runner travels with this worker so Run does not wait for more scripts.
  runnerUrl ??= URL.createObjectURL(new Blob([PUDDI_RUNNER_CODE], { type: 'text/javascript' }));
  const created = new Worker(runnerUrl, { type: 'module' });
  created.onmessage = ({ data }) => {
    if (current?.id !== data.id || runner !== created) return;
    self.postMessage(data);
    if (data.kind === 'exit' || data.kind === 'failure') current = undefined;
  };
  created.onerror = event => {
    if (runner !== created) return;
    created.terminate();
    runner = undefined;
    if (current?.running) {
      send('failure', current.id, { message: event.message || 'The program runner could not start' });
      current = undefined;
    }
  };
  runner = created;
  return created;
}

function cancel(id) {
  if (current?.id !== id) return;
  if (current.running) {
    runner?.terminate();
    runner = undefined;
  }
  current = undefined;
}

self.addEventListener('message', async ({ data }) => {
  if (data?.action === 'warmup') {
    send('engine', null, engine);
    void getCompiler().catch(() => {});
    return;
  }
  if (data?.action === 'cancel') {
    cancel(data.id);
    return;
  }
  if (!['check', 'run'].includes(data?.action)) return;

  const { id, action, files, preview } = data;
  if (current) cancel(current.id);
  const job = { id, running: false };
  current = job;
  try {
    // Load the console runtime alongside the compiler on a cold run.
    if (action === 'run' && !preview) getRunner();
    const wasm = await getCompiler();
    if (current !== job) return;
    send('phase', id, { phase: 'compiling' });
    const start = performance.now();
    const { bytes, sourceKey, ...result } = execute(wasm, action, files);
    const elapsed = performance.now() - start;
    if (!result.ok || action !== 'run') {
      send('result', id, { ...result, elapsed });
      current = undefined;
      return;
    }

    const download = bytes.slice().buffer;
    send('compiled', id, { diagnostics: result.diagnostics, elapsed, wasm: download }, [download]);
    if (preview) {
      current = undefined;
      return;
    }
    const input = bytes.slice().buffer;
    job.running = true;
    getRunner().postMessage({ kind: 'run', id, bytes: input }, [input]);
  } catch (error) {
    if (current !== job) return;
    send('failure', id, { message: error.message });
    current = undefined;
  }
});
