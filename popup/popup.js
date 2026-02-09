import { StorageManager } from '../background/storage.js';

const storage = new StorageManager();

// NEW UI Elements
const mainFocusBtn = document.getElementById('mainFocusBtn');
const focusIcon = document.getElementById('focusIcon');
const focusButtonText = document.getElementById('focusButtonText');
const focusButtonContainer = document.getElementById('focusButtonContainer');
const focusModeLabel = document.getElementById('focusModeLabel');
const focusStatusBadge = document.getElementById('focusStatusBadge');
const orbitDots = document.querySelectorAll('.orbit-dot');

const setMusicBtn = document.getElementById('setMusicBtn');
const statusTitle = document.getElementById('statusTitle');
const statusSubtitle = document.getElementById('statusSubtitle');
const statusFavicon = document.getElementById('statusFavicon');
const toggleAgent = document.getElementById('toggleAgent');
const modeRadios = document.querySelectorAll('input[name="mode"]');
const volumeControl = document.getElementById('volumeControl');
const volSlider = document.getElementById('volSlider');
const volValue = document.getElementById('volValue');
const toast = document.getElementById('toast');

let toastTimer = null;

async function init() {
    const settings = await storage.getSettings();
    const musicTabId = await storage.getMusicTabId();

    updateFocusUI(settings);
    updateDuckingUI(settings);
    await updateStatus(musicTabId);

    // --- Event Listeners ---

    // 1. Focus Toggle (Central Button)
    mainFocusBtn.addEventListener('click', async () => {
        const s = await storage.getSettings();
        s.focusEnabled = !s.focusEnabled; // toggle
        await storage.updateSettings(s);
        updateFocusUI(s);
    });

    // 2. Focus Styles (Orbit Dots)
    orbitDots.forEach(dot => {
        dot.addEventListener('click', async (e) => {
            // If focus is off, maybe turn it on? 
            // UX decision: Yes, selecting a style should auto-enable focus.
            const style = dot.dataset.style;
            const s = await storage.getSettings();

            s.focusStyle = style;
            if (!s.focusEnabled) s.focusEnabled = true;

            await storage.updateSettings(s);
            updateFocusUI(s);
        });
    });

    // 3. Priority Ducking Toggle
    toggleAgent.addEventListener('change', async (e) => {
        const s = await storage.getSettings();
        s.enabled = e.target.checked;
        await storage.updateSettings(s);
        updateStatus();
    });

    // 4. Ducking Modes
    modeRadios.forEach((r) => {
        r.addEventListener('change', async (e) => {
            const s = await storage.getSettings();
            s.mode = e.target.value;
            await storage.updateSettings(s);
            updateDuckingUI(s);
        });
    });

    // 5. Volume Slider
    volSlider.addEventListener('input', (e) => {
        volValue.textContent = `${e.target.value}%`;
    });
    volSlider.addEventListener('change', async (e) => {
        const s = await storage.getSettings();
        s.duckingIntensity = parseInt(e.target.value, 10);
        await storage.updateSettings(s);
    });

    // 6. Set Music Tab
    setMusicBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            await chrome.runtime.sendMessage({ action: 'set_music_tab', tabId: tab.id });
            showToast('Music Tab Updated');
            setTimeout(() => updateStatus(), 100);
        }
    });
}

function formatFocusStyle(style) {
    if (!style) return 'Normal';
    if (style === 'focus_background') return 'Deep Focus';
    return style.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function updateFocusUI(settings) {
    const enabled = settings.focusEnabled;
    const style = settings.focusStyle || 'normal';
    const styleLabel = formatFocusStyle(style);

    // Update Central Button
    if (enabled) {
        mainFocusBtn.classList.add('active');
        focusIcon.src = '../icons/FOCUS ON.png';
        focusStatusBadge.textContent = 'FOCUS ON';
        focusStatusBadge.classList.add('active');
        focusButtonText.textContent = 'FOCUS ON';
        focusButtonContainer.classList.add('focus-on');
    } else {
        mainFocusBtn.classList.remove('active');
        focusIcon.src = '../icons/FOCUS OFF.png';
        focusStatusBadge.textContent = 'FOCUS OFF';
        focusStatusBadge.classList.remove('active');
        focusButtonText.textContent = 'FOCUS OFF';
        focusButtonContainer.classList.remove('focus-on');
    }

    if (focusModeLabel) {
        focusModeLabel.textContent = `Focus mode: ${styleLabel}`;
        focusModeLabel.classList.toggle('active', enabled);
    }

    // Update Dots
    orbitDots.forEach(dot => {
        if (dot.dataset.style === style) {
            dot.classList.add('selected');
        } else {
            dot.classList.remove('selected');
        }
    });
}

function updateDuckingUI(settings) {
    toggleAgent.checked = settings.enabled;

    // Radio
    const radio = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
    if (radio) radio.checked = true;

    // Volume
    volSlider.value = settings.duckingIntensity || 30;
    volValue.textContent = `${settings.duckingIntensity || 30}%`;

    if (settings.mode === 'volume') {
        volumeControl.classList.remove('hidden');
    } else {
        volumeControl.classList.add('hidden');
    }
}

function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

async function updateStatus(musicTabIdOverride) {
    const musicTabId = musicTabIdOverride !== undefined ? musicTabIdOverride : await storage.getMusicTabId();
    const settings = await storage.getSettings();

    if (musicTabId) {
        try {
            const tab = await chrome.tabs.get(musicTabId);
            statusTitle.textContent = tab.title;
            // statusSubtitle.textContent = new URL(tab.url).hostname;
            setFavicon(tab.favIconUrl);
            setMusicBtn.textContent = 'Update';
        } catch (e) {
            statusTitle.textContent = 'Music Tab Lost';
            statusSubtitle.textContent = 'Tab was closed';
            setFavicon(null);
            setMusicBtn.textContent = 'Set';
        }
    } else {
        statusTitle.textContent = 'No Music Detected';
        statusSubtitle.textContent = 'Open Spotify, YT, etc.';
        setFavicon(null);
        setMusicBtn.textContent = 'Set Current';
    }
}

function setFavicon(url) {
    if (!statusFavicon) return;
    if (url) {
        statusFavicon.src = url;
        statusFavicon.classList.remove('hidden');
    } else {
        statusFavicon.classList.add('hidden');
    }
}


document.addEventListener('DOMContentLoaded', init);

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'DUCKIT_MUSIC_TAB_SET_AUTO') {
        updateStatus(message.tabId);
        showToast('Music Tab Detected');
    }
});
