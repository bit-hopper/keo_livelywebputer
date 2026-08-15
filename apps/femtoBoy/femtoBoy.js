// femtoBoy — browser glue around the gambatte-core WASM build (wasm/gambatte.js).
// Handles ROM loading, the emulation/render loop, keyboard input, audio via
// an AudioWorklet, and IDBFS-backed save state persistence.
(function () {
  'use strict';

  var SCREEN_W = 160, SCREEN_H = 144;
  var SAMPLE_RATE = 44100;
  var SAMPLES_PER_FRAME = Math.round(SAMPLE_RATE / 60);
  var SAVE_DIR = '/saves';
  var GAMES = [
    { name: 'HimesQuest', file: 'games/HimesQuest.gb' }
  ];

  var canvas = document.getElementById('screen');
  var ctx = canvas.getContext('2d');
  var dropHint = document.getElementById('dropHint');
  var screenWrap = document.getElementById('screenWrap');
  var romInput = document.getElementById('romInput');
  var saveStateBtn = document.getElementById('saveStateBtn');
  var loadStateBtn = document.getElementById('loadStateBtn');
  var muteBtn = document.getElementById('muteBtn');
  var statusEl = document.getElementById('status');
  var gamesBtn = document.getElementById('gamesBtn');
  var gamesMenu = document.getElementById('gamesMenu');

  var Module = null;
  var fn = {}; // cwrap'd native functions
  var drawBuf = new ArrayBuffer(SCREEN_W * SCREEN_H * 4);
  var drawClamped = new Uint8ClampedArray(drawBuf);
  var drawU32 = new Uint32Array(drawBuf);
  var romLoaded = false;
  var saveKey = null; // sanitized rom name used as the save-state filename
  var romBufPtr = null;
  var audioSamplesPtr = null;
  var running = false;

  var audioCtx = null;
  var audioNode = null;
  var muted = false;

  var KEY_MAP = {
    'ArrowUp': 4,    // BTN_Up
    'ArrowDown': 5,  // BTN_Down
    'ArrowLeft': 6,  // BTN_Left
    'ArrowRight': 7, // BTN_Right
    'KeyX': 0,       // BTN_A
    'KeyZ': 1,       // BTN_B
    'Tab': 2,        // BTN_Sel
    'Enter': 3       // BTN_Start
  };

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function sanitizeName(name) {
    return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  }

  function setupFS() {
    Module.FS.mkdir(SAVE_DIR);
    Module.FS.mount(Module.FS.filesystems.IDBFS, {}, SAVE_DIR);
    return new Promise(function (resolve) {
      Module.FS.syncfs(true, function (err) {
        if (err) console.error('femtoBoy: initial IDBFS sync failed', err);
        resolve();
      });
    });
  }

  function persistFS(cb) {
    Module.FS.syncfs(false, function (err) {
      if (err) console.error('femtoBoy: IDBFS persist failed', err);
      if (cb) cb();
    });
  }

  function bindNativeFns() {
    fn.init = Module.cwrap('init', null, ['number', 'number']);
    fn.frame = Module.cwrap('frame', null, []);
    fn.framebuffer = Module.cwrap('framebuffer', 'number', []);
    fn.setKey = Module.cwrap('set_key', null, ['number', 'number']);
    fn.dumpState = Module.cwrap('dump_state', null, ['string']);
    fn.loadState = Module.cwrap('load_state', null, ['string']);
    fn.apuSampleVariable = Module.cwrap('apu_sample_variable', 'number', ['number', 'number']);
  }

  function loadRom(bytes, name) {
    if (romBufPtr) {
      Module._free(romBufPtr);
      romBufPtr = null;
    }
    var ptr = Module._malloc(bytes.length);
    Module.HEAPU8.set(bytes, ptr);
    fn.init(ptr, bytes.length);
    Module._free(ptr);

    saveKey = sanitizeName(name);
    romLoaded = true;
    dropHint.classList.add('hidden');
    saveStateBtn.disabled = false;
    loadStateBtn.disabled = false;
    setStatus('Loaded ' + name);

    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  }

  function handleFile(file) {
    if (!file) return;
    file.arrayBuffer().then(function (buf) {
      loadRom(new Uint8Array(buf), file.name);
    });
  }

  function loadGame(game) {
    fetch(game.file).then(function (resp) {
      return resp.arrayBuffer();
    }).then(function (buf) {
      loadRom(new Uint8Array(buf), game.name + '.gb');
    }).catch(function (err) {
      console.error('femtoBoy: failed to load game', game, err);
      setStatus('Failed to load ' + game.name + '.');
    });
  }

  function populateGamesMenu() {
    GAMES.forEach(function (game) {
      var btn = document.createElement('button');
      btn.textContent = game.name;
      btn.addEventListener('click', function () {
        gamesMenu.classList.add('hidden');
        loadGame(game);
      });
      gamesMenu.appendChild(btn);
    });
  }
  populateGamesMenu();

  gamesBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    gamesMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', function () {
    gamesMenu.classList.add('hidden');
  });

  function drawFrame() {
    // The core's framebuffer packs pixels as R,G,B,<unused> (unused byte is
    // always 0), so a direct ImageData view renders fully transparent.
    // Force alpha to opaque while copying into our own stable output buffer.
    var ptr = fn.framebuffer();
    var src = new Uint32Array(Module.HEAPU8.buffer, ptr, SCREEN_W * SCREEN_H);
    for (var i = 0; i < drawU32.length; i++) {
      drawU32[i] = src[i] | 0xff000000;
    }
    ctx.putImageData(new ImageData(drawClamped, SCREEN_W, SCREEN_H), 0, 0);
  }

  function pumpAudio() {
    if (!audioNode) return;
    var count = fn.apuSampleVariable(audioSamplesPtr, SAMPLES_PER_FRAME);
    if (count <= 0) return;
    var view = new Int16Array(Module.HEAP16.buffer, audioSamplesPtr, count);
    var copy = new Int16Array(count);
    copy.set(view);
    audioNode.port.postMessage({ type: 'samples', samples: copy }, [copy.buffer]);
  }

  function tick() {
    if (!running) return;
    fn.frame();
    drawFrame();
    pumpAudio();
    requestAnimationFrame(tick);
  }

  function initAudio() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioSamplesPtr = Module._malloc(SAMPLES_PER_FRAME * 2 * 4); // headroom
    return audioCtx.audioWorklet.addModule('audio-worklet.js').then(function () {
      audioNode = new AudioWorkletNode(audioCtx, 'femtoboy-audio-processor');
      audioNode.connect(audioCtx.destination);
    }).catch(function (err) {
      console.error('femtoBoy: audio worklet failed to load, continuing without audio', err);
    });
  }

  function resumeAudioOnGesture() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  romInput.addEventListener('change', function (e) {
    handleFile(e.target.files[0]);
    romInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (evt) {
    screenWrap.addEventListener(evt, function (e) {
      e.preventDefault();
      e.stopPropagation();
    });
  });
  screenWrap.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  document.addEventListener('keydown', function (e) {
    var key = KEY_MAP[e.code];
    if (key === undefined) return;
    e.preventDefault();
    fn.setKey(key, 1);
  });
  document.addEventListener('keyup', function (e) {
    var key = KEY_MAP[e.code];
    if (key === undefined) return;
    e.preventDefault();
    fn.setKey(key, 0);
  });

  saveStateBtn.addEventListener('click', function () {
    if (!romLoaded) return;
    fn.dumpState(SAVE_DIR + '/' + saveKey + '.state');
    persistFS(function () { setStatus('State saved.'); });
  });
  loadStateBtn.addEventListener('click', function () {
    if (!romLoaded) return;
    fn.loadState(SAVE_DIR + '/' + saveKey + '.state');
    setStatus('State loaded.');
  });
  muteBtn.addEventListener('click', function () {
    muted = !muted;
    muteBtn.textContent = muted ? 'Unmute' : 'Mute';
    if (audioNode) audioNode.port.postMessage({ type: 'mute', value: muted });
    resumeAudioOnGesture();
  });
  document.addEventListener('click', resumeAudioOnGesture, { once: true });
  document.addEventListener('keydown', resumeAudioOnGesture, { once: true });

  FemtoBoyModule().then(function (mod) {
    Module = mod;
    bindNativeFns();
    return setupFS();
  }).then(function () {
    return initAudio();
  }).then(function () {
    setStatus('');
  }).catch(function (err) {
    console.error('femtoBoy: init failed', err);
    setStatus('Failed to initialize (see console).');
  });
})();
