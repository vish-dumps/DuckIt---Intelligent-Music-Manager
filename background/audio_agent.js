import { ScriptManager } from './script_manager.js';

export class AudioAgent {
    constructor(storageManager) {
        this.storage = storageManager;
        this.scriptManager = new ScriptManager();
        this.duckedByAgent = false;
        this.lastDuckMode = null;
        this.tabAudioState = new Map();
        this.NOTIFICATION_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAALElEQVR42mNgGAU0AxGMiYGB4T8TDLQZCxVgQWg0Go02GoxGY9FoNAyGQxEAAG4kBtuWNb49AAAAAElFTkSuQmCC';

        this.KNOWN_MUSIC_SITES = [
            'spotify.com',
            'music.youtube.com',
            'soundcloud.com',
            'open.spotify.com',
            'gaana.com',
            'wynk.in'
        ];

        this.ready = this.init();
    }

    async init() {
        await this.storage.whenReady();
        await this.registerSensorScript();
        await this.injectSensorIntoExistingTabs();
        await this.detectExistingMusicTabs();

        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (changeInfo.status === 'loading') {
                this.scriptManager.forget(tabId);
            }
            if (changeInfo.status === 'complete') {
                this.scriptManager.ensureSensor(tabId);
            }
            if (changeInfo.url) {
                this.checkAutoDetect(tabId, tab);
            }
        });
        chrome.tabs.onCreated.addListener((tab) => {
            this.scriptManager.ensureSensor(tab.id);
            this.checkAutoDetect(tab.id, tab);
        });
        chrome.tabs.onRemoved.addListener(this.handleTabRemoval.bind(this));

        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'set_music_tab') {
                this.setMusicTab(sender.tab ? sender.tab.id : request.tabId, { manual: true });
                sendResponse({ success: true });
            } else if (request.type === 'DUCKIT_AUDIO_STATE') {
                this.handleAudioState(sender.tab ? sender.tab.id : request.tabId, request.audible, request.source);
            }
            return true;
        });

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            const settingsKey = this.storage.STORAGE_KEYS.SETTINGS;
            if (changes[settingsKey]) {
                const newSettings = changes[settingsKey].newValue;
                if (this.duckedByAgent && newSettings && newSettings.enabled === false) {
                    const musicTabId = this.storage.getMusicTabIdSync();
                    if (musicTabId) {
                        this.restoreMusic(musicTabId, newSettings);
                    }
                }
            }
        });
    }

    async registerSensorScript() {
        try {
            await chrome.scripting.registerContentScripts([{
                id: 'duckit-audio-sensor',
                js: ['content/audio_sensor.js'],
                matches: ['<all_urls>'],
                runAt: 'document_start'
            }]);
        } catch (e) {
            // Already registered or not supported (older Chrome) — safe to ignore.
            console.debug('DuckIt sensor registration', e?.message || e);
        }
    }

    async injectSensorIntoExistingTabs() {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (!tab.url) continue;
            if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) continue;
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content/audio_sensor.js']
                });
            } catch (e) {
                console.debug('DuckIt sensor inject skip', tab.id, e?.message || e);
            }
        }
    }

    async setMusicTab(tabId, options = {}) {
        console.log(`Setting Music Tab: ${tabId}`);
        await this.storage.setMusicTabId(tabId);
        this.duckedByAgent = false;
        this.lastDuckMode = null;

        if (options.auto && options.tab) {
            this.notifyAutoDetect(options.tab);
        }
    }

    async notifyAutoDetect(tab) {
        const title = tab.title || 'Music Tab';
        let source = '';
        try {
            source = new URL(tab.url || '').hostname || '';
        } catch (_) {
            source = '';
        }
        try {
            const notification = {
                type: 'basic',
                iconUrl: this.NOTIFICATION_ICON,
                title: 'Music Tab Detected',
                message: `${title} is now set as your Music Tab`
            };
            if (source) notification.contextMessage = `Source: ${source}`;

            await chrome.notifications.create(notification);
        } catch (e) {
            console.debug('DuckIt notification failed', e?.message || e);
        }

        try {
            await chrome.runtime.sendMessage({
                type: 'DUCKIT_MUSIC_TAB_SET_AUTO',
                tabId: tab.id,
                title,
                url: tab.url
            });
        } catch (_) {
            // Popup may be closed; that's fine.
        }
    }

    async handleTabRemoval(tabId) {
        this.tabAudioState.delete(tabId);

        const musicTabId = this.storage.getMusicTabIdSync();
        if (tabId === musicTabId) {
            console.log("Music tab closed.");
            await this.storage.setMusicTabId(null);
            this.duckedByAgent = false;
            this.lastDuckMode = null;
        }
        this.scriptManager.forget(tabId);
    }

    isKnownMusicSite(url) {
        let hostname = '';
        try {
            hostname = new URL(url).hostname;
        } catch (_) {
            return false;
        }
        return this.KNOWN_MUSIC_SITES.some(site => hostname.includes(site));
    }

    checkAutoDetect(tabId, tab) {
        if (!tab || !tab.url) return;
        const musicTabId = this.storage.getMusicTabIdSync();
        if (musicTabId) return; // Already have one

        if (this.isKnownMusicSite(tab.url)) {
            console.log(`Auto-detected Music Site: ${tab.url}`);
            this.setMusicTab(tabId, { auto: true, tab });
        }
    }

    async detectExistingMusicTabs() {
        const current = this.storage.getMusicTabIdSync();
        if (current) return;

        try {
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
                if (!tab.url) continue;
                if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) continue;
                if (this.isKnownMusicSite(tab.url)) {
                    await this.setMusicTab(tab.id, { auto: true, tab });
                    break;
                }
            }
        } catch (e) {
            console.debug('DuckIt auto-detect scan failed', e?.message || e);
        }
    }

    async handleAudioState(tabId, audible, source) {
        if (!tabId) return;

        const prev = this.tabAudioState.get(tabId)?.audible;
        if (prev === audible) return;

        this.tabAudioState.set(tabId, { audible, source, ts: Date.now() });

        const musicTabId = await this.storage.getMusicTabId();
        if (!musicTabId) return;

        const settings = await this.storage.getSettings();
        if (!settings.enabled) return;

        const noisy = Array.from(this.tabAudioState.entries())
            .filter(([id, state]) => id !== musicTabId && state.audible);

        if (noisy.length > 0) {
            await this.duckMusic(musicTabId, settings);
        } else {
            await this.restoreMusic(musicTabId, settings);
        }
    }

    async duckMusic(musicTabId, settings) {
        if (this.duckedByAgent && this.lastDuckMode === settings.mode) return;

        console.log(`Ducking Music Tab (${settings.mode})...`);
        this.duckedByAgent = true;
        this.lastDuckMode = settings.mode;

        if (settings.mode === 'mute') {
            await chrome.tabs.update(musicTabId, { muted: true });
        } else if (settings.mode === 'pause') {
            await this.scriptManager.pause(musicTabId);
        } else if (settings.mode === 'volume') {
            const intensity = settings.duckingIntensity ?? 30;
            await this.scriptManager.duckVolume(musicTabId, intensity);
        }
    }

    async restoreMusic(musicTabId, settings) {
        if (!this.duckedByAgent) return;

        console.log("Restoring Music Tab...");

        if (settings.mode === 'mute') {
            await chrome.tabs.update(musicTabId, { muted: false });
        } else if (settings.mode === 'pause') {
            await this.scriptManager.resume(musicTabId);
        } else if (settings.mode === 'volume') {
            await this.scriptManager.restoreVolume(musicTabId);
        }

        this.duckedByAgent = false;
        this.lastDuckMode = null;
    }
}
