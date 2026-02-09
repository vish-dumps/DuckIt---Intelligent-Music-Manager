import { StorageManager } from '../background/storage.js';

const storage = new StorageManager();

// Elements
const toggleAgent = document.getElementById('toggleAgent');
const setMusicBtn = document.getElementById('setMusicBtn');
const statusTitle = document.getElementById('statusTitle');
const statusSubtitle = document.getElementById('statusSubtitle');
const duckingIndicator = document.getElementById('duckingIndicator');
const statusFavicon = document.getElementById('statusFavicon');
const modeRadios = document.querySelectorAll('input[name="mode"]');
const volumeControl = document.getElementById('volumeControl');
const volSlider = document.getElementById('volSlider');
const volValue = document.getElementById('volValue');
const toast = document.getElementById('toast');

// Focus Mode Elements
const toggleFocus = document.getElementById('toggleFocus');
const focusControls = document.getElementById('focusControls');
const focusStyle = document.getElementById('focusStyle');

let toastTimer = null;

async function init() {
    // Initial state
    const settings = await storage.getSettings();
    const musicTabId = await storage.getMusicTabId();

    // 1. Agent Enabled Toggle
    toggleAgent.checked = settings.enabled;

    // 2. Ducking Mode
    const currentMode = settings.mode || 'mute';
    const radio = document.querySelector(`input[name="mode"][value="${currentMode}"]`);
    if (radio) radio.checked = true;

    // 3. Volume Slider
    const currentVol = settings.duckingIntensity || 30;
    volSlider.value = currentVol;
    volValue.textContent = `${currentVol}%`;

    if (currentMode === 'volume') {
        volumeControl.classList.remove('hidden');
    } else {
        volumeControl.classList.add('hidden');
    }

    // 4. Focus Mode State
    if (toggleFocus && focusControls && focusStyle) {
        toggleFocus.checked = settings.focusEnabled || false;
        if (settings.focusEnabled) {
            focusControls.classList.remove('hidden');
        } else {
            focusControls.classList.add('hidden');
        }
        if (settings.focusStyle) {
            focusStyle.value = settings.focusStyle;
        }
    }

    await updateStatus(musicTabId);

    // Event Listeners
    // Toggle agent
    toggleAgent.addEventListener('change', async (e) => {
        const s = await storage.getSettings();
        s.enabled = e.target.checked;
        await storage.updateSettings(s);
        updateStatus();
    });

    // Mode selection
    modeRadios.forEach((r) => {
        r.addEventListener('change', async (e) => {
            const s = await storage.getSettings();
            s.mode = e.target.value;
            await storage.updateSettings(s);

            if (s.mode === 'volume') {
                volumeControl.classList.remove('hidden');
            } else {
                volumeControl.classList.add('hidden');
            }
        });
    });

    // Slider live display
    volSlider.addEventListener('input', (e) => {
        volValue.textContent = `${e.target.value}%`;
    });

    // Slider commit
    volSlider.addEventListener('change', async (e) => {
        const s = await storage.getSettings();
        s.duckingIntensity = parseInt(e.target.value, 10);
        await storage.updateSettings(s);
    });

    // Focus Mode Listeners
    if (toggleFocus && focusControls && focusStyle) {
        toggleFocus.addEventListener('change', async (e) => {
            const s = await storage.getSettings();
            s.focusEnabled = e.target.checked;
            await storage.updateSettings(s);

            if (s.focusEnabled) {
                focusControls.classList.remove('hidden');
            } else {
                focusControls.classList.add('hidden');
            }
        });

        focusStyle.addEventListener('change', async (e) => {
            const s = await storage.getSettings();
            s.focusStyle = e.target.value;
            await storage.updateSettings(s);
        });
    }

    // Manual set music tab
    setMusicBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            await chrome.runtime.sendMessage({ action: 'set_music_tab', tabId: tab.id });
            setTimeout(() => updateStatus(), 100);
        }
    });
}

function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

async function updateStatus(musicTabIdOverride) {
    const musicTabId = musicTabIdOverride !== undefined ? musicTabIdOverride : await storage.getMusicTabId();
    const settings = await storage.getSettings();

    if (!settings.enabled) {
        statusTitle.textContent = 'Agent Disabled';
        statusSubtitle.textContent = 'Turn on to start ducking';
        duckingIndicator.classList.add('hidden');
        setFavicon(null);
        return;
    }

    if (musicTabId) {
        try {
            const tab = await chrome.tabs.get(musicTabId);
            statusTitle.textContent = 'Music Active';
            statusSubtitle.textContent = tab.title;
            setMusicBtn.textContent = 'Update Music Tab';
            setFavicon(tab.favIconUrl);

            // If focus mode enabled, maybe show something? 
            // For now, adhere to existing logic for ducking indicator
            if (settings.mode === 'mute' && tab.mutedInfo && tab.mutedInfo.muted) {
                duckingIndicator.classList.remove('hidden');
            } else {
                duckingIndicator.classList.add('hidden');
            }
        } catch (e) {
            statusTitle.textContent = 'Music Tab Lost';
            statusSubtitle.textContent = 'Tab was closed';
            duckingIndicator.classList.add('hidden');
            setFavicon(null);
        }
    } else {
        statusTitle.textContent = 'No Music Tab';
        statusSubtitle.textContent = 'Open music to auto-detect';
        setMusicBtn.textContent = 'Set Current Tab';
        duckingIndicator.classList.add('hidden');
        setFavicon(null);
    }
}

document.addEventListener('DOMContentLoaded', init);

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'DUCKIT_MUSIC_TAB_SET_AUTO') {
        const name = message.title || 'Music Tab';
        let host = '';
        try {
            host = message.url ? new URL(message.url).hostname : '';
        } catch (_) {
            host = '';
        }
        const label = host ? `${name} - ${host}` : name;
        showToast(`Music tab set automatically: ${label}`);
        updateStatus(message.tabId);
    }
});

function setFavicon(url) {
    if (!statusFavicon) return;
    if (url) {
        statusFavicon.src = url;
        statusFavicon.classList.remove('hidden');
    } else {
        statusFavicon.src = '../icons/icon128.png';
        statusFavicon.classList.remove('hidden');
    }
}
