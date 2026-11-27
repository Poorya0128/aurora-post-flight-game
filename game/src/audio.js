// audio.js — AURORA POST synthesized sound engine (A9 Audio Engineer).
//
// Every sound is generated with WebAudio oscillators and filtered noise.
// There are no audio files and no network requests.
//
// Public API (see interfaces.md):
//   createAudio() -> {
//     start(),                                // call on first user gesture
//     setEngine(throttle, airspeed, engineOn),// call every frame
//     event(name),                            // one-shot / state sounds
//     setMuted(bool), isMuted(),
//   }
//
// Event names understood by event(name) (unknown names are ignored):
//   click                 UI button click
//   ring                  ring threaded chime
//   ring_miss             dull miss blip
//   touchdown             gear touchdown thump
//   hard_landing          heavier thump + creak
//   crash                 crash bang (engine stops dead)
//   damage                damage bang (terrain / building strike)
//   damage_critical       bang + 3 s master-warning alarm (100% damage)
//   engine_out            empty-tank sputter: RPM steps down over ~2 s
//   engine_start          starter churn as the engine catches
//   stall                 start repeating stall-warning beep
//   stall_clear           stop the stall-warning beep
//   stall_beep            a single stall beep
//   buffet                low stall-buffet rumble
//   low_fuel              single low-fuel chime (25% tank)
//   fuel_critical         start repeating soft alarm + rough engine (10%)
//   fuel_ok               stop fuel alarm, engine smooth again
//   overspeed             airframe creak / groan
//   parcel_release        parcel release click + whoosh
//   parachute             parachute pop
//   parcel_delivered      delivery ding
//   parcel_lost           descending "lost" blip
//   unload                unload-complete double ding
//   success               mission success jingle
//   fail                  gentle mission-fail descent
//   splash                ditching splash
//   refuel, repair        soft ground-service whir + click
//   warning               single caution beep
//
// Continuous sounds (engine, wind, stall beep, fuel alarm) use persistent
// nodes created once in start(); only short one-shots allocate nodes, and
// they disconnect themselves when finished.

const MASTER_VOLUME = 0.9;
const ENGINE_IDLE_HZ = 50;
const ENGINE_THROTTLE_HZ = 95;
const ENGINE_AIRSPEED_HZ_PER_MS = 0.35;
const SPUTTER_DURATION_MS = 2100;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createAudio() {
  let audioContext = null;
  let masterGain = null;
  let noiseBuffer = null;

  // Persistent engine chain.
  let engineMainOscillator = null;
  let engineSubOscillator = null;
  let engineHarmonicOscillator = null;
  let engineFilter = null;
  let engineGain = null;
  let engineWobbleOscillator = null;
  let engineWobbleDepth = null;

  // Persistent wind chain.
  let windSource = null;
  let windFilter = null;
  let windGain = null;

  // Persistent alarm chains (gated by their gains).
  let stallOscillator = null;
  let stallGain = null;
  let stallGateOscillator = null;
  let stallGateDepth = null;
  let fuelAlarmOscillator = null;
  let fuelAlarmGain = null;
  let fuelAlarmGateOscillator = null;
  let fuelAlarmGateDepth = null;

  let muted = false;
  let started = false;
  let sputtering = false;
  let sputterTimer = null;
  let lastThrottle = 0;
  let lastAirspeed = 0;
  let lastEngineOn = false;

  function makeNoiseBuffer(context) {
    const length = context.sampleRate * 2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic pseudo-random fill (no Math.random: same buffer every run).
    let seed = 22222;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
    return buffer;
  }

  function buildPersistentGraph() {
    const context = audioContext;
    noiseBuffer = makeNoiseBuffer(context);

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;
    compressor.connect(context.destination);

    masterGain = context.createGain();
    masterGain.gain.value = muted ? 0 : MASTER_VOLUME;
    masterGain.connect(compressor);

    // --- Piston engine: sawtooth fundamental + square sub-octave + harmonic.
    engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 500;
    engineFilter.Q.value = 1.1;

    engineGain = context.createGain();
    engineGain.gain.value = 0;
    engineFilter.connect(engineGain);
    engineGain.connect(masterGain);

    engineMainOscillator = context.createOscillator();
    engineMainOscillator.type = 'sawtooth';
    engineMainOscillator.frequency.value = ENGINE_IDLE_HZ;

    engineSubOscillator = context.createOscillator();
    engineSubOscillator.type = 'square';
    engineSubOscillator.frequency.value = ENGINE_IDLE_HZ / 2;

    engineHarmonicOscillator = context.createOscillator();
    engineHarmonicOscillator.type = 'sawtooth';
    engineHarmonicOscillator.frequency.value = ENGINE_IDLE_HZ * 2;
    engineHarmonicOscillator.detune.value = 5;

    const subGain = context.createGain();
    subGain.gain.value = 0.55;
    const harmonicGain = context.createGain();
    harmonicGain.gain.value = 0.28;

    engineMainOscillator.connect(engineFilter);
    engineSubOscillator.connect(subGain);
    subGain.connect(engineFilter);
    engineHarmonicOscillator.connect(harmonicGain);
    harmonicGain.connect(engineFilter);

    // Rough-running wobble (fuel critical / heavy damage): depth 0 when smooth.
    engineWobbleOscillator = context.createOscillator();
    engineWobbleOscillator.type = 'sine';
    engineWobbleOscillator.frequency.value = 7;
    engineWobbleDepth = context.createGain();
    engineWobbleDepth.gain.value = 0;
    engineWobbleOscillator.connect(engineWobbleDepth);
    engineWobbleDepth.connect(engineMainOscillator.frequency);
    engineWobbleDepth.connect(engineSubOscillator.frequency);

    engineMainOscillator.start();
    engineSubOscillator.start();
    engineHarmonicOscillator.start();
    engineWobbleOscillator.start();

    // --- Wind rush: looping noise through a bandpass that follows airspeed.
    windSource = context.createBufferSource();
    windSource.buffer = noiseBuffer;
    windSource.loop = true;
    windFilter = context.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 420;
    windFilter.Q.value = 0.55;
    windGain = context.createGain();
    windGain.gain.value = 0;
    windSource.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(masterGain);
    windSource.start();

    // --- Stall warning: square beep gated by a square LFO (~2.5 Hz).
    stallOscillator = context.createOscillator();
    stallOscillator.type = 'square';
    stallOscillator.frequency.value = 880;
    stallGain = context.createGain();
    stallGain.gain.value = 0;
    stallOscillator.connect(stallGain);
    stallGain.connect(masterGain);
    stallGateOscillator = context.createOscillator();
    stallGateOscillator.type = 'square';
    stallGateOscillator.frequency.value = 2.5;
    stallGateDepth = context.createGain();
    stallGateDepth.gain.value = 0;
    stallGateOscillator.connect(stallGateDepth);
    stallGateDepth.connect(stallGain.gain);
    stallOscillator.start();
    stallGateOscillator.start();

    // --- Fuel-critical alarm: soft sine pulsing slowly (~0.8 Hz).
    fuelAlarmOscillator = context.createOscillator();
    fuelAlarmOscillator.type = 'sine';
    fuelAlarmOscillator.frequency.value = 660;
    fuelAlarmGain = context.createGain();
    fuelAlarmGain.gain.value = 0;
    fuelAlarmOscillator.connect(fuelAlarmGain);
    fuelAlarmGain.connect(masterGain);
    fuelAlarmGateOscillator = context.createOscillator();
    fuelAlarmGateOscillator.type = 'sine';
    fuelAlarmGateOscillator.frequency.value = 0.8;
    fuelAlarmGateDepth = context.createGain();
    fuelAlarmGateDepth.gain.value = 0;
    fuelAlarmGateOscillator.connect(fuelAlarmGateDepth);
    fuelAlarmGateDepth.connect(fuelAlarmGain.gain);
    fuelAlarmOscillator.start();
    fuelAlarmGateOscillator.start();
  }

  // Short oscillator one-shot with an exponential decay envelope.
  function playTone(options) {
    if (!started) return;
    const context = audioContext;
    const startTime = context.currentTime + (options.delay || 0);
    const duration = options.duration || 0.2;
    const peak = options.gain || 0.15;

    const oscillator = context.createOscillator();
    oscillator.type = options.type || 'sine';
    oscillator.frequency.setValueAtTime(options.frequency, startTime);
    if (options.slideTo) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(1, options.slideTo),
        startTime + duration,
      );
    }

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, startTime);
    envelope.gain.exponentialRampToValueAtTime(peak, startTime + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    oscillator.connect(envelope);
    envelope.connect(masterGain);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
    oscillator.start(startTime);
    oscillator.stop(startTime + duration + 0.05);
  }

  // Short filtered-noise one-shot (thumps, bangs, whooshes, splashes).
  function playNoiseBurst(options) {
    if (!started) return;
    const context = audioContext;
    const startTime = context.currentTime + (options.delay || 0);
    const duration = options.duration || 0.3;
    const peak = options.gain || 0.25;

    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    source.playbackRate.value = options.playbackRate || 1;

    const filter = context.createBiquadFilter();
    filter.type = options.filterType || 'lowpass';
    filter.frequency.setValueAtTime(options.frequency || 800, startTime);
    if (options.frequencyEnd) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(10, options.frequencyEnd),
        startTime + duration,
      );
    }
    filter.Q.value = options.q || 0.8;

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, startTime);
    envelope.gain.exponentialRampToValueAtTime(peak, startTime + (options.attack || 0.006));
    envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(masterGain);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    };
    source.start(startTime, options.offset || 0);
    source.stop(startTime + duration + 0.05);
  }

  function setStallBeepActive(active) {
    if (!started) return;
    const now = audioContext.currentTime;
    const level = active ? 0.035 : 0;
    stallGain.gain.setTargetAtTime(level, now, 0.02);
    stallGateDepth.gain.setTargetAtTime(level, now, 0.02);
  }

  function setFuelAlarmActive(active) {
    if (!started) return;
    const now = audioContext.currentTime;
    const level = active ? 0.045 : 0;
    fuelAlarmGain.gain.setTargetAtTime(level, now, 0.05);
    fuelAlarmGateDepth.gain.setTargetAtTime(level, now, 0.05);
    // Engine note roughens while the tank is critical (design.md §3.1).
    engineWobbleDepth.gain.setTargetAtTime(active ? 3.5 : 0, now, 0.3);
  }

  function stopEngineImmediately() {
    if (!started) return;
    const now = audioContext.currentTime;
    engineGain.gain.cancelScheduledValues(now);
    engineGain.gain.setTargetAtTime(0, now, 0.03);
  }

  // Empty tank: RPM drops in steps over ~2 s, then silence (design.md §3.3).
  function playEngineSputter() {
    if (!started || sputtering) return;
    sputtering = true;
    const context = audioContext;
    const now = context.currentTime;
    const currentFrequency = engineMainOscillator.frequency.value;
    const gainSteps = [0.7, 0.25, 0.55, 0.12, 0.4, 0.06, 0.22, 0.02, 0];
    const freqSteps = [0.92, 0.7, 0.84, 0.58, 0.72, 0.46, 0.55, 0.36, 0.3];
    const baseGain = Math.max(engineGain.gain.value, 0.06);

    engineGain.gain.cancelScheduledValues(now);
    engineMainOscillator.frequency.cancelScheduledValues(now);
    engineSubOscillator.frequency.cancelScheduledValues(now);
    engineHarmonicOscillator.frequency.cancelScheduledValues(now);

    for (let i = 0; i < gainSteps.length; i++) {
      const stepTime = now + (i / gainSteps.length) * 2.0;
      engineGain.gain.setValueAtTime(baseGain * gainSteps[i], stepTime);
      const steppedFrequency = currentFrequency * freqSteps[i];
      engineMainOscillator.frequency.setValueAtTime(steppedFrequency, stepTime);
      engineSubOscillator.frequency.setValueAtTime(steppedFrequency / 2, stepTime);
      engineHarmonicOscillator.frequency.setValueAtTime(steppedFrequency * 2, stepTime);
    }
    engineGain.gain.setValueAtTime(0, now + 2.0);

    // Short coughs of noise between the RPM steps sell the sputter.
    for (let i = 0; i < 5; i++) {
      playNoiseBurst({
        duration: 0.09,
        gain: 0.12,
        filterType: 'bandpass',
        frequency: 300 + i * 40,
        q: 1.4,
        delay: 0.15 + i * 0.38,
      });
    }

    if (sputterTimer) clearTimeout(sputterTimer);
    sputterTimer = setTimeout(() => {
      sputtering = false;
      sputterTimer = null;
    }, SPUTTER_DURATION_MS);
  }

  function playTouchdownThump(strength) {
    playTone({
      frequency: 110,
      slideTo: 42,
      duration: 0.22,
      gain: 0.32 * strength,
      type: 'sine',
    });
    playNoiseBurst({
      duration: 0.16,
      gain: 0.2 * strength,
      filterType: 'lowpass',
      frequency: 420,
      frequencyEnd: 120,
    });
  }

  function playDamageBang() {
    playNoiseBurst({
      duration: 0.4,
      gain: 0.5,
      filterType: 'lowpass',
      frequency: 2600,
      frequencyEnd: 180,
    });
    playTone({ frequency: 150, slideTo: 45, duration: 0.45, gain: 0.4, type: 'sine' });
    // Metallic clang partials.
    playTone({ frequency: 1180, duration: 0.18, gain: 0.12, type: 'square' });
    playTone({ frequency: 1740, duration: 0.12, gain: 0.08, type: 'square', delay: 0.01 });
  }

  function playCrashBang() {
    stopEngineImmediately();
    setStallBeepActive(false);
    setFuelAlarmActive(false);
    playNoiseBurst({
      duration: 0.9,
      gain: 0.65,
      filterType: 'lowpass',
      frequency: 3200,
      frequencyEnd: 90,
      attack: 0.003,
    });
    playTone({ frequency: 120, slideTo: 30, duration: 0.9, gain: 0.55, type: 'sine' });
    playNoiseBurst({
      duration: 0.5,
      gain: 0.22,
      filterType: 'bandpass',
      frequency: 500,
      frequencyEnd: 160,
      delay: 0.05,
    });
  }

  function playMasterWarningAlarm() {
    // Three firm beeps over ~3 s (design.md §3.3, 100% damage).
    for (let i = 0; i < 3; i++) {
      playTone({
        frequency: 740,
        duration: 0.28,
        gain: 0.14,
        type: 'square',
        delay: i * 0.9,
      });
    }
  }

  function playRingChime() {
    playTone({ frequency: 1318, duration: 0.35, gain: 0.16, type: 'sine' });
    playTone({ frequency: 1760, duration: 0.5, gain: 0.16, type: 'sine', delay: 0.09 });
    playTone({ frequency: 2637, duration: 0.3, gain: 0.06, type: 'sine', delay: 0.09 });
  }

  function playSuccessJingle() {
    const notes = [523, 659, 784, 1046];
    for (let i = 0; i < notes.length; i++) {
      playTone({
        frequency: notes[i],
        duration: i === notes.length - 1 ? 0.7 : 0.28,
        gain: 0.16,
        type: 'triangle',
        delay: i * 0.14,
      });
    }
  }

  function playLowFuelChime() {
    playTone({ frequency: 880, duration: 0.18, gain: 0.12, type: 'sine' });
    playTone({ frequency: 659, duration: 0.3, gain: 0.12, type: 'sine', delay: 0.16 });
  }

  function handleEvent(rawName) {
    if (!started) return;
    const name = String(rawName || '').toLowerCase().trim();

    switch (name) {
      case 'click':
      case 'button':
      case 'button_click':
      case 'ui_click':
        playTone({ frequency: 1250, duration: 0.045, gain: 0.1, type: 'square' });
        break;

      case 'ring':
      case 'ring_chime':
      case 'ring_hit':
      case 'ring_through':
        playRingChime();
        break;

      case 'ring_miss':
        playTone({ frequency: 330, slideTo: 262, duration: 0.18, gain: 0.1, type: 'sine' });
        break;

      case 'touchdown':
      case 'gear':
      case 'gear_touchdown':
      case 'landing':
      case 'thump':
        playTouchdownThump(1);
        break;

      case 'hard_landing':
        playTouchdownThump(1.5);
        playTone({ frequency: 190, slideTo: 90, duration: 0.35, gain: 0.14, type: 'sawtooth', delay: 0.05 });
        break;

      case 'crash':
      case 'crash_bang':
      case 'impact':
        playCrashBang();
        break;

      case 'damage':
      case 'damage_bang':
      case 'bang':
      case 'terrain_strike':
      case 'building_hit':
        playDamageBang();
        break;

      case 'damage_critical':
      case 'airframe_critical':
      case 'master_warning':
        playDamageBang();
        stopEngineImmediately();
        playMasterWarningAlarm();
        break;

      case 'engine_out':
      case 'sputter':
      case 'fuel_empty':
      case 'empty_tank':
      case 'out_of_fuel':
        playEngineSputter();
        break;

      case 'engine_start':
        playNoiseBurst({
          duration: 0.5,
          gain: 0.14,
          filterType: 'bandpass',
          frequency: 240,
          frequencyEnd: 420,
          q: 1.2,
        });
        playTone({ frequency: 70, slideTo: 120, duration: 0.55, gain: 0.12, type: 'sawtooth' });
        break;

      case 'stall':
      case 'stall_warning':
        setStallBeepActive(true);
        break;

      case 'stall_clear':
      case 'stall_end':
      case 'stall_off':
        setStallBeepActive(false);
        break;

      case 'stall_beep':
        playTone({ frequency: 880, duration: 0.14, gain: 0.09, type: 'square' });
        break;

      case 'buffet':
      case 'stall_buffet':
        playNoiseBurst({
          duration: 0.45,
          gain: 0.16,
          filterType: 'lowpass',
          frequency: 180,
          frequencyEnd: 110,
        });
        break;

      case 'low_fuel':
      case 'fuel_low':
        playLowFuelChime();
        break;

      case 'fuel_critical':
        setFuelAlarmActive(true);
        playLowFuelChime();
        break;

      case 'fuel_ok':
      case 'fuel_clear':
        setFuelAlarmActive(false);
        break;

      case 'overspeed':
      case 'creak':
      case 'overspeed_creak':
        playTone({ frequency: 140, slideTo: 95, duration: 0.5, gain: 0.1, type: 'sawtooth' });
        playNoiseBurst({
          duration: 0.4,
          gain: 0.07,
          filterType: 'bandpass',
          frequency: 700,
          frequencyEnd: 380,
          q: 3,
        });
        break;

      case 'parcel_release':
      case 'parcel':
      case 'drop':
      case 'release':
        playTone({ frequency: 900, duration: 0.04, gain: 0.1, type: 'square' });
        playNoiseBurst({
          duration: 0.45,
          gain: 0.13,
          filterType: 'bandpass',
          frequency: 1400,
          frequencyEnd: 500,
          q: 0.9,
          delay: 0.03,
        });
        break;

      case 'parachute':
      case 'parachute_pop':
      case 'chute':
        playNoiseBurst({
          duration: 0.12,
          gain: 0.2,
          filterType: 'bandpass',
          frequency: 900,
          frequencyEnd: 350,
          q: 1.1,
          attack: 0.002,
        });
        playTone({ frequency: 520, slideTo: 300, duration: 0.1, gain: 0.08, type: 'sine' });
        break;

      case 'parcel_delivered':
      case 'delivered':
      case 'drop_scored':
        playTone({ frequency: 1046, duration: 0.3, gain: 0.14, type: 'sine' });
        playTone({ frequency: 1568, duration: 0.4, gain: 0.12, type: 'sine', delay: 0.1 });
        break;

      case 'parcel_lost':
        playTone({ frequency: 587, slideTo: 392, duration: 0.35, gain: 0.11, type: 'sine' });
        break;

      case 'unload':
      case 'unload_complete':
        playTone({ frequency: 784, duration: 0.2, gain: 0.13, type: 'triangle' });
        playTone({ frequency: 1175, duration: 0.35, gain: 0.13, type: 'triangle', delay: 0.13 });
        break;

      case 'success':
      case 'mission_success':
      case 'mission_complete':
      case 'jingle':
      case 'win':
        playSuccessJingle();
        break;

      case 'fail':
      case 'mission_fail':
        playTone({ frequency: 523, duration: 0.25, gain: 0.12, type: 'triangle' });
        playTone({ frequency: 392, duration: 0.45, gain: 0.12, type: 'triangle', delay: 0.2 });
        break;

      case 'splash':
      case 'ditch':
      case 'ditched':
      case 'water':
        playNoiseBurst({
          duration: 0.8,
          gain: 0.3,
          filterType: 'lowpass',
          frequency: 1400,
          frequencyEnd: 300,
          attack: 0.02,
        });
        playTone({ frequency: 180, slideTo: 70, duration: 0.5, gain: 0.14, type: 'sine' });
        break;

      case 'refuel':
      case 'repair':
        playNoiseBurst({
          duration: 0.7,
          gain: 0.06,
          filterType: 'bandpass',
          frequency: 500,
          frequencyEnd: 650,
          q: 1.5,
        });
        playTone({ frequency: 1250, duration: 0.05, gain: 0.08, type: 'square', delay: 0.72 });
        break;

      case 'warning':
      case 'caution':
        playTone({ frequency: 740, duration: 0.2, gain: 0.11, type: 'square' });
        break;

      default:
        // Unknown event names are silently ignored: audio must never
        // break the game loop.
        break;
    }
  }

  return {
    // Create (or resume) the AudioContext. Must be called from a user
    // gesture; main.js calls this on the first click/keypress. Safe to
    // call repeatedly, and safe where WebAudio is unavailable.
    start() {
      if (started) {
        if (audioContext && audioContext.state === 'suspended') {
          audioContext.resume();
        }
        return;
      }
      const AudioContextClass =
        typeof window !== 'undefined'
          ? window.AudioContext || window.webkitAudioContext
          : undefined;
      if (!AudioContextClass) return;
      try {
        audioContext = new AudioContextClass();
        buildPersistentGraph();
        started = true;
        if (audioContext.state === 'suspended') {
          audioContext.resume();
        }
        // Apply whatever state was set before the first gesture.
        this.setEngine(lastThrottle, lastAirspeed, lastEngineOn);
      } catch (error) {
        audioContext = null;
        started = false;
      }
    },

    // Continuous engine + wind. throttle 0..1, airspeed in m/s,
    // engineOn false cuts the engine (wind keeps following airspeed,
    // so an engine-out glide still sounds like moving air).
    setEngine(throttle, airspeed, engineOn) {
      lastThrottle = clamp(Number(throttle) || 0, 0, 1);
      lastAirspeed = clamp(Number(airspeed) || 0, 0, 120);
      lastEngineOn = engineOn === undefined ? lastEngineOn : Boolean(engineOn);
      if (!started || sputtering) return;

      const now = audioContext.currentTime;
      // Spool lag: a ~0.2 s time constant reads as the design's 0.6 s spool.
      const smoothing = 0.2;

      const engineFrequency =
        ENGINE_IDLE_HZ +
        lastThrottle * ENGINE_THROTTLE_HZ +
        Math.min(lastAirspeed, 60) * ENGINE_AIRSPEED_HZ_PER_MS;
      engineMainOscillator.frequency.setTargetAtTime(engineFrequency, now, smoothing);
      engineSubOscillator.frequency.setTargetAtTime(engineFrequency / 2, now, smoothing);
      engineHarmonicOscillator.frequency.setTargetAtTime(engineFrequency * 2, now, smoothing);
      engineFilter.frequency.setTargetAtTime(
        420 + lastThrottle * 1500 + lastAirspeed * 9,
        now,
        smoothing,
      );
      engineGain.gain.setTargetAtTime(
        lastEngineOn ? 0.045 + lastThrottle * 0.17 : 0,
        now,
        smoothing,
      );

      const windLevel = Math.pow(clamp((lastAirspeed - 5) / 60, 0, 1), 1.3) * 0.22;
      windGain.gain.setTargetAtTime(windLevel, now, 0.25);
      windFilter.frequency.setTargetAtTime(400 + lastAirspeed * 18, now, 0.25);
    },

    event(name) {
      try {
        handleEvent(name);
      } catch (error) {
        // Audio failures must never break the game loop.
      }
    },

    setMuted(value) {
      muted = Boolean(value);
      if (started && masterGain) {
        masterGain.gain.setTargetAtTime(
          muted ? 0 : MASTER_VOLUME,
          audioContext.currentTime,
          0.03,
        );
      }
    },

    isMuted() {
      return muted;
    },
  };
}

export default createAudio;
