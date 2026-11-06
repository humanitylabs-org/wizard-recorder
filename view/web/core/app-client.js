/* WizardApp v1: the only app-facing platform facade. Same-origin synchronous
 * connection keeps share/capture inside the originating gesture. Standalone uses
 * the same resource modules; hosted apps never own a root guard or install worker. */
(() => {
  'use strict';
  // Runs before frontend scripts, including iframe refresh/recreation. The native
  // document-start hook is an additional fence, not the sole ordering guarantee.
  // Ordinary workspace/standalone clients are unchanged: the policy is session-only.
  try { if (parent !== window && parent.WizHomeScreenPolicy?.mode) parent.WizHomeScreenPolicy.installPresentationStorage(window); } catch (_) {}
  if (window.WizardApp) return;
  const ORIGIN = location.origin, VERSION = 1, overlays = [], handlers = [], themes = new Set(), updates = new Set();
  let service = null, transportReady = false, currentTheme = null, updateAvailable = null, rootWatcher = null, guarded = false, exitUntil = 0, requestId = 0;
  const requests = new Map();
  let toolHandler = null, orbHandler = null;
  const guardPush = history.pushState.bind(history);
  let guardBase = null, standaloneIsRoot = null;
  let conversation = null;
  const voiceInput = Object.freeze({ register(handler) {
    if (typeof handler?.snapshot !== 'function' || typeof handler?.receive !== 'function') throw new TypeError('Voice input needs snapshot and receive');
    if (conversation) throw new Error('Voice input already registered');
    conversation = Object.freeze({ snapshot: handler.snapshot, receive: handler.receive });
    const registered = conversation;
    return () => { if (conversation === registered) conversation = null; };
  } });
  const conversationClient = Object.freeze({
    get voiceInput() { return conversation; },
    get conversation() { return conversation; },
    back, alive: () => true,
  });
  const framed = parent !== window;
  const detached = () => !service;
  const localHolds = new Map();
  const notify = (set, value) => { for (const fn of set) try { fn(value); } catch (e) { console.warn('WizardApp subscriber', e); } };
  function request(op, args, timeout = 15000) {
    if (!framed || requests.size >= 32) return Promise.reject(new Error('Shared app transport unavailable'));
    const id = 'wa-' + (++requestId) + '-' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('Shared app transport timed out')); }, timeout);
      requests.set(id, { resolve, reject, timer });
      try { parent.postMessage({ type: 'wizard:app:request', version: VERSION, id, op, args }, ORIGIN); }
      catch (e) { clearTimeout(timer); requests.delete(id); reject(e); }
    });
  }
  function back() {
    const top = overlays[overlays.length - 1];
    if (top) { if (top.fn() === false) return false; top.release(); return true; }
    for (let i = handlers.length - 1; i >= 0; i--) {
      const h = handlers[i];
      const can = h.canGoBack();
      if (typeof can !== 'boolean') throw new TypeError('canGoBack must return a synchronous boolean');
      if (can) { const did = h.back(); if (typeof did !== 'boolean') throw new TypeError('back must return a synchronous boolean'); return did; }
    }
    return false;
  }
  function ready(meta = {}) {
    if (framed) {
      try { service = parent.WizAppServices?.connect(window, conversationClient) || null; } catch (_) { service = null; }
      if (service) { try { rootWatcher?.destroy(); } catch (_) {} rootWatcher = null; }
      parent.postMessage({ type: 'wizard:appearance:ready', version: VERSION, app: String(meta.name || '').slice(0, 96) }, ORIGIN);
    }
    if (service) { const r = service.ready(); registerShare(); return Promise.resolve(r); }
    if (!framed) return Promise.resolve({ version: VERSION, hosted: false });
    return request('ready', null, 1500).then(result => {
      transportReady = result?.version === VERSION && result.hosted === true;
      if (transportReady) registerShare();
      return transportReady ? result : { version: VERSION, hosted: false };
    }, () => { transportReady = false; return { version: VERSION, hosted: false }; });
  }
  /* Receiving shares from Wizard's share sheet (docs/SHARE-SHEET.md). Hosted apps only: the shell keeps each item
   * pending until receive() returns true (the item is visibly placed, e.g. in the app's composer), then it is acked. */
  let shareRecv = null, sharePull = null;
  function shareOp(op, args) {
    if (service) return Promise.resolve().then(() => op === 'receive' ? service.share.receive(args) : op === 'targets' ? service.share.targets(args.targets) : op === 'pending' ? service.share.pending() : service.share.ack(args.id));
    if (transportReady) return request('share.' + op, args);
    return Promise.reject(new Error('Receiving shares needs the Wizard host'));
  }
  function pullShares() {
    if (!shareRecv) return Promise.resolve(0);
    if (sharePull) { sharePull.again = true; return sharePull.done; }
    const run = sharePull = { again: false };
    run.done = (async () => {
      let n = 0;
      try {
        do {
          run.again = false;
          const items = await shareOp('pending').catch(() => []);
          for (const it of Array.isArray(items) ? items : []) {
            if (!shareRecv) break;
            let ok = false;
            try { ok = (await shareRecv.receive(Object.freeze({ ...it }))) === true; } catch (e) { console.warn('WizardApp share receive', e); }
            if (ok) { await shareOp('ack', { id: it.id }).catch(() => {}); n++; }
          }
        } while (run.again && shareRecv);
      } finally { sharePull = null; }
      return n;
    })();
    return run.done;
  }
  function registerShare() {
    if (!shareRecv || (!service && !transportReady)) return Promise.resolve(false);
    return shareOp('receive', { accepts: shareRecv.accepts, targets: shareRecv.targets }).then(ok => { if (ok) pullShares(); return ok === true; }, () => false);
  }
  function receiveShares({ accepts, targets, receive } = {}) {
    if (typeof receive !== 'function') throw new TypeError('Share receiver needs receive(item)');
    shareRecv = { accepts: Array.isArray(accepts) ? accepts.slice(0, 8) : [], targets: Array.isArray(targets) ? targets.slice(0, 24) : undefined, receive };
    registerShare();
    const mine = shareRecv;
    return () => { if (shareRecv !== mine) return; shareRecv = null; shareOp('receive', { accepts: [] }).catch(() => {}); };
  }
  function shareTargets(list) { if (shareRecv && Array.isArray(list)) shareRecv.targets = list.slice(0, 24); return shareRecv && Array.isArray(list) ? shareOp('targets', { targets: list.slice(0, 24) }).then(v => v === true, () => false) : Promise.resolve(false); }
  function register({ canGoBack, back: fn }) {
    if (typeof canGoBack !== 'function' || typeof fn !== 'function') throw new TypeError('Back needs synchronous canGoBack/back callbacks');
    const h = { canGoBack, back: fn }; handlers.push(h);
    return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); };
  }
  function push(fn) {
    if (typeof fn !== 'function') throw new TypeError('Back overlay needs a callback');
    const h = { fn, release() { const i = overlays.indexOf(h); if (i >= 0) overlays.splice(i, 1); } };
    overlays.push(h); return { release: h.release };
  }
  function useHistory({ isRoot } = {}) {
    if (typeof isRoot !== 'function') throw new TypeError('History adapter needs isRoot');
    const history = window.history, id = 'wh-' + Math.random().toString(36).slice(2);
    const priorPush = history.pushState, priorReplace = history.replaceState;
    let index = 0, pending = false;
    const stamp = state => { const next = { ...(state && typeof state === 'object' ? state : {}), __wizardApp: { version: VERSION, id, index } }; delete next.__wizardAppGuard; return next; };
    if (!framed) standaloneIsRoot = isRoot;
    priorReplace.call(history, stamp(history.state), '');
    const wrappedPush = function (state, title, url) {
      index++; try { return priorPush.call(history, stamp(state), title, url); } catch (e) { index--; throw e; }
    };
    const wrappedReplace = function (state, title, url) { return priorReplace.call(history, stamp(state), title, url); };
    history.pushState = wrappedPush; history.replaceState = wrappedReplace;
    const pop = e => { const mark = e.state?.__wizardApp; if (mark?.id === id) index = mark.index; else index = 0; pending = false; };
    addEventListener('popstate', pop);
    // A traversal already admitted by this adapter still owns Back until its
    // popstate arrives. Reporting root while it is pending lets a rapid second
    // hardware callback collapse fullscreen or send the shell Home.
    const unregister = register({ canGoBack: () => pending || (!isRoot() && index > 0),
      back: () => { if (pending) return true; if (isRoot() || index <= 0) return false; pending = true; history.back(); return true; } });
    return () => { unregister(); removeEventListener('popstate', pop); if (history.pushState === wrappedPush) history.pushState = priorPush; if (history.replaceState === wrappedReplace) history.replaceState = priorReplace; if (standaloneIsRoot === isRoot) standaloneIsRoot = null; };
  }
  const listen = (set, fn, value) => { if (typeof fn !== 'function') throw new TypeError('Subscriber must be a function'); set.add(fn); if (value) fn(value); return () => set.delete(fn); };
  const TOKENS = ['canvas', 'base', 'chrome', 'overlay', 'surface', 'surface-raised', 'text', 'text-secondary', 'text-muted', 'border', 'accent', 'accent-soft', 'on-accent', 'reader-surface'];
  function applyTheme(a) {
    if (!a || a.version !== VERSION || !Number.isSafeInteger(a.revision) || a.revision < 0 || !['window', 'immersive'].includes(a.presentation) || !['light', 'dark'].includes(a.colorScheme) || !/^[a-z0-9-]{1,40}$/.test(a.skin || '') || !a.tokens) return false;
    if (!TOKENS.every(k => typeof a.tokens[k] === 'string' && a.tokens[k].length < 96 && a.tokens[k].length > 0 && !/[;{}]|url\(/i.test(a.tokens[k]) && (!window.CSS?.supports || CSS.supports('color', a.tokens[k])))) return false;
    if (currentTheme && a.revision < currentTheme.revision) return false;
    if (currentTheme && a.revision === currentTheme.revision && JSON.stringify(a) === JSON.stringify(currentTheme)) return true;
    const root = document.documentElement;
    for (const k of TOKENS) root.style.setProperty('--wz-' + k, a.tokens[k]);
    root.style.colorScheme = a.colorScheme;
    root.dataset.skin = a.skin; root.dataset.presentation = a.presentation; root.dataset.colorScheme = a.colorScheme;
    root.setAttribute('data-wz-hosted', '');
    currentTheme = Object.freeze({ ...a, tokens: Object.freeze({ ...a.tokens }) });
    notify(themes, currentTheme);
    if (!window.WizardTheme) dispatchEvent(new CustomEvent('wizard:theme', { detail: currentTheme }));
    return true;
  }
  // Compatibility with the already-vendored Appearance v1 client: one protocol, same tokens and event.
  addEventListener('wizard:theme', e => { if (window.WizardTheme && e.detail !== currentTheme) { currentTheme = e.detail; notify(themes, currentTheme); } });
  addEventListener('message', e => {
    if (!framed || e.source !== parent || e.origin !== ORIGIN || !e.data) return;
    const d = e.data;
    if (d.type === 'wizard:app:reply' && d.version === VERSION && requests.has(d.id)) {
      const pending = requests.get(d.id); clearTimeout(pending.timer); requests.delete(d.id);
      if (d.error) pending.reject(new Error(String(d.error))); else pending.resolve(d.value);
    }
    if (d.type === 'wizard:appearance' && applyTheme(d.appearance)) parent.postMessage({ type: 'wizard:appearance:ack', version: VERSION, revision: currentTheme.revision }, ORIGIN);
    if (d.type === 'wizard:app:orb' && d.version === VERSION && orbHandler) { try { orbHandler(); } catch (err) { console.warn('WizardApp orb', err); } }
    if (d.type === 'wizard:app:tool' && d.version === VERSION && toolHandler && typeof d.id === 'string') { try { toolHandler({ id: d.id, value: typeof d.value === 'string' ? d.value : undefined }); } catch (err) { console.warn('WizardApp tool', err); } }
    if (d.type === 'wizard:app:update' && d.version === VERSION) { updateAvailable = d.available; notify(updates, updateAvailable); }
    if (d.type === 'wizard:app:share' && d.version === VERSION) pullShares();
  });
  function hold(reason) {
    if (service) return service.update.hold(reason);
    if (transportReady) {
      const pending = request('update.hold', { reason }); let released = false;
      pending.catch(() => {});
      return { release() { if (released) return; released = true; pending.then(id => request('update.release', { id })).catch(() => {}); } };
    }
    const id = {}; localHolds.set(id, String(reason || 'Unsaved work'));
    return { release() { localHolds.delete(id); } };
  }
  async function nativeReceipt(invoke) {
    let timer;
    try {
      let result = await Promise.race([Promise.resolve(invoke()), new Promise(resolve => { timer = setTimeout(() => resolve('unsupported'), 15000); })]);
      if (typeof result === 'string') { try { result = JSON.parse(result); } catch (_) {} }
      const outcome = result && typeof result === 'object' ? result.status || result.outcome : result;
      return ['shared', 'copied', 'cancelled', 'unsupported'].includes(outcome) ? outcome : 'unsupported';
    } catch (e) { return e?.name === 'AbortError' ? 'cancelled' : 'unsupported'; }
    finally { clearTimeout(timer); }
  }
  async function fallbackText(data = {}) {
    if (window.WosChat?.sharePayload) return window.WosChat.sharePayload(data);
    const payload = {};
    for (const k of ['title', 'text', 'url']) if (data[k] != null && String(data[k])) payload[k] = String(data[k]);
    if (!payload.text && !payload.url) return 'unsupported';
    if ((payload.text || '').length > 90000 || (payload.title || '').length > 1024 || (payload.url || '').length > 8192) return 'unsupported';
    if (payload.url) { try { const parsed = new URL(payload.url, location.href); if (!/^https?:$/.test(parsed.protocol)) return 'unsupported'; if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(payload.url)) payload.url = parsed.href; } catch (_) { return 'unsupported'; } }
    const native = window.WizardOSNative;
    if (!framed && typeof native?.shareText === 'function') return nativeReceipt(() => native.shareText([payload.text, payload.url].filter(Boolean).join('\n'), payload.title || ''));
    if (navigator.share) {
      try { await navigator.share(payload); return 'shared'; } catch (e) { if (e?.name === 'AbortError') return 'cancelled'; return 'unsupported'; }
    }
    try { if (!navigator.clipboard?.writeText) return 'unsupported'; await navigator.clipboard.writeText([payload.text, payload.url].filter(Boolean).join('\n')); return 'copied'; } catch (_) { return 'unsupported'; }
  }
  async function fallbackFile(file, { title } = {}) {
    if (window.WosChat?.shareFile) return window.WosChat.shareFile(file, { title });
    if (!file || !['[object Blob]', '[object File]'].includes(Object.prototype.toString.call(file)) || file.size > 32 * 1024 * 1024) return 'unsupported';
    const native = window.WizardOSNative;
    if (!framed && typeof native?.shareFile === 'function') {
      let bytes;
      try { bytes = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = reject; reader.readAsDataURL(file); }); } catch (_) { return 'unsupported'; }
      return nativeReceipt(() => native.shareFile(bytes, file.name || 'wizard-file', file.type));
    }
    try { if (navigator.share && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], ...(title ? { title } : {}) }); return 'shared'; } } catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
    return 'unsupported';
  }
  function captureModule() { if (!window.WizAppCapture) throw new Error('Load shared app-capture.js before app-client.js for standalone capture'); return window.WizAppCapture; }
  // A fallback owner is generated, not a raw pathname (capture IDs cannot contain
  // slashes). Capture it once so ordinary in-app route changes do not change owner.
  const standaloneOwner = (() => {
    const root = location.pathname.split('/').filter(Boolean)[0] || 'root';
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(root)) return 'standalone-' + root;
    let hash = 2166136261; for (const c of root) hash = Math.imul(hash ^ c.codePointAt(0), 16777619) >>> 0;
    return 'standalone-' + hash.toString(36);
  })();
  const standaloneId = () => document.documentElement.dataset.app || standaloneOwner;
  function stayBack() {
    if (back()) return;
    // Back never exits Recorder, including browser tabs.
    return;
  }
  function pushStandaloneGuard() {
    // A guard protects the current domain entry; it is not another app route.
    guardBase = history.state?.__wizardApp || null;
    guardPush({ ...history.state, __wizardAppGuard: true }, ''); guarded = true;
  }
  function armStandalone() {
    if (framed || !detached() || Date.now() < exitUntil) return;
    if ('CloseWatcher' in window && !rootWatcher) {
      rootWatcher = new CloseWatcher(); rootWatcher.onclose = () => { rootWatcher = null; stayBack(); setTimeout(armStandalone, 0); };
    }
    if (!guarded && navigator.userActivation?.isActive) {
      pushStandaloneGuard();
    }
  }
  if (!framed) {
    document.addEventListener('pointerdown', armStandalone, true);
    addEventListener('popstate', e => {
      if (Date.now() < exitUntil) { history.back(); return; }
      guarded = !!e.state?.__wizardAppGuard;
      const mark = e.state?.__wizardApp;
      const rootGuard = !guarded && mark && guardBase && mark.id === guardBase.id && mark.index === guardBase.index && standaloneIsRoot?.();
      if (mark && !rootGuard) {
        // Let the router finish its one domain step, then protect a newly reached
        // root even when the next Back comes without another pointer gesture.
        setTimeout(() => { if (!guarded && !exitUntil && detached() && standaloneIsRoot?.()) pushStandaloneGuard(); }, 0);
        return;
      }
      stayBack(); if (!exitUntil) pushStandaloneGuard();
    });
  }
  const sharedResult = promise => promise.then(value => ['shared', 'copied', 'cancelled', 'unsupported'].includes(value) ? value : 'unsupported', () => 'unsupported');
  window.WizardApp = Object.freeze({ version: VERSION, get hosted() { return !!service || transportReady; }, ready,
    identity: Object.freeze({
      info: () => framed ? request('identity.info') : Promise.resolve({ unavailable: true }),
      sign: event => framed ? request('identity.sign', { event }, 190000) : Promise.resolve({ unavailable: true }),
      nip44_encrypt: args => framed ? request('identity.nip44_encrypt', args, 190000) : Promise.resolve({ unavailable: true }),
      nip44_decrypt: args => framed ? request('identity.nip44_decrypt', args, 190000) : Promise.resolve({ unavailable: true }),
    }),
    voiceInput, conversation: voiceInput, // backwards-compatible name, identical receiver/authority
    back: Object.freeze({ register, push, useHistory }),
    view: Object.freeze({ isVisible: () => !document.hidden && (!framed || service?.view?.isVisible() === true) }),
    nav: Object.freeze({ get threadAgents() { return service?.nav?.threadAgents === true; }, openThread: (id, opts) => service?.nav?.openThread(id, opts) === true, openContextDraft: data => { if (!service?.nav?.openContextDraft) throw new Error('Context drafts need the verified Wizard host'); return service.nav.openContextDraft(data); } }),
    theme: Object.freeze({ get: () => currentTheme || window.WizardTheme?.current || null, onChange: fn => listen(themes, fn, currentTheme || window.WizardTheme?.current) }),
    voice: Object.freeze({ transcribe: (file, opts = {}) => service?.voice ? service.voice.transcribe(file, opts) : transportReady ? request('voice.transcribe', { file, language: opts.language }, 180000) : Promise.resolve({ unavailable: true }) }),
    share: Object.freeze({ get wizard() { return service?.share?.wizard ? data => service.share.wizard(data) : transportReady ? data => request('share.wizard', data, 600000) : undefined; }, text: data => service ? service.share.text(data) : transportReady ? sharedResult(request('share.text', data)) : fallbackText(data), file: (file, opts) => service ? service.share.file(file, opts) : transportReady ? sharedResult(request('share.file', { file, options: opts })) : fallbackFile(file, opts),
      receive: receiveShares, targets: shareTargets, check: () => pullShares() }),
    titlebar: Object.freeze({ set: (tools, onTool) => { toolHandler = typeof onTool === 'function' ? onTool : null; return service ? Promise.resolve(service.titlebar.set(tools)) : transportReady ? request('titlebar.set', { tools }).then(v => v === true, () => false) : Promise.resolve(false); },
      shown: () => { try { return !!service?.titlebar.shown(); } catch (_) { return false; } } }),
    /* The agent orb as this app's main button (two-orb layout): claim({ icon, label }, onTap) puts the icon on the orb
     * in this app's colour while the app is in front; tap runs onTap, hold still picks an agent. Resolves true when
     * the host shows it (the app then hides its own button), false when there is no orb to claim. */
    orb: Object.freeze({
      claim: (spec, onTap) => { orbHandler = typeof onTap === 'function' ? onTap : null; return service?.orb ? Promise.resolve(service.orb.set(spec)) : transportReady ? request('orb.set', { spec }).then(v => v === true, () => false) : Promise.resolve(false); },
      release: () => { orbHandler = null; return service?.orb ? Promise.resolve(service.orb.set(null)) : transportReady ? request('orb.set', { spec: null }).then(() => true, () => false) : Promise.resolve(false); },
      shown: () => { try { return !!service?.orb?.shown(); } catch (_) { return false; } },
    }),
    /* Lower Wizard Music while this app plays something short (a voice note); duck(false) restores it. */
    audio: Object.freeze({ duck: on => service?.audio ? Promise.resolve(service.audio.duck(!!on)).then(v => v === true, () => false) : transportReady ? request('audio.duck', { on: !!on }).then(v => v === true, () => false) : Promise.resolve(false) }),

    /* Fingerprint vault (Wizard OS Android app): keep one small secret for this app on the phone, behind the
     * fingerprint. has() -> {available, saved}; seal(secret, title) and open(title) show the fingerprint prompt;
     * errors carry .code (cancelled, unavailable, not_saved, invalidated, busy, failed). */
    vault: Object.freeze((() => {
      const call = (op, args) => service?.vault ? service.vault[op.slice(6)](...(op === 'vault.seal' ? [args.secret, args.title] : [args?.title]))
        : transportReady ? request(op, args, 130000).catch(e => { throw Object.assign(new Error(String(e.message).replace(/^vault:/, '')), { code: String(e.message).startsWith('vault:') ? String(e.message).slice(6) : 'unavailable' }); })
        : Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }));
      return {
        has: () => call('vault.has').catch(() => ({ available: false, saved: false })),
        seal: (secret, title) => call('vault.seal', { secret, title }),
        open: title => call('vault.open', { title }).then(r => r.secret),
        forget: () => call('vault.forget').catch(() => ({ saved: false })),
      };
    })()),
    badge: Object.freeze({ set: n => service ? service.badge.set(n) : transportReady ? request('badge.set', { n }).then(() => true, () => false) : Promise.resolve(false) }),
    update: Object.freeze({ hold, onAvailable: fn => listen(updates, fn, updateAvailable || service?.update.available()) }),
    capture: Object.freeze({ start: async opts => { if (['auto', 'command'].includes(opts?.kind)) throw new Error('Capture kind is reserved for Wizard voice; use audio/meeting and task metadata'); if (service) return service.capture.start(opts); if (framed) throw new Error('Shared capture needs the verified synchronous host connection'); const resource=captureModule(); return opts?.resumeId && resource.resume ? resource.resume(standaloneId(),opts.resumeId,opts) : resource.start(standaloneId(), opts); },
      prepare: opts => { if(service) return service.capture.prepare(opts); if(framed) throw new Error('Capture preparation needs the verified host connection'); return captureModule().prepare(standaloneId(),opts); },
      capabilities: opts => { if(service) return service.capture.capabilities(opts); if(framed) return {}; return captureModule().capabilities(opts); },
      current: () => { if(service) return service.capture.current(); if(framed) return null; return captureModule().current(standaloneId()); },
      pending: async () => service ? service.capture.pending() : transportReady ? request('capture.pending') : captureModule().pending(standaloneId()), ack: async id => service ? service.capture.ack(id) : transportReady ? request('capture.ack', { id }) : captureModule().ack(standaloneId(), id) }),
  });
  ready();
})();
