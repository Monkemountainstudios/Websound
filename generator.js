(() => {
  "use strict";

  /*
    Silent Machine Generator — Version 2.1

    Added:
    - Fault-tolerant audio loading: one bad file no longer stops the machine
    - Only successfully decoded files are selected for playback
    - Clear console report listing failed files
    - 30 "rareties" files used as occasional rare events
  */

  const CONFIG = {
    fade: {
      masterIn: 10,
      masterOut: 10,
      sporadicCrossfade: 12,
      frequentCrossfade: 9,
      drumIn: 7,
      drumOut: 9,
      glacialCrossfade: 8,
      rarityIn: 5,
      rarityOut: 8
    },

    evolution: {
      normal: {
        sporadic: { min: 18, max: 49 },
        frequent: { min: 7, max: 32 }
      },
      glacial: {
        sporadic: { min: 45, max: 100 },
        frequent: { min: 25, max: 55 }
      }
    },

    glacial: {
      slots: 4
    },

    normalLayers: [
      { name: "pad", folder: "pad", prefix: "pad", count: 11, volume: 0.24 },
      { name: "noise", folder: "noise", prefix: "noise", count: 13, volume: 0.17 },
      { name: "bass", folder: "bass", prefix: "bass", count: 11, volume: 0.17 },
      { name: "melody", folder: "melody", prefix: "melody", count: 14, volume: 0.23 },
      { name: "misc", folder: "misc", prefix: "misc", count: 16, volume: 0.18 }
    ],

    drumLayer: {
      name: "drums",
      folder: "drums",
      prefix: "drum",
      count: 7,
      volume: 0.17,
      chance: { sporadic: 0.12, frequent: 0.20 },
      activeFor: {
        sporadic: { min: 25, max: 80 },
        frequent: { min: 10, max: 65 }
      }
    },

    rarityLayer: {
      name: "rareties",
      folder: "rareties",
      prefix: "rareties",
      count: 31,
      volume: 0.18,
      chance: { sporadic: 0.055, frequent: 0.085 },
      activeFor: {
        sporadic: { min: 18, max: 55 },
        frequent: { min: 14, max: 42 }
      }
    },

    temporaryLayers: {
      pad: {
        chance: { sporadic: 0.10, frequent: 0.16 },
        volume: 0.15,
        activeFor: {
          sporadic: { min: 45, max: 100 },
          frequent: { min: 30, max: 75 }
        }
      },
      melody: {
        chance: { sporadic: 0.07, frequent: 0.13 },
        volume: 0.12,
        activeFor: {
          sporadic: { min: 30, max: 75 },
          frequent: { min: 25, max: 60 }
        }
      }
    }
  };

  const ui = {
    on: document.getElementById("onButton"),
    off: document.getElementById("offButton"),
    sporadic: document.getElementById("sporadicButton"),
    frequent: document.getElementById("frequentButton"),
    normal: document.getElementById("normalButton"),
    glacial: document.getElementById("glacialButton"),
    evolutionLabel: document.getElementById("evolutionLabel"),
    modeHelp: document.getElementById("modeHelp"),
    led: document.getElementById("statusLed")
  };

  let audioContext = null;
  let masterGain = null;
  let dryGain = null;
  let convolver = null;
  let wetHighpass = null;
  let wetGain = null;
  let compressor = null;

  const buffers = new Map();
  const availableIndexes = new Map();
  const failedFiles = [];

  const voices = new Map();
  const temporaryVoices = new Map();
  const temporaryVoiceTimers = new Map();
  const glacialVoices = [];

  let rarityVoice = null;
  let rarityStopTimer = null;

  let evolutionMode = "sporadic";
  let performanceMode = "normal";
  let atmosphereOn = false;
  let initialized = false;
  let initializing = false;
  let voicesStarted = false;
  let evolutionTimer = null;
  let drumStopTimer = null;
  let drumVoice = null;
  let operationToken = 0;

  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const randomItem = array => array[Math.floor(Math.random() * array.length)];

  function allAudioLayers() {
    return [
      ...CONFIG.normalLayers,
      CONFIG.drumLayer,
      CONFIG.rarityLayer
    ];
  }

  function allSelectableLayers() {
    return [...CONFIG.normalLayers, CONFIG.drumLayer]
      .filter(layer => getAvailableIndexes(layer).length > 0);
  }

  function getAvailableIndexes(layer) {
    return availableIndexes.get(layer.name) || [];
  }

  function setButtonPair(activeButton, inactiveButton) {
    activeButton.classList.add("active");
    activeButton.setAttribute("aria-pressed", "true");
    inactiveButton.classList.remove("active");
    inactiveButton.setAttribute("aria-pressed", "false");
  }

  function setControlsDisabled(disabled) {
    Object.values(ui).forEach(element => {
      if (element instanceof HTMLButtonElement) {
        element.disabled = disabled;
      }
    });
  }

  function refreshLed() {
    ui.led.classList.remove("on", "loading", "glacial");

    if (initializing) {
      ui.led.classList.add("loading");
      return;
    }

    if (atmosphereOn) {
      ui.led.classList.add("on");
      if (performanceMode === "glacial") {
        ui.led.classList.add("glacial");
      }
    }
  }

  function updateModeText() {
    const isGlacial = performanceMode === "glacial";
    ui.evolutionLabel.textContent = isGlacial ? "Glacial Evolution" : "Evolution";
    ui.modeHelp.textContent = isGlacial
      ? "The machine breathes more slowly. Four voices evolve one at a time."
      : "If you experience clicks, pops or other audio glitches, engage Glacial Mode.";
  }

  function createAudioGraph() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("This browser does not support Web Audio.");
    }

    audioContext = new AudioContextClass({ latencyHint: "playback" });

    masterGain = audioContext.createGain();
    masterGain.gain.value = 0;

    dryGain = audioContext.createGain();
    dryGain.gain.value = 0.82;

    convolver = audioContext.createConvolver();
    convolver.buffer = createSyntheticImpulse(audioContext, 5.8, 2.2);
    
    wetHighpass = audioContext.createBiquadFilter();
    wetHighpass.type = "highpass";
    wetHighpass.frequency.value = 200;
    wetHighpass.Q.value = 0.7;
    
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
    wetHighpass.connect(wetGain);
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
        data[i] =
          (Math.random() * 2 - 1) *
          Math.pow(1 - i / length, decay);
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
    const attempted = [];
    let lastError = null;

    for (const url of fileCandidates(layer, index)) {
      attempted.push(url);

      try {
        const response = await fetch(url, { cache: "no-cache" });

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();

        if (arrayBuffer.byteLength === 0) {
          throw new Error("Empty audio file");
        }

        const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));

        if (!decoded || decoded.duration <= 0) {
          throw new Error("Audio decoded with no playable duration");
        }

        buffers.set(key, decoded);

        if (!availableIndexes.has(layer.name)) {
          availableIndexes.set(layer.name, []);
        }
        availableIndexes.get(layer.name).push(index);

        return {
          ok: true,
          key,
          url,
          duration: decoded.duration
        };
      } catch (error) {
        lastError = error;
        console.warn(`Could not load or decode ${url}.`, error);
      }
    }

    const failure = {
      ok: false,
      key,
      attempted,
      error: lastError?.message || "Unknown error"
    };

    failedFiles.push(failure);
    return failure;
  }

  async function loadAllAudio() {
    buffers.clear();
    availableIndexes.clear();
    failedFiles.length = 0;

    const jobs = [];

    for (const layer of allAudioLayers()) {
      for (let index = 1; index <= layer.count; index += 1) {
        jobs.push(loadAudioBuffer(layer, index));
      }
    }

    const results = await Promise.allSettled(jobs);

    for (const indexes of availableIndexes.values()) {
      indexes.sort((a, b) => a - b);
    }

    const loadedCount = results.filter(
      result => result.status === "fulfilled" && result.value?.ok
    ).length;

    console.info(
      `Silent Machine: ${loadedCount} audio files loaded successfully.`
    );

    if (failedFiles.length > 0) {
      console.group(
        `Silent Machine: ${failedFiles.length} file(s) failed and will be skipped`
      );
      console.table(
        failedFiles.map(item => ({
          file: item.key,
          attempted: item.attempted.join(" | "),
          error: item.error
        }))
      );
      console.groupEnd();
    }

    const usableCoreLayers = CONFIG.normalLayers.filter(
      layer => getAvailableIndexes(layer).length > 0
    );

    if (usableCoreLayers.length === 0) {
      throw new Error("No core atmosphere audio files could be decoded.");
    }

    if (performanceMode === "normal") {
      const missingCoreLayers = CONFIG.normalLayers.filter(
        layer => getAvailableIndexes(layer).length === 0
      );

      if (missingCoreLayers.length > 0) {
        console.warn(
          "These complete layers are unavailable and will be omitted:",
          missingCoreLayers.map(layer => layer.name)
        );
      }
    }
  }

  function chooseIndex(layer, avoidIndex = null, additionalAvoidIndexes = []) {
    const loaded = getAvailableIndexes(layer);

    if (loaded.length === 0) {
      return null;
    }

    let choices = loaded.filter(index => {
      const isOldIndex = index === avoidIndex && loaded.length > 1;
      const isAdditionallyAvoided = additionalAvoidIndexes.includes(index);
      return !isOldIndex && !isAdditionallyAvoided;
    });

    if (choices.length === 0) {
      choices = loaded.filter(
        index => index !== avoidIndex || loaded.length === 1
      );
    }

    if (choices.length === 0) {
      choices = [...loaded];
    }

    return randomItem(choices);
  }

  function createVoice(layer, index, initialGain = 0, loop = true) {
    if (index === null || index === undefined) {
      return null;
    }

    const buffer = buffers.get(`${layer.name}:${index}`);

    if (!buffer) {
      console.warn(`Skipped missing buffer ${layer.name}:${index}`);
      return null;
    }

    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();

    source.buffer = buffer;
    source.loop = loop;
    gain.gain.value = initialGain;

    source.connect(gain);
    gain.connect(dryGain);
    gain.connect(convolver);

    const randomStart = loop
      ? Math.random() * Math.max(0.001, buffer.duration)
      : 0;

    source.start(0, randomStart);

    return {
      layer,
      index,
      source,
      gain,
      stopped: false,
      duration: buffer.duration
    };
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
      try {
        voice.source.disconnect();
        voice.gain.disconnect();
      } catch (_) {}
    }, Math.ceil(seconds * 1000) + 150);
  }

  function stopVoiceNow(voice) {
    if (!voice || voice.stopped) return;
    voice.stopped = true;

    try { voice.source.stop(); } catch (_) {}
    try {
      voice.source.disconnect();
      voice.gain.disconnect();
    } catch (_) {}
  }

  function getCurrentCrossfade() {
    if (performanceMode === "glacial") {
      return CONFIG.fade.glacialCrossfade;
    }

    return evolutionMode === "sporadic"
      ? CONFIG.fade.sporadicCrossfade
      : CONFIG.fade.frequentCrossfade;
  }

  function beginNormalVoices() {
    for (const layer of CONFIG.normalLayers) {
      if (getAvailableIndexes(layer).length === 0) continue;

      const voice = createVoice(
        layer,
        chooseIndex(layer),
        layer.volume
      );

      if (voice) {
        voices.set(layer.name, voice);
      }
    }
  }

  function beginGlacialVoices() {
    const selectable = allSelectableLayers();

    if (selectable.length === 0) {
      throw new Error("No playable layers are available.");
    }

    for (let slot = 0; slot < CONFIG.glacial.slots; slot += 1) {
      const layer = randomItem(selectable);
      const voice = createVoice(
        layer,
        chooseIndex(layer),
        layer.volume
      );

      if (voice) {
        glacialVoices.push(voice);
      }
    }
  }

  function beginCurrentModeVoices() {
    if (voicesStarted) return;

    if (performanceMode === "glacial") {
      beginGlacialVoices();
    } else {
      beginNormalVoices();
    }

    voicesStarted = true;
  }

  function replaceNormalLayer(layer) {
    if (!atmosphereOn || getAvailableIndexes(layer).length === 0) return;

    const oldVoice = voices.get(layer.name);
    const temporaryVoice = temporaryVoices.get(layer.name);
    const additionalAvoidIndexes = temporaryVoice
      ? [temporaryVoice.index]
      : [];

    const newIndex = chooseIndex(
      layer,
      oldVoice?.index,
      additionalAvoidIndexes
    );

    const newVoice = createVoice(layer, newIndex, 0);
    if (!newVoice) return;

    const fade = getCurrentCrossfade();

    voices.set(layer.name, newVoice);
    rampGain(newVoice.gain.gain, layer.volume, fade);

    if (oldVoice) {
      rampGain(oldVoice.gain.gain, 0, fade);
      stopVoiceAfter(oldVoice, fade);
    }
  }

  function evolveGlacialSlot() {
    if (!atmosphereOn || glacialVoices.length === 0) return;

    const selectable = allSelectableLayers();
    if (selectable.length === 0) return;

    const slotIndex = Math.floor(Math.random() * glacialVoices.length);
    const oldVoice = glacialVoices[slotIndex];
    const newLayer = randomItem(selectable);

    const avoidIndex =
      oldVoice?.layer.name === newLayer.name
        ? oldVoice.index
        : null;

    const newVoice = createVoice(
      newLayer,
      chooseIndex(newLayer, avoidIndex),
      0
    );

    if (!newVoice) return;

    const fade = CONFIG.fade.glacialCrossfade;
    glacialVoices[slotIndex] = newVoice;

    rampGain(newVoice.gain.gain, newLayer.volume, fade);

    if (oldVoice) {
      rampGain(oldVoice.gain.gain, 0, fade);
      stopVoiceAfter(oldVoice, fade);
    }
  }

  function maybeStartTemporaryVoice(layerName) {
    if (!atmosphereOn || performanceMode !== "normal") return;

    const settings = CONFIG.temporaryLayers[layerName];
    if (!settings || temporaryVoices.has(layerName)) return;
    if (Math.random() > settings.chance[evolutionMode]) return;

    const layer = CONFIG.normalLayers.find(
      item => item.name === layerName
    );

    if (!layer || getAvailableIndexes(layer).length === 0) return;

    const mainVoice = voices.get(layerName);

    const companionVoice = createVoice(
      layer,
      chooseIndex(layer, mainVoice?.index),
      0
    );

    if (!companionVoice) return;

    temporaryVoices.set(layerName, companionVoice);

    const fade = getCurrentCrossfade();
    rampGain(companionVoice.gain.gain, settings.volume, fade);

    const activeRange = settings.activeFor[evolutionMode];

    const timer = window.setTimeout(
      () => stopTemporaryVoice(layerName),
      randomBetween(activeRange.min, activeRange.max) * 1000
    );

    temporaryVoiceTimers.set(layerName, timer);
  }

  function stopTemporaryVoice(layerName) {
    const timer = temporaryVoiceTimers.get(layerName);

    if (timer) {
      clearTimeout(timer);
      temporaryVoiceTimers.delete(layerName);
    }

    const voice = temporaryVoices.get(layerName);
    if (!voice) return;

    temporaryVoices.delete(layerName);

    const fade = getCurrentCrossfade();
    rampGain(voice.gain.gain, 0, fade);
    stopVoiceAfter(voice, fade);
  }

  function stopAllTemporaryVoices() {
    for (const layerName of Array.from(temporaryVoices.keys())) {
      stopTemporaryVoice(layerName);
    }

    for (const timer of temporaryVoiceTimers.values()) {
      clearTimeout(timer);
    }

    temporaryVoiceTimers.clear();
  }

  function maybeStartDrums() {
    const layer = CONFIG.drumLayer;

    if (
      !atmosphereOn ||
      performanceMode !== "normal" ||
      drumVoice ||
      getAvailableIndexes(layer).length === 0
    ) {
      return;
    }

    if (Math.random() > layer.chance[evolutionMode]) return;

    drumVoice = createVoice(layer, chooseIndex(layer), 0);
    if (!drumVoice) return;

    rampGain(
      drumVoice.gain.gain,
      layer.volume,
      CONFIG.fade.drumIn
    );

    const activeRange = layer.activeFor[evolutionMode];

    clearTimeout(drumStopTimer);
    drumStopTimer = window.setTimeout(
      stopDrums,
      randomBetween(activeRange.min, activeRange.max) * 1000
    );
  }

  function stopDrums() {
    clearTimeout(drumStopTimer);
    drumStopTimer = null;

    if (!drumVoice) return;

    const oldVoice = drumVoice;
    drumVoice = null;

    rampGain(oldVoice.gain.gain, 0, CONFIG.fade.drumOut);
    stopVoiceAfter(oldVoice, CONFIG.fade.drumOut);
  }

  function maybeStartRarity() {
    const layer = CONFIG.rarityLayer;

    if (
      !atmosphereOn ||
      performanceMode !== "normal" ||
      rarityVoice ||
      getAvailableIndexes(layer).length === 0
    ) {
      return;
    }

    if (Math.random() > layer.chance[evolutionMode]) return;

    rarityVoice = createVoice(
      layer,
      chooseIndex(layer),
      0,
      false
    );

    if (!rarityVoice) return;

    rampGain(
      rarityVoice.gain.gain,
      layer.volume,
      CONFIG.fade.rarityIn
    );

    const activeRange = layer.activeFor[evolutionMode];
    const desiredDuration = randomBetween(
      activeRange.min,
      activeRange.max
    );

    /*
      A rarity is played once. It fades out before either its configured
      maximum presence or the end of the actual file, whichever comes first.
    */
    const usableDuration = Math.max(
      CONFIG.fade.rarityIn + 1,
      Math.min(desiredDuration, rarityVoice.duration)
    );

    const fadeStartDelay = Math.max(
      1,
      usableDuration - CONFIG.fade.rarityOut
    );

    clearTimeout(rarityStopTimer);

    rarityStopTimer = window.setTimeout(() => {
      if (!rarityVoice) return;

      const oldVoice = rarityVoice;
      rarityVoice = null;

      rampGain(
        oldVoice.gain.gain,
        0,
        Math.min(CONFIG.fade.rarityOut, usableDuration / 2)
      );

      stopVoiceAfter(
        oldVoice,
        Math.min(CONFIG.fade.rarityOut, usableDuration / 2)
      );
    }, fadeStartDelay * 1000);
  }

  function stopRarity() {
    clearTimeout(rarityStopTimer);
    rarityStopTimer = null;

    if (!rarityVoice) return;

    const oldVoice = rarityVoice;
    rarityVoice = null;

    rampGain(oldVoice.gain.gain, 0, CONFIG.fade.rarityOut);
    stopVoiceAfter(oldVoice, CONFIG.fade.rarityOut);
  }

  function stopAllVoicesImmediately() {
    clearTimeout(evolutionTimer);
    evolutionTimer = null;

    clearTimeout(drumStopTimer);
    drumStopTimer = null;

    clearTimeout(rarityStopTimer);
    rarityStopTimer = null;

    for (const timer of temporaryVoiceTimers.values()) {
      clearTimeout(timer);
    }
    temporaryVoiceTimers.clear();

    for (const voice of voices.values()) {
      stopVoiceNow(voice);
    }
    voices.clear();

    for (const voice of temporaryVoices.values()) {
      stopVoiceNow(voice);
    }
    temporaryVoices.clear();

    if (drumVoice) stopVoiceNow(drumVoice);
    drumVoice = null;

    if (rarityVoice) stopVoiceNow(rarityVoice);
    rarityVoice = null;

    for (const voice of glacialVoices) {
      stopVoiceNow(voice);
    }
    glacialVoices.length = 0;

    voicesStarted = false;
  }

  function scheduleNextEvolution() {
    clearTimeout(evolutionTimer);

    if (!atmosphereOn) return;

    const range =
      CONFIG.evolution[performanceMode][evolutionMode];

    const delaySeconds = randomBetween(range.min, range.max);

    evolutionTimer = window.setTimeout(() => {
      if (!atmosphereOn) return;

      if (performanceMode === "glacial") {
        evolveGlacialSlot();
      } else {
        const usableNormalLayers = CONFIG.normalLayers.filter(
          layer => getAvailableIndexes(layer).length > 0
        );

        if (usableNormalLayers.length > 0) {
          replaceNormalLayer(randomItem(usableNormalLayers));
        }

        maybeStartDrums();
        maybeStartTemporaryVoice("pad");
        maybeStartTemporaryVoice("melody");
        maybeStartRarity();
      }

      scheduleNextEvolution();
    }, delaySeconds * 1000);
  }

  async function initialize() {
    if (initialized || initializing) return;

    initializing = true;
    setControlsDisabled(true);
    refreshLed();

    try {
      createAudioGraph();
      await loadAllAudio();
      initialized = true;
    } catch (error) {
      console.error(error);

      alert(
        "The atmosphere could not start because no usable audio could be loaded. Open the browser console for details, then reload."
      );

      throw error;
    } finally {
      initializing = false;
      setControlsDisabled(false);
      refreshLed();
    }
  }

  async function turnOn() {
    if (atmosphereOn || initializing) return;

    const token = ++operationToken;

    try {
      await initialize();
      if (token !== operationToken) return;

      await audioContext.resume();
      if (token !== operationToken) return;

      beginCurrentModeVoices();

      atmosphereOn = true;
      setButtonPair(ui.on, ui.off);
      refreshLed();

      rampGain(
        masterGain.gain,
        0.99,
        CONFIG.fade.masterIn
      );

      scheduleNextEvolution();
    } catch (_) {
      setButtonPair(ui.off, ui.on);
    }
  }

  function turnOff() {
    ++operationToken;
    setButtonPair(ui.off, ui.on);

    if (!initialized || !audioContext || !atmosphereOn) {
      atmosphereOn = false;
      refreshLed();
      return;
    }

    atmosphereOn = false;
    refreshLed();

    clearTimeout(evolutionTimer);
    evolutionTimer = null;

    stopDrums();
    stopRarity();
    stopAllTemporaryVoices();

    rampGain(
      masterGain.gain,
      0,
      CONFIG.fade.masterOut
    );

    const context = audioContext;

    window.setTimeout(async () => {
      if (!atmosphereOn) {
        stopAllVoicesImmediately();

        if (context.state === "running") {
          try {
            await context.suspend();
          } catch (error) {
            console.warn(error);
          }
        }
      }
    }, CONFIG.fade.masterOut * 1000 + 150);
  }

  function setEvolution(mode) {
    evolutionMode = mode;

    if (mode === "sporadic") {
      setButtonPair(ui.sporadic, ui.frequent);
    } else {
      setButtonPair(ui.frequent, ui.sporadic);
    }

    if (atmosphereOn) {
      scheduleNextEvolution();
    }
  }

  function setPerformance(mode) {
    if (performanceMode === mode) return;

    performanceMode = mode;

    if (mode === "glacial") {
      setButtonPair(ui.glacial, ui.normal);
    } else {
      setButtonPair(ui.normal, ui.glacial);
    }

    updateModeText();
    refreshLed();

    if (!initialized) return;

    const wasOn = atmosphereOn;

    clearTimeout(evolutionTimer);
    evolutionTimer = null;

    stopAllVoicesImmediately();

    if (wasOn) {
      beginCurrentModeVoices();
      scheduleNextEvolution();
    }
  }

  ui.on.addEventListener("click", turnOn);
  ui.off.addEventListener("click", turnOff);
  ui.sporadic.addEventListener(
    "click",
    () => setEvolution("sporadic")
  );
  ui.frequent.addEventListener(
    "click",
    () => setEvolution("frequent")
  );
  ui.normal.addEventListener(
    "click",
    () => setPerformance("normal")
  );
  ui.glacial.addEventListener(
    "click",
    () => setPerformance("glacial")
  );

  updateModeText();
  refreshLed();
})();
