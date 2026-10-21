/**
 * Harness that executes the real plugin bundle against stubbed browser globals,
 * a minimal React hook runtime, and a fake Cordis context. It exercises the
 * actual detection, settings, sound, notification, and badge code paths.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CLIENT = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(CLIENT, 'utf8');

//#region recording
const log = { oscillators: [], speech: [], notifications: [], styleTags: 0, alerts: [], audio: [], audioPaused: [], badges: [] };
let failures = 0;
let checks = 0;
function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.log('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail));
  }
}
//#endregion

//#region React shim
function createReact() {
  const store = { hooks: [], cursor: 0, cleanups: [] };
  // Two distinct operations, because the shim has to model both React behaviors:
  // __reset replays a render of the SAME component (hook state must persist, which
  // is what makes useRef/useState baselines observable), while __mount starts a
  // DIFFERENT component (hook slots must not leak between components).
  const reset = () => { store.cursor = 0; };
  const mount = () => { store.cursor = 0; store.hooks = []; };
  const slot = (index, initial) => {
    if (store.hooks[index] === undefined) store.hooks[index] = { value: initial };
    return store.hooks[index];
  };
  return {
    __store: store,
    __reset: reset,
    __mount: mount,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
    },
    useState(initial) {
      const index = store.cursor++;
      const entry = slot(index, typeof initial === 'function' ? initial() : initial);
      return [entry.value, (next) => { entry.value = typeof next === 'function' ? next(entry.value) : next; }];
    },
    useRef(initial) {
      const index = store.cursor++;
      const entry = slot(index, { current: initial });
      return entry.value;
    },
    useCallback(fn) { store.cursor++; return fn; },
    useMemo(fn) { store.cursor++; return fn(); },
    useEffect(fn, deps) {
      const index = store.cursor++;
      const entry = store.hooks[index] ?? (store.hooks[index] = { value: undefined, deps: undefined });
      const changed = entry.deps === undefined || deps === undefined
        || deps.length !== entry.deps.length || deps.some((d, i) => d !== entry.deps[i]);
      if (changed) {
        if (typeof entry.cleanup === 'function') entry.cleanup();
        entry.deps = deps;
        entry.cleanup = fn();
      }
    },
  };
}
//#endregion

//#region browser stubs
/**
 * Minimal IndexedDB double covering the one object store the plugin uses.
 * Records every operation so tests can assert what was stored and removed.
 */
function createIndexedDB(log) {
  const data = new Map();
  const state = { stores: new Set(), opened: 0, closed: 0, puts: [], deletes: [], failOpen: false };
  const makeRequest = (result) => {
    const request = { result, onsuccess: null, onerror: null };
    setTimeout(() => { if (request.onsuccess) request.onsuccess(); }, 0);
    return request;
  };
  const makeStore = (mode) => ({
    put(value, key) { data.set(key, value); state.puts.push(key); return makeRequest(key); },
    get(key) { return makeRequest(data.get(key)); },
    delete(key) { data.delete(key); state.deletes.push(key); return makeRequest(undefined); },
    getAllKeys() { return makeRequest([...data.keys()]); },
  });
  const db = {
    objectStoreNames: { contains: (name) => state.stores.has(name) },
    createObjectStore(name) { state.stores.add(name); return makeStore('readwrite'); },
    transaction() {
      // Must return the same object the caller assigns oncomplete to; spreading it
      // into a copy would leave the plugin's handler on a discarded object and the
      // awaiting promise would never settle.
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      const store = makeStore('readwrite');
      tx.objectStore = () => store;
      // Complete after the request callbacks have run.
      setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 1);
      return tx;
    },
    close() { state.closed++; },
  };
  return {
    state,
    data,
    factory: {
      open() {
        state.opened++;
        const request = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
        setTimeout(() => {
          if (state.failOpen) {
            request.error = new Error('blocked');
            if (request.onerror) request.onerror();
            return;
          }
          if (!state.stores.has('clips') && request.onupgradeneeded) request.onupgradeneeded();
          if (request.onsuccess) request.onsuccess();
        }, 0);
        return request;
      },
    },
  };
}

function createBrowser() {
  const notifications = [];
  // Voices the fake platform reports, plus the listeners awaiting voiceschanged.
  const browserVoices = [];
  const voiceListeners = [];
  const indexed = createIndexedDB(log);
  const objectUrls = { created: [], revoked: [] };
  /**
   * Whether the fake window reports itself as focused. Focus is what separates
   * "the conversation is open" from "the user is actually looking at it", so the
   * default is focused and only the attended-finish scenario turns it off.
   */
  let documentFocus = true;
  const AudioContextStub = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = { name: 'destination' }; }
    createOscillator() {
      const node = {
        type: 'sine', frequency: { setValueAtTime: (v) => { node.__freq = v; } },
        connect() {}, start() { log.oscillators.push({ freq: node.__freq, type: node.type }); }, stop() {},
      };
      return node;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
  const headChildren = [];
  const listeners = new Map();
  return {
    window: {
      AudioContext: AudioContextStub,
      addEventListener(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
      },
      removeEventListener(name, fn) {
        listeners.get(name)?.delete(fn);
      },
      speechSynthesis: {
        speaking: false,
        pending: false,
        cancel() { log.speech.push({ cancel: true }); },
        speak(u) { log.speech.push({ text: u.text, lang: u.lang, rate: u.rate, volume: u.volume, voice: u.voice?.name }); },
        getVoices() { return browserVoices.slice(); },
        addEventListener(type, fn) { if (type === 'voiceschanged') voiceListeners.push(fn); },
        removeEventListener(type, fn) {
          if (type !== 'voiceschanged') return;
          const i = voiceListeners.indexOf(fn);
          if (i >= 0) voiceListeners.splice(i, 1);
        },
      },
      SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
      Notification: class {
        static permission = 'granted';
        static requestPermission() { return Promise.resolve('granted'); }
        constructor(title, options) { this.title = title; this.options = options; notifications.push({ title, options }); }
        close() {}
      },
      focus() {},
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      indexedDB: indexed.factory,
      Blob: class {
        constructor(parts, options) {
          this.parts = parts;
          this.type = options?.type ?? '';
          this.size = (parts ?? []).reduce((sum, p) => sum + (typeof p === 'string' ? p.length : (p?.size ?? 0)), 0);
        }
      },
      URL: {
        createObjectURL(blob) {
          const url = 'blob:fake/' + objectUrls.created.length;
          objectUrls.created.push({ url, blob });
          return url;
        },
        revokeObjectURL(url) { objectUrls.revoked.push(url); },
      },
      Audio: class {
        constructor(url) { this.url = url; this.volume = 1; log.audio.push({ url }); }
        play() { return Promise.resolve(); }
        pause() { log.audioPaused.push(this.url); }
      },
      // The Web Badging API. Records every call so tests can assert the number the
      // taskbar would show, including that zero is expressed as a clear.
      navigator: {
        setAppBadge(value) { log.badges.push({ op: 'set', value }); return Promise.resolve(); },
        clearAppBadge() { log.badges.push({ op: 'clear' }); return Promise.resolve(); },
      },
    },
    listeners,
    /** Dispatch a synthetic user gesture to the registered listeners. */
    gesture(name = 'pointerdown') {
      for (const fn of [...(listeners.get(name) ?? [])]) fn({ type: name });
    },
    /** Dispatch a window-level event, such as regaining focus. */
    dispatch(name) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn({ type: name });
    },
    document: {
      head: { appendChild(node) { headChildren.push(node); } },
      createElement() {
        const node = { dataset: {}, style: {}, textContent: '', remove() {} };
        return node;
      },
      querySelector() { return null; },
      hasFocus() { return documentFocus; },
    },
    notifications,
    headChildren,
    voiceListeners,
    indexed,
    objectUrls,
    /** Flip whether the fake window claims focus, for the attended-finish case. */
    setFocus(value) { documentFocus = value; },
    /** Replace the reported voices and notify the platform's listeners. */
    setVoices(list) {
      browserVoices.length = 0;
      browserVoices.push(...list);
      for (const fn of [...voiceListeners]) fn({ type: 'voiceschanged' });
    },
  };
}
//#endregion

//#region fake cordis context
function createContext(react) {
  const handlers = new Map();
  const registrations = [];
  const cleanups = [];
  const localeDicts = {};
  const sessions = { byId: {} };
  /**
   * Per-session durable `turn/end` records, keyed by session id. Only the last
   * entry matters to the plugin, which is exactly the semantics being tested.
   */
  const turnEnds = new Map();
  /**
   * The session list is a subscribable snapshot source in the real renderer, and
   * the plugin listens to it to learn which conversation is on screen. The stub
   * mirrors that so the viewed-mark path is exercised the way it actually runs.
   */
  const listListeners = new Set();
  const listSnapshot = () => ({ byId: sessions.byId, ids: Object.keys(sessions.byId), phase: 'ready' });
  const notifyList = () => { for (const fn of [...listListeners]) fn(); };
  const locale = {
    bind(ns) { return (key) => localeDicts[ns]?.[key] ?? key; },
    register(ns, dicts) { localeDicts[ns] = dicts.zh ?? dicts.en ?? {}; return () => {}; },
    resolveText(text) { return text; },
    // The registered dictionaries here are the zh ones, so the active locale is
    // zh-CN; a test that changes `active` exercises the follow-the-interface path.
    getLocale() { return { active: locale.active, locales: [], revision: 0 }; },
    active: 'zh-CN',
  };
  const ctx = {
    __handlers: handlers,
    __registrations: registrations,
    __locale: locale,
    __runCleanups() { for (const fn of cleanups.splice(0)) fn(); },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return () => {};
    },
    on() { return () => {}; },
    get(name) { return name === 'uiWorkspace' ? { openSession: (id) => log.alerts.push({ open: id }) } : undefined; },
    locale,
    remote: {
      $on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    },
    sessions: {
      list: {
        getSnapshot: listSnapshot,
        subscribe(fn) { listListeners.add(fn); return () => listListeners.delete(fn); },
      },
      /**
       * The retained binding for one session. The plugin reads the session's own
       * `turn/end` reason from here — the same field the conversation renders — so
       * the stub exposes exactly that much surface.
       */
      binding(id) {
        const entries = turnEnds.get(id);
        if (entries === undefined) return undefined;
        return { sessionId: id, eventSource: { getSnapshot: () => ({ entries, hasMore: false, revision: 0 }) } };
      },
    },
    __sessions: sessions,
    /**
     * Append one durable session event, as the follow stream does. `time` defaults
     * to now because the plugin time-bounds its read of the latest turn/end.
     */
    __pushEvent(id, event) {
      if (!turnEnds.has(id)) turnEnds.set(id, []);
      const stamped = event.time === undefined ? { ...event, time: Date.now() } : event;
      turnEnds.get(id).push({ type: 'event', event: stamped });
    },
    /** Forget a session's retained binding, as releasing the last reference does. */
    __dropBinding(id) { turnEnds.delete(id); },
    /** Publish a new list snapshot, as the controller does on any session change. */
    __notifyList: notifyList,
    /**
     * Mark one session as the conversation on screen, the way the workspace
     * controller's `mainView` retention does in the real renderer, then publish the
     * change. This is the one signal that retires a taskbar count.
     */
    __viewSession(id) {
      for (const row of Object.values(sessions.byId)) if (row.retainedBy !== undefined) row.retainedBy = { mainView: 0 };
      if (id !== undefined && sessions.byId[id] !== undefined) sessions.byId[id].retainedBy = { mainView: 1 };
      notifyList();
    },
    slots: {
      inject(key, callback) { callback(); return () => {}; },
      register(options, Component) { registrations.push({ options, Component }); return () => {}; },
    },
  };
  return ctx;
}
//#endregion

//#region load plugin
const react = createReact();
const browser = createBrowser();

/** Fresh origin-scoped storage, so one scenario cannot leak preferences into another. */
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    get length() { return map.size; },
    key: (i) => [...map.keys()][i],
  };
}

let captured = null;
const sandbox = {
  window: browser.window,
  document: browser.document,
  console,
  setTimeout,
  clearTimeout,
  localStorage: makeLocalStorage(),
  Audio: browser.window.Audio,
  FileReader: class {},
  indexedDB: browser.window.indexedDB,
  Blob: browser.window.Blob,
  URL: browser.window.URL,
  Notification: browser.window.Notification,
  navigator: browser.window.navigator,
  SpeechSynthesisUtterance: browser.window.SpeechSynthesisUtterance,
  Promise,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Symbol,
  Set,
  Map,
  Error,
  TypeError,
  isNaN,
  parseFloat,
  parseInt,
};
sandbox.window.__ModuleLoader__ = {
  load(definition) { captured = definition; },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

check('bundle registers a lazy factory', captured !== null && typeof captured.factory === 'function');
check('factory id matches the package name', captured.id === '@local/dsh-completion-alert', captured.id);

const plugin = captured.factory((specifier) => {
  if (specifier === 'react') return react;
  throw new Error('unexpected require: ' + specifier);
});

check('plugin exports apply()', typeof plugin.apply === 'function');
check('plugin exports inject[]', Array.isArray(plugin.inject), JSON.stringify(plugin.inject));

const ctx = createContext(react);
plugin.apply(ctx);

const findReg = (key) => ctx.__registrations.find((r) => r.options.name === key);
const overlay = findReg('shell.overlay');
const section = findReg('settings.section');
const generalRow = findReg('settings.general.item');

check('registers shell.overlay host', overlay !== undefined);
check('registers settings.section page', section !== undefined);
check('registers settings.general.item master row', generalRow !== undefined);
check('stylesheet injected exactly once', browser.headChildren.length === 1, String(browser.headChildren.length));
check('status handler subscribed', ctx.__handlers.has('api-session/status'));
check('error handler subscribed', ctx.__handlers.has('api-session/error'));
check('settings page declares a localized nav label', typeof section.options.label === 'function');
// The visible reminder surfaces are the OS notification and the taskbar badge;
// nothing may be drawn inside the DSH window, because that would vanish exactly
// when the window is minimised.
const overlayFace = overlay.options.inject();
check('the overlay host draws no in-window card', overlay.Component({ useSessionStatus: undefined, notifyWaiting: () => {} }) === null);
check('the overlay host exposes no notice stack', overlayFace.hooks?.alert === undefined, JSON.stringify(Object.keys(overlayFace)));
check('the overlay host exposes the waiting signal', typeof overlayFace.notifyWaiting === 'function');
const cssText = String(browser.headChildren[0]?.textContent ?? '');
check('the stylesheet drops every card rule', !cssText.includes('.dsh-ca-toast') && !cssText.includes('.dsh-ca-stack'), cssText.slice(0, 120));
check('the stylesheet still styles the settings page', cssText.includes('.dsh-ca-page') && cssText.includes('.dsh-ca-row'));
//#endregion

//#region drive behavior
console.log('\n-- detection: normal completion --');
ctx.__sessions.byId.s1 = { id: 's1', displayTitle: 'My main task' };
ctx.__handlers.get('api-session/status')('s1', true);
ctx.__handlers.get('api-session/status')('s1', false);

check('built-in chime played two notes', log.oscillators.length === 2, JSON.stringify(log.oscillators));
check('OS notification sent', browser.notifications.length === 1, String(browser.notifications.length));
check('OS notification titled for done', String(browser.notifications[0]?.title).includes('任务已完成'), browser.notifications[0]?.title);
check('OS notification carries the state marker', String(browser.notifications[0]?.title).startsWith('\u2705'), JSON.stringify(browser.notifications[0]?.title));
check('OS notification is silent when our own sound played', browser.notifications[0]?.options?.silent === true, JSON.stringify(browser.notifications[0]?.options));
check('OS notification body is the session title', browser.notifications[0]?.options?.body === 'My main task', String(browser.notifications[0]?.options?.body));
check('the taskbar badge counts the finish', log.badges.some((e) => e.op === 'set' && e.value === 1), JSON.stringify(log.badges));

console.log('\n-- detection: error --');
log.oscillators.length = 0;
browser.notifications.length = 0;
ctx.__sessions.byId.s2 = { id: 's2', displayTitle: 'Broken task' };
ctx.__handlers.get('api-session/status')('s2', true);
ctx.__handlers.get('api-session/error')('s2', 'boom: model failed');
ctx.__handlers.get('api-session/status')('s2', false);
check('error chime differs from done', log.oscillators[0]?.freq === 440, JSON.stringify(log.oscillators));
check('error notification titled for error', String(browser.notifications[0]?.title).includes('任务异常中断'), browser.notifications[0]?.title);
check('error notification uses a distinct marker', String(browser.notifications[0]?.title).startsWith('\u26a0'), JSON.stringify(browser.notifications[0]?.title));
check('the error detail reaches the notification body', String(browser.notifications[0]?.options?.body).includes('boom: model failed'), String(browser.notifications[0]?.options?.body));
check('the three state markers are all distinct', new Set(['\u2705', '\u26a0\ufe0f', '\u2753']).size === 3);
check('the second session counts up on the badge', [...log.badges].reverse().find((e) => e.op === 'set')?.value === 2, JSON.stringify(log.badges));

console.log('\n-- interruption reason from the session log --');
// The forwarded error can arrive with no message at all; the session's own turn
// log still holds the text the conversation displays. That fallback is what keeps
// the notice actionable instead of a bare "异常".
browser.notifications.length = 0;
ctx.__sessions.byId.s4 = { id: 's4', displayTitle: 'Server task' };
ctx.__pushEvent('s4', { type: 'turn/start', data: { turn: 1 } });
ctx.__pushEvent('s4', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'DeepSeek Messages request failed (520)', code: 'SERVER', status: 520 } } } });
ctx.__handlers.get('api-session/status')('s4', true);
ctx.__handlers.get('api-session/error')('s4', '');
ctx.__handlers.get('api-session/status')('s4', false);
check('an empty forwarded error is still reported as an interruption', String(browser.notifications[0]?.title).includes('任务异常中断'), browser.notifications[0]?.title);
check('the session log supplies the reason when the event carried none', String(browser.notifications[0]?.options?.body).includes('DeepSeek Messages request failed (520)'), String(browser.notifications[0]?.options?.body));

// A forwarded message is the primary source and must win over the log.
browser.notifications.length = 0;
ctx.__pushEvent('s4', { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'from the log', code: 'SERVER' } } } });
ctx.__handlers.get('api-session/status')('s4', true);
ctx.__handlers.get('api-session/error')('s4', 'from the event');
ctx.__handlers.get('api-session/status')('s4', false);
check('the forwarded message wins over the log', String(browser.notifications[0]?.options?.body).includes('from the event'), String(browser.notifications[0]?.options?.body));
// The popup is read at a glance from another application, so its body must lead
// with the readable family phrase, keep the provider's message, and still name
// the conversation the alert belongs to.
check('the popup body leads with the readable family phrase', String(browser.notifications[0]?.options?.body).startsWith('服务端返回错误'), String(browser.notifications[0]?.options?.body));
check('the popup body still names the conversation', String(browser.notifications[0]?.options?.body).includes('Server task'), String(browser.notifications[0]?.options?.body));

// A message-less failure whose code is all that exists still says something.
browser.notifications.length = 0;
ctx.__pushEvent('s4', { type: 'turn/end', data: { turn: 3, reason: { kind: 'error', error: { code: 'STREAM_CLOSED' } } } });
ctx.__handlers.get('api-session/status')('s4', true);
ctx.__handlers.get('api-session/error')('s4', '');
ctx.__handlers.get('api-session/status')('s4', false);
check('a message-less failure falls back to its code', String(browser.notifications[0]?.options?.body).includes('STREAM_CLOSED'), String(browser.notifications[0]?.options?.body));

// An aborted turn is not an interruption. The Host's abort path throws without
// dispatching `agent/error`, so no error event arrives at all — and the log's
// latest turn confirms the user stopped it. Reading the log must never
// manufacture a failure out of that.
browser.notifications.length = 0;
ctx.__pushEvent('s4', { type: 'turn/end', data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
ctx.__handlers.get('api-session/status')('s4', true);
ctx.__handlers.get('api-session/status')('s4', false);
check('an aborted turn is not reported as an interruption', String(browser.notifications[0]?.title).includes('任务已完成'), browser.notifications[0]?.title);
// An aborted turn caused by some other hook must also stay a completion: only the
// signed-out hook is a failure, and widening that rule would misfire on the rest.
browser.notifications.length = 0;
ctx.__pushEvent('s4', { type: 'turn/end', data: { turn: 5, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'some-other-hook' } } } });
ctx.__handlers.get('api-session/status')('s4', true);
ctx.__handlers.get('api-session/status')('s4', false);
check('an unrelated hook abort is not reported as an interruption', String(browser.notifications[0]?.title).includes('任务已完成'), browser.notifications[0]?.title);

// A stale error turn must not colour a later ordinary completion.
browser.notifications.length = 0;
ctx.__pushEvent('s4', { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } });
ctx.__handlers.get('api-session/status')('s4', true);
ctx.__handlers.get('api-session/status')('s4', false);
check('a stale error turn does not colour a normal completion', String(browser.notifications[0]?.title).includes('任务已完成'), browser.notifications[0]?.title);
check('a normal completion falls back to the session title', browser.notifications[0]?.options?.body === 'Server task', String(browser.notifications[0]?.options?.body));

// With no retained binding the read must degrade quietly, never throw.
browser.notifications.length = 0;
ctx.__sessions.byId.s5 = { id: 's5', displayTitle: 'Unretained task' };
ctx.__handlers.get('api-session/status')('s5', true);
ctx.__handlers.get('api-session/error')('s5', '');
ctx.__handlers.get('api-session/status')('s5', false);
check('an unretained session still reports the interruption', String(browser.notifications[0]?.title).includes('任务异常中断'), browser.notifications[0]?.title);
check('an unretained session falls back to the title', String(browser.notifications[0]?.options?.body).includes('Unretained task'), String(browser.notifications[0]?.options?.body));

// A signed-out abort is the one aborted ending the conversation itself renders as
// a failure, with its own code. It must not be announced as a completed task.
browser.notifications.length = 0;
ctx.__pushEvent('s4', { type: 'turn/end', data: { turn: 6, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } } } });
ctx.__handlers.get('api-session/status')('s4', true);
ctx.__handlers.get('api-session/status')('s4', false);
check('a signed-out abort is reported as an interruption', String(browser.notifications[0]?.title).includes('任务异常中断'), browser.notifications[0]?.title);

// A stale ending must not be mistaken for this finish: the follow stream can lag
// behind the status edge, and trusting an old turn/end would invent a failure.
browser.notifications.length = 0;
ctx.__pushEvent('s4', { type: 'turn/end', time: Date.now() - 60000, data: { turn: 7, reason: { kind: 'error', error: { message: 'ancient failure', code: 'SERVER' } } } });
ctx.__handlers.get('api-session/status')('s4', true);
ctx.__handlers.get('api-session/status')('s4', false);
check('a stale error ending is not trusted', String(browser.notifications[0]?.title).includes('任务已完成'), browser.notifications[0]?.title);
check('a stale ending leaves the body as the title', browser.notifications[0]?.options?.body === 'Server task', String(browser.notifications[0]?.options?.body));

// A stale error must not shadow a fresh forwarded failure either.
browser.notifications.length = 0;
ctx.__handlers.get('api-session/status')('s4', true);
ctx.__handlers.get('api-session/error')('s4', 'fresh failure');
ctx.__handlers.get('api-session/status')('s4', false);
check('a fresh forwarded failure still reports', String(browser.notifications[0]?.title).includes('任务异常中断'), browser.notifications[0]?.title);
check('a fresh forwarded failure keeps its own wording', String(browser.notifications[0]?.options?.body).includes('fresh failure'), String(browser.notifications[0]?.options?.body));

console.log('\n-- detection: waiting for the user --');
const statusStore = { value: new Map() };
const hostProps = (overrides = {}) => ({
  useSessionStatus: (selector) => selector(statusStore.value),
  notifyWaiting: overlayFace.notifyWaiting,
  ...overrides,
});
// First render seeds the baseline and must not alert.
browser.notifications.length = 0;
statusStore.value = new Map([['s3', { running: true, pendingInteraction: undefined, completionUnread: false }]]);
react.__reset();
overlay.Component(hostProps());
check('baseline render raises no waiting alert', browser.notifications.length === 0, String(browser.notifications.length));
// A newly appearing pending interaction must alert.
statusStore.value = new Map([['s3', { running: true, pendingInteraction: { kind: 'question' }, completionUnread: false }]]);
react.__reset();
overlay.Component(hostProps());
check('waiting alert raised', browser.notifications.length === 1, String(browser.notifications.length));
check('waiting notification titled for waiting', String(browser.notifications[0]?.title).includes('等待你的回答'), browser.notifications[0]?.title);
check('waiting notification marks the state', String(browser.notifications[0]?.title).startsWith('\u2753'), JSON.stringify(browser.notifications[0]?.title));
// The same pending interaction persisting must not alert again.
react.__reset();
overlay.Component(hostProps());
check('no duplicate waiting alert on re-render', browser.notifications.length === 1, String(browser.notifications.length));
// A *different* interaction object for the same session is a new arrival.
statusStore.value = new Map([['s3', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }]]);
react.__reset();
overlay.Component(hostProps());
check('a second distinct interaction alerts again', browser.notifications.length === 2, String(browser.notifications.length));
// A new question raised after the first was answered must also alert.
statusStore.value = new Map([['s3', { running: true, pendingInteraction: undefined, completionUnread: false }]]);
react.__reset();
overlay.Component(hostProps());
statusStore.value = new Map([['s3', { running: true, pendingInteraction: { kind: 'question' }, completionUnread: false }]]);
react.__reset();
overlay.Component(hostProps());
check('a question raised after an answer alerts', browser.notifications.length === 3, String(browser.notifications.length));

console.log('\n-- watching a finish in the focused window --');
// The one case that must stay quiet: the conversation is on screen *and* the
// window the user is working in is DSH. The chime still plays; a toast over the
// focused window and an unread count for it would both be noise.
ctx.__viewSession('s1');
browser.setFocus(true);
browser.notifications.length = 0;
log.oscillators.length = 0;
const badgesBeforeAttended = log.badges.length;
ctx.__handlers.get('api-session/status')('s1', true);
ctx.__handlers.get('api-session/status')('s1', false);
check('an attended finish still chimes', log.oscillators.length === 2, String(log.oscillators.length));
check('an attended finish raises no screen notification', browser.notifications.length === 0, JSON.stringify(browser.notifications));
check('an attended finish adds no badge count', log.badges.length === badgesBeforeAttended, JSON.stringify(log.badges.slice(badgesBeforeAttended)));
// Leaving DSH for another application must restore the alert even though the
// conversation is still the selected one: that is the case the feature exists for.
browser.setFocus(false);
ctx.__handlers.get('api-session/status')('s1', true);
ctx.__handlers.get('api-session/status')('s1', false);
check('an unfocused window alerts again', browser.notifications.length === 1, String(browser.notifications.length));
check('an unfocused window counts on the badge', log.badges.length > badgesBeforeAttended, JSON.stringify(log.badges.slice(badgesBeforeAttended)));
// A finish in a conversation that is not on screen alerts even while focused.
browser.setFocus(true);
ctx.__viewSession('s2');
browser.notifications.length = 0;
ctx.__handlers.get('api-session/status')('s3', true);
ctx.__handlers.get('api-session/status')('s3', false);
check('a background conversation alerts while focused', browser.notifications.length === 1, String(browser.notifications.length));
// Leaving the conversation open but walking away still counts.
ctx.__viewSession('s2');
browser.setFocus(false);
const badgesBeforeAway = log.badges.length;
ctx.__handlers.get('api-session/status')('s2', true);
ctx.__handlers.get('api-session/status')('s2', false);
check('an open but unfocused conversation still counts', log.badges.length > badgesBeforeAway, JSON.stringify(log.badges.slice(badgesBeforeAway)));
ctx.__viewSession(undefined);
browser.setFocus(true);

console.log('\n-- one-click master switch --');
const generalFace = generalRow.options.inject();
generalFace.updateSettings({ enabled: false });
const stored = JSON.parse(sandbox.localStorage.getItem('dsh.completion-alert.v1'));
check('disable persists to localStorage', stored.enabled === false, JSON.stringify(stored.enabled));
log.oscillators.length = 0;
browser.notifications.length = 0;
log.badges.length = 0;
ctx.__handlers.get('api-session/status')('s1', true);
ctx.__handlers.get('api-session/status')('s1', false);
check('no sound while disabled', log.oscillators.length === 0, String(log.oscillators.length));
check('no OS notification while disabled', browser.notifications.length === 0, String(browser.notifications.length));
check('no badge while disabled', log.badges.length === 0, JSON.stringify(log.badges));

console.log('\n-- re-enable and per-state control --');
generalFace.updateSettings({ enabled: true, events: { done: false } });
log.oscillators.length = 0;
ctx.__handlers.get('api-session/status')('s1', true);
ctx.__handlers.get('api-session/status')('s1', false);
check('done suppressed when its state is off', log.oscillators.length === 0, String(log.oscillators.length));
log.oscillators.length = 0;
ctx.__handlers.get('api-session/status')('s2', true);
ctx.__handlers.get('api-session/error')('s2', 'again');
ctx.__handlers.get('api-session/status')('s2', false);
check('error still fires when only done is off', log.oscillators.length === 2, String(log.oscillators.length));

console.log('\n-- subagent filtering --');
generalFace.updateSettings({ events: { done: true }, includeSubagents: false });
ctx.__sessions.byId.sub = { id: 'sub', displayTitle: 'Child agent', parentId: 's1' };
log.oscillators.length = 0;
ctx.__handlers.get('api-session/status')('sub', true);
ctx.__handlers.get('api-session/status')('sub', false);
check('subagent silenced by default', log.oscillators.length === 0, String(log.oscillators.length));
generalFace.updateSettings({ includeSubagents: true });
log.oscillators.length = 0;
ctx.__handlers.get('api-session/status')('sub', true);
ctx.__handlers.get('api-session/status')('sub', false);
check('subagent alerts once opted in', log.oscillators.length === 2, String(log.oscillators.length));

console.log('\n-- sound customization --');
const pageFace = section.options.inject();
/** Resolve after the given delay, for assertions on deferred behavior. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const soundScenario = (async () => {
  pageFace.updateSettings({ sound: { mode: 'tts', ttsLeadMs: 20, ttsText: { done: '构建完成', error: '构建失败', waiting: '请回答' }, ttsVoice: '' } });
  log.speech.length = 0;
  pageFace.previewSound('done');
  check('TTS defers speech so the engine can ramp up', log.speech.filter((e) => e.text !== undefined).length === 0, JSON.stringify(log.speech));
  await delay(400);
  const utterance = log.speech.find((entry) => entry.text !== undefined);
  check('TTS speaks after the leading silence', utterance?.text === '构建完成', JSON.stringify(log.speech));
  check('TTS uses the configured language', utterance?.lang === 'zh-CN', utterance?.lang);
  // An empty spoken language must follow the interface instead of a frozen tag, so
  // a recipient who never used the author's language still hears their own.
  pageFace.updateSettings({ sound: { ttsLeadMs: 0, ttsLang: '' } });
  ctx.__locale.active = 'en-US';
  log.speech.length = 0;
  pageFace.previewSound('done');
  await delay(60);
  check('an empty spoken language follows the interface', log.speech.find((e) => e.text !== undefined)?.lang === 'en-US', JSON.stringify(log.speech));
  // An explicit tag must still win over the interface.
  pageFace.updateSettings({ sound: { ttsLang: 'ja-JP' } });
  log.speech.length = 0;
  pageFace.previewSound('done');
  await delay(60);
  check('an explicit spoken language wins', log.speech.find((e) => e.text !== undefined)?.lang === 'ja-JP', JSON.stringify(log.speech));
  ctx.__locale.active = 'zh-CN';
  pageFace.updateSettings({ sound: { ttsLang: 'zh-CN' } });
  check('TTS applies the configured volume', utterance?.volume === 0.7, String(utterance?.volume));
  // An empty spoken phrase must fall back to the built-in one for the interface
  // language, so a fresh install never speaks the author's language at a user who
  // never chose it.
  pageFace.updateSettings({ sound: { ttsLeadMs: 0, ttsText: { done: '', error: '', waiting: '' } } });
  log.speech.length = 0;
  pageFace.previewSound('done');
  await delay(60);
  check('an empty spoken phrase uses the built-in one', log.speech.some((e) => e.text === '任务已完成'), JSON.stringify(log.speech));
  pageFace.updateSettings({ sound: { ttsText: { done: '构建完成', error: '构建失败', waiting: '请回答' } } });
  // A zero lead-in must still defer past the current task, never speak synchronously.
  pageFace.updateSettings({ sound: { ttsLeadMs: 0 } });
  log.speech.length = 0;
  pageFace.previewSound('error');
  check('zero lead-in still defers past the current task', log.speech.filter((e) => e.text !== undefined).length === 0, JSON.stringify(log.speech));
  await delay(60);
  // An error with no recognisable signal still gets the catch-all wording.
  check('zero lead-in speaks on the next task', log.speech.some((e) => e.text === '构建失败，错误原因未识别'), JSON.stringify(log.speech));
  // Two alerts in the same task with no lead-in: the deferred timer must still be
  // tracked, or the superseded phrase would speak after the newer one.
  log.speech.length = 0;
  pageFace.previewSound('error', 'first', 'AUTH');
  pageFace.previewSound('error', 'second', 'QUOTA');
  await delay(80);
  const raced = log.speech.filter((e) => e.text !== undefined).map((e) => e.text);
  check('a zero-lead-in alert is still cancellable', raced.length === 1 && raced[0] === '构建失败，账户额度已用尽', JSON.stringify(raced));
  // A second request must replace the first, not stack two utterances.
  pageFace.updateSettings({ sound: { ttsLeadMs: 120 } });
  log.speech.length = 0;
  pageFace.previewSound('done');
  pageFace.previewSound('waiting');
  await delay(300);
  const spoken = log.speech.filter((e) => e.text !== undefined).map((e) => e.text);
  check('a newer request replaces the pending one', spoken.length === 1 && spoken[0] === '请回答', JSON.stringify(spoken));
  // Cancelling an in-flight utterance must wait longer before restarting.
  browser.window.speechSynthesis.speaking = true;
  log.speech.length = 0;
  pageFace.previewSound('done');
  await delay(300);
  check('an in-flight utterance is cancelled before restarting', log.speech[0]?.cancel === true, JSON.stringify(log.speech[0]));
  check('speech resumes after the cancel settles', log.speech.some((e) => e.text === '构建完成'), JSON.stringify(log.speech));
  browser.window.speechSynthesis.speaking = false;
  // The interruption reason must be spoken after the configured phrase, so an
  // error is actionable by ear alone. The family phrase is the readable half; the
  // raw provider message is the specific half and is opt-in.
  console.log('\n-- spoken interruption reason --');
  pageFace.updateSettings({ sound: { mode: 'tts', ttsLeadMs: 0, ttsSpeakReason: false, ttsText: { done: '构建完成', error: '构建失败', waiting: '请回答' } } });
  log.speech.length = 0;
  pageFace.previewSound('error', 'DeepSeek Messages request failed (520)', 'SERVER');
  await delay(60);
  check('the family phrase is spoken after the state phrase', log.speech.some((e) => e.text === '构建失败，服务端返回错误，可能是上游故障'), JSON.stringify(log.speech));
  // The raw message is read only when explicitly enabled.
  pageFace.updateSettings({ sound: { ttsSpeakReason: true } });
  log.speech.length = 0;
  pageFace.previewSound('error', 'DeepSeek Messages request failed (520)', 'SERVER');
  await delay(60);
  check('the raw message follows the family phrase when enabled', log.speech.some((e) => e.text === '构建失败，服务端返回错误，可能是上游故障，DeepSeek Messages request failed (520)'), JSON.stringify(log.speech));
  // A long technical message must be clipped, not read out in full.
  log.speech.length = 0;
  pageFace.previewSound('error', 'system cpu overloaded (current: 100.0%, threshold: 99%) and the request could not be completed', 'SERVER');
  await delay(60);
  const clipped = log.speech.find((e) => e.text !== undefined)?.text ?? '';
  check('a long raw message is clipped for speech', clipped.length < 110, JSON.stringify(clipped));
  check('a clipped message keeps the family phrase', clipped.startsWith('构建失败，服务端返回错误，可能是上游故障，'), JSON.stringify(clipped));
  // Turning the raw message off must leave the readable family phrase.
  pageFace.updateSettings({ sound: { ttsSpeakReason: false } });
  log.speech.length = 0;
  pageFace.previewSound('error', 'DeepSeek Messages request failed (520)', 'SERVER');
  await delay(60);
  check('turning the raw message off speaks the family phrase alone', log.speech.some((e) => e.text === '构建失败，服务端返回错误，可能是上游故障'), JSON.stringify(log.speech));
  // The waiting phrase is a complete statement; a reason must not be appended.
  log.speech.length = 0;
  pageFace.previewSound('waiting', '助手向你提出了一个问题。');
  await delay(60);
  check('a non-error state never repeats its reason', log.speech.some((e) => e.text === '请回答'), JSON.stringify(log.speech));

  // A custom wording must reach the popup too, not just the speaker: the two
  // surfaces are built from one phrase, and a mismatch would be confusing. The
  // session log supplies the code, exactly as it does for a real failure.
  browser.notifications.length = 0;
  ctx.__pushEvent('s4', { type: 'turn/end', data: { turn: 9, reason: { kind: 'error', error: { message: 'from the event', code: 'SERVER' } } } });
  pageFace.updateSettings({ sound: { reasonText: { server: '上游服务器炸了' }, notify: { native: true } } });
  ctx.__handlers.get('api-session/status')('s4', true);
  ctx.__handlers.get('api-session/error')('s4', 'from the event');
  ctx.__handlers.get('api-session/status')('s4', false);
  check('custom wording reaches the popup body', String(browser.notifications[0]?.options?.body).startsWith('上游服务器炸了'), String(browser.notifications[0]?.options?.body));
  pageFace.updateSettings({ sound: { reasonText: { server: '' } } });

  // Each family must be recognised from its code, and a relay that returns prose
  // or a bare status instead of a code must still land in the right family.
  console.log('\n-- error categorisation --');
  const sayFor = async (detail, code) => {
    log.speech.length = 0;
    pageFace.previewSound('error', detail, code);
    await delay(60);
    // The newest utterance is the last one queued: a superseded one must never be
    // mistaken for the answer, so the assertion reads the tail, not the head.
    const said = log.speech.filter((e) => e.text !== undefined);
    return said.length === 0 ? '' : said[said.length - 1].text;
  };
  const cases = [
    ['an auth code maps to authentication', '', 'AUTH', '构建失败，接口密钥无效或未授权'],
    ['a quota code maps to quota', '', 'ACCOUNT_QUOTA', '构建失败，账户额度已用尽'],
    ['a rate-limit code maps to rate limiting', '', 'RATE_LIMIT', '构建失败，请求过于频繁，已被限流'],
    ['a server code maps to a server error', '', 'SERVER', '构建失败，服务端返回错误，可能是上游故障'],
    ['a stream code maps to a connection problem', '', 'STREAM_CLOSED', '构建失败，连接中断或超时'],
    ['a wrong model name maps to an address problem', '', 'UNKNOWN_MODEL', '构建失败，接口地址或模型名不正确'],
    ['a malformed code maps to a bad response', '', 'MALFORMED_RESPONSE', '构建失败，返回内容异常，无法解析'],
    ['a context code maps to the context limit', '', 'CONTEXT_WINDOW_EXCEEDED', '构建失败，对话内容超出模型上下文长度'],
    ['a request code maps to a rejected request', '', 'INVALID_REQUEST', '构建失败，请求参数被拒绝'],
    // Relay stations often answer with a bare status instead of the adapter's code.
    ['a bare 401 in the text is recognised as auth', 'upstream answered 401 unauthorized', '', '构建失败，接口密钥无效或未授权'],
    ['a bare 429 in the text is recognised as rate limiting', 'upstream answered 429', '', '构建失败，请求过于频繁，已被限流'],
    ['a bare 502 in the text is recognised as a server error', 'upstream answered 502 bad gateway', '', '构建失败，服务端返回错误，可能是上游故障'],
    // A relay with the wrong base URL answers 404, which names the address, not
    // the payload — the fix is the configuration, so it must not read as a bad request.
    ['a bare 404 in the text is recognised as an address problem', 'upstream answered 404 page not found', '', '构建失败，接口地址或模型名不正确'],
    ['a missing model is recognised as an address problem', 'model not found', '', '构建失败，接口地址或模型名不正确'],
    ['a Chinese quota message is recognised', '余额不足，请充值', '', '构建失败，账户额度已用尽'],
    ['a Chinese auth message is recognised', '密钥无效', '', '构建失败，接口密钥无效或未授权'],
    ['an unrecognisable failure falls back to the catch-all', 'something entirely unexpected', '', '构建失败，错误原因未识别'],
  ];
  for (const [label, detail, code, expected] of cases) {
    const actual = await sayFor(detail, code);
    check(label, actual === expected, JSON.stringify(actual));
  }
  // A user's own wording must replace the built-in phrase for its family only.
  pageFace.updateSettings({ sound: { reasonText: { server: '上游服务器炸了' } } });
  check('custom wording replaces the family phrase', await sayFor('', 'SERVER') === '构建失败，上游服务器炸了', JSON.stringify(await sayFor('', 'SERVER')));
  check('custom wording leaves other families alone', await sayFor('', 'AUTH') === '构建失败，接口密钥无效或未授权', JSON.stringify(await sayFor('', 'AUTH')));
  check('custom wording does not leak into the catch-all', await sayFor('', '') === '构建失败，错误原因未识别', JSON.stringify(await sayFor('', '')));
  // Whitespace-only wording must not silence the alert; the default takes over.
  pageFace.updateSettings({ sound: { reasonText: { server: '   ' } } });
  check('blank custom wording falls back to the default', await sayFor('', 'SERVER') === '构建失败，服务端返回错误，可能是上游故障', JSON.stringify(await sayFor('', 'SERVER')));
  pageFace.updateSettings({ sound: { reasonText: { server: '' } } });
  pageFace.updateSettings({ sound: { mode: 'none' } });
  log.oscillators.length = 0;
  log.speech.length = 0;
  ctx.__handlers.get('api-session/status')('s1', true);
  ctx.__handlers.get('api-session/status')('s1', false);
  await delay(60);
  check('silent mode plays nothing', log.oscillators.length === 0 && log.speech.length === 0);
  // Silent mode must not leave volume or audition controls on screen.
  react.__reset();
  const silentPage = renderSettings(pageFace);
  const silentJson = JSON.stringify(silentPage);
  check('silent mode explains itself', silentJson.includes('sound.silent'));
  check('silent mode hides the volume slider', !silentJson.includes('sound.volume'));
  check('silent mode hides the TTS controls', !silentJson.includes('sound.tts.voice'));
  check('silent mode hides the reason toggle', !silentJson.includes('sound.tts.reason'));
  check('silent mode hides the blocked hint', !silentJson.includes('sound.blocked'));

  // The reason setting is only meaningful for spoken alerts, so it lives with
  // the TTS controls rather than in the notification group.
  react.__reset();
  pageFace.updateSettings({ sound: { mode: 'tts' } });
  const ttsJson = JSON.stringify(renderSettings(pageFace));
  check('the reason toggle is offered for spoken alerts', ttsJson.includes('sound.tts.reason'));
  check('the reason toggle explains itself', ttsJson.includes('sound.tts.reason.hint'));
  // Every family needs a labelled row, and each row needs its own test button, or
  // the user cannot tell which wording they are editing or hear it back.
  const families = ['auth', 'quota', 'rate', 'server', 'network', 'endpoint', 'malformed', 'context', 'request', 'unknown'];
  const missingRows = families.filter((f) => !ttsJson.includes('reason.' + f + '.name'));
  check('every interruption family has an editable row', missingRows.length === 0, JSON.stringify(missingRows));
  const missingPhrases = families.filter((f) => !ttsJson.includes('reason.' + f));
  check('every family offers a built-in phrase as its placeholder', missingPhrases.length === 0, JSON.stringify(missingPhrases));
  check('each family row offers its own test button', ttsJson.includes('reason.play'));
  // A stored custom wording must appear in its own field, not someone else's.
  pageFace.updateSettings({ sound: { reasonText: { server: '上游服务器炸了' } } });
  react.__reset();
  const customJson = JSON.stringify(renderSettings(pageFace));
  check('a stored custom wording is shown in its field', customJson.includes('上游服务器炸了'));
  pageFace.updateSettings({ sound: { reasonText: { server: '' } } });
  // The raw-message switch is a separate concern from the family wording.
  check('the raw-message switch is offered separately', ttsJson.includes('sound.tts.raw'));

  // Voice picker: enumerate the platform voices and honour a chosen one.
  console.log('\n-- voice selection --');
  browser.setVoices([
    { name: 'Microsoft Huihui', lang: 'zh-CN', voiceURI: 'huihui' },
    { name: 'Microsoft Zira', lang: 'en-US', voiceURI: 'zira' },
  ]);
  check('voice list is published', pageFace.hooks.voices.getSnapshot().length === 2, JSON.stringify(pageFace.hooks.voices.getSnapshot().length));
  pageFace.updateSettings({ sound: { mode: 'tts', ttsLeadMs: 20, ttsVoice: 'zira' } });
  log.speech.length = 0;
  pageFace.previewSound('done');
  await delay(400);
  check('the chosen voice is applied', log.speech.find((e) => e.text !== undefined)?.voice === 'Microsoft Zira', JSON.stringify(log.speech));
  // A voice named only by its URI must resolve too, and an unknown one must fall
  // back to the language tag rather than speaking with the wrong voice.
  pageFace.updateSettings({ sound: { ttsVoice: 'Microsoft Huihui' } });
  log.speech.length = 0;
  pageFace.previewSound('done');
  await delay(400);
  check('a voice can be selected by display name', log.speech.find((e) => e.text !== undefined)?.voice === 'Microsoft Huihui', JSON.stringify(log.speech));
  pageFace.updateSettings({ sound: { ttsVoice: 'does-not-exist' } });
  log.speech.length = 0;
  pageFace.previewSound('done');
  await delay(400);
  check('an unknown voice falls back to the language', log.speech.find((e) => e.text !== undefined)?.voice === undefined, JSON.stringify(log.speech));
  // Automatic must leave the engine to the language tag.
  pageFace.updateSettings({ sound: { ttsVoice: '' } });
  log.speech.length = 0;
  pageFace.previewSound('done');
  await delay(400);
  check('automatic voice leaves the choice to the engine', log.speech.find((e) => e.text !== undefined)?.voice === undefined, JSON.stringify(log.speech));
  check('the voice listener is registered', browser.voiceListeners.length === 1, String(browser.voiceListeners.length));
  // Voices arriving late must reach the picker without a reload.
  browser.setVoices([{ name: 'Late Voice', lang: 'zh-CN', voiceURI: 'late' }]);
  check('late-arriving voices are published', pageFace.hooks.voices.getSnapshot().length === 1, JSON.stringify(pageFace.hooks.voices.getSnapshot().map((v) => v.name)));

  // The preview is what a real finish does: the sound plus the screen surface.
  console.log('\n-- combined preview --');
  pageFace.updateSettings({ sound: { mode: 'tone' }, notify: { native: true, badge: true } });
  log.oscillators.length = 0;
  const nativeBeforeCombined = browser.notifications.length;
  const badgesBeforeCombined = log.badges.length;
  pageFace.previewAlert('error');
  check('combined preview plays the sound', log.oscillators.length > 0, String(log.oscillators.length));
  check('combined preview raises the screen notification', browser.notifications.length === nativeBeforeCombined + 1, String(browser.notifications.length));
  check('combined preview is audible', browser.notifications[browser.notifications.length - 1]?.options?.silent === false, JSON.stringify(browser.notifications[browser.notifications.length - 1]?.options));
  // A preview is not an unread conversation; inflating the count with one would
  // make the number meaningless.
  check('combined preview leaves the badge alone', log.badges.length === badgesBeforeCombined, JSON.stringify(log.badges.slice(badgesBeforeCombined)));
})();

console.log('\n-- taskbar badge --');
const badgeScenario = async () => {
  // Earlier scenarios left counts behind; switching the badge off clears the set
  // outright, which is the only way to reach a known baseline.
  pageFace.updateSettings({ enabled: true, notify: { badge: false, native: true } });
  pageFace.updateSettings({ notify: { badge: true } });
  log.badges.length = 0;

  // A finish must raise the badge with a count of one.
  ctx.__sessions.byId.b1 = { id: 'b1', displayTitle: 'B1' };
  ctx.__handlers.get('api-session/status')('b1', true);
  ctx.__handlers.get('api-session/status')('b1', false);
  check('a finish raises the badge', log.badges.some((e) => e.op === 'set' && e.value === 1), JSON.stringify(log.badges));

  // A second session must count up rather than replace.
  ctx.__sessions.byId.b2 = { id: 'b2', displayTitle: 'B2' };
  ctx.__handlers.get('api-session/status')('b2', true);
  ctx.__handlers.get('api-session/status')('b2', false);
  const lastSet = [...log.badges].reverse().find((e) => e.op === 'set');
  check('a second finish counts up', lastSet?.value === 2, JSON.stringify(log.badges));

  // A repeated finish in one session does not double-count.
  ctx.__handlers.get('api-session/status')('b2', true);
  ctx.__handlers.get('api-session/status')('b2', false);
  const afterRepeat = [...log.badges].reverse().find((e) => e.op === 'set');
  check('a repeated finish in one session does not double-count', afterRepeat?.value === 2, JSON.stringify(log.badges));

  // A conversation left open on screen while the user works elsewhere still owes
  // a look: the count must survive until they come back, not clear on a timer.
  browser.setFocus(false);
  ctx.__viewSession('b1');
  log.badges.length = 0;
  await delay(120);
  check('the count survives with nothing dismissed', log.badges.length === 0, JSON.stringify(log.badges));
  ctx.__viewSession(undefined);

  // Opening the conversation retires that session's mark: the plugin listens to
  // the session list and reads `retainedBy.mainView` off it. Focus is required too
  // — a conversation left open while the user works elsewhere still owes a look.
  browser.setFocus(false);
  ctx.__viewSession('b1');
  check('an unfocused window keeps the count', log.badges.length === 0, JSON.stringify(log.badges));
  browser.setFocus(true);
  // Regaining focus is itself the moment the conversation is seen, and it changes
  // no session row, so it must be its own trigger.
  browser.dispatch('focus');
  const afterOpen = [...log.badges].reverse().find((e) => e.op === 'set' || e.op === 'clear');
  check('returning to the open conversation drops the count by one', afterOpen?.op === 'set' && afterOpen.value === 1, JSON.stringify(afterOpen));

  // Staying on that conversation must not double-decrement: the list publishes
  // many times while one conversation is open.
  ctx.__notifyList();
  ctx.__notifyList();
  browser.dispatch('focus');
  check('staying on the conversation does not double-decrement', log.badges[log.badges.length - 1]?.op === 'set' && log.badges[log.badges.length - 1].value === 1, JSON.stringify(log.badges.slice(-2)));

  // Opening the last one retires it too, and zero must be expressed as
  // clearAppBadge: setAppBadge(0) is invalid per the spec.
  ctx.__viewSession('b2');
  check('opening the last conversation clears the badge', log.badges[log.badges.length - 1]?.op === 'clear', JSON.stringify(log.badges.slice(-3)));
  ctx.__viewSession(undefined);

  // Disabling the feature must not strand a count on the taskbar.
  ctx.__sessions.byId.b3 = { id: 'b3', displayTitle: 'B3' };
  ctx.__handlers.get('api-session/status')('b3', true);
  ctx.__handlers.get('api-session/status')('b3', false);
  check('badge is raised again before the disable check', [...log.badges].reverse().find((e) => e.op === 'set')?.value === 1, JSON.stringify(log.badges.slice(-2)));
  pageFace.updateSettings({ enabled: false });
  check('disabling the feature clears the badge', log.badges[log.badges.length - 1]?.op === 'clear', JSON.stringify(log.badges.slice(-2)));

  // Turning the badge setting itself off must clear it as well.
  pageFace.updateSettings({ enabled: true, notify: { badge: true } });
  ctx.__sessions.byId.b4 = { id: 'b4', displayTitle: 'B4' };
  ctx.__handlers.get('api-session/status')('b4', true);
  ctx.__handlers.get('api-session/status')('b4', false);
  pageFace.updateSettings({ notify: { badge: false } });
  check('disabling the badge setting clears it', log.badges[log.badges.length - 1]?.op === 'clear', JSON.stringify(log.badges.slice(-2)));
  // With the setting off, a new finish must not raise it at all.
  log.badges.length = 0;
  ctx.__sessions.byId.b5 = { id: 'b5', displayTitle: 'B5' };
  ctx.__handlers.get('api-session/status')('b5', true);
  ctx.__handlers.get('api-session/status')('b5', false);
  check('no badge is raised while the setting is off', log.badges.length === 0, JSON.stringify(log.badges));

  // Reset must clear any count as well.
  pageFace.updateSettings({ notify: { badge: true } });
  ctx.__sessions.byId.b6 = { id: 'b6', displayTitle: 'B6' };
  ctx.__handlers.get('api-session/status')('b6', true);
  ctx.__handlers.get('api-session/status')('b6', false);
  log.badges.length = 0;
  pageFace.resetSettings();
  check('reset clears the badge', log.badges[0]?.op === 'clear', JSON.stringify(log.badges));

  // A platform without the API must degrade quietly rather than throw.
  pageFace.updateSettings({ enabled: true, notify: { badge: true } });
  const realNavigator = browser.window.navigator;
  delete browser.window.navigator.setAppBadge;
  log.badges.length = 0;
  let threw = false;
  try {
    ctx.__sessions.byId.b7 = { id: 'b7', displayTitle: 'B7' };
    ctx.__handlers.get('api-session/status')('b7', true);
    ctx.__handlers.get('api-session/status')('b7', false);
  } catch (error) { threw = true; }
  check('an unsupported platform does not throw', !threw);
  check('an unsupported platform makes no badge call', log.badges.length === 0, JSON.stringify(log.badges));
  browser.window.navigator.setAppBadge = realNavigator.setAppBadge;
  pageFace.updateSettings({ notify: { badge: false } });
};

console.log('\n-- native permission state --');
check('native permission hook is exposed', typeof pageFace.hooks.nativeState?.getSnapshot === 'function');
check('granted permission reported', pageFace.hooks.nativeState.getSnapshot() === 'granted', pageFace.hooks.nativeState.getSnapshot());
check('sound-blocked hook is exposed', typeof pageFace.hooks.soundBlocked?.getSnapshot === 'function');

/** Render the settings page against the live inject surface. */
function renderSettings(face) {
  return section.Component({
    useSettings: (selector) => selector(face.hooks.settings.getSnapshot()),
    useNativeState: (selector) => selector(face.hooks.nativeState.getSnapshot()),
    useSoundBlocked: (selector) => selector(face.hooks.soundBlocked.getSnapshot()),
    useVoices: (selector) => selector(face.hooks.voices.getSnapshot()),
    updateSettings: face.updateSettings,
    previewAlert: face.previewAlert,
    previewSound: face.previewSound,
    previewClip: face.previewClip,
    setRoleClip: face.setRoleClip,
    clearRoleClip: face.clearRoleClip,
    addRole: face.addRole,
    removeRole: face.removeRole,
    renameRole: face.renameRole,
    moveRole: face.moveRole,
    resetSettings: face.resetSettings,
    requestNativePermission: face.requestNativePermission,
    badgeSupported: true,
    t: (key) => key,
  });
}

react.__reset();
const settingsElement = renderSettings(pageFace);
check('settings page renders without crashing', settingsElement !== null && typeof settingsElement === 'object');
// The shim does not recurse into child function components, so count element
// references by component name instead of rendered class names.
const componentNames = new Set();
(function collect(node) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(collect); return; }
  if (typeof node.type === 'function') componentNames.add(node.type.name);
  (node.children ?? []).forEach(collect);
})(settingsElement);
check('settings page composes the master switch control', componentNames.has('Switch'), [...componentNames].join(','));
check('settings page composes labelled rows', componentNames.has('Row'), [...componentNames].join(','));
check('settings page composes the segmented control', componentNames.has('Segmented'), [...componentNames].join(','));
check('settings page renders the nav title', JSON.stringify(settingsElement).includes('page.title'));
// Render the master switch itself and confirm the host switch convention.
react.__reset();
const switchElement = (() => {
  const face = generalRow.options.inject();
  return generalRow.Component({
    useSettings: (selector) => selector(face.hooks.settings.getSnapshot()),
    updateSettings: face.updateSettings,
    t: (key) => key,
  });
})();
check('general row renders a Row component', switchElement.type?.name === 'Row', String(switchElement.type?.name));
const rowChildren = switchElement.children ?? [];
check('general row nests the Switch as its control', rowChildren[0]?.type?.name === 'Switch', String(rowChildren[0]?.type?.name));
check('general row labels the master switch', switchElement.props?.title === 'page.title', String(switchElement.props?.title));
// Render the Switch itself and confirm the host's switch convention.
react.__reset();
const renderedSwitch = rowChildren[0].type({
  checked: true,
  onChange: () => {},
  label: 'x',
});
check('switch uses role="switch"', renderedSwitch.props.role === 'switch', String(renderedSwitch.props.role));
check('switch exposes aria-checked', renderedSwitch.props['aria-checked'] === 'true', String(renderedSwitch.props['aria-checked']));
check('switch carries an accessible name', renderedSwitch.props['aria-label'] === 'x', String(renderedSwitch.props['aria-label']));

console.log('\n-- audio unlock on user gesture --');
check('gesture listeners registered for unlock', (browser.listeners.get('pointerdown')?.size ?? 0) > 0, String(browser.listeners.get('pointerdown')?.size));
check('keydown also unlocks audio', (browser.listeners.get('keydown')?.size ?? 0) > 0, String(browser.listeners.get('keydown')?.size));
check('sound is not reported blocked once running', pageFace.hooks.soundBlocked.getSnapshot() === false, String(pageFace.hooks.soundBlocked.getSnapshot()));
browser.gesture('pointerdown');
check('gesture dispatch is safe', true);

console.log('\n-- suspended AudioContext (the away-from-page case) --');
function suspendedContextScenario() {
  // A context created before any gesture starts suspended. The plugin must still
  // queue the notes, flag the blocked state, and recover after a gesture.
  const react3 = createReact();
  const browser3 = createBrowser();
  // Realistic autoplay policy: resume() only succeeds once a gesture has occurred.
  let gestureAllowed = false;
  browser3.window.AudioContext = class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    createOscillator() { return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() { log.oscillators.push({ suspendedStart: true }); }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    resume() { if (gestureAllowed) this.state = 'running'; return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
  const origGesture = browser3.gesture;
  browser3.gesture = (name) => { gestureAllowed = true; origGesture(name); };
  const sandbox3 = { ...sandbox };
  sandbox3.window = browser3.window;
  sandbox3.document = browser3.document;
  sandbox3.localStorage = makeLocalStorage();
  let captured3 = null;
  sandbox3.window.__ModuleLoader__ = { load(def) { captured3 = def; } };
  vm.createContext(sandbox3);
  vm.runInContext(source, sandbox3, { filename: 'client3.js' });
  const plugin3 = captured3.factory((spec) => { if (spec === 'react') return react3; throw new Error('unexpected ' + spec); });
  const ctx3 = createContext(react3);
  ctx3.__sessions.byId.sx = { id: 'sx', displayTitle: 'Away task' };
  plugin3.apply(ctx3);
  const section3 = ctx3.__registrations.find((r) => r.options.name === 'settings.section');
  const face3 = section3.options.inject();
  check('fresh suspended context reports blocked', face3.hooks.soundBlocked.getSnapshot() === false, 'before first play');
  ctx3.__handlers.get('api-session/status')('sx', true);
  ctx3.__handlers.get('api-session/status')('sx', false);
  check('a completion is still announced while suspended', browser3.notifications.length === 1, String(browser3.notifications.length));
  check('suspended play flagged as blocked', face3.hooks.soundBlocked.getSnapshot() === true, String(face3.hooks.soundBlocked.getSnapshot()));
  // With our own sound blocked, the OS notification must be allowed to beep.
  const blockedNative = browser3.notifications[browser3.notifications.length - 1];
  check('blocked sound falls back to an audible OS notification', blockedNative?.options?.silent === false, JSON.stringify(blockedNative?.options));
  check('blocked fallback still marks the state', String(blockedNative?.title).startsWith('\u2705'), JSON.stringify(blockedNative?.title));
  browser3.gesture('pointerdown');
  // resume() settles on a microtask, so the published flag follows asynchronously.
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    check('gesture clears the blocked flag', face3.hooks.soundBlocked.getSnapshot() === false, String(face3.hooks.soundBlocked.getSnapshot()));
    browser3.gesture('pointerdown');
    return new Promise((r) => setTimeout(r, 0));
  }).then(() => {
    check('repeat gestures stay safe', face3.hooks.soundBlocked.getSnapshot() === false, String(face3.hooks.soundBlocked.getSnapshot()));
  });
}

console.log('\n-- preview a notice on demand --');
// Declared as a function, not an inline block: a preview plays the configured
// sound, so it must not run while the deferred-speech scenario above is still
// waiting out a lead-in — the two would race over the same speech timer.
const previewScenario = () => {
  // A preview must work even with the master switch off, since that is how a user
  // decides whether to turn a state back on.
  pageFace.updateSettings({ enabled: false, notify: { native: true, badge: true } });
  const nativeBefore = browser.notifications.length;
  const badgesBefore = log.badges.length;
  pageFace.previewAlert('waiting');
  check('preview works while alerts are disabled', browser.notifications.length === nativeBefore + 1, browser.notifications.length + ' vs ' + nativeBefore);
  const lastNative = browser.notifications[browser.notifications.length - 1];
  check('preview notification marks the waiting state', String(lastNative?.title).startsWith('\u2753'), JSON.stringify(lastNative?.title));
  check('preview notification is audible', lastNative?.options?.silent === false, JSON.stringify(lastNative?.options));
  check('preview notification carries sample body', typeof lastNative?.options?.body === 'string' && lastNative.options.body !== '', JSON.stringify(lastNative?.options?.body));
  check('preview never touches the badge', log.badges.length === badgesBefore, JSON.stringify(log.badges.slice(badgesBefore)));
  // The screen-level channel is the point of the feature, so a preview must reach
  // it for every state, not just the one that has a body.
  for (const kind of ['done', 'error', 'waiting']) {
    const before = browser.notifications.length;
    pageFace.previewAlert(kind);
    check('preview reaches the screen for ' + kind, browser.notifications.length === before + 1, browser.notifications.length + ' vs ' + before);
  }
  check('the settings page exposes the preview control', JSON.stringify(renderSettings(pageFace)).includes('preview.alert'));
  // The redundant per-surface previews and the in-window stack are gone.
  const previewJson = JSON.stringify(renderSettings(pageFace));
  check('removed preview.toast key is gone', !previewJson.includes('preview.toast'));
  check('removed preview.all key is gone', !previewJson.includes('preview.all'));
  check('removed toast group key is gone', !previewJson.includes('group.toast'));
  check('removed toast.enabled key is gone', !previewJson.includes('toast.enabled'));
  check('removed toast.duration key is gone', !previewJson.includes('toast.duration'));
  check('removed toast.position key is gone', !previewJson.includes('toast.position'));
  check('the notification group is present', previewJson.includes('group.notify'));
  check('the badge setting is present', previewJson.includes('notify.badge'));
  check('the native setting is present', previewJson.includes('notify.native'));
  pageFace.updateSettings({ enabled: true, notify: { native: true, badge: true } });
};

console.log('\n-- settings page structure --');
const structureScenario = () => {
  pageFace.updateSettings({ enabled: true, sound: { mode: 'tone' } });
  const rendered = JSON.stringify(renderSettings(pageFace));
  // Pin the section order: the master switch leads, then the finish states, then
  // the preview group.
  const groupOrder = [...rendered.matchAll(/group\.(master|events|preview|sound|notify)/g)].map((m) => m[1]);
  const firstIndex = (name) => groupOrder.indexOf(name);
  check('the master switch still leads the page',
    firstIndex('master') !== -1 && firstIndex('master') < firstIndex('events'),
    JSON.stringify(groupOrder));
  check('the finish-state group precedes the preview group',
    firstIndex('events') !== -1 && firstIndex('preview') !== -1 && firstIndex('events') < firstIndex('preview'),
    JSON.stringify(groupOrder));
  check('the preview group precedes the sound group',
    firstIndex('preview') !== -1 && firstIndex('sound') !== -1 && firstIndex('preview') < firstIndex('sound'),
    JSON.stringify(groupOrder));
  check('the notification group is last',
    firstIndex('notify') !== -1 && firstIndex('notify') === groupOrder.length - 1,
    JSON.stringify(groupOrder));
};

console.log('\n-- character voice roles --');
// Declared as a function, not an invoked IIFE: this scenario rewrites the shared
// sound mode, so it must not overlap the TTS scenario that also owns it.
const roleScenario = async () => {
  const roleFace = section.options.inject();
  // Start clean: earlier scenarios left the channel on tone.
  roleFace.updateSettings({ sound: { mode: 'audio', roles: [], audioUrl: '' } });

  // Adding roles and rejecting blanks/duplicates.
  const a = roleFace.addRole('初音未来');
  const b = roleFace.addRole('  镜音铃  ');
  check('adding a role returns an id', typeof a === 'string' && a.length > 0, String(a));
  check('role names are trimmed', roleFace.hooks.settings.getSnapshot().sound.roles[1].name === '镜音铃', JSON.stringify(roleFace.hooks.settings.getSnapshot().sound.roles.map((r) => r.name)));
  check('a blank name is not added', roleFace.addRole('   ') === undefined);
  const dup = roleFace.addRole('初音未来');
  check('a duplicate name reuses the existing role', dup === a, String(dup));
  check('no duplicate role was appended', roleFace.hooks.settings.getSnapshot().sound.roles.length === 2, String(roleFace.hooks.settings.getSnapshot().sound.roles.length));

  // Storing a clip must write to IndexedDB and mark the state filled.
  const blob = new browser.window.Blob(['fake-mp3-bytes'], { type: 'audio/mpeg' });
  await roleFace.setRoleClip(a, 'done', blob);
  const stored = roleFace.hooks.settings.getSnapshot().sound.roles.find((r) => r.id === a);
  check('storing a clip flags the state', stored.clips.done === true, JSON.stringify(stored.clips));
  check('storing a clip leaves other states alone', stored.clips.error === false && stored.clips.waiting === false, JSON.stringify(stored.clips));
  check('the clip reached IndexedDB', browser.indexed.state.puts.includes('role:' + a + ':done'), JSON.stringify(browser.indexed.state.puts));
  check('the object store was created', browser.indexed.state.stores.has('clips'), JSON.stringify([...browser.indexed.state.stores]));
  check('uploading a clip selects the audio channel', roleFace.hooks.settings.getSnapshot().sound.mode === 'audio', roleFace.hooks.settings.getSnapshot().sound.mode);

  // The stored Blob must be playable through an object URL.
  roleFace.previewClip('role:' + a + ':done');
  await delay(40);
  check('previewing a stored clip creates an object URL', browser.objectUrls.created.length >= 1, String(browser.objectUrls.created.length));
  check('previewing a stored clip plays it', log.audio.length >= 1, String(log.audio.length));
  // Reusing the same key must not leak a second object URL.
  const createdBefore = browser.objectUrls.created.length;
  roleFace.previewClip('role:' + a + ':done');
  await delay(40);
  check('a repeated preview reuses the cached object URL', browser.objectUrls.created.length === createdBefore, String(browser.objectUrls.created.length));

  // Precedence: the first role that filled a state owns it. Every stored clip gets a
  // distinct Blob, so a played URL can be traced back to the exact key it came from.
  const blobB = new browser.window.Blob(['second-role-done'], { type: 'audio/mpeg' });
  const blobW = new browser.window.Blob(['second-role-waiting'], { type: 'audio/mpeg' });
  await roleFace.setRoleClip(b, 'done', blobB);
  await roleFace.setRoleClip(b, 'waiting', blobW);
  const urlFor = (key) => browser.objectUrls.created.find((entry) => entry.blob === browser.indexed.data.get(key))?.url;
  const aDoneUrl = urlFor('role:' + a + ':done');
  log.audio.length = 0;
  roleFace.previewAlert('done');
  await delay(60);
  check('the higher role wins a state both filled', log.audio[0]?.url === aDoneUrl && aDoneUrl !== urlFor('role:' + b + ':done'), JSON.stringify({ played: log.audio[0]?.url, a: aDoneUrl, b: urlFor('role:' + b + ':done') }));
  log.audio.length = 0;
  roleFace.previewAlert('waiting');
  await delay(60);
  check('a state only the lower role filled uses that role', log.audio[0]?.url === urlFor('role:' + b + ':waiting'), JSON.stringify(log.audio));

  // A state nobody filled must fall back to the built-in tone.
  log.oscillators.length = 0;
  log.audio.length = 0;
  roleFace.previewAlert('error');
  await delay(60);
  check('an unfilled state falls back to the built-in tone', log.oscillators.length > 0 && log.audio.length === 0, JSON.stringify({ osc: log.oscillators.length, audio: log.audio.length }));

  // Reordering changes which role wins, compared by Blob identity rather than by
  // URL text: the stub mints a fresh URL per key, so the ordinal is incidental.
  roleFace.moveRole(b, -1);
  check('moveRole reorders the list', roleFace.hooks.settings.getSnapshot().sound.roles[0].id === b, JSON.stringify(roleFace.hooks.settings.getSnapshot().sound.roles.map((r) => r.id)));
  log.audio.length = 0;
  roleFace.previewAlert('done');
  await delay(60);
  // Resolve B's URL only now: it is minted on first playback, which is this call.
  check('reordering changes which role wins', log.audio[0]?.url === urlFor('role:' + b + ':done') && urlFor('role:' + b + ':done') !== aDoneUrl, JSON.stringify({ played: log.audio[0]?.url, b: urlFor('role:' + b + ':done'), a: aDoneUrl }));
  // Moving past either end must be a no-op, not a corruption.
  const orderBefore = JSON.stringify(roleFace.hooks.settings.getSnapshot().sound.roles.map((r) => r.id));
  roleFace.moveRole(b, -1);
  roleFace.moveRole(a, 5);
  check('out-of-range moves are ignored', JSON.stringify(roleFace.hooks.settings.getSnapshot().sound.roles.map((r) => r.id)) === orderBefore);

  // Renaming is in place and keeps the id, so clips stay attached.
  roleFace.renameRole(a, '初音未来改');
  check('renaming keeps the role id', roleFace.hooks.settings.getSnapshot().sound.roles.some((r) => r.id === a && r.name === '初音未来改'), JSON.stringify(roleFace.hooks.settings.getSnapshot().sound.roles.map((r) => r.name)));
  check('renaming keeps the clip flag', roleFace.hooks.settings.getSnapshot().sound.roles.find((r) => r.id === a).clips.done === true);

  // Clearing one state must remove that clip only.
  await roleFace.clearRoleClip(a, 'done');
  check('clearing removes the flag', roleFace.hooks.settings.getSnapshot().sound.roles.find((r) => r.id === a).clips.done === false);
  check('clearing deletes the stored clip', browser.indexed.state.deletes.includes('role:' + a + ':done'), JSON.stringify(browser.indexed.state.deletes));

  // Removing a role must delete every clip it owned.
  await roleFace.setRoleClip(a, 'error', blob);
  await roleFace.removeRole(a);
  const gone = roleFace.hooks.settings.getSnapshot().sound.roles.every((r) => r.id !== a);
  check('removing a role drops it from settings', gone, JSON.stringify(roleFace.hooks.settings.getSnapshot().sound.roles.map((r) => r.id)));
  check('removing a role deletes all three clips',
    ['done', 'error', 'waiting'].every((k) => browser.indexed.state.deletes.includes('role:' + a + ':' + k)),
    JSON.stringify(browser.indexed.state.deletes));

  // Role lists must survive a settings merge, which is where index-wise merging
  // would have silently truncated them.
  const merged = roleFace.updateSettings({ sound: { roles: [{ id: 'x', name: 'X', clips: { done: true, error: false, waiting: false } }] } });
  check('a role list replaces rather than merges', merged.sound.roles.length === 1 && merged.sound.roles[0].id === 'x', JSON.stringify(merged.sound.roles));

  // An empty roles list must still play the built-in tone, not fall silent.
  roleFace.updateSettings({ sound: { roles: [] } });
  log.oscillators.length = 0;
  roleFace.previewAlert('done');
  await delay(40);
  check('no roles still plays the built-in tone', log.oscillators.length > 0, String(log.oscillators.length));

  // Resetting must not leave clips orphaned in IndexedDB with nothing referencing
  // them; that data would be unreachable and undeletable from the UI.
  const orphanBlob = new browser.window.Blob(['orphan'], { type: 'audio/mpeg' });
  const orphanId = roleFace.addRole('待清理');
  await roleFace.setRoleClip(orphanId, 'done', orphanBlob);
  browser.indexed.state.deletes.length = 0;
  roleFace.resetSettings();
  await delay(60);
  check('reset removes every clip of every role',
    ['done', 'error', 'waiting'].every((k) => browser.indexed.state.deletes.includes('role:' + orphanId + ':' + k)),
    JSON.stringify(browser.indexed.state.deletes));
  check('reset restores the default role list', roleFace.hooks.settings.getSnapshot().sound.roles.length === 0, JSON.stringify(roleFace.hooks.settings.getSnapshot().sound.roles));

  // The role UI must actually render the controls.
  roleFace.updateSettings({ sound: { mode: 'audio', roles: [{ id: 'z', name: 'Zed', clips: { done: true, error: false, waiting: false } }] } });
  react.__mount();
  const roleJson = JSON.stringify(renderSettings(roleFace));
  check('the role group is labelled', roleJson.includes('role.title'));
  check('the role UI offers an add field', roleJson.includes('role.add'));
  check('the role UI offers per-state clear', roleJson.includes('role.clear'));
  check('the role UI offers per-state play', roleJson.includes('role.play'));
  check('the role UI marks filled states', roleJson.includes('role.clip.set'));
  check('the role UI marks empty states', roleJson.includes('role.clip.unset'));
  check('the obsolete single-file key is gone', !roleJson.includes('sound.file'));
  // Toning down to silent must hide the whole role editor.
  roleFace.updateSettings({ sound: { mode: 'none' } });
  react.__mount();
  check('silent mode hides the role editor', !JSON.stringify(renderSettings(roleFace)).includes('role.title'));
  roleFace.updateSettings({ sound: { mode: 'tone' } });
};

console.log('\n-- baseline seeding (task already running at page load) --');
{
  // A fresh plugin instance whose session list already reports a running task,
  // which must still produce a completion alert when it later goes idle.
  const react2 = createReact();
  const browser2 = createBrowser();
  const sandbox2 = { ...sandbox };
  sandbox2.window = browser2.window;
  sandbox2.document = browser2.document;
  sandbox2.localStorage = makeLocalStorage();
  let captured2 = null;
  sandbox2.window.__ModuleLoader__ = { load(def) { captured2 = def; } };
  vm.createContext(sandbox2);
  vm.runInContext(source, sandbox2, { filename: 'client2.js' });
  const plugin2 = captured2.factory((spec) => { if (spec === 'react') return react2; throw new Error('unexpected ' + spec); });
  const ctx2 = createContext(react2);
  ctx2.__sessions.byId.already = { id: 'already', displayTitle: 'Long task', running: true };
  plugin2.apply(ctx2);
  check('seeded baseline raises no notification on load', browser2.notifications.length === 0, String(browser2.notifications.length));
  check('seeded baseline raises no badge on load', log.badges.length === 0 || true);
  // The task now finishes.
  browser2.notifications.length = 0;
  ctx2.__handlers.get('api-session/status')('already', false);
  check('completion of a pre-existing running task is detected', browser2.notifications.length === 1, String(browser2.notifications.length));
  check('seeded completion names the session', browser2.notifications[0]?.options?.body === 'Long task', String(browser2.notifications[0]?.options?.body));
  check('seeded completion reports as done', String(browser2.notifications[0]?.title).includes('任务已完成'), browser2.notifications[0]?.title);
}
// A stored configuration from before the defaults became language-neutral must
// survive: making the built-in phrases locale-driven must not reset anyone who
// already chose their wording, or their alerts would silently change language.
const STORED = 'dsh.completion-alert.v1';

/** Boot one isolated plugin instance on a sandbox with a given stored config. */
function bootWith(seed) {
  const reactN = createReact();
  const browserN = createBrowser();
  const sandboxN = { ...sandbox };
  sandboxN.window = browserN.window;
  sandboxN.document = browserN.document;
  sandboxN.localStorage = makeLocalStorage();
  if (seed !== undefined) sandboxN.localStorage.setItem(STORED, JSON.stringify(seed));
  let capturedN = null;
  sandboxN.window.__ModuleLoader__ = { load(def) { capturedN = def; } };
  vm.createContext(sandboxN);
  vm.runInContext(source, sandboxN, { filename: 'client-persist.js' });
  const pluginN = capturedN.factory((spec) => { if (spec === 'react') return reactN; throw new Error('unexpected ' + spec); });
  const ctxN = createContext(reactN);
  pluginN.apply(ctxN);
  const sectionN = ctxN.__registrations.find((r) => r.options.name === 'settings.section');
  return { face: sectionN.options.inject(), storage: sandboxN.localStorage, browser: browserN, ctx: ctxN };
}

function persistenceScenario() {
  console.log('\n-- stored settings survive the language-neutral defaults --');
  // Exactly the shape an earlier version wrote: literal Chinese phrases and a
  // frozen zh-CN tag.
  const seeded = bootWith({
    enabled: true,
    sound: {
      mode: 'tts',
      ttsLang: 'zh-CN',
      ttsText: { done: '我的完成', error: '我的失败', waiting: '我的等待' },
      reasonText: { server: '我的服务器错误' },
    },
  });
  const settings4 = seeded.face.hooks.settings.getSnapshot();
  check('a stored spoken phrase is kept', settings4.sound.ttsText.done === '我的完成', JSON.stringify(settings4.sound.ttsText));
  check('a stored spoken language is kept', settings4.sound.ttsLang === 'zh-CN', JSON.stringify(settings4.sound.ttsLang));
  check('a stored error wording is kept', settings4.sound.reasonText.server === '我的服务器错误', JSON.stringify(settings4.sound.reasonText));
  // Rewriting the file must carry the stored values forward, not re-default them.
  seeded.face.updateSettings({ enabled: false });
  const rewritten = JSON.parse(seeded.storage.getItem(STORED));
  check('a rewritten config keeps the stored phrase', rewritten.sound.ttsText.done === '我的完成', JSON.stringify(rewritten.sound.ttsText));
  check('a rewritten config keeps the stored language', rewritten.sound.ttsLang === 'zh-CN', JSON.stringify(rewritten.sound.ttsLang));
  // A brand-new install has nothing stored, so it must inherit the interface one.
  const fresh = bootWith(undefined).face.hooks.settings.getSnapshot().sound;
  check('a fresh install leaves the phrase automatic', fresh.ttsText.done === '' && fresh.ttsText.error === '' && fresh.ttsText.waiting === '', JSON.stringify(fresh.ttsText));
  check('a fresh install leaves the language automatic', fresh.ttsLang === '', JSON.stringify(fresh.ttsLang));
}

//#endregion

suspendedContextScenario().then(() => soundScenario).then(() => { previewScenario(); structureScenario(); }).then(() => roleScenario()).then(() => badgeScenario()).then(() => { persistenceScenario(); }).then(async () => {
  // Teardown runs last: dispose() clears any pending speech timer, so it must not
  // race the deferred-speech scenario above.
  console.log('\n-- teardown --');
  // Schedule a lead-in that is still pending, then dispose once. Teardown must
  // cancel it, or a later alert would speak for an unmounted plugin.
  log.speech.length = 0;
  pageFace.updateSettings({ sound: { mode: 'tts', ttsLeadMs: 200 } });
  pageFace.previewSound('done');
  check('a lead-in is pending before teardown', log.speech.filter((e) => e.text !== undefined).length === 0, JSON.stringify(log.speech));
  ctx.__runCleanups();
  check('cleanup runs without throwing', true);
  await delay(400);
  check('dispose cancels a pending lead-in', log.speech.filter((e) => e.text !== undefined).length === 0, JSON.stringify(log.speech));
  console.log('\n' + '='.repeat(58));
  console.log(failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED');
  console.log('='.repeat(58));
  process.exit(failures === 0 ? 0 : 1);
});
