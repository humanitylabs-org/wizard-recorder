// App-owned, local-only check of the ALREADY-LOADED shell. No recovery, native
// requests, storage access, transport, eval, or reload. Unknown truth stays unknown.
const REASONS = new Set(['native_owner_uncertain', 'device_recording',
  'capture_custody_uncertain', 'capture_starting', 'microphone_loan', 'capture']);
const ERRORS = new Set(['native_owner_uncertain', 'native_bridge_owned', 'native_claim_pending',
  'native_recovery_failed', 'native_timeout', 'native_read_failed', 'storage_failed', 'storage_full',
  'storage_limit', 'storage_unavailable', 'storage_blocked', 'capture_lock_unavailable',
  'native_start_failed', 'native_stop_failed', 'native_unavailable', 'permission_denied', 'pcm_unavailable',
  'busy', 'start_timeout', 'start_abandoned', 'recovery_yielded',
  'AbortError', 'InvalidStateError', 'NotAllowedError', 'NotFoundError', 'NotReadableError',
  'QuotaExceededError', 'SecurityError', 'UnknownError', 'VersionError']);
const errorCode = value => typeof value === 'string' && ERRORS.has(value) ? value : 'unclassified';

export function readReloadCheck(host, now = () => performance.now()) {
  const start = now();
  let reason = 'shell_unavailable', error = 'none';
  try {
    // Direct parent only: a standalone tab or unrelated frame cannot diagnose the
    // old shell and must not install a second recorder to manufacture an answer.
    const capture = host?.WizAppCapture;
    if (typeof capture?.reloadCheck === 'function' && typeof capture?.getState === 'function') {
      const check = capture.reloadCheck();
      reason = REASONS.has(check?.reason) ? check.reason : check?.safe === true ? 'allowed_now' : 'unclassified';
      // Never serialize the state/check objects: they can contain private take IDs.
      const code = capture.getState()?.error;
      if (code != null) error = errorCode(code);
    }
  } catch (e) {
    reason = 'check_threw';
    error = errorCode(e?.code ?? e?.name);
  }
  const elapsedMs = Math.min(60000, Math.max(0, Math.round(now() - start)));
  return Object.freeze({ reason, error, elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0 });
}

export function showReloadCheck(win = window) {
  // Normal app handshake for live Appearance/Back; no share receiver, capture,
  // update hold or other resource is registered by this read-only view.
  void win.WizardApp?.ready?.({ name: 'Recorder reload check' })?.catch(() => {});
  const output = win.document.querySelector('[data-reload-check-result]');
  const button = win.document.querySelector('[data-reload-check]');
  const check = () => {
    let host;
    try { if (win.parent !== win && win.parent.location.origin === win.location.origin) host = win.parent; } catch (_) { /* stay unavailable */ }
    const result = readReloadCheck(host);
    output.textContent = `Reason: ${result.reason}\nCode: ${result.error}\nTime: ${result.elapsedMs} ms`;
  };
  button.addEventListener('click', check);
  check();
}
if (typeof window !== 'undefined' && window.document?.querySelector('[data-reload-check-result]')) showReloadCheck();
