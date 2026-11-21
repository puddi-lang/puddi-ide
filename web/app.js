import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { setDiagnostics } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { examples } from './examples.js';
import { formatSource } from './formatter.js';

const el = id => document.getElementById(id);
const storageKey = 'puddi-ide/v1';
const layoutKey = 'puddi-ide/layout/v1';
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

let savedLayout;
try { savedLayout = JSON.parse(localStorage.getItem(layoutKey)); } catch {}
const layout = {
  sidebar: savedLayout?.sidebar !== false,
  results: savedLayout?.results !== false,
  share: Number.isFinite(savedLayout?.share) ? Math.max(0, Math.min(100, savedLayout.share)) : 62,
  wrap: savedLayout?.wrap === true,
};
const mobile = matchMedia('(max-width: 680px)');
let mobileSidebar = false;

function saveLayout() {
  try { localStorage.setItem(layoutKey, JSON.stringify(layout)); } catch {}
}

const project = () => projects[activeProject];
const stateCache = new Map();
const cacheKey = () => `${activeProject}/${project().current}`;
let saveTimer;
let revision = 0;
let diagnostics = [];
let checkedRevision;
let runRevision;
let worker;
let engine = { state: 'loading' };
let pending;
let sequence = 0;
let download;
let previewRun;
let frame = el('preview-frame');
let activeTab = 'console';
let actionFocus = 'run';

function persist() {
  const status = el('save-status');
  try {
    localStorage.setItem(storageKey, JSON.stringify({ activeProject, projects }));
    status.textContent = 'Saved on this device';
    delete status.parentElement.dataset.kind;
  } catch {
    status.textContent = 'Local saving unavailable';
    status.parentElement.dataset.kind = 'error';
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

const wrapping = new Compartment();
const wrapExtension = () => layout.wrap ? EditorView.lineWrapping : [];
const extensions = [
  basicSetup, theme, colors, puddi,
  wrapping.of(wrapExtension()),
  EditorState.tabSize.of(4),
  EditorView.contentAttributes.of({ 'aria-label': 'Puddi source code', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
  EditorView.updateListener.of(update => {
    if (update.docChanged) {
      project().files[project().current] = update.state.doc.toString();
      sourceChanged();
      setEditorFeedback('');
      queueMicrotask(renderDiagnostics);
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
  stateCache.set(cacheKey(), { state: editor.state, scroll: editor.scrollSnapshot() });
}

function openEditor() {
  const cached = stateCache.get(cacheKey());
  editor.setState(cached?.state ?? editorState());
  editor.dispatch({ effects: [wrapping.reconfigure(wrapExtension()), ...(cached ? [cached.scroll] : [])] });
  el('editor-file').textContent = el('editor-file').title = project().current;
  setEditorFeedback('');
  updateCursor();
  renderFiles();
  renderDiagnostics();
}

function openFile(name, focus = true) {
  if (!Object.hasOwn(project().files, name)) return;
  showEditor();
  if (name !== project().current) {
    stashEditor();
    project().current = name;
    openEditor();
    persist();
  }
  if (focus) editor.focus();
}

function setProject(id) {
  showEditor();
  if (id === activeProject) {
    editor.focus();
    return;
  }
  stop(false);
  stashEditor();
  activeProject = id;
  revision++;
  diagnostics = [];
  checkedRevision = runRevision = undefined;
  clearWasm();
  clearOutput();
  selectTab('console');
  setStatus('Ready to run');
  updateOutputFreshness();
  setFileForm(false);
  el('workspace-feedback').hidden = true;
  el('project-name').textContent = examples[id].name;
  openEditor();
  renderExamples();
  persist();
  editor.focus();
}

function label(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderFiles() {
  const list = el('files');
  const names = Object.keys(project().files);
  el('file-count').textContent = names.length;
  list.replaceChildren();
  names.sort((a, b) =>
    a === 'main.pud' ? -1 : b === 'main.pud' ? 1 : a.localeCompare(b),
  ).forEach(name => {
    const row = document.createElement('li');
    const button = label('button', '', 'file-link');
    button.type = 'button';
    if (name === project().current) button.setAttribute('aria-current', 'page');
    const badge = label('span', 'P', 'file-badge');
    badge.setAttribute('aria-hidden', 'true');
    const count = label('span', '', 'file-problems');
    count.hidden = true;
    button.dataset.file = name;
    button.append(badge, label('span', name, 'file-name'), count);
    button.title = name;
    button.addEventListener('click', () => openFile(name));
    row.append(button);
    if (name !== 'main.pud') {
      const remove = label('button', '×', 'icon-button file-remove');
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
        if (project().current === name) openFile('main.pud', false);
        delete project().files[name];
        stateCache.delete(`${activeProject}/${name}`);
        invalidate();
        if (mobile.matches) el('toggle-sidebar').focus();
        else list.querySelector('[aria-current]').focus();
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

function sourceChanged() {
  revision++;
  diagnostics = [];
  clearWasm();
  updateOutputFreshness();
}

function invalidate() {
  sourceChanged();
  renderFiles();
  renderDiagnostics();
  persist();
}

function selectTab(name, focus = false) {
  const focused = document.activeElement;
  const moveFocus = focus || (name !== activeTab && (
    focused === el(`tab-${activeTab}`) || el(activeTab).contains(focused) || focused === el('clear')
  ));
  activeTab = name;
  for (const tab of resultTabs) {
    const selected = tab === name;
    const button = el(`tab-${tab}`);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    el(tab).hidden = !selected;
    if (selected && moveFocus) button.focus();
  }
  el('clear').hidden = name !== 'console';
  if (name === 'console' && consoleFollow) el('console').scrollTop = el('console').scrollHeight;
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

function setEditorFeedback(text, kind = '') {
  const status = el('editor-feedback');
  status.textContent = status.title = text;
  status.dataset.kind = kind;
}

function updateOutputFreshness() {
  el('output-freshness').hidden = runRevision === undefined || runRevision === revision;
}

let consoleFollow = true;
el('console').addEventListener('scroll', () => {
  const panel = el('console');
  if (panel.clientHeight) consoleFollow = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 32;
}, { passive: true });

function clearOutput() {
  consoleFollow = true;
  el('output').replaceChildren();
  el('console-empty').hidden = false;
  el('console-hint').textContent = pending?.action === 'run' ? 'Waiting for program output' : 'Run the program to see its output';
  el('output-limit').hidden = true;
  el('clear').disabled = true;
}

function output(text, className = '') {
  const container = el('output');
  if (container.children.length >= 500) {
    el('output-limit').hidden = false;
  } else {
    const limit = 8000;
    const line = text.length > limit ? `${text.slice(0, limit)}…` : text;
    container.append(label('div', line, className));
  }
  el('console-empty').hidden = true;
  el('clear').disabled = false;
  const panel = el('console');
  if (consoleFollow && panel.clientHeight) panel.scrollTop = panel.scrollHeight;
}

function editorPosition(diagnostic) {
  const doc = editor.state.doc;
  const line = doc.line(Math.min(Math.max(diagnostic.line ?? 1, 1), doc.lines));
  return Math.min(line.to, line.from + Math.max(0, (diagnostic.column ?? 1) - 1));
}

function renderDiagnostics() {
  const list = el('diagnostics');
  list.replaceChildren();
  const errors = diagnostics.some(item => item.severity === 'error');
  for (const id of ['problem-count', 'mobile-problem-count']) {
    const count = el(id);
    count.textContent = diagnostics.length;
    count.hidden = !diagnostics.length;
    count.dataset.kind = errors ? 'error' : 'warning';
  }
  const checked = checkedRevision === revision;
  el('problems-title').textContent = checked ? 'No problems' : checkedRevision === undefined ? 'Source unchecked' : 'Source changed';
  el('problems-hint').hidden = checked;
  el('problems-empty').hidden = !!diagnostics.length;
  const byFile = new Map();
  for (const diagnostic of diagnostics) {
    const row = document.createElement('li');
    const navigable = Object.hasOwn(project().files, diagnostic.file);
    const detail = label(navigable ? 'button' : 'div', '', 'diagnostic');
    detail.dataset.severity = diagnostic.severity;
    detail.append(label('span', diagnostic.severity === 'warning' ? 'Warning' : 'Error', 'severity'));
    detail.append(label('span', diagnostic.message));
    if (navigable) {
      const count = byFile.get(diagnostic.file) ?? { total: 0, errors: false };
      count.total++;
      count.errors ||= diagnostic.severity === 'error';
      byFile.set(diagnostic.file, count);
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

  for (const button of el('files').querySelectorAll('.file-link')) {
    const issues = byFile.get(button.dataset.file);
    const count = button.querySelector('.file-problems');
    count.hidden = !issues;
    if (issues) {
      count.textContent = issues.total;
      count.title = `${issues.total} ${issues.total === 1 ? 'problem' : 'problems'}`;
      count.dataset.kind = issues.errors ? 'error' : 'warning';
    }
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
    updateCompilerStatus();
  });
  return worker;
}

function engineStatus() {
  if (engine.state === 'ready') return engine.stored ? 'Compiler ready' : 'Compiler ready for this tab';
  if (engine.state === 'reading') return 'Reading cached compiler';
  if (engine.state === 'saving') return 'Saving compiler locally';
  if (engine.state === 'starting') return 'Starting compiler';
  if (engine.state === 'offline') return 'Compiler unavailable';
  if (engine.retry) return 'Trying another download source';
  return engine.percent ? `Downloading compiler ${engine.percent}%` : 'Loading compiler';
}

function updateCompilerStatus() {
  const status = el('compiler-status');
  status.textContent = engineStatus();
  status.dataset.kind = engine.state === 'offline' ? 'error' : '';
}

function busy(value) {
  const focused = document.activeElement;
  if (value && (focused === el('run') || focused === el('check'))) actionFocus = focused.id;
  el('run').hidden = value;
  el('check').disabled = value;
  el('stop').hidden = !value;
  if (value && (focused === el('run') || focused === el('check'))) el('stop').focus();
  if (!value && focused === el('stop')) el(actionFocus).focus();
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
  const action = pending?.action;
  finish();
  setStatus(action === 'check' ? 'Check failed' : 'Run failed', 'error');
  output(message, 'stderr');
  revealResults('console');
}

function stop(report = true) {
  if (!pending && !previewRun) return;
  const action = pending?.action;
  if (pending?.phase === 'compiling') {
    // A synchronous Wasm compilation cannot be interrupted by a message.
    worker?.terminate();
    worker = undefined;
    engine = { state: 'loading' };
    updateCompilerStatus();
  } else if (pending) {
    worker?.postMessage({ action: 'cancel', id: pending.id });
  }
  resetPreview();
  finish();
  if (report) {
    setStatus('Stopped');
    if (action === 'run' && !el('output').childElementCount) output('Stopped', 'meta');
  }
}

function runAction(action) {
  if (pending) return;
  const files = Object.entries(project().files).map(([name, text]) => ({ name, text }));
  if (new TextEncoder().encode(JSON.stringify(files)).length > maxSource) {
    fail('Reduce the number or size of source files before compiling');
    return;
  }
  if (action === 'run') {
    clearOutput();
    resetPreview();
    runRevision = revision;
    updateOutputFreshness();
    el('console-hint').textContent = 'Waiting for program output';
    revealResults('console');
  }
  const preview = action === 'run' && files.some(file => /^\s*import\s+std\.dom(?=[\s.;{]|$)/m.test(file.text));
  const id = ++sequence;
  pending = {
    id, action, revision, preview, phase: 'loading',
  };
  busy(true);
  setStatus(engine.state === 'ready' ? (action === 'check' ? 'Checking' : 'Compiling') : 'Waiting for compiler');
  try {
    getWorker().postMessage({ id, action, files, preview });
  } catch (error) {
    fail(error.message);
  }
}

async function formatCurrentFile() {
  const button = el('format');
  if (button.disabled) return;
  showEditor();
  const file = project().current;
  const currentProject = project();
  const before = editor.state.doc.toString();
  if (new TextEncoder().encode(before).length > maxSource) {
    setEditorFeedback('File is too large to format', 'error');
    return;
  }
  button.disabled = true;
  setEditorFeedback('Formatting');
  try {
    const formatted = await formatSource(before);
    if (project() !== currentProject || project().current !== file || editor.state.doc.toString() !== before) return;
    if (formatted !== before) {
      const { head } = editor.state.selection.main;
      const line = editor.state.doc.lineAt(head);
      const lines = formatted.split('\n');
      const index = Math.min(line.number - 1, lines.length - 1);
      let anchor = Math.min(head - line.from, lines[index].length);
      for (let i = 0; i < index; i++) anchor += lines[i].length + 1;
      editor.dispatch({ changes: { from: 0, to: before.length, insert: formatted }, selection: { anchor }, scrollIntoView: true });
      setEditorFeedback('Formatted', 'success');
    } else {
      setEditorFeedback('Already formatted', 'success');
    }
  } catch (error) {
    if (project() === currentProject && project().current === file && editor.state.doc.toString() === before) {
      setEditorFeedback('Formatting failed', 'error');
      el('editor-feedback').title = error.message;
    }
  } finally {
    button.disabled = false;
  }
}

function openPreview(id, wasm, reveal) {
  previewRun = { id, wasm };
  frame.srcdoc = PUDDI_PREVIEW_HTML;
  frame.hidden = false;
  el('preview-empty').hidden = true;
  if (reveal) revealResults('preview');
}

function receive(data) {
  if (data.kind === 'engine') {
    engine = data;
    updateCompilerStatus();
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
        setStatus('Source changed during compilation', 'stale');
        return;
      }
      diagnostics = data.diagnostics;
      checkedRevision = revision;
      renderDiagnostics();
      setStatus(data.ok ? 'Check passed' : 'Compilation failed', data.ok ? 'success' : 'error');
      if (request.action === 'run') el('console-hint').textContent = 'See Problems for compiler diagnostics';
      if (diagnostics.length) revealResults('problems');
      else if (!data.ok) {
        output('Compilation failed without diagnostics', 'stderr');
        revealResults('console');
      }
      break;
    }
    case 'compiled':
      pending.phase = 'running';
      limitOperation();
      if (pending.revision === revision) {
        diagnostics = data.diagnostics;
        checkedRevision = revision;
        renderDiagnostics();
        download = data.wasm;
        el('download-wasm').hidden = false;
      }
      setStatus('Running');
      if (pending.preview) openPreview(data.id, data.wasm, pending.revision === revision && activeTab === 'console'
        && (!mobile.matches || el('panes').dataset.view === 'results'));
      break;
    case 'line':
      output(data.text, data.fd === 2 ? 'stderr' : '');
      break;
    case 'exit':
      if (pending?.id === data.id) finish();
      setStatus(data.code === 0 ? 'Run finished' : `Exit code ${data.code}`, data.code === 0 ? 'success' : 'error');
      if (!el('output').children.length) output('Program finished without output', 'meta');
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
el('clear').addEventListener('click', () => {
  clearOutput();
  el('console').focus();
});
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
  formName.setAttribute('aria-invalid', String(!!message));
}

function setFileForm(open) {
  form.hidden = !open;
  el('new-file').setAttribute('aria-expanded', String(open));
  fileError('');
  if (open) formName.focus();
  else form.reset();
}

el('new-file').addEventListener('click', () => setFileForm(form.hidden));
formName.addEventListener('input', () => fileError(''));
form.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  setFileForm(false);
  el('new-file').focus();
});
form.addEventListener('submit', event => {
  event.preventDefault();
  const input = formName.value.trim();
  const name = input.endsWith('.pud') ? input : `${input}.pud`;
  if (!validName(name)) return fileError('Use letters, numbers or underscores in module paths');
  if (Object.hasOwn(project().files, name)) return fileError('That file already exists');
  if (Object.keys(project().files).length >= maxFiles) return fileError('This workspace has reached its file limit');
  project().files[name] = '';
  setFileForm(false);
  invalidate();
  openFile(name);
});

el('open-file').addEventListener('click', () => el('file-input').click());
el('file-input').addEventListener('change', async event => {
  const target = project();
  const files = Array.from(event.target.files);
  event.target.value = '';
  const rejected = [];
  const names = [];
  for (const file of files) {
    if (!validName(file.name) || file.size > maxSource) {
      rejected.push(file.name);
      continue;
    }
    try {
      const text = await file.text();
      if (Object.keys(target.files).length >= maxFiles) {
        rejected.push(file.name);
        continue;
      }
      let name = file.name;
      for (let i = 2; Object.hasOwn(target.files, name); i++) name = `${file.name.slice(0, -4)}_${i}.pud`;
      target.files[name] = text;
      names.push(name);
      if (target === project()) sourceChanged();
    } catch {
      rejected.push(file.name);
    }
  }
  if (target !== project()) {
    persist();
    return;
  }
  if (names.length) {
    renderFiles();
    renderDiagnostics();
    openFile(names[0]);
  }
  const feedback = el('workspace-feedback');
  const message = rejected.length === 1 ? 'One file could not be imported' : `${rejected.length} files could not be imported`;
  feedback.textContent = rejected.length ? message : '';
  feedback.hidden = !rejected.length;
  if (names.length && rejected.length) setEditorFeedback(message, 'error');
});

const panes = el('panes');
const divider = el('pane-divider');

function updateSidebar() {
  const open = mobile.matches ? mobileSidebar : layout.sidebar;
  el('sidebar').hidden = !open;
  el('toggle-sidebar').setAttribute('aria-expanded', String(open));
}
el('toggle-sidebar').addEventListener('click', () => {
  if (mobile.matches) mobileSidebar = !mobileSidebar;
  else {
    layout.sidebar = !layout.sidebar;
    saveLayout();
  }
  updateSidebar();
});

function updateResults() {
  const collapsed = !mobile.matches && !layout.results;
  panes.toggleAttribute('data-collapsed', collapsed);
  el('results-pane').hidden = divider.hidden = collapsed;
  el('toggle-results').setAttribute('aria-expanded', String(!collapsed));
}

function mobileView(name, moveFocus = false) {
  panes.dataset.view = name;
  for (const view of ['editor', 'results']) el(`view-${view}`).setAttribute('aria-pressed', String(name === view));
  if (moveFocus && mobile.matches) el(`view-${name}`).focus();
  if (name === 'results' && activeTab === 'console' && consoleFollow) el('console').scrollTop = el('console').scrollHeight;
}

function showEditor() {
  if (!mobile.matches) return;
  mobileSidebar = false;
  updateSidebar();
  mobileView('editor');
}

function revealResults(tab) {
  if (!mobile.matches && !layout.results) {
    layout.results = true;
    updateResults();
    saveLayout();
  }
  if (mobile.matches) {
    const editorFocused = el('editor-pane').contains(document.activeElement);
    mobileSidebar = false;
    updateSidebar();
    mobileView('results', editorFocused);
  }
  selectTab(tab);
}

el('view-editor').addEventListener('click', () => mobileView('editor'));
el('view-results').addEventListener('click', () => mobileView('results'));
el('toggle-results').addEventListener('click', () => {
  layout.results = !layout.results;
  updateResults();
  saveLayout();
});

mobile.addEventListener('change', () => {
  mobileSidebar = false;
  updateSidebar();
  updateResults();
});

function setEditorShare(share) {
  const width = panes.clientWidth;
  if (!width) return;
  const min = Math.ceil(280 / width * 100);
  const max = Math.floor((width - 288) / width * 100);
  layout.share = Math.max(min, Math.min(max, share));
  panes.style.setProperty('--editor-share', `${layout.share}%`);
}

function updateDivider() {
  if (!divider.offsetWidth) return;
  const width = panes.clientWidth;
  const percent = px => Math.round(px / width * 100);
  divider.setAttribute('aria-valuemin', percent(280));
  divider.setAttribute('aria-valuemax', percent(width - 288));
  const current = percent(el('editor-pane').offsetWidth);
  divider.setAttribute('aria-valuenow', current);
  divider.setAttribute('aria-valuetext', `${current}% editor width`);
}

divider.addEventListener('pointerdown', event => {
  if (event.button !== 0 || divider.hasAttribute('data-dragging')) return;
  divider.focus();
  divider.setPointerCapture(event.pointerId);
  divider.setAttribute('data-dragging', '');
});
divider.addEventListener('pointermove', event => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const { left, width } = panes.getBoundingClientRect();
  setEditorShare((event.clientX - left - divider.offsetWidth / 2) / width * 100);
});
divider.addEventListener('lostpointercapture', () => {
  divider.removeAttribute('data-dragging');
  saveLayout();
});
divider.addEventListener('keydown', event => {
  const current = Number(divider.getAttribute('aria-valuenow'));
  const shares = { ArrowLeft: current - 4, ArrowRight: current + 4, Home: 0, End: 100 };
  if (!Object.hasOwn(shares, event.key)) return;
  event.preventDefault();
  setEditorShare(shares[event.key]);
  saveLayout();
});
const resize = new ResizeObserver(updateDivider);
resize.observe(el('editor-pane'));

function updateWrap() {
  el('wrap').setAttribute('aria-pressed', String(layout.wrap));
}
el('wrap').addEventListener('click', () => {
  layout.wrap = !layout.wrap;
  editor.dispatch({ effects: wrapping.reconfigure(wrapExtension()), scrollIntoView: true });
  updateWrap();
  saveLayout();
});

const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const modifier = apple ? 'Command' : 'Ctrl';
const ariaModifier = apple ? 'Meta' : 'Control';
for (const [id, title, keys] of [
  ['run', 'Run program', ['Enter']],
  ['check', 'Check types', ['Shift', 'Enter']],
  ['format', 'Format current file', ['Shift', 'F']],
]) {
  el(id).title = `${title} ${[modifier, ...keys].join(' + ')}`;
  el(id).setAttribute('aria-keyshortcuts', [ariaModifier, ...keys].join('+'));
}
el('run-key').textContent = apple ? '⌘ ↵' : 'Ctrl ↵';

document.addEventListener('keydown', event => {
  if (event.defaultPrevented) return;
  if (event.key === 'Escape' && mobile.matches && mobileSidebar) {
    mobileSidebar = false;
    updateSidebar();
    el('toggle-sidebar').focus();
    return;
  }
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing || event.repeat) return;
  if (event.key.toLowerCase() === 'f' && event.shiftKey) {
    event.preventDefault();
    void formatCurrentFile();
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  runAction(event.shiftKey ? 'check' : 'run');
});
panes.style.setProperty('--editor-share', `${layout.share}%`);
updateSidebar();
updateResults();
updateWrap();
el('project-name').textContent = examples[activeProject].name;
el('editor-file').textContent = el('editor-file').title = project().current;
renderFiles();
renderExamples();
updateCursor();

// Prepare the compiler while the visitor reads or edits the source.
try {
  getWorker().postMessage({ action: 'warmup' });
} catch {
  engine = { state: 'offline' };
  updateCompilerStatus();
}
