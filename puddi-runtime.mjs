// Puddi runtime glue. Works in browsers and in Node.js (>= 22).
// Node usage: node puddi.mjs run app.wasm [args...] | node puddi.mjs test app.wasm

const enc = new TextEncoder();
const dec = new TextDecoder();

export class PuddiPanic extends Error {
  constructor(msg) {
    super(msg);
    this.name = "PuddiPanic";
  }
}

function fmtFloat(x, is32) {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  let s;
  if (is32) {
    s = String(x);
    for (let p = 1; p <= 9; p++) {
      const t = x.toPrecision(p);
      if (Math.fround(Number(t)) === x) {
        s = String(Number(t));
        break;
      }
    }
  } else {
    s = String(x);
  }
  s = s.replace("e+", "e");
  if (!/[.eE]/.test(s)) s += ".0";
  return s;
}

function parseFloatStrict(s) {
  const t = s.trim();
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return NaN;
  return Number(t);
}

function mathOp(op, x, y, env) {
  switch (op) {
    case 0: return Math.pow(x, y);
    case 1: return Math.sin(x);
    case 2: return Math.cos(x);
    case 3: return Math.tan(x);
    case 4: return Math.asin(x);
    case 5: return Math.acos(x);
    case 6: return Math.atan(x);
    case 7: return Math.atan2(x, y);
    case 8: return Math.exp(x);
    case 9: return Math.log(x);
    case 10: return Math.log2(x);
    case 11: return Math.log10(x);
    case 12: return Math.cbrt(x);
    case 13: return Math.hypot(x, y);
    case 14: return Math.random();
    case 15: return Date.now();
    case 16: return globalThis.performance ? performance.now() : Date.now();
    case 17: return env.tzOffset ? env.tzOffset() : -new Date().getTimezoneOffset();
    default: return NaN;
  }
}

/// Thrown into a cancelled task at its next suspension point.
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
    this.puddiCancel = true;
  }
}

export const hasJSPI = typeof WebAssembly !== "undefined" && typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function";

/// Build the import object. `env` provides write(fd, bytes), host(op, arg)
/// and optionally hostAsync(op, arg) for operations that may return a promise.
export function makeImports(env, extra = {}) {
  let inst = null;
  let pending = new Uint8Array(0);
  let ok = 1;
  const mem = () => new Uint8Array(inst.exports.memory.buffer);
  const str = (p, n) => dec.decode(mem().subarray(p, p + n));
  const setResult = (r, good) => {
    ok = good ? 1 : 0;
    pending = enc.encode(r == null ? "" : String(r));
    return pending.length;
  };

  // ---- tasks: 0 is the main task; children are started by Scope.spawn
  let cur = 0;
  let nextTid = 1;
  const tasks = new Map([[0, { parent: -1, done: false, cancelled: false, reject: null, promise: null }]]);
  const results = new Map(); // token -> [task, value, ok]
  let nextTok = 1;
  let runTask = null;
  const fatal = (e) => (env.fatal ? env.fatal(e) : setTimeout(() => { throw e; }));
  const cancelTask = (tid) => {
    const t = tasks.get(tid);
    if (!t || t.done || t.cancelled) return;
    t.cancelled = true;
    if (t.reject) t.reject(new Cancelled());
    for (const [id, c] of tasks) if (c.parent === tid) cancelTask(id);
  };
  const scheduler = {
    spawn(runner) {
      const tid = nextTid++;
      const t = { parent: cur, done: false, cancelled: false, reject: null, promise: null };
      tasks.set(tid, t);
      const prev = cur;
      cur = tid;
      let p;
      try {
        p = runTask(runner);
      } catch (e) {
        p = Promise.reject(e);
      } finally {
        cur = prev;
      }
      t.promise = Promise.resolve(p).then(
        () => { t.done = true; },
        (e) => {
          t.done = true;
          if (e && e.puddiCancel) t.cancelled = true;
          else fatal(e);
        },
      );
      return tid;
    },
    cancel: cancelTask,
    isCancelled: () => !!tasks.get(cur)?.cancelled,
    current: () => cur,
    wait(tid) {
      const t = tasks.get(tid);
      return t && !t.done ? t.promise : null;
    },
  };
  env.scheduler = scheduler;

  const syncHost = (op, arg) => {
    switch (op) {
      case 40: return scheduler.spawn(Number(arg));
      case 41: scheduler.cancel(Number(arg)); return "";
      case 42: return scheduler.isCancelled() ? "1" : "0";
      case 43: if (scheduler.isCancelled()) throw new Cancelled(); return "";
    }
    return env.host(op, arg);
  };

  const hostAsync = (op, p, n) => {
    const arg = str(p, n);
    const me = cur;
    const t = tasks.get(me);
    const tok = nextTok++;
    const done = (v, good) => { results.set(tok, [me, v, good]); return tok; };
    if (t && t.cancelled) throw new Cancelled();
    let r;
    try {
      if (op === 102) r = scheduler.wait(Number(arg)) ?? "";
      else r = env.hostAsync ? env.hostAsync(op, arg) : env.host(op, arg);
    } catch (e) {
      if (e && (e.puddiExit !== undefined || e.puddiCancel)) throw e;
      return done(e && e.message !== undefined ? e.message : String(e), false);
    }
    if (!(r instanceof Promise)) return done(r, true);
    if (!hasJSPI) throw new Error("this operation needs WebAssembly JSPI (Node.js 24+ or a current browser)");
    return new Promise((resolve, reject) => {
      if (t) t.reject = reject;
      r.then(
        (v) => resolve(done(v, true)),
        (e) => {
          if (e && (e.puddiExit !== undefined || e.puddiCancel)) reject(e);
          else resolve(done(e && e.message !== undefined ? e.message : String(e), false));
        },
      );
    }).finally(() => { if (t) t.reject = null; });
  };

  const imports = {
    puddi: {
      write(fd, p, n) {
        env.write(fd, mem().slice(p, p + n));
      },
      panic(p, n) {
        throw new PuddiPanic(str(p, n));
      },
      fmt_f64(x, p, is32) {
        const b = enc.encode(fmtFloat(x, is32));
        mem().set(b, p);
        return b.length;
      },
      parse_f64(p, n) {
        return parseFloatStrict(str(p, n));
      },
      math(op, x, y) {
        return mathOp(op, x, y, env);
      },
      host(op, p, n) {
        const arg = str(p, n);
        try {
          return setResult(syncHost(op, arg), true);
        } catch (e) {
          if (e && (e.puddiExit !== undefined || e.puddiCancel)) throw e;
          return setResult(e && e.message !== undefined ? e.message : String(e), false);
        }
      },
      host_async: hasJSPI ? new WebAssembly.Suspending(hostAsync) : hostAsync,
      host_claim(tok) {
        const [task, v, good] = results.get(tok);
        results.delete(tok);
        cur = task;
        return setResult(v, good);
      },
      host_take(p) {
        mem().set(pending, p);
      },
      host_ok() {
        return ok;
      },
    },
  };
  for (const [mod, fns] of Object.entries(extra)) {
    imports[mod] = imports[mod] || {};
    for (const [name, f] of Object.entries(fns)) {
      // raw @extern imports receive strings as (ptr, len); hosts can use readStr
      imports[mod][name] = f;
    }
  }
  const api = {
    imports,
    scheduler,
    bind(instance) {
      inst = instance;
      const ex = instance.exports;
      const wrap = (f) => (f && hasJSPI ? WebAssembly.promising(f) : f);
      runTask = wrap(ex.__run_task);
      api.call = (name, ...args) => Promise.resolve(wrap(ex[name])(...args));
      api.callback = wrap(ex.__callback);
    },
    readStr: str,
  };
  return api;
}

/// The core module inside a component built by `pud build --target browser`,
/// or the bytes themselves when they already are a core module.
export function coreModuleBytes(source) {
  const b = source instanceof Uint8Array ? source : new Uint8Array(source);
  // component preamble: \0asm, version 0x0d, layer 1
  if (!(b[4] === 0x0d && b[5] === 0 && b[6] === 1 && b[7] === 0)) return b;
  let pos = 8;
  let best = null;
  const leb = () => {
    let r = 0, shift = 0, x;
    do { x = b[pos++]; r += (x & 0x7f) * 2 ** shift; shift += 7; } while (x & 0x80);
    return r;
  };
  while (pos < b.length) {
    const id = b[pos++];
    const size = leb();
    if (id === 1 && (!best || size > best.length)) best = b.subarray(pos, pos + size);
    pos += size;
  }
  if (!best) throw new Error("the component contains no core module");
  return best;
}

/// Compiles a Puddi module from bytes (component or core module).
export function compile(bytes) {
  return WebAssembly.compile(coreModuleBytes(bytes));
}

/// Instantiates a core module. Modules unpacked from a component use WIT
/// names for imports and exports; the `puddi:names` section maps them back.
export async function instantiate(mod, imports) {
  const sec = WebAssembly.Module.customSections(mod, "puddi:names");
  if (sec.length === 0) return WebAssembly.instantiate(mod, imports);
  const names = JSON.parse(new TextDecoder().decode(sec[0]));
  const root = {};
  const exportNames = {};
  for (const n of names) {
    if (n[0] === "i") {
      const f = imports[n[2]] && imports[n[2]][n[3]];
      if (f === undefined) throw new Error(`missing import ${n[2]}.${n[3]}`);
      root[n[1]] = f;
    } else exportNames[n[1]] = n[2];
  }
  const instance = await WebAssembly.instantiate(mod, { $root: root });
  const exports = {};
  for (const [k, v] of Object.entries(instance.exports)) exports[exportNames[k] ?? k] = v;
  return { exports };
}

export function panicMessage(e) {
  if (e instanceof PuddiPanic) return e.message;
  if (e instanceof RangeError && /call stack/i.test(e.message)) return "stack overflow";
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError) {
    const m = e.message;
    if (/divide by zero|remainder by zero/i.test(m)) return "division by zero";
    if (/out of bounds/i.test(m)) return "index out of bounds";
    if (/unreachable/i.test(m)) return "entered unreachable code";
    if (/null/i.test(m)) return "null reference";
    if (/integer overflow/i.test(m)) return "integer overflow";
    return m;
  }
  return null;
}

function lineWriter(sink) {
  const bufs = { 1: "", 2: "" };
  return {
    write(fd, bytes) {
      bufs[fd] += dec.decode(bytes);
      let i;
      while ((i = bufs[fd].indexOf("\n")) >= 0) {
        sink(fd, bufs[fd].slice(0, i));
        bufs[fd] = bufs[fd].slice(i + 1);
      }
    },
    flush() {
      for (const fd of [1, 2]) {
        if (bufs[fd]) sink(fd, bufs[fd]);
        bufs[fd] = "";
      }
    },
  };
}

// ---------------------------------------------------------------- shared host operations

async function httpFetch(arg) {
  const [method, url, hdrs, ...rest] = arg.split("\0");
  const body = rest.join("\0");
  const headers = {};
  for (const line of hdrs.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const res = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body });
  const text = await res.text();
  const hs = [...res.headers].map(([k, v]) => `${k}:${v}`).join("\n");
  return `${res.status}\0${hs}\0${text}`;
}

function channel() {
  const inbox = [];
  const waiters = [];
  let closed = false;
  return {
    push(m) {
      if (waiters.length) waiters.shift()("1" + m);
      else inbox.push(m);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()("");
    },
    recv() {
      if (inbox.length) return "1" + inbox.shift();
      if (closed) return "";
      return new Promise((r) => waiters.push(r));
    },
  };
}

/// Worker bookkeeping for the owning instance. `spawn(entry, onMessage)`
/// creates the platform worker and returns { post(msg), terminate() }.
function workerHost(spawn) {
  const workers = new Map();
  let next = 1;
  return {
    start(entry) {
      const id = next++;
      const ch = channel();
      const handle = spawn(entry, (m) => (m.done ? ch.close() : ch.push(m.msg)));
      workers.set(id, { ch, handle });
      return String(id);
    },
    send(arg) {
      const i = arg.indexOf("\0");
      workers.get(Number(arg.slice(0, i))).handle.post({ msg: arg.slice(i + 1) });
      return "";
    },
    recv: (id) => workers.get(id).ch.recv(),
    close(id) {
      const w = workers.get(id);
      if (!w) return "";
      w.handle.terminate();
      w.ch.close();
      workers.delete(id);
      return "";
    },
  };
}

/// Host operations that work the same everywhere: time, HTTP, tasks and workers.
function commonOps(ctx) {
  return {
    sync(op, arg) {
      switch (op) {
        case 50: if (!ctx.workers) throw new Error("workers are not available here"); return ctx.workers.start(Number(arg));
        case 51: return ctx.workers.send(arg);
        case 52: return ctx.workers.close(Number(arg));
        case 53: ctx.port.post({ msg: arg }); return "";
        case 54: ctx.port.post({ done: true }); return "";
      }
      return undefined;
    },
    async(op, arg) {
      switch (op) {
        case 100: return new Promise((r) => setTimeout(() => r(""), Math.max(0, Number(arg))));
        case 101: return httpFetch(arg);
        case 103: return ctx.workers.recv(Number(arg));
        case 104: return ctx.port.ch.recv();
      }
      return undefined;
    },
  };
}

function domOps(api, fatal) {
  const nodes = [null];
  const ids = new WeakMap();
  const events = [null];
  const id = (n) => {
    if (!n) return "";
    let i = ids.get(n);
    if (i === undefined) {
      i = nodes.length;
      nodes.push(n);
      ids.set(n, i);
    }
    return String(i);
  };
  const get = (s) => nodes[Number(s)];
  return (op, arg) => {
    if (op < 60 || op > 82) return undefined;
    const a = arg.split("\0");
    switch (op) {
      case 60: return id(document.querySelector(arg));
      case 61: return id(document.createElement(arg));
      case 62: return get(a[0]).textContent ?? "";
      case 63: get(a[0]).textContent = a[1]; return "";
      case 64: { const v = get(a[0]).getAttribute(a[1]); if (v === null) throw new Error("no attribute"); return v; }
      case 65: get(a[0]).setAttribute(a[1], a[2]); return "";
      case 66: get(a[0]).append(get(a[1])); return "";
      case 67: get(a[0]).remove(); return "";
      case 68: return get(a[0]).value ?? "";
      case 69: get(a[0]).value = a[1]; return "";
      case 70: get(a[0]).classList.add(a[1]); return "";
      case 71: get(a[0]).classList.remove(a[1]); return "";
      case 72: get(a[0]).innerHTML = a[1]; return "";
      case 73: {
        const cb = Number(a[2]);
        get(a[0]).addEventListener(a[1], (ev) => {
          const eid = events.length;
          events.push(ev);
          Promise.resolve(api.callback(cb, eid)).catch(fatal).finally(() => { events[eid] = null; });
        });
        return "";
      }
      case 74: return id(document.body);
      case 75: get(a[0]).style.setProperty(a[1], a[2]); return "";
      case 76: document.title = arg; return "";
      case 77: get(a[0]).classList.toggle(a[1]); return "";
      case 78: return [...document.querySelectorAll(arg)].map(id).join(",");
      case 79: return id(get(a[0]).querySelector(a[1]));
      case 80: {
        const ev = events[Number(a[0])];
        if (a[1] === "type") return ev.type;
        if (a[1] === "key") return ev.key ?? "";
        if (a[1] === "value") return ev.target && ev.target.value !== undefined ? String(ev.target.value) : "";
        return "";
      }
      case 81: return id(events[Number(a[0])].target);
      case 82: events[Number(a[0])].preventDefault(); return "";
    }
    return undefined;
  };
}

function exitCodeOf(e) {
  return e && e.puddiExit !== undefined ? e.puddiExit : null;
}

/// Browser / generic loader. Returns { instance, exports, run() }; run() resolves to the exit code.
export async function load(source, opts = {}) {
  const output = opts.output || ((fd, line) => (fd === 2 ? console.error(line) : console.log(line)));
  const lw = lineWriter(output);
  const fatal = (e) => {
    lw.flush();
    const m = panicMessage(e);
    output(2, m !== null ? `panic: ${m}` : String(e && e.stack ? e.stack : e));
  };
  let mod;
  if (source instanceof WebAssembly.Module) mod = source;
  else if (typeof source === "string" || source instanceof URL) mod = await compile(await (await fetch(source)).arrayBuffer());
  else mod = await compile(source);
  const ctx = {};
  if (typeof Worker !== "undefined") {
    ctx.workers = workerHost((entry, onMessage) => {
      const w = new Worker(import.meta.url, { type: "module" });
      w.onmessage = (ev) => onMessage(ev.data);
      w.onerror = (ev) => fatal(ev.message || ev);
      w.postMessage({ puddiInit: { module: mod, entry } });
      return { post: (m) => w.postMessage(m), terminate: () => w.terminate() };
    });
  }
  if (opts.port) ctx.port = opts.port;
  const common = commonOps(ctx);
  let api;
  let dom = () => undefined;
  const env = {
    fatal,
    write: (fd, b) => lw.write(fd, b),
    host(op, arg) {
      const c = common.sync(op, arg);
      if (c !== undefined) return c;
      const d = typeof document !== "undefined" ? dom(op, arg) : undefined;
      if (d !== undefined) return d;
      if (op === 30) {
        const [lvl, msg] = arg.split("\0");
        (lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log)(`[${lvl}] ${msg}`);
        return "";
      }
      if (opts.host) return opts.host(op, arg);
      throw new Error("host operation not available in this environment");
    },
    hostAsync(op, arg) {
      const c = common.async(op, arg);
      return c !== undefined ? c : env.host(op, arg);
    },
  };
  api = makeImports(env, opts.imports || {});
  dom = domOps(api, fatal);
  const instance = await instantiate(mod, api.imports);
  api.bind(instance);
  return {
    instance,
    exports: instance.exports,
    call: api.call,
    async run() {
      try {
        const code = instance.exports.main ? await api.call("main") : 0;
        lw.flush();
        return code;
      } catch (e) {
        lw.flush();
        const x = exitCodeOf(e);
        if (x !== null) return x;
        const m = panicMessage(e);
        if (m !== null) {
          output(2, `panic: ${m}`);
          return 101;
        }
        throw e;
      }
    },
  };
}

// Browser worker: the owner posts { puddiInit: { module, entry } } first.
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  const ch = channel();
  let started = false;
  globalThis.onmessage = async (ev) => {
    const d = ev.data;
    if (!started && d && d.puddiInit) {
      started = true;
      const port = { ch, post: (m) => globalThis.postMessage(m) };
      const app = await load(d.puddiInit.module, { port });
      await app.call("__worker_entry", d.puddiInit.entry);
      return;
    }
    if (d && d.msg !== undefined) ch.push(d.msg);
  };
}

// ---------------------------------------------------------------- Node CLI

async function nodeEnv(fs, process, wasmPath, rest, ctx) {
  let stdinBuf = Buffer.alloc(0);
  let stdinEof = false;
  const readStdinChunk = () => {
    const b = Buffer.alloc(65536);
    let n = 0;
    try {
      n = fs.readSync(0, b, 0, b.length, null);
    } catch (e) {
      if (e.code === "EAGAIN") return true;
      if (e.code === "EOF") n = 0;
      else throw e;
    }
    if (n === 0) {
      stdinEof = true;
      return false;
    }
    stdinBuf = Buffer.concat([stdinBuf, b.subarray(0, n)]);
    return true;
  };
  const ioErr = (e) => {
    const code = e.code === "ENOENT" ? "NotFound" : e.code === "EACCES" || e.code === "EPERM" ? "PermissionDenied" : e.code === "EEXIST" ? "AlreadyExists" : "Other";
    return new Error(`${code}\0${e.message}`);
  };
  const common = commonOps(ctx);
  const env = {
    write(fd, b) {
      fs.writeSync(fd, b);
    },
    fatal(e) {
      const x = exitCodeOf(e);
      if (x !== null) process.exit(x);
      const m = panicMessage(e);
      fs.writeSync(2, m !== null ? `panic: ${m}\n` : `${e && e.stack ? e.stack : e}\n`);
      process.exit(m !== null ? 101 : 70);
    },
    hostAsync(op, arg) {
      const c = common.async(op, arg);
      return c !== undefined ? c : env.host(op, arg);
    },
    host(op, arg) {
      const c = common.sync(op, arg);
      if (c !== undefined) return c;
      try {
        switch (op) {
          case 1: return fs.readFileSync(arg, "utf8");
          case 2: { const i = arg.indexOf("\0"); fs.writeFileSync(arg.slice(0, i), arg.slice(i + 1)); return ""; }
          case 3: { const i = arg.indexOf("\0"); fs.appendFileSync(arg.slice(0, i), arg.slice(i + 1)); return ""; }
          case 4: return fs.existsSync(arg) ? "1" : "0";
          case 5: fs.rmSync(arg, { recursive: true }); return "";
          case 6: return fs.readdirSync(arg).sort().join("\n");
          case 7: fs.mkdirSync(arg, { recursive: true }); return "";
          case 8: return fs.statSync(arg).isDirectory() ? "1" : "0";
        }
      } catch (e) {
        throw ioErr(e);
      }
      switch (op) {
        case 10: return [wasmPath.replace(/\.wasm$/, ""), ...rest].join("\0");
        case 11: {
          const v = process.env[arg];
          if (v === undefined) throw new Error("not set");
          return v;
        }
        case 12: {
          const e = new Error("exit");
          e.puddiExit = Number(arg);
          throw e;
        }
        case 20: {
          for (;;) {
            const i = stdinBuf.indexOf(10);
            if (i >= 0) {
              const line = stdinBuf.subarray(0, i).toString("utf8").replace(/\r$/, "");
              stdinBuf = stdinBuf.subarray(i + 1);
              return line;
            }
            if (stdinEof || !readStdinChunk()) {
              if (stdinBuf.length === 0) throw new Error("end of input");
              const line = stdinBuf.toString("utf8");
              stdinBuf = Buffer.alloc(0);
              return line;
            }
          }
        }
        case 21: {
          while (!stdinEof && readStdinChunk()) {}
          const s = stdinBuf.toString("utf8");
          stdinBuf = Buffer.alloc(0);
          return s;
        }
        case 22: fs.writeSync(1, arg); return "";
        case 23: fs.writeSync(2, arg); return "";
        case 30: {
          const [lvl, msg] = arg.split("\0");
          fs.writeSync(2, `[${lvl}] ${msg}\n`);
          return "";
        }
      }
      throw new Error(`unknown host operation ${op}`);
    },
  };
  return env;
}

async function nodeInstantiate(mod, env) {
  const api = makeImports(env);
  const instance = await instantiate(mod, api.imports);
  api.bind(instance);
  return { instance, api };
}

async function nodeMain() {
  const fs = await import("node:fs");
  const { Worker } = await import("node:worker_threads");
  const process = globalThis.process;
  const [cmd, wasmPath, ...rest] = process.argv.slice(2);
  const mod = await compile(fs.readFileSync(wasmPath));
  const ctx = {};
  ctx.workers = workerHost((entry, onMessage) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { puddiWorker: true, module: mod, entry, wasmPath, rest }, stdout: false, stderr: false });
    w.on("message", (m) => (m.fatal !== undefined ? process.exit(m.fatal) : onMessage(m)));
    w.on("error", (e) => env.fatal(e));
    return { post: (m) => w.postMessage(m), terminate: () => w.terminate() };
  });
  const env = await nodeEnv(fs, process, wasmPath, rest, ctx);
  const report = (e) => {
    const x = exitCodeOf(e);
    if (x !== null) return { code: x };
    const m = panicMessage(e);
    if (m === null) throw e;
    return { code: 101, msg: m };
  };
  if (cmd === "run") {
    const { instance, api } = await nodeInstantiate(mod, env);
    let code = 0;
    try {
      code = instance.exports.main ? await api.call("main") : 0;
    } catch (e) {
      const r = report(e);
      if (r.msg !== undefined) fs.writeSync(2, `panic: ${r.msg}\n`);
      code = r.code;
    }
    process.exit(code);
  } else if (cmd === "test") {
    const tests = JSON.parse(fs.readFileSync(wasmPath.replace(/\.wasm$/, ".tests.json"), "utf8"));
    const filter = rest[0];
    let passed = 0;
    let failed = 0;
    const selected = tests.filter(([name]) => !filter || name.includes(filter));
    fs.writeSync(1, `running ${selected.length} test${selected.length === 1 ? "" : "s"}\n`);
    for (const [name, exp] of selected) {
      const { api } = await nodeInstantiate(mod, env);
      try {
        await api.call(exp);
        passed++;
        fs.writeSync(1, `test "${name}" ... ok\n`);
      } catch (e) {
        const r = report(e);
        failed++;
        fs.writeSync(1, `test "${name}" ... FAILED\n    panic: ${r.msg ?? "exit"}\n`);
      }
    }
    fs.writeSync(1, `\n${failed === 0 ? "ok" : "FAILED"}: ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  } else {
    fs.writeSync(2, "usage: node puddi.mjs run|test app.wasm [args...]\n");
    process.exit(2);
  }
}

async function nodeWorkerMain(wt) {
  const fs = await import("node:fs");
  const process = globalThis.process;
  const { module, entry, wasmPath, rest } = wt.workerData;
  const ch = channel();
  wt.parentPort.on("message", (m) => {
    if (m && m.msg !== undefined) ch.push(m.msg);
  });
  const ctx = { port: { ch, post: (m) => wt.parentPort.postMessage(m) } };
  const env = await nodeEnv(fs, process, wasmPath, rest, ctx);
  env.fatal = (e) => {
    const x = exitCodeOf(e);
    const m = panicMessage(e);
    if (x === null) fs.writeSync(2, m !== null ? `panic: ${m}\n` : `${e && e.stack ? e.stack : e}\n`);
    wt.parentPort.postMessage({ fatal: x !== null ? x : m !== null ? 101 : 70 });
  };
  const { api } = await nodeInstantiate(module, env);
  try {
    await api.call("__worker_entry", entry);
  } catch (e) {
    env.fatal(e);
  }
  wt.parentPort.close();
}

if (typeof process !== "undefined" && process.versions && process.versions.node) {
  const wt = await import("node:worker_threads");
  if (!wt.isMainThread && wt.workerData && wt.workerData.puddiWorker) {
    nodeWorkerMain(wt);
  } else if (wt.isMainThread && process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
    nodeMain().catch((e) => {
      console.error(e);
      process.exit(70);
    });
  }
}
