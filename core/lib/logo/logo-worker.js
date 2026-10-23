/**
 * core/lib/logo/logo-worker.js
 *
 * Hand-written Worker entry point for the wiki's Logo and TPN code cells. Runs in a dedicated Worker;
 * core/lively/identity/LogoWorker.js owns exactly one per wiki page (every logo and tpn cell on the page will share its
 * interpreter, LOGO.md decision 1).
 *
 * PHASE 0 STUB (LOGO.md section 10): there is no engine yet. The worker answers the protocol below so the whole
 * cell -> controller -> worker path can be exercised, and every `run` finishes at once with one error segment saying Logo
 * is not built yet. Phase 1 replaces this file's body with the real engine (a committed bundle, logo-engine.js, defining
 * LogoEngine, loaded with importScripts as ml-worker.js does for MLEngine) and a time-sliced job loop; the protocol stays.
 * Do not add engine behaviour here: it belongs in core/lib/logo/src and is exercised by tests/logo.
 *
 * Protocol (postMessage, plain JSON-able objects), the same as ml-worker.js (LOGO.md 7.1; the `draw` and `screen` ops
 * arrive with Phase 2 and Phase 6):
 *   in:  {op:'init'}
 *   out: {op:'init', ok:true, buildId} | {op:'init', ok:false, error}
 *   in:  {id, op:'run', source}
 *   out: {id, op:'segments', segments:[{kind, text, ...}]}   (zero or more; new output since the last message)
 *        {id, op:'done', state, segments:[...]}              (state: done | error | stopped | exit)
 *   in:  {op:'interrupt'}                                    (cooperative; nothing can be running in the stub)
 *   in:  {op:'reset'}                                        (fresh interpreter; the worker stays alive)
 *   out: {op:'reset', ok:true}
 */

'use strict';

var BUILD_ID = 'phase0-stub';
var NOT_BUILT = "Logo isn't built yet. This cell type is registered, but its interpreter arrives in a later phase.";

onmessage = function (evt) {
  var msg = evt.data;
  switch (msg.op) {
    case 'init':
      postMessage({ op: 'init', ok: true, buildId: BUILD_ID });
      break;
    case 'run':
      postMessage({ id: msg.id, op: 'done', state: 'error', segments: [{ kind: 'error', errorClass: 'not built', text: NOT_BUILT }] });
      break;
    case 'interrupt':
      break;
    case 'reset':
      postMessage({ op: 'reset', ok: true });
      break;
  }
};
