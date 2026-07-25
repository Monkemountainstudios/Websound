(() => {
  "use strict";

  const CONFIG = {
    fade: {
      masterIn: 8,
      masterOut: 8,
      sporadicCrossfade: 10,
      frequentCrossfade: 7,
      drumIn: 7,
      drumOut: 9
    },
    evolution: {
      sporadic: { min: 20, max: 50 },
      frequent: { min: 10, max: 35 }
    },
    normalLayers: [
      { name: "pad", folder: "pad", prefix: "pad", count: 4, volume: 0.28 },
      { name: "noise", folder: "noise", prefix: "noise", count: 4, volume: 0.19 },
      { name: "bass",   folder: "bass",   prefix: "bass",   count: 4, volume: 0.24 },
      { name: "melody", folder: "melody", prefix: "melody", count: 4, volume: 0.23 },
      { name: "misc", folder: "misc", prefix: "misc", count: 4, volume: 0.18 }
    ],
    drumLayer: {
      name: "drums",
      folder: "drums",
      prefix: "drum",
      count: 4,
      volume: 0.17,
      chance: { sporadic: 0.12, frequent: 0.20 },
      activeFor: {
        sporadic: { min: 35, max: 80 },
        frequent: { min: 30, max: 65 }
      }
    }
  };

  const ui = {
    on: document.getElementById("onButton"),
    off: document.getElementById("offButton"),
    sporadic: document.getElementById("sporadicButton"),
    frequent: document.getElementById("frequentButton"),
    led: document.getElementById("statusLed")
  };

  let audioContext = null;
  let masterGain = null;
  let dryGain = null;
  let convolver = null;
  let wetGain = null;
  let compressor = null;
  let buffers = new Map();
  let voices = new Map();
  let evolutionMode = "sporadic";
  let atmosphereOn = false;
  let initialized = false;
  let initializing = false;
  let evolutionTimer = null;
  let drumStopTimer = null;
  let drumVoice = null;
  let operationToken = 0;

  const randomBetween = (min, max) => min + Math.random() * (max - min);

  function setButtonPair(activeButton, inactiveButton) {
    activeButton.classList.add("active");
    activeButton.setAttribute("aria-pressed", "true");
    inactiveButton.classList.remove("active");
    inactiveButton.setAttribute("aria-pressed", "false");
  }

  function setControlsDisabled(disabled) {
    ui.on.disabled = disabled;
    ui.off.disabled = disabled;
    ui.sporadic.disabled = disabled;
    ui.frequent.disabled = disabled;
  }

  function setLed(state) {
    ui.led.classList.remove("on", "loading");
    if (state) ui.led.classList.add(state);
  }

  function createAudioGraph() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("This browser does not support Web Audio.");

    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0;
    dryGain = audioContext.createGain();
    dryGain.gain.value = 0.82;
    convolver = audioContext.createConvolver();
    convolver.buffer = createSyntheticImpulse(audioContext, 4.8, 2.7);
    wetGain = audioContext.createGain();
    wetGain.gain.value = 0.25;
    compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 18;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.012;
    compressor.release.value = 0.32;

    dryGain.connect(masterGain);
    convolver.connect(wetGain);
    wetGain.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(audioContext.destination);
  }

  function createSyntheticImpulse(context, duration, decay) {
    const length = Math.floor(context.sampleRate * duration);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  function fileCandidates(layer, index) {
    const base = `${layer.folder}/${layer.prefix}${index}`;
    return [`${base}.ogg`, `${base}.mp3`];
  }

  async function loadAudioBuffer(layer, index) {
    const key = `${layer.name}:${index}`;
    let lastError = null;
    for (const url of fileCandidates(layer, index)) {
      try {
        const response = await fetch(url, { cache: "force-cache" });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const decoded = await audioContext.decodeAudioData(await response.arrayBuffer());
        buffers.set(key, decoded);
        return;
      } catch (error) {
        lastError = error;
        console.warn(`Could not load ${url}; trying fallback.`, error);
      }
    }
    throw new Error(`Unable to load ${key}: ${lastError?.message || "unknown error"}`);
  }

  async function loadAllAudio() {
    const jobs = [];
    for (const layer of [...CONFIG.normalLayers, CONFIG.drumLayer]) {
      for (let i = 1; i <= layer.count; i += 1) jobs.push(loadAudioBuffer(layer, i));
    }
    await Promise.all(jobs);
  }

  function chooseIndex(layer, avoidIndex = null) {
    const choices = [];
    for (let i = 1; i <= layer.count; i += 1) {
      if (i !== avoidIndex || layer.count === 1) choices.push(i);
    }
    return choices[Math.floor(Math.random() * choices.length)];
  }

  function createVoice(layer, index, initialGain = 0) {
    const buffer = buffers.get(`${layer.name}:${index}`);
    if (!buffer) throw new Error(`Missing buffer ${layer.name}:${index}`);
    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = initialGain;
    source.connect(gain);
    gain.connect(dryGain);
    gain.connect(convolver);
    source.start(0, Math.random() * Math.max(0.001, buffer.duration));
    return { layer, index, source, gain, stopped: false };
  }

  function rampGain(param, target, seconds) {
    const now = audioContext.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + seconds);
  }

  function stopVoiceAfter(voice, seconds) {
    if (!voice || voice.stopped) return;
    voice.stopped = true;
    window.setTimeout(() => {
      try { voice.source.stop(); } catch (_) {}
      try { voice.source.disconnect(); voice.gain.disconnect(); } catch (_) {}
    }, Math.ceil(seconds * 1000) + 150);
  }

  function beginInitialVoices() {
    for (const layer of CONFIG.normalLayers) {
      const index = chooseIndex(layer);
      voices.set(layer.name, createVoice(layer, index, layer.volume));
    }
  }

  function replaceLayer(layer) {
    if (!atmosphereOn) return;
    const oldVoice = voices.get(layer.name);
    const newVoice = createVoice(layer, chooseIndex(layer, oldVoice?.index), 0);
    const fade = evolutionMode === "sporadic"
      ? CONFIG.fade.sporadicCrossfade
      : CONFIG.fade.frequentCrossfade;
    voices.set(layer.name, newVoice);
    rampGain(newVoice.gain.gain, layer.volume, fade);
    if (oldVoice) {
      rampGain(oldVoice.gain.gain, 0, fade);
      stopVoiceAfter(oldVoice, fade);
    }
  }

  function maybeStartDrums() {
    if (!atmosphereOn || drumVoice) return;
    if (Math.random() > CONFIG.drumLayer.chance[evolutionMode]) return;
    const layer = CONFIG.drumLayer;
    drumVoice = createVoice(layer, chooseIndex(layer), 0);
    rampGain(drumVoice.gain.gain, layer.volume, CONFIG.fade.drumIn);
    const range = layer.activeFor[evolutionMode];
    clearTimeout(drumStopTimer);
    drumStopTimer = window.setTimeout(stopDrums, randomBetween(range.min, range.max) * 1000);
  }

  function stopDrums() {
    clearTimeout(drumStopTimer);
    drumStopTimer = null;
    if (!drumVoice) return;
    const old = drumVoice;
    drumVoice = null;
    rampGain(old.gain.gain, 0, CONFIG.fade.drumOut);
    stopVoiceAfter(old, CONFIG.fade.drumOut);
  }

  function scheduleNextEvolution() {
    clearTimeout(evolutionTimer);
    if (!atmosphereOn) return;
    const range = CONFIG.evolution[evolutionMode];
    evolutionTimer = window.setTimeout(() => {
      if (!atmosphereOn) return;
      const layer = CONFIG.normalLayers[Math.floor(Math.random() * CONFIG.normalLayers.length)];
      replaceLayer(layer);
      maybeStartDrums();
      scheduleNextEvolution();
    }, randomBetween(range.min, range.max) * 1000);
  }

  async function initialize() {
    if (initialized || initializing) return;
    initializing = true;
    setControlsDisabled(true);
    setLed("loading");
    try {
      createAudioGraph();
      await loadAllAudio();
      beginInitialVoices();
      initialized = true;
    } catch (error) {
      console.error(error);
      setLed(null);
      alert("The atmosphere could not start. Check the audio folders and filenames, then reload.");
      throw error;
    } finally {
      initializing = false;
      setControlsDisabled(false);
    }
  }

  async function turnOn() {
    if (atmosphereOn || initializing) return;
    const token = ++operationToken;
    try {
      await initialize();
      if (token !== operationToken) return;
      await audioContext.resume();
      atmosphereOn = true;
      setButtonPair(ui.on, ui.off);
      setLed("on");
      rampGain(masterGain.gain, 0.72, CONFIG.fade.masterIn);
      scheduleNextEvolution();
    } catch (_) {
      setButtonPair(ui.off, ui.on);
    }
  }

  function turnOff() {
    ++operationToken;
    setButtonPair(ui.off, ui.on);
    setLed(null);
    if (!initialized || !audioContext || !atmosphereOn) {
      atmosphereOn = false;
      return;
    }
    atmosphereOn = false;
    clearTimeout(evolutionTimer);
    evolutionTimer = null;
    stopDrums();
    rampGain(masterGain.gain, 0, CONFIG.fade.masterOut);
    const context = audioContext;
    window.setTimeout(async () => {
      if (!atmosphereOn && context.state === "running") {
        try { await context.suspend(); } catch (error) { console.warn(error); }
      }
    }, CONFIG.fade.masterOut * 1000 + 120);
  }

  function setEvolution(mode) {
    evolutionMode = mode;
    if (mode === "sporadic") setButtonPair(ui.sporadic, ui.frequent);
    else setButtonPair(ui.frequent, ui.sporadic);
    if (atmosphereOn) scheduleNextEvolution();
  }

  ui.on.addEventListener("click", turnOn);
  ui.off.addEventListener("click", turnOff);
  ui.sporadic.addEventListener("click", () => setEvolution("sporadic"));
  ui.frequent.addEventListener("click", () => setEvolution("frequent"));
})();
