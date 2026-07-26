(() => {
  "use strict";

  const CONFIG = {
    fade: {
      masterIn: 10,
      masterOut: 10,
      sporadicCrossfade: 12,
      frequentCrossfade: 9,
      drumIn: 7,
      drumOut: 9
    },

    evolution: {
      sporadic: { min: 20, max: 55 },
      frequent: { min: 10, max: 35 }
    },

    normalLayers: [
      {
        name: "pad",
        folder: "pad",
        prefix: "pad",
        count: 5,
        volume: 0.28
      },
      {
        name: "noise",
        folder: "noise",
        prefix: "noise",
        count: 5,
        volume: 0.19
      },
      {
        name: "bass",
        folder: "bass",
        prefix: "bass",
        count: 6,
        volume: 0.18
      },
      {
        name: "melody",
        folder: "melody",
        prefix: "melody",
        count: 6,
        volume: 0.23
      },
      {
        name: "misc",
        folder: "misc",
        prefix: "misc",
        count: 8,
        volume: 0.18
      }
    ],

    drumLayer: {
      name: "drums",
      folder: "drums",
      prefix: "drum",
      count: 5,
      volume: 0.17,

      chance: {
        sporadic: 0.12,
        frequent: 0.20
      },

      activeFor: {
        sporadic: { min: 35, max: 80 },
        frequent: { min: 30, max: 65 }
      }
    },

    /*
      Occasionally allows an additional pad or melody recording
      to fade in alongside the normal one.

      Only one temporary companion per layer is allowed at a time.
    */
    temporaryLayers: {
      pad: {
        chance: {
          sporadic: 0.10,
          frequent: 0.16
        },

        volume: 0.15,

        activeFor: {
          sporadic: { min: 45, max: 100 },
          frequent: { min: 30, max: 75 }
        }
      },

      melody: {
        chance: {
          sporadic: 0.07,
          frequent: 0.13
        },

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
    led: document.getElementById("statusLed")
  };

  let audioContext = null;
  let masterGain = null;
  let dryGain = null;
  let convolver = null;
  let wetGain = null;
  let compressor = null;

  const buffers = new Map();
  const voices = new Map();

  /*
    Temporary companion voices and their timers are stored
    separately from the normal layer voices.
  */
  const temporaryVoices = new Map();
  const temporaryVoiceTimers = new Map();

  let evolutionMode = "sporadic";
  let atmosphereOn = false;
  let initialized = false;
  let initializing = false;

  let evolutionTimer = null;
  let drumStopTimer = null;
  let drumVoice = null;

  let operationToken = 0;

  const randomBetween = (min, max) =>
    min + Math.random() * (max - min);

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

    if (state) {
      ui.led.classList.add(state);
    }
  }

  function createAudioGraph() {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("This browser does not support Web Audio.");
    }

    audioContext = new AudioContextClass();

    masterGain = audioContext.createGain();
    masterGain.gain.value = 0;

    dryGain = audioContext.createGain();
    dryGain.gain.value = 0.82;

    convolver = audioContext.createConvolver();
    convolver.buffer = createSyntheticImpulse(
      audioContext,
      4.8,
      2.7
    );

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
    const length = Math.floor(
      context.sampleRate * duration
    );

    const impulse = context.createBuffer(
      2,
      length,
      context.sampleRate
    );

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
    const base =
      `${layer.folder}/${layer.prefix}${index}`;

    return [
      `${base}.ogg`,
      `${base}.mp3`
    ];
  }

  async function loadAudioBuffer(layer, index) {
    const key = `${layer.name}:${index}`;
    let lastError = null;

    for (const url of fileCandidates(layer, index)) {
      try {
        const response = await fetch(url, {
          cache: "force-cache"
        });

        if (!response.ok) {
          throw new Error(
            `${response.status} ${response.statusText}`
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        const decoded =
          await audioContext.decodeAudioData(arrayBuffer);

        buffers.set(key, decoded);
        return;
      } catch (error) {
        lastError = error;

        console.warn(
          `Could not load ${url}; trying fallback.`,
          error
        );
      }
    }

    throw new Error(
      `Unable to load ${key}: ${
        lastError?.message || "unknown error"
      }`
    );
  }

  async function loadAllAudio() {
    const jobs = [];

    const allLayers = [
      ...CONFIG.normalLayers,
      CONFIG.drumLayer
    ];

    for (const layer of allLayers) {
      for (let i = 1; i <= layer.count; i += 1) {
        jobs.push(loadAudioBuffer(layer, i));
      }
    }

    await Promise.all(jobs);
  }

  function chooseIndex(
    layer,
    avoidIndex = null,
    additionalAvoidIndexes = []
  ) {
    let choices = [];

    for (let i = 1; i <= layer.count; i += 1) {
      const isOldIndex =
        i === avoidIndex && layer.count > 1;

      const isAdditionallyAvoided =
        additionalAvoidIndexes.includes(i);

      if (!isOldIndex && !isAdditionallyAvoided) {
        choices.push(i);
      }
    }

    /*
      If every file was excluded, fall back to everything except
      the currently replacing file.
    */
    if (choices.length === 0) {
      for (let i = 1; i <= layer.count; i += 1) {
        if (i !== avoidIndex || layer.count === 1) {
          choices.push(i);
        }
      }
    }

    return choices[
      Math.floor(Math.random() * choices.length)
    ];
  }

  function createVoice(layer, index, initialGain = 0) {
    const buffer = buffers.get(
      `${layer.name}:${index}`
    );

    if (!buffer) {
      throw new Error(
        `Missing buffer ${layer.name}:${index}`
      );
    }

    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();

    source.buffer = buffer;
    source.loop = true;

    gain.gain.value = initialGain;

    source.connect(gain);

    /*
      Each voice is sent both to the dry signal and to
      the shared synthetic reverb.
    */
    gain.connect(dryGain);
    gain.connect(convolver);

    const randomStart =
      Math.random() * Math.max(0.001, buffer.duration);

    source.start(0, randomStart);

    return {
      layer,
      index,
      source,
      gain,
      stopped: false
    };
  }

  function rampGain(param, target, seconds) {
    const now = audioContext.currentTime;

    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(
      target,
      now + seconds
    );
  }

  function stopVoiceAfter(voice, seconds) {
    if (!voice || voice.stopped) {
      return;
    }

    voice.stopped = true;

    window.setTimeout(() => {
      try {
        voice.source.stop();
      } catch (_) {}

      try {
        voice.source.disconnect();
        voice.gain.disconnect();
      } catch (_) {}
    }, Math.ceil(seconds * 1000) + 150);
  }

  function getCurrentCrossfade() {
    return evolutionMode === "sporadic"
      ? CONFIG.fade.sporadicCrossfade
      : CONFIG.fade.frequentCrossfade;
  }

  function beginInitialVoices() {
    for (const layer of CONFIG.normalLayers) {
      const index = chooseIndex(layer);

      const voice = createVoice(
        layer,
        index,
        layer.volume
      );

      voices.set(layer.name, voice);
    }
  }

  function replaceLayer(layer) {
    if (!atmosphereOn) {
      return;
    }

    const oldVoice = voices.get(layer.name);

    /*
      Avoid selecting the currently active temporary companion
      recording when possible.
    */
    const temporaryVoice =
      temporaryVoices.get(layer.name);

    const additionalAvoidIndexes =
      temporaryVoice ? [temporaryVoice.index] : [];

    const newIndex = chooseIndex(
      layer,
      oldVoice?.index,
      additionalAvoidIndexes
    );

    const newVoice = createVoice(
      layer,
      newIndex,
      0
    );

    const fade = getCurrentCrossfade();

    voices.set(layer.name, newVoice);

    rampGain(
      newVoice.gain.gain,
      layer.volume,
      fade
    );

    if (oldVoice) {
      rampGain(
        oldVoice.gain.gain,
        0,
        fade
      );

      stopVoiceAfter(oldVoice, fade);
    }
  }

  function maybeStartTemporaryVoice(layerName) {
    if (!atmosphereOn) {
      return;
    }

    const settings =
      CONFIG.temporaryLayers[layerName];

    if (!settings) {
      return;
    }

    /*
      Never allow more than one temporary companion
      for the same layer.
    */
    if (temporaryVoices.has(layerName)) {
      return;
    }

    const chance =
      settings.chance[evolutionMode];

    if (Math.random() > chance) {
      return;
    }

    const layer = CONFIG.normalLayers.find(
      item => item.name === layerName
    );

    if (!layer) {
      return;
    }

    const mainVoice = voices.get(layerName);

    const companionIndex = chooseIndex(
      layer,
      mainVoice?.index
    );

    const companionVoice = createVoice(
      layer,
      companionIndex,
      0
    );

    temporaryVoices.set(
      layerName,
      companionVoice
    );

    const fade = getCurrentCrossfade();

    rampGain(
      companionVoice.gain.gain,
      settings.volume,
      fade
    );

    const activeRange =
      settings.activeFor[evolutionMode];

    const activeSeconds = randomBetween(
      activeRange.min,
      activeRange.max
    );

    const timer = window.setTimeout(() => {
      stopTemporaryVoice(layerName);
    }, activeSeconds * 1000);

    temporaryVoiceTimers.set(
      layerName,
      timer
    );
  }

  function stopTemporaryVoice(layerName) {
    const timer =
      temporaryVoiceTimers.get(layerName);

    if (timer) {
      clearTimeout(timer);
      temporaryVoiceTimers.delete(layerName);
    }

    const voice =
      temporaryVoices.get(layerName);

    if (!voice) {
      return;
    }

    temporaryVoices.delete(layerName);

    const fade = getCurrentCrossfade();

    rampGain(
      voice.gain.gain,
      0,
      fade
    );

    stopVoiceAfter(voice, fade);
  }

  function stopAllTemporaryVoices() {
    const activeLayerNames = Array.from(
      temporaryVoices.keys()
    );

    for (const layerName of activeLayerNames) {
      stopTemporaryVoice(layerName);
    }

    /*
      Clear any orphaned timer entries as an additional safeguard.
    */
    for (const timer of temporaryVoiceTimers.values()) {
      clearTimeout(timer);
    }

    temporaryVoiceTimers.clear();
  }

  function maybeStartDrums() {
    if (!atmosphereOn || drumVoice) {
      return;
    }

    const chance =
      CONFIG.drumLayer.chance[evolutionMode];

    if (Math.random() > chance) {
      return;
    }

    const layer = CONFIG.drumLayer;

    drumVoice = createVoice(
      layer,
      chooseIndex(layer),
      0
    );

    rampGain(
      drumVoice.gain.gain,
      layer.volume,
      CONFIG.fade.drumIn
    );

    const activeRange =
      layer.activeFor[evolutionMode];

    const activeSeconds = randomBetween(
      activeRange.min,
      activeRange.max
    );

    clearTimeout(drumStopTimer);

    drumStopTimer = window.setTimeout(
      stopDrums,
      activeSeconds * 1000
    );
  }

  function stopDrums() {
    clearTimeout(drumStopTimer);
    drumStopTimer = null;

    if (!drumVoice) {
      return;
    }

    const oldVoice = drumVoice;
    drumVoice = null;

    rampGain(
      oldVoice.gain.gain,
      0,
      CONFIG.fade.drumOut
    );

    stopVoiceAfter(
      oldVoice,
      CONFIG.fade.drumOut
    );
  }

  function scheduleNextEvolution() {
    clearTimeout(evolutionTimer);

    if (!atmosphereOn) {
      return;
    }

    const range =
      CONFIG.evolution[evolutionMode];

    const delaySeconds = randomBetween(
      range.min,
      range.max
    );

    evolutionTimer = window.setTimeout(() => {
      if (!atmosphereOn) {
        return;
      }

      /*
        Replace one randomly chosen normal layer.
      */
      const layer =
        CONFIG.normalLayers[
          Math.floor(
            Math.random() *
            CONFIG.normalLayers.length
          )
        ];

      replaceLayer(layer);

      /*
        Independently test whether drums, a second pad,
        or a second melody should appear.
      */
      maybeStartDrums();
      maybeStartTemporaryVoice("pad");
      maybeStartTemporaryVoice("melody");

      scheduleNextEvolution();
    }, delaySeconds * 1000);
  }

  async function initialize() {
    if (initialized || initializing) {
      return;
    }

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

      alert(
        "The atmosphere could not start. " +
        "Check the audio folders and filenames, then reload."
      );

      throw error;
    } finally {
      initializing = false;
      setControlsDisabled(false);
    }
  }

  async function turnOn() {
    if (atmosphereOn || initializing) {
      return;
    }

    const token = ++operationToken;

    try {
      await initialize();

      if (token !== operationToken) {
        return;
      }

      await audioContext.resume();

      atmosphereOn = true;

      setButtonPair(ui.on, ui.off);
      setLed("on");

      rampGain(
        masterGain.gain,
        0.72,
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
    setLed(null);

    if (
      !initialized ||
      !audioContext ||
      !atmosphereOn
    ) {
      atmosphereOn = false;
      return;
    }

    atmosphereOn = false;

    clearTimeout(evolutionTimer);
    evolutionTimer = null;

    stopDrums();
    stopAllTemporaryVoices();

    rampGain(
      masterGain.gain,
      0,
      CONFIG.fade.masterOut
    );

    const context = audioContext;

    window.setTimeout(async () => {
      if (
        !atmosphereOn &&
        context.state === "running"
      ) {
        try {
          await context.suspend();
        } catch (error) {
          console.warn(error);
        }
      }
    }, CONFIG.fade.masterOut * 1000 + 120);
  }

  function setEvolution(mode) {
    evolutionMode = mode;

    if (mode === "sporadic") {
      setButtonPair(
        ui.sporadic,
        ui.frequent
      );
    } else {
      setButtonPair(
        ui.frequent,
        ui.sporadic
      );
    }

    if (atmosphereOn) {
      scheduleNextEvolution();
    }
  }

  ui.on.addEventListener(
    "click",
    turnOn
  );

  ui.off.addEventListener(
    "click",
    turnOff
  );

  ui.sporadic.addEventListener(
    "click",
    () => setEvolution("sporadic")
  );

  ui.frequent.addEventListener(
    "click",
    () => setEvolution("frequent")
  );
})();
