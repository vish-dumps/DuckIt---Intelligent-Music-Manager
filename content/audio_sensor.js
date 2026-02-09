(() => {
    if (window.__duckitSensorLoaded) return;
    window.__duckitSensorLoaded = true;

    // --- State ---
    const playingMedia = new Set();
    const pausedByDuckit = new Set();
    const duckedVolumes = new Map();
    const contextInfo = new Map();

    let ducked = false;
    let duckFraction = 1;
    let lastAudible = null;

    // Focus Mode State
    let focusModeEnabled = false;
    let focusStyle = 'normal';
    let focusParams = {};
    const mediaElementSources = new WeakMap(); // Map<HTMLMediaElement, MediaElementSourceNode>
    const focusEngineCache = new WeakMap(); // Map<HTMLMediaElement, FocusEngine>
    let activeFocusEngines = new WeakMap(); // Map<HTMLMediaElement, FocusEngine>
    let globalAudioContext = null;

    // --- Utils ---
    const postMessage = (payload) => {
        try {
            chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
        } catch (_) { /* ignore */ }
    };

    const getGlobalContext = () => {
        if (!globalAudioContext) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) globalAudioContext = new Ctx();
        }
        return globalAudioContext;
    };

    // --- Impulse Response Generator ---
    const createImpulseResponse = (duration, decay, reverse) => {
        const ctx = getGlobalContext();
        if (!ctx) return null;
        const sampleRate = ctx.sampleRate;
        const length = sampleRate * duration;
        const impulse = ctx.createBuffer(2, length, sampleRate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            const n = reverse ? length - i : i;
            let val = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
            left[i] = val;
            right[i] = val;
        }
        return impulse;
    };

    // --- Focus Engine ---
    class FocusEngine {
        constructor(mediaElement) {
            this.mediaElement = mediaElement;
            this.ctx = getGlobalContext();
            this.source = null;
            this.filter = null;
            this.convolver = null;
            this.wetTone = null;
            this.focusGain = null;
            this.duckGain = null;
            this.masterGain = null; // Connects to destination
            this.active = false;

            this.initGraph();
        }

        initGraph() {
            if (!this.ctx) return;

            // Try to create source. Note: safe to call only once per element.
            // If already created by page, this might crash or fail silent.
            // We'll wrap in try-catch.
            const cachedSource = mediaElementSources.get(this.mediaElement);
            if (cachedSource) {
                this.source = cachedSource;
            } else {
                try {
                    // Check if we can/should attach. 
                    // In a real pro extension, we'd shadow createMediaElementSource to capture page usage.
                    // For now, we attempt to hook.
                    this.source = this.ctx.createMediaElementSource(this.mediaElement);
                    mediaElementSources.set(this.mediaElement, this.source);
                } catch (e) {
                    console.warn('DuckIt: Could not create MediaElementSource (already connected?)', e);
                    // Fallback: we cannot process audio if we can't get source.
                    // But we can still control volume.
                    return;
                }
            }

            if (!this.source) return;

            this.filter = this.ctx.createBiquadFilter();
            this.convolver = this.ctx.createConvolver();
            this.wetTone = this.ctx.createBiquadFilter();
            this.focusGain = this.ctx.createGain();
            this.duckGain = this.ctx.createGain();

            // Default graph connections
            // Source -> Filter -> Convolver(Parallel) -> FocusGain -> DuckGain -> Destination
            // Note: Reverb is usually parallel (Wet/Dry).

            this.dryGain = this.ctx.createGain();
            this.wetGain = this.ctx.createGain();

            // Wiring
            this.source.disconnect();
            this.source.connect(this.filter);

            // Filter splits to Dry and Wet path
            this.filter.connect(this.dryGain);
            this.filter.connect(this.convolver);

            // Wet path: Convolver -> tone filter -> wet gain
            this.convolver.connect(this.wetTone);
            this.wetTone.connect(this.wetGain);

            // Merge Wet and Dry
            this.dryGain.connect(this.focusGain);
            this.wetGain.connect(this.focusGain);

            this.focusGain.connect(this.duckGain);
            this.duckGain.connect(this.ctx.destination);

            this.applyStyle();
        }

        applyStyle() {
            if (!this.filter) return;

            const now = this.ctx.currentTime;

            // Style definitions
            // 'normal', 'muffle', 'far_away', 'soft_room', 'focus_background'

            const defaults = {
                filterType: 'allpass',
                filterFreq: 20000,
                dry: 1.0,
                wet: 0.0,
                wetLowpass: 20000,
                gain: 1.0,
                reverbDuration: 0,
                reverbDecay: 0
            };

            let p = { ...defaults };

            switch (focusStyle) {
                case 'muffle':
                    p.filterType = 'lowpass';
                    p.filterFreq = 800;
                    p.gain = 0.9;
                    break;
                case 'far_away':
                    p.filterType = 'lowpass';
                    p.filterFreq = 1000;
                    p.dry = 0.6;
                    p.wet = 0.4;
                    p.gain = 0.7;
                    p.reverbDuration = 2.0;
                    p.reverbDecay = 2.0;
                    break;
                case 'soft_room':
                    p.filterType = 'allpass'; // keep direct signal clear
                    p.filterFreq = 20000;
                    p.dry = 0.85;
                    p.wet = 0.25;
                    p.gain = 0.9;
                    p.wetLowpass = 3000;
                    p.reverbDuration = 1.0;
                    p.reverbDecay = 2.2;
                    break;
                case 'focus_background': // Deep Focus
                    p.filterType = 'lowpass';
                    p.filterFreq = 600;
                    p.dry = 0.7;
                    p.wet = 0.3;
                    p.gain = 0.75;
                    p.reverbDuration = 2.5;
                    p.reverbDecay = 3.0;
                    break;
                case 'normal':
                default:
                    // defaults apply
                    break;
            }

            // Apply paremeters
            // Filter
            if (p.filterType === 'allpass') {
                // effectively bypass filter
                this.filter.type = 'lowpass';
                this.filter.frequency.setTargetAtTime(22000, now, 0.1);
            } else {
                this.filter.type = p.filterType;
                this.filter.frequency.setTargetAtTime(p.filterFreq, now, 0.1);
            }

            // Reverb (Impulse)
            if (p.wet > 0 && (!this.convolver.buffer || this.lastStyle !== focusStyle)) {
                this.convolver.buffer = createImpulseResponse(p.reverbDuration, p.reverbDecay, false);
            }

            // Wet tone shaping (wet path only)
            if (this.wetTone) {
                this.wetTone.type = 'lowpass';
                this.wetTone.frequency.setTargetAtTime(p.wetLowpass, now, 0.1);
            }

            // Gains
            this.dryGain.gain.setTargetAtTime(p.dry, now, 0.1);
            this.wetGain.gain.setTargetAtTime(p.wet, now, 0.1);
            this.focusGain.gain.setTargetAtTime(p.gain, now, 0.1);

            this.lastStyle = focusStyle;

            // Ensure Ducking Gain is maintained
            this.updateDucking();
        }

        updateDucking() {
            if (!this.duckGain) return;
            const now = this.ctx.currentTime;
            const target = ducked ? duckFraction : 1.0;
            this.duckGain.gain.setTargetAtTime(target, now, 0.1);
        }

        destroy() {
            try {
                this.source.disconnect();
                this.duckGain.disconnect();
                // If we could, we would reconnect source to destination directly, 
                // but createMediaElementSource disconnects it forever from its original graph in some browsers 
                // unless we reconnect it.
                this.source.connect(this.ctx.destination);
            } catch (_) { }
            this.source = null;
            this.filter = null;
        }
    }

    const ensureFocusEngine = (el) => {
        if (!focusModeEnabled) return;
        if (activeFocusEngines.has(el)) return;

        // Only attach to relevant media
        if (el.duration < 5 && el.tagName === 'AUDIO') return; // Skip short sfx

        let engine = focusEngineCache.get(el);
        if (!engine) {
            engine = new FocusEngine(el);
            if (engine.source) {
                focusEngineCache.set(el, engine);
            }
        } else if (!engine.source) {
            engine.initGraph();
        }

        if (engine && engine.source) {
            activeFocusEngines.set(el, engine);
        }
    };

    const removeFocusEngine = (el) => {
        const engine = activeFocusEngines.get(el);
        if (engine) {
            engine.destroy();
            activeFocusEngines.delete(el);
        }
    };

    const updateAllFocusEngines = () => {
        if (focusModeEnabled) {
            document.querySelectorAll('audio,video').forEach(el => {
                ensureFocusEngine(el);
                const engine = activeFocusEngines.get(el);
                if (engine) engine.applyStyle();
            });
        } else {
            // Remove all
            // Ideally we iterate weakmap, but we can't.
            // So we iterate DOM.
            document.querySelectorAll('audio,video').forEach(el => removeFocusEngine(el));
        }
    };

    // --- Audio Logic ---

    const webAudioAudible = () => {
        for (const info of contextInfo.values()) {
            if (info.running && info.sources > 0) return true;
        }
        return false;
    };

    const recomputeAudible = (sourceHint) => {
        const audible = playingMedia.size > 0 || webAudioAudible();
        if (audible === lastAudible) return;
        lastAudible = audible;
        postMessage({
            type: 'DUCKIT_AUDIO_STATE',
            audible,
            source: sourceHint || (playingMedia.size > 0 ? 'media' : 'webaudio')
        });
    };

    // ---- Media elements ------------------------------------------------------
    const trackedMedia = new WeakSet();
    const mediaEvents = [
        'play', 'playing', 'pause', 'ended', 'suspend', 'stalled',
        'emptied', 'abort', 'volumechange', 'seeking', 'seeked',
        'loadeddata', 'ratechange', 'waiting', 'canplay'
    ];

    const updateMediaState = (el) => {
        const audible = !el.paused && !el.ended && !el.muted && el.volume > 0;
        if (audible) {
            playingMedia.add(el);
        } else {
            playingMedia.delete(el);
        }

        // Focus Engine hook
        if (focusModeEnabled && audible) {
            ensureFocusEngine(el);
        }

        // Apply Ducking
        if (activeFocusEngines.has(el)) {
            activeFocusEngines.get(el).updateDucking();
        } else {
            // Fallback volume ducking
            if (ducked) applyDuckToElement(el);
        }

        recomputeAudible('media');
    };

    const monitorMediaElement = (el) => {
        if (!(el instanceof HTMLMediaElement)) return;
        if (trackedMedia.has(el)) return;
        trackedMedia.add(el);

        const handler = () => updateMediaState(el);
        mediaEvents.forEach(ev => el.addEventListener(ev, handler, { passive: true }));
        updateMediaState(el);
    };

    const scanForMedia = (root = document) => {
        root.querySelectorAll?.('audio,video').forEach(monitorMediaElement);
    };

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            mutation.addedNodes.forEach(node => {
                if (node instanceof HTMLMediaElement) {
                    monitorMediaElement(node);
                } else if (node.querySelectorAll) {
                    scanForMedia(node);
                }
            });
        }
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });

    document.addEventListener('DOMContentLoaded', () => scanForMedia());
    scanForMedia();

    // ---- Web Audio Interception -----------------------------------------------
    const setupContext = (ctx) => {
        if (contextInfo.has(ctx)) return;

        const masterGain = ctx.createGain();
        masterGain.gain.value = 1;
        masterGain.connect(ctx.destination);
        ctx.__duckitMasterGain = masterGain;

        const info = {
            masterGain,
            originalGain: 1,
            ducked: false,
            pausedByDuckit: false,
            sources: 0,
            running: ctx.state === 'running'
        };
        contextInfo.set(ctx, info);

        if (ducked) {
            info.ducked = true;
            info.masterGain.gain.value = info.originalGain * duckFraction;
        }

        ctx.addEventListener('statechange', () => {
            info.running = ctx.state === 'running';
            recomputeAudible('webaudio');
        });
    };

    // We keep the simpler interception logic for Web Audio unless user asks for Focus on WebAudio too.
    // Spec says "Attach... to the selected Music Tab".
    // For now, FocusEngine is only for HTMLMediaElement.

    const OriginalAudioContext = window.AudioContext;
    if (OriginalAudioContext) {
        const DuckitAudioContext = function (...args) {
            const ctx = new OriginalAudioContext(...args);
            setupContext(ctx);
            return ctx;
        };
        DuckitAudioContext.prototype = OriginalAudioContext.prototype;
        window.AudioContext = DuckitAudioContext;
    }

    const OriginalWebkitAudioContext = window.webkitAudioContext;
    if (OriginalWebkitAudioContext) {
        const DuckitWebkitContext = function (...args) {
            const ctx = new OriginalWebkitAudioContext(...args);
            setupContext(ctx);
            return ctx;
        };
        DuckitWebkitContext.prototype = OriginalWebkitAudioContext.prototype;
        window.webkitAudioContext = DuckitWebkitContext;
    }

    const originalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...rest) {
        try {
            if (destination instanceof AudioDestinationNode && destination.context && destination.context.__duckitMasterGain) {
                return originalConnect.call(this, destination.context.__duckitMasterGain, ...rest);
            }
        } catch (_) { }
        return originalConnect.call(this, destination, ...rest);
    };

    const markSourceStart = (ctx) => {
        if (!contextInfo.has(ctx)) setupContext(ctx);
        const info = contextInfo.get(ctx);
        if (info) info.sources = (info.sources || 0) + 1;
        recomputeAudible('webaudio');
    };

    const markSourceStop = (ctx) => {
        const info = contextInfo.get(ctx);
        if (info) info.sources = Math.max(0, (info.sources || 0) - 1);
        recomputeAudible('webaudio');
    };

    if (window.AudioScheduledSourceNode) {
        const originalStart = AudioScheduledSourceNode.prototype.start;
        AudioScheduledSourceNode.prototype.start = function (...args) {
            markSourceStart(this.context);
            try {
                this.addEventListener('ended', () => markSourceStop(this.context), { once: true });
            } catch (_) {
                this.onended = () => markSourceStop(this.context);
            }
            return originalStart.apply(this, args);
        };

        const originalStop = AudioScheduledSourceNode.prototype.stop;
        AudioScheduledSourceNode.prototype.stop = function (...args) {
            markSourceStop(this.context);
            return originalStop.apply(this, args);
        };
    }

    // ---- Duck / pause control -------------------------------------------------
    const applyDuckToElement = (el) => {
        if (!(el instanceof HTMLMediaElement)) return;

        // NOTE: If FocusEngine is active on this element, we let FocusEngine handle ducking via GainNode.
        if (activeFocusEngines.has(el)) {
            activeFocusEngines.get(el).updateDucking();
            return;
        }

        if (!ducked) return;
        if (!duckedVolumes.has(el)) {
            duckedVolumes.set(el, el.volume);
        }
        const base = duckedVolumes.get(el);
        const target = Math.max(0, Math.min(1, base * duckFraction));
        el.volume = target;
    };

    const applyDuckToContexts = () => {
        for (const info of contextInfo.values()) {
            if (!info.masterGain) continue;
            if (!info.ducked) {
                info.originalGain = info.masterGain.gain.value;
            }
            info.ducked = true;
            info.masterGain.gain.value = info.originalGain * duckFraction;
        }
    };

    const restoreDuckFromContexts = () => {
        for (const info of contextInfo.values()) {
            if (!info.masterGain) continue;
            info.masterGain.gain.value = info.originalGain ?? 1;
            info.ducked = false;
        }
    };

    const pauseMediaElements = () => {
        document.querySelectorAll('audio,video').forEach((el) => {
            if (!el.paused && !el.ended) {
                pausedByDuckit.add(el);
                try { el.pause(); } catch (_) { }
            }
        });
    };

    const resumeMediaElements = () => {
        for (const el of pausedByDuckit) {
            try { el.play(); } catch (_) { }
        }
        pausedByDuckit.clear();
    };

    // Global duck/restore
    const updateGlobalDucking = () => {
        document.querySelectorAll('audio,video').forEach(applyDuckToElement);
        if (ducked) {
            applyDuckToContexts();
        } else {
            restoreDuckFromContexts();
        }
    };

    const duckVolume = (fraction) => {
        ducked = true;
        duckFraction = Math.max(0, Math.min(1, fraction));
        updateGlobalDucking();
    };

    const restoreVolume = () => {
        ducked = false;
        duckFraction = 1;
        // Restore elements without FocusEngine
        for (const [el, originalVol] of duckedVolumes.entries()) {
            // If focused, FocusEngine handles gain reset.
            // If not focused, we restore simple volume.
            if (!activeFocusEngines.has(el)) {
                el.volume = originalVol;
            }
        }
        duckedVolumes.clear();
        updateGlobalDucking();
    };

    // ---- Message router ------------------------------------------------------
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!request || !request.type) return;
        switch (request.type) {
            case 'DUCKIT_PING':
                sendResponse?.({ ok: true });
                break;

            // Core Ducking
            case 'PAUSE_AUDIO':
                // Focus Mode typically stays active during pause, we just pause playback.
                pauseMediaElements();
                // pauseContexts(); // Existing logic
                sendResponse?.({ ok: true });
                break;
            case 'RESUME_AUDIO':
                resumeMediaElements();
                // resumeContexts();
                sendResponse?.({ ok: true });
                break;
            case 'SET_VOLUME':
                duckVolume(typeof request.value === 'number' ? request.value : 0.3);
                sendResponse?.({ ok: true });
                break;
            case 'RESTORE_VOLUME':
                restoreVolume();
                sendResponse?.({ ok: true });
                break;

            // Focus Mode
            case 'ENABLE_FOCUS':
                focusModeEnabled = true;
                focusStyle = request.style || 'normal';
                updateAllFocusEngines();
                sendResponse?.({ ok: true });
                break;
            case 'DISABLE_FOCUS':
                focusModeEnabled = false;
                updateAllFocusEngines();
                sendResponse?.({ ok: true });
                break;
            case 'SET_FOCUS_STYLE':
                focusStyle = request.style;
                updateAllFocusEngines();
                sendResponse?.({ ok: true });
                break;

            default:
                break;
        }
        return true;
    });

    // kick off initial state
    recomputeAudible('init');
})();
