export class StorageManager {
    constructor() {
        this.STORAGE_KEYS = {
            MUSIC_TAB_ID: 'duckit_music_tab_id',
            SETTINGS: 'duckit_settings'
        };

        this.cache = {
            musicTabId: null,
            settings: { mode: 'mute', enabled: true, duckingIntensity: 30 }
        };

        this.ready = this.init();

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            if (changes[this.STORAGE_KEYS.MUSIC_TAB_ID]) {
                this.cache.musicTabId = changes[this.STORAGE_KEYS.MUSIC_TAB_ID].newValue || null;
            }
            if (changes[this.STORAGE_KEYS.SETTINGS]) {
                this.cache.settings = changes[this.STORAGE_KEYS.SETTINGS].newValue || this.cache.settings;
            }
        });
    }

    async init() {
        const stored = await chrome.storage.local.get([
            this.STORAGE_KEYS.MUSIC_TAB_ID,
            this.STORAGE_KEYS.SETTINGS
        ]);

        this.cache.musicTabId = stored[this.STORAGE_KEYS.MUSIC_TAB_ID] || null;
        const fallbackSettings = {
            mode: 'mute',
            enabled: true,
            duckingIntensity: 30,
            focusEnabled: false,
            focusStyle: 'normal'
        };

        const incomingSettings = stored[this.STORAGE_KEYS.SETTINGS] || fallbackSettings;

        // Migration: replace legacy 'soft_room' with new 'voice_band'
        if (incomingSettings.focusStyle === 'soft_room') {
            incomingSettings.focusStyle = 'voice_band';
        }

        this.cache.settings = { ...fallbackSettings, ...incomingSettings };
        console.log('StorageManager initialized with cache:', this.cache);
    }

    async whenReady() {
        return this.ready;
    }

    getMusicTabIdSync() {
        return this.cache.musicTabId;
    }

    getSettingsSync() {
        return this.cache.settings;
    }

    async getMusicTabId() {
        await this.ready;
        return this.cache.musicTabId;
    }

    async setMusicTabId(tabId) {
        await this.ready;
        this.cache.musicTabId = tabId;
        await chrome.storage.local.set({ [this.STORAGE_KEYS.MUSIC_TAB_ID]: tabId });
    }

    async getSettings() {
        await this.ready;
        return this.cache.settings;
    }

    async updateSettings(settings) {
        await this.ready;
        this.cache.settings = settings;
        await chrome.storage.local.set({ [this.STORAGE_KEYS.SETTINGS]: settings });
    }
}
