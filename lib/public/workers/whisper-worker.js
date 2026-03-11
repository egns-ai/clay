// Whisper WASM Web Worker
// Loads whisper.cpp Emscripten build and runs inference off main thread
// Requires COOP/COEP headers for SharedArrayBuffer

var instance = null;
var printBuffer = [];

function log(msg) {
  self.postMessage({ type: 'log', text: '[worker] ' + msg });
}

// Shared output function — Emscripten captures this once at load time,
// so we must always push to the SAME array reference
function captureOutput(text) {
  printBuffer.push(text);
  log('captureOutput(' + printBuffer.length + '): ' + (text.length > 80 ? text.slice(0, 80) + '...' : text));
}

// --- Message handler ---
self.onmessage = function(e) {
  var msg = e.data;

  if (msg.type === 'init') {
    initWhisper(msg.mainJsUrl, msg.modelData);
  } else if (msg.type === 'transcribe') {
    transcribe(msg.audio, msg.lang, msg.nthreads, msg.tailDuration);
  }
};

// --- Pre-allocate pthread worker pool ---
function preallocPthreadPool(count) {
  var PThread = Module.PThread || (typeof globalThis !== 'undefined' && globalThis.PThread);

  log('preallocPthreadPool: Module.PThread=' + !!Module.PThread + ', globalThis.PThread=' + !!(typeof globalThis !== 'undefined' && globalThis.PThread));

  if (!PThread) {
    log('No PThread object found — skipping pool');
    return Promise.resolve();
  }

  log('PThread keys: ' + Object.keys(PThread).join(', '));
  log('PThread.unusedWorkers.length=' + PThread.unusedWorkers.length + ', runningWorkers.length=' + PThread.runningWorkers.length);

  var promises = [];
  for (var i = PThread.unusedWorkers.length; i < count; i++) {
    log('Allocating worker ' + (i + 1) + '/' + count);
    PThread.allocateUnusedWorker();
    var w = PThread.unusedWorkers[PThread.unusedWorkers.length - 1];
    log('Worker allocated, loading WASM module...');
    promises.push(PThread.loadWasmModuleToWorker(w));
  }

  if (promises.length === 0) {
    log('Pool already has ' + PThread.unusedWorkers.length + ' workers, no allocation needed');
    return Promise.resolve();
  }

  return Promise.all(promises).then(function() {
    log('Pthread pool READY: ' + PThread.unusedWorkers.length + ' unused, ' + PThread.runningWorkers.length + ' running');
  }).catch(function(err) {
    log('Pthread pool FAILED: ' + err.message + '\n' + err.stack);
  });
}

// --- Init: load WASM engine + model ---
function initWhisper(mainJsUrl, modelData) {
  log('initWhisper: url=' + mainJsUrl + ', modelData.byteLength=' + modelData.byteLength);
  try {
    self.Module = {
      print: captureOutput,
      printErr: captureOutput,
      setStatus: function(s) { log('Module.setStatus: ' + s); },
      monitorRunDependencies: function(left) { log('Module.monitorRunDependencies: ' + left); },
      mainScriptUrlOrBlob: mainJsUrl
    };

    log('Calling importScripts...');
    self.postMessage({ type: 'status', text: 'Loading Whisper engine...' });
    importScripts(mainJsUrl);
    log('importScripts done');
  } catch (err) {
    log('importScripts FAILED: ' + err.message);
    self.postMessage({ type: 'error', error: 'Failed to load Whisper WASM: ' + err.message });
    return;
  }

  // Check what's available after importScripts
  log('After importScripts: Module.init=' + typeof Module.init + ', Module.full_default=' + typeof Module.full_default);
  log('After importScripts: Module.PThread=' + !!Module.PThread + ', globalThis.PThread=' + !!(typeof globalThis !== 'undefined' && globalThis.PThread));
  log('SharedArrayBuffer=' + (typeof SharedArrayBuffer !== 'undefined') + ', crossOriginIsolated=' + (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'N/A'));

  // Poll for Emscripten runtime to be ready (WASM compilation is async)
  var attempts = 0;
  var timer = setInterval(function() {
    attempts++;
    if (Module.init && typeof Module.init === 'function') {
      clearInterval(timer);
      log('Emscripten ready after ' + attempts + ' polls (' + (attempts * 50) + 'ms)');
      log('Module keys: ' + Object.keys(Module).slice(0, 30).join(', '));
      log('Module.PThread=' + !!Module.PThread + ', globalThis.PThread=' + !!(typeof globalThis !== 'undefined' && globalThis.PThread));
      loadModel(modelData);
    } else if (attempts > 200) {
      clearInterval(timer);
      log('TIMEOUT waiting for Emscripten runtime');
      self.postMessage({ type: 'error', error: 'Whisper WASM initialization timed out' });
    }
  }, 50);
}

// --- Store model in WASM FS and init ---
function loadModel(modelData) {
  try {
    self.postMessage({ type: 'status', text: 'Initializing model...' });

    var buf = new Uint8Array(modelData);
    log('Model data: ' + buf.byteLength + ' bytes');
    try { Module.FS_unlink('whisper.bin'); } catch (e) { /* ignore */ }
    Module.FS_createDataFile('/', 'whisper.bin', buf, true, true);

    log('Calling Module.init("whisper.bin")...');
    instance = Module.init('whisper.bin');
    log('Module.init returned: ' + instance);

    if (!instance) {
      self.postMessage({ type: 'error', error: 'Failed to initialize Whisper model' });
      return;
    }

    // Clear init output before pool alloc
    var initOutput = printBuffer.slice();
    log('Init output (' + initOutput.length + ' lines): ' + JSON.stringify(initOutput.slice(0, 5)));
    printBuffer.length = 0;

    // Pre-allocate pthread pool, then signal ready
    preallocPthreadPool(8).then(function() {
      printBuffer.length = 0;
      log('Sending ready signal');
      self.postMessage({ type: 'ready' });
    });
  } catch (err) {
    log('loadModel FAILED: ' + err.message + '\n' + err.stack);
    self.postMessage({ type: 'error', error: 'Model init failed: ' + err.message });
  }
}

// --- Wait for inference to complete ---
// In pthreads mode, full_default dispatches to workers and returns immediately.
// We detect completion by checking for "total time" in printBuffer output,
// which whisper_print_timings writes at the very end of inference.
function waitForInferenceComplete(callback) {
  // Check if already complete (single-thread mode)
  if (hasTimingOutput()) {
    log('waitForInference: already complete (sync mode)');
    callback();
    return;
  }

  var pollCount = 0;
  var maxPolls = 3000; // 30 seconds max
  var timer = setInterval(function() {
    pollCount++;

    if (pollCount % 100 === 0) {
      log('waitForInference poll #' + pollCount + ': printBuffer=' + printBuffer.length);
    }

    if (hasTimingOutput()) {
      clearInterval(timer);
      log('waitForInference DONE after ' + (pollCount * 10) + 'ms, printBuffer=' + printBuffer.length);
      callback();
    } else if (pollCount >= maxPolls) {
      clearInterval(timer);
      log('waitForInference TIMEOUT, printBuffer=' + printBuffer.length);
      callback();
    }
  }, 10);
}

function hasTimingOutput() {
  for (var i = printBuffer.length - 1; i >= 0; i--) {
    if (printBuffer[i].indexOf('total time') !== -1) return true;
  }
  return false;
}

// --- Reinit whisper state to reset accumulated fallbacks ---
function reinitState() {
  if (!instance) return;
  var t0 = performance.now();
  Module.free(instance);
  instance = Module.init('whisper.bin');
  var elapsed = performance.now() - t0;
  log('reinitState: new instance=' + instance + ' in ' + elapsed.toFixed(1) + 'ms');
}

// --- Run inference ---
function transcribe(audio, lang, nthreads, tailDuration) {
  if (!instance) {
    self.postMessage({ type: 'error', error: 'Whisper not initialized' });
    return;
  }

  // Reinit state each call to prevent fallback counter accumulation
  reinitState();

  var PThread = Module.PThread || globalThis.PThread;

  log('=== transcribe START ===');
  log('audio.length=' + audio.length + ' (' + (audio.length / 16000).toFixed(1) + 's), lang=' + lang + ', nthreads=' + nthreads);

  if (PThread) {
    log('PThread BEFORE: unused=' + PThread.unusedWorkers.length + ', running=' + PThread.runningWorkers.length);
  }

  // Clear buffer
  printBuffer.length = 0;

  var t0 = performance.now();
  var ret;
  try {
    log('Calling Module.full_default(instance=' + instance + ', audio.len=' + audio.length + ', lang=' + (lang || 'en') + ', nthreads=' + (nthreads || 1) + ', translate=false)');
    ret = Module.full_default(instance, audio, lang || 'en', nthreads || 1, false);
  } catch (err) {
    log('full_default THREW: ' + err.message + '\n' + err.stack);
    self.postMessage({ type: 'error', error: 'Transcription failed: ' + err.message });
    return;
  }
  var elapsed = performance.now() - t0;

  log('full_default returned: ' + ret + ' in ' + elapsed.toFixed(1) + 'ms, printBuffer=' + printBuffer.length);

  if (PThread) {
    log('PThread AFTER: unused=' + PThread.unusedWorkers.length + ', running=' + PThread.runningWorkers.length);
  }

  var totalDur = audio.length / 16000;
  waitForInferenceComplete(function() {
    log('Inference complete callback: printBuffer.length=' + printBuffer.length);
    // Extra yield for any remaining proxied print messages
    setTimeout(function() {
      log('Final: printBuffer.length=' + printBuffer.length);
      log('=== transcribe END ===');
      self.postMessage({
        type: 'result',
        lines: printBuffer.slice(),
        totalDuration: totalDur,
        tailDuration: tailDuration || 0
      });
    }, 50);
  });
}
