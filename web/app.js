import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { setDiagnostics } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { examples } from './examples.js';
import { formatSource } from './formatter.js';

const el = id => document.getElementById(id);
const storageKey = 'puddi-ide/v1';
const maxSource = 512 * 1024;
const maxFiles = 32;
const validName = name => /^(?:[a-zA-Z_]\w*\/)*[a-zA-Z_]\w*\.pud$/.test(name);
const projects = Object.fromEntries(Object.entries(examples).map(([id, example]) =>
  [id, { current: 'main.pud', files: { ...example.files } }]));

let activeProject = 'workspace';
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  for (const [id, fallback] of Object.entries(projects)) {
    const draft = saved?.projects?.[id];
    if (!draft || !draft.files || typeof draft.files['main.pud'] !== 'string') continue;
    const files = Object.entries(draft.files).filter(([name, text]) => validName(name) && typeof text === 'string');
    projects[id] = {
      files: Object.fromEntries(files),
      current: files.some(([name]) => name === draft.current) ? draft.current : fallback.current,
    };
  }
  if (Object.hasOwn(projects, saved?.activeProject)) activeProject = saved.activeProject;
} catch {
  // A corrupt or unavailable local store does not prevent editing.
}

const project = () => projects[activeProject];
const stateCache = new Map();
const cacheKey = () => `${activeProject}/${project().current}`;
let saveTimer;
let revision = 0;
let diagnostics = [];
let worker;
let engine = { state: 'loading' };
let pending;
let sequence = 0;
let download;
let previewRun;
let frame = el('preview-frame');
let activeTab = 'console';

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ activeProject, projects }));
    el('save-status').textContent = 'Saved on this device';
  } catch {
    el('save-status').textContent = 'Local saving unavailable';
  }
}

function scheduleSave() {
  el('save-status').textContent = 'Saving locally';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}

window.addEventListener('pagehide', persist);

const keywords = /^(?:as|async|await|break|const|continue|dyn|else|enum|export|fn|for|if|impl|import|in|let|loop|match|pub|return|self|struct|test|trait|type|var|while)\b/;
const puddi = StreamLanguage.define({
  startState: () => ({ comment: 0, quote: null }),
  token(stream, state) {
    if (!state.comment && !state.quote) {
      if (stream.eatSpace()) return null;
      if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
      if (stream.match('/*')) state.comment = 1;
      else if (stream.peek() === '"' || stream.peek() === "'") state.quote = stream.next();
    }
    if (state.comment) {
      while (!stream.eol() && state.comment) {
        if (stream.match('/*')) state.comment++;
        else if (stream.match('*/')) state.comment--;
        else stream.next();
      }
      return 'comment';
    }
    if (state.quote) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '\\') stream.next();
        else if (ch === state.quote) { state.quote = null; break; }
      }
      return 'string';
    }
    if (stream.match(keywords)) return 'keyword';
    if (stream.match(/^(?:true|false)\b/)) return 'bool';
    if (stream.match(/^@[a-zA-Z_]\w*/)) return 'meta';
    if (stream.match(/^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)/)) return 'number';
    if (stream.match(/^[A-Z]\w*/)) return 'typeName';
    if (stream.match(/^[a-z_]\w*/i)) return 'variableName';
    if (stream.match(/^[+\-*/%!=<>&|^?.:]+/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

const theme = EditorView.theme({
  '&': { color: '#e6ece8', backgroundColor: '#13171b' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '14px', lineHeight: '1.7' },
  '.cm-content': { padding: '14px 0', caretColor: '#bbf3d4' },
  '.cm-line': { padding: '0 14px 0 8px' },
  '.cm-gutters': { backgroundColor: '#13171b', color: '#77848c', borderRight: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', minWidth: '42px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#1e272a' },
  '.cm-activeLineGutter': { color: '#cfdbd7' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: '#345047' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#bbf3d4' },
  '.cm-tooltip': { border: '1px solid #39454a', background: '#22282d' },
  '.cm-panel': { background: '#22282d', color: '#eef2ef' },
}, { dark: true });

const colors = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: '#d8b8f4' },
  { tag: tags.string, color: '#a5e9c4' },
  { tag: [tags.bool, tags.number], color: '#f2c58d' },
  { tag: tags.typeName, color: '#9bcde9' },
  { tag: tags.comment, color: '#83969d', fontStyle: 'italic' },
  { tag: tags.meta, color: '#f2c58d' },
  { tag: tags.operator, color: '#b9c7cc' },
]));

const extensions = [
  basicSetup, theme, colors, puddi,
  EditorState.tabSize.of(4),
  EditorView.contentAttributes.of({ 'aria-label': 'Puddi source code' }),
  EditorView.updateListener.of(update => {
    if (update.docChanged) {
      project().files[project().current] = update.state.doc.toString();
      revision++;
      clearWasm();
      if (diagnostics.length) {
        diagnostics = [];
        queueMicrotask(renderDiagnostics);
      }
      scheduleSave();
    }
    if (update.docChanged || update.selectionSet) updateCursor();
  }),
];

const editorState = () => EditorState.create({ doc: project().files[project().current], extensions });
const editor = new EditorView({ state: editorState(), parent: el('editor') });

function updateCursor() {
  const pos = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(pos);
  el('cursor').textContent = `Ln ${line.number}, Col ${pos - line.from + 1}`;
}

function stashEditor() {
  stateCache.set(cacheKey(), editor.state);
}

function openEditor() {
  editor.setState(stateCache.get(cacheKey()) ?? editorState());
  el('editor-file').textContent = project().current;
  updateCursor();
  renderFiles();
  renderDiagnostics();
}

function openFile(name, focus = true) {
  if (!Object.hasOwn(project().files, name)) return;
  if (name !== project().current) {
    stashEditor();
    project().current = name;
    openEditor();
    persist();
  }
  if (focus) editor.focus();
}

function setProject(id) {
  if (id === activeProject) return;
  stop(false);
  stashEditor();
  activeProject = id;
  revision++;
  diagnostics = [];
  clearWasm();
  clearOutput();
  resetPreview();
  selectTab('console');
  setStatus('Browser target');
  el('project-name').textContent = examples[id].name;
  openEditor();
  renderExamples();
  persist();
}

function label(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderFiles() {
  const list = el('files');
  list.replaceChildren();
  Object.keys(project().files).sort((a, b) =>
    a === 'main.pud' ? -1 : b === 'main.pud' ? 1 : a.localeCompare(b),
  ).forEach(name => {
    const row = document.createElement('li');
    const button = label('button', '', 'file-link');
    button.type = 'button';
    if (name === project().current) button.setAttribute('aria-current', 'page');
    const badge = label('span', 'P', 'file-badge');
    badge.setAttribute('aria-hidden', 'true');
    button.append(badge, label('span', name));
    button.title = name;
    button.addEventListener('click', () => openFile(name));
    row.append(button);
    if (name !== 'main.pud') {
      const remove = label('button', '×', 'icon-button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.title = `Remove ${name}`;
      remove.addEventListener('click', () => {
        if (remove.dataset.confirm !== 'true') {
          remove.dataset.confirm = 'true';
          remove.textContent = '✓';
          remove.title = `Confirm removal of ${name}`;
          remove.setAttribute('aria-label', remove.title);
          remove.addEventListener('blur', () => {
            remove.dataset.confirm = 'false';
            remove.textContent = '×';
            remove.title = `Remove ${name}`;
            remove.setAttribute('aria-label', remove.title);
          }, { once: true });
          return;
        }
        if (project().current === name) openFile('main.pud');
        delete project().files[name];
        stateCache.delete(`${activeProject}/${name}`);
        invalidate();
      });
      row.append(remove);
    }
    list.append(row);
  });
}

function renderExamples() {
  const list = el('examples');
  list.replaceChildren();
  for (const [id, example] of Object.entries(examples)) {
    const row = document.createElement('li');
    const button = label('button', '', 'example');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(id === activeProject));
    button.append(label('span', example.name, 'example-name'));
    if (example.description) button.append(label('span', example.description, 'example-description'));
    button.addEventListener('click', () => setProject(id));
    row.append(button);
    list.append(row);
  }
}

function invalidate() {
  revision++;
  diagnostics = [];
  clearWasm();
  renderFiles();
  renderDiagnostics();
  persist();
}

function selectTab(name, focus = false) {
  activeTab = name;
  for (const tab of ['console', 'problems', 'preview']) {
    const selected = tab === name;
    const button = el(`tab-${tab}`);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    el(tab).hidden = !selected;
    if (selected && focus) button.focus();
  }
  el('clear').hidden = name !== 'console';
}

const resultTabs = ['console', 'problems', 'preview'];
for (const name of resultTabs) {
  const button = el(`tab-${name}`);
  button.addEventListener('click', () => selectTab(name));
  button.addEventListener('keydown', event => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? resultTabs.length - 1
      : (resultTabs.indexOf(name) + step + resultTabs.length) % resultTabs.length;
    selectTab(resultTabs[next], true);
  });
}

function setStatus(text, kind = '') {
  const status = el('run-status');
  status.textContent = text;
  status.dataset.kind = kind;
}

function clearOutput() {
  el('output').replaceChildren();
  el('console-empty').hidden = false;
}

function output(text, className = '') {
  const container = el('output');
  if (container.children.length >= 500) return;
  el('console-empty').hidden = true;
  const panel = el('console');
  const follow = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40;
  container.append(label('div', text.slice(0, 8000), className));
  if (follow) panel.scrollTop = panel.scrollHeight;
}

function editorPosition(diagnostic) {
  const doc = editor.state.doc;
  const line = doc.line(Math.min(Math.max(diagnostic.line ?? 1, 1), doc.lines));
  return Math.min(line.to, line.from + Math.max(0, (diagnostic.column ?? 1) - 1));
}

function renderDiagnostics() {
  const list = el('diagnostics');
  list.replaceChildren();
  el('problem-count').textContent = String(diagnostics.length);
  el('problem-count').hidden = !diagnostics.length;
  el('problems-empty').hidden = !!diagnostics.length;
  for (const diagnostic of diagnostics) {
    const row = document.createElement('li');
    const navigable = Object.hasOwn(project().files, diagnostic.file);
    const detail = label(navigable ? 'button' : 'div', '', 'diagnostic');
    detail.dataset.severity = diagnostic.severity;
    detail.append(label('span', diagnostic.severity === 'warning' ? 'Warning' : 'Error', 'severity'));
    detail.append(label('span', diagnostic.message));
    if (navigable) {
      detail.type = 'button';
      detail.append(label('span', `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`, 'location'));
      detail.addEventListener('click', () => {
        openFile(diagnostic.file);
        const pos = editorPosition(diagnostic);
        editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      });
    }
    for (const note of diagnostic.notes) detail.append(label('span', note, 'note'));
    row.append(detail);
    list.append(row);
  }

  const current = diagnostics.filter(item => item.file === project().current).map(item => {
    const from = editorPosition(item);
    return { from, to: Math.min(editor.state.doc.length, from + 1), severity: item.severity, message: item.message };
  });
  editor.dispatch(setDiagnostics(editor.state, current));
}

function clearWasm() {
  download = undefined;
  el('download-wasm').hidden = true;
}

function resetPreview() {
  previewRun = undefined;
  const replacement = frame.cloneNode(false);
  replacement.removeAttribute('srcdoc');
  replacement.hidden = true;
  frame.replaceWith(replacement);
  frame = replacement;
  el('preview-empty').hidden = false;
}

function getWorker() {
  if (worker) return worker;
  worker = window.puddiWarmCompiler ?? new Worker(new URL(PUDDI_COMPILER_WORKER, import.meta.url), { type: 'module' });
  delete window.puddiWarmCompiler;
  worker.addEventListener('message', ({ data }) => receive(data));
  worker.addEventListener('error', event => {
    if (pending) fail(event.message || 'The compiler could not start');
    worker?.terminate();
    worker = undefined;
    engine = { state: 'offline' };
  });
  return worker;
}

function engineStatus() {
  if (engine.state === 'ready') return 'Compiler ready';
  if (engine.state === 'starting') return 'Starting compiler';
  if (engine.state === 'offline') return 'Compiler will retry on demand';
  return engine.percent ? `Downloading compiler ${engine.percent}%` : 'Loading compiler';
}

function busy(value) {
  for (const id of ['run', 'check']) el(id).disabled = value;
  el('stop').hidden = !value;
}

function finish() {
  clearTimeout(pending?.timeout);
  pending = undefined;
  busy(false);
}

function limitOperation() {
  clearTimeout(pending.timeout);
  pending.timeout = setTimeout(() => {
    stop(false);
    fail('The operation exceeded the 30 second time limit');
  }, 30_000);
}

function fail(message) {
  finish();
  setStatus('Execution failed', 'error');
  output(message, 'stderr');
  selectTab('console');
}

function stop(report = true) {
  if (!pending && !previewRun) return;
  if (pending?.phase === 'compiling') {
    // A synchronous Wasm compilation cannot be interrupted by a message.
    worker?.terminate();
    worker = undefined;
    engine = { state: 'loading' };
  } else if (pending) {
    worker?.postMessage({ action: 'cancel', id: pending.id });
  }
  resetPreview();
  finish();
  if (report) {
    setStatus('Stopped');
    output('Stopped', 'meta');
    selectTab('console');
  }
}

function runAction(action) {
  if (pending) return;
  const files = Object.entries(project().files).map(([name, text]) => ({ name, text }));
  if (new TextEncoder().encode(JSON.stringify(files)).length > maxSource) {
    fail('Reduce the number or size of source files before compiling');
    return;
  }
  clearWasm();
  diagnostics = [];
  renderDiagnostics();
  clearOutput();
  selectTab('console');
  if (action === 'run') resetPreview();
  const preview = action === 'run' && files.some(file => /^\s*import\s+std\.dom(?=[\s.;{]|$)/m.test(file.text));
  const id = ++sequence;
  pending = {
    id, action, revision, preview, phase: 'loading',
  };
  busy(true);
  setStatus(engine.state === 'offline' ? 'Loading compiler' : engineStatus());
  try {
    getWorker().postMessage({ id, action, files, preview });
  } catch (error) {
    fail(error.message);
  }
}

async function formatCurrentFile() {
  const button = el('format');
  const file = project().current;
  const currentProject = project();
  const before = editor.state.doc.toString();
  if (new TextEncoder().encode(before).length > maxSource) {
    if (!pending) setStatus('Reduce the size of this file before formatting', 'error');
    return;
  }
  delete el('run-status').dataset.phase;
  button.disabled = true;
  if (!pending) setStatus('Formatting');
  try {
    const formatted = await formatSource(before);
    if (project() !== currentProject || project().current !== file || editor.state.doc.toString() !== before) {
      if (!pending) setStatus('Source changed');
      return;
    }
    if (formatted !== before) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: formatted } });
      if (!pending) setStatus('Formatted', 'success');
    } else if (!pending) {
      setStatus('Format up to date', 'success');
    }
  } catch (error) {
    if (!pending) setStatus('Formatting failed', 'error');
    output(error.message, 'stderr');
  } finally {
    button.disabled = false;
  }
}

function openPreview(id, wasm) {
  previewRun = { id, wasm };
  frame.srcdoc = PUDDI_PREVIEW_HTML;
  frame.hidden = false;
  el('preview-empty').hidden = true;
  selectTab('preview');
}

function receive(data) {
  if (data.kind === 'engine') {
    engine = data;
    if (pending?.phase === 'loading' || (!pending && el('run-status').dataset.phase === 'warmup')) {
      setStatus(engineStatus());
      if (data.state === 'ready' || data.state === 'offline') delete el('run-status').dataset.phase;
    }
    return;
  }
  if (pending?.id !== data.id && previewRun?.id !== data.id) return;
  switch (data.kind) {
    case 'phase':
      pending.phase = data.phase;
      limitOperation();
      setStatus(pending.action === 'check' ? 'Checking' : 'Compiling');
      break;
    case 'failure':
      fail(data.message);
      break;
    case 'result': {
      const request = pending;
      finish();
      if (!request || request.revision !== revision) {
        setStatus('Source changed');
        return;
      }
      diagnostics = data.diagnostics;
      renderDiagnostics();
      setStatus(data.ok ? 'Check passed' : 'Compilation failed', data.ok ? 'success' : 'error');
      if (diagnostics.length) selectTab('problems');
      else output('Type check passed', 'meta');
      break;
    }
    case 'compiled':
      pending.phase = 'running';
      limitOperation();
      if (pending.revision === revision) {
        diagnostics = data.diagnostics;
        renderDiagnostics();
        download = data.wasm;
        el('download-wasm').hidden = false;
      }
      setStatus('Running');
      if (pending.preview) openPreview(data.id, data.wasm);
      break;
    case 'line':
      output(data.text, data.fd === 2 ? 'stderr' : '');
      break;
    case 'exit':
      if (pending?.id === data.id) finish();
      setStatus(`Exit code ${data.code}`, data.code === 0 ? 'success' : 'error');
      if (!el('output').children.length && activeTab === 'console') output('Program finished without output', 'meta');
      break;
  }
}

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.from !== 'puddi-preview') return;
  if (event.data.kind === 'ready' && previewRun && pending?.id === previewRun.id) {
    frame.contentWindow.postMessage({ kind: 'run-preview', id: previewRun.id, wasm: previewRun.wasm }, '*');
  } else {
    receive(event.data);
  }
});

function saveDownload(name, data, type) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([data], { type }));
  link.download = name;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const action of ['run', 'check']) el(action).addEventListener('click', () => runAction(action));
el('format').addEventListener('click', () => void formatCurrentFile());
el('stop').addEventListener('click', () => stop());
el('clear').addEventListener('click', clearOutput);
el('download-source').addEventListener('click', () =>
  saveDownload(project().current.split('/').at(-1), editor.state.doc.toString(), 'text/plain;charset=utf-8'),
);
el('download-wasm').addEventListener('click', () => {
  if (download) saveDownload('main.wasm', download, 'application/wasm');
});

const form = el('new-file-form');
const formName = el('file-name');
const formError = el('file-error');
function fileError(message) {
  formError.textContent = message;
  formError.hidden = !message;
}
el('new-file').addEventListener('click', () => {
  form.hidden = !form.hidden;
  fileError('');
  if (!form.hidden) formName.focus();
});
form.addEventListener('submit', event => {
  event.preventDefault();
  const input = formName.value.trim();
  const name = input.endsWith('.pud') ? input : `${input}.pud`;
  if (!validName(name)) return fileError('Use letters, numbers or underscores in module paths');
  if (Object.hasOwn(project().files, name)) return fileError('That file already exists');
  if (Object.keys(project().files).length >= maxFiles) return fileError('This workspace has reached its file limit');
  project().files[name] = '';
  form.reset();
  form.hidden = true;
  invalidate();
  openFile(name);
});

el('open-file').addEventListener('click', () => el('file-input').click());
el('file-input').addEventListener('change', async event => {
  const target = project();
  const rejected = [];
  const names = [];
  for (const file of event.target.files) {
    if (!validName(file.name) || file.size > maxSource || Object.keys(target.files).length >= maxFiles) {
      rejected.push(file.name);
      continue;
    }
    let name = file.name;
    for (let i = 2; Object.hasOwn(target.files, name); i++) name = `${file.name.slice(0, -4)}_${i}.pud`;
    try {
      target.files[name] = await file.text();
      names.push(name);
    } catch {
      rejected.push(file.name);
    }
  }
  event.target.value = '';
  if (target !== project()) {
    persist();
    return;
  }
  if (names.length) {
    invalidate();
    openFile(names[0]);
  }
  if (rejected.length) setStatus(`${rejected.length} files could not be imported`, 'error');
});

const mobile = matchMedia('(max-width: 625px)');
let sidebarOpen = false;
function updateSidebar() {
  el('sidebar').hidden = mobile.matches && !sidebarOpen;
  el('toggle-sidebar').hidden = !mobile.matches;
  el('toggle-sidebar').setAttribute('aria-expanded', String(!el('sidebar').hidden));
}
el('toggle-sidebar').addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  updateSidebar();
});
mobile.addEventListener('change', updateSidebar);
updateSidebar();

document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
  event.preventDefault();
  runAction(event.shiftKey ? 'check' : 'run');
});
el('project-name').textContent = examples[activeProject].name;
el('editor-file').textContent = project().current;
renderFiles();
renderExamples();
updateCursor();

// Prepare the compiler while the visitor reads or edits the source.
try {
  el('run-status').dataset.phase = 'warmup';
  setStatus(engineStatus());
  getWorker().postMessage({ action: 'warmup' });
} catch {
  engine = { state: 'offline' };
  delete el('run-status').dataset.phase;
  setStatus(engineStatus());
}
