(() => {
    if (window.__duckitSensorLoaded) return;
    window.__duckitSensorLoaded = true;

    const playingMedia = new Set();
    const pausedByDuckit = new Set();
    const duckedVolumes = new Map();
    const contextInfo = new Map();

    let ducked = false;
    let duckFraction = 1;
    let lastAudible = null;

    const postMessage = (payload) => {
        try {
            chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
        } catch (_) {
            // ignore if service worker asleep
        }
    };

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

        if (ducked) applyDuckToElement(el);
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

    // ---- Web Audio -----------------------------------------------------------
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
        } catch (_) {
            // ignore
        }
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

    const pauseContexts = () => {
        for (const [ctx, info] of contextInfo.entries()) {
            if (ctx.state === 'running') {
                info.pausedByDuckit = true;
                ctx.suspend().catch(() => {});
            }
        }
    };

    const resumeContexts = () => {
        for (const [ctx, info] of contextInfo.entries()) {
            if (info.pausedByDuckit) {
                ctx.resume().catch(() => {});
                info.pausedByDuckit = false;
            }
        }
    };

    const pauseMediaElements = () => {
        document.querySelectorAll('audio,video').forEach((el) => {
            if (!el.paused && !el.ended) {
                pausedByDuckit.add(el);
                try { el.pause(); } catch (_) {}
            }
        });
    };

    const resumeMediaElements = () => {
        for (const el of pausedByDuckit) {
            try { el.play(); } catch (_) {}
        }
        pausedByDuckit.clear();
    };

    const duckVolume = (fraction) => {
        ducked = true;
        duckFraction = Math.max(0, Math.min(1, fraction));
        document.querySelectorAll('audio,video').forEach(applyDuckToElement);
        applyDuckToContexts();
    };

    const restoreVolume = () => {
        ducked = false;
        duckFraction = 1;
        for (const [el, originalVol] of duckedVolumes.entries()) {
            el.volume = originalVol;
        }
        duckedVolumes.clear();
        restoreDuckFromContexts();
    };

    // ---- Message router ------------------------------------------------------
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!request || !request.type) return;
        switch (request.type) {
            case 'DUCKIT_PING':
                sendResponse?.({ ok: true });
                break;
            case 'PAUSE_AUDIO':
                pauseMediaElements();
                pauseContexts();
                sendResponse?.({ ok: true });
                break;
            case 'RESUME_AUDIO':
                resumeMediaElements();
                resumeContexts();
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
            default:
                break;
        }
        return true;
    });

    // kick off initial state
    recomputeAudible('init');
})();
