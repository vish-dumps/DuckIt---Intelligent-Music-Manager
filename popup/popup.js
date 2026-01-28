import { StorageManager } from '../background/storage.js';

const storage = new StorageManager();

// Elements
const toggleAgent = document.getElementById('toggleAgent');
const setMusicBtn = document.getElementById('setMusicBtn');
const statusTitle = document.getElementById('statusTitle');
const statusSubtitle = document.getElementById('statusSubtitle');
const duckingIndicator = document.getElementById('duckingIndicator');
const modeRadios = document.querySelectorAll('input[name="mode"]');
const volumeControl = document.getElementById('volumeControl');
const volSlider = document.getElementById('volSlider');
const volValue = document.getElementById('volValue');
const toast = document.getElementById('toast');
let toastTimer = null;

async function init() {
    // 1. Get current state (async for first load)
    const settings = await storage.getSettings();
    const musicTabId = await storage.getMusicTabId();

    // 2. Render State
    toggleAgent.checked = settings.enabled;

    // Set Mode Radio
    const currentMode = settings.mode || 'mute';
    const radio = document.querySelector(`input[name="mode"][value="${currentMode}"]`);
    if (radio) radio.checked = true;

    // Set Volume
    const currentVol = settings.duckingIntensity || 30;
    volSlider.value = currentVol;
    volValue.textContent = `${currentVol}%`;

    // Toggle Volume Slider visibility
    if (currentMode === 'volume') {
        volumeControl.classList.remove('hidden');
    }

    await updateStatus(musicTabId);

    // 3. Listeners

    // Toggle
    toggleAgent.addEventListener('change', async (e) => {
        const s = await storage.getSettings();
        s.enabled = e.target.checked;
        await storage.updateSettings(s);
        updateStatus(); // Refresh status text
    });

    // Modes
    modeRadios.forEach(r => {
        r.addEventListener('change', async (e) => {
            const s = await storage.getSettings();
            s.mode = e.target.value;
            await storage.updateSettings(s);

            // Show/Hide Slider
            if (s.mode === 'volume') {
                volumeControl.classList.remove('hidden');
            } else {
                volumeControl.classList.add('hidden');
            }
        });
    });

    // Slider
    volSlider.addEventListener('input', (e) => {
        volValue.textContent = `${e.target.value}%`;
    });

    volSlider.addEventListener('change', async (e) => {
        const s = await storage.getSettings();
        s.duckingIntensity = parseInt(e.target.value);
        await storage.updateSettings(s);
    });

    // Set Tab
    setMusicBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            await chrome.runtime.sendMessage({ action: 'set_music_tab', tabId: tab.id });
            // Small delay to allow bg to update
            setTimeout(() => updateStatus(), 100);
        }
    });

    // Polling for live status updates?
    // For now rely on open.
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
        statusTitle.textContent = "Agent Disabled";
        statusSubtitle.textContent = "Turn on to start ducking";
        duckingIndicator.classList.add('hidden');
        return;
    }

    if (musicTabId) {
        try {
            const tab = await chrome.tabs.get(musicTabId);
            statusTitle.textContent = "Music Active";
            statusSubtitle.textContent = tab.title;
            setMusicBtn.textContent = "Update Music Tab";

            // Heuristic for "Ducking Active": 
            // We can't easily know if the agent *currently* has it ducked without tracking it in storage.
            // But we can check if tab is muted (if mode=mute).
            if (settings.mode === 'mute' && tab.mutedInfo && tab.mutedInfo.muted) {
                duckingIndicator.classList.remove('hidden');
            } else {
                duckingIndicator.classList.add('hidden');
            }

        } catch (e) {
            statusTitle.textContent = "Music Tab Lost";
            statusSubtitle.textContent = "Tab was closed";
            duckingIndicator.classList.add('hidden');
        }
    } else {
        statusTitle.textContent = "No Music Tab";
        statusSubtitle.textContent = "Open music to auto-detect";
        setMusicBtn.textContent = "Set Current Tab";
        duckingIndicator.classList.add('hidden');
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
        const label = host ? `${name} · ${host}` : name;
        showToast(`🎵 ${label} set automatically`);
        updateStatus(message.tabId);
    }
});
