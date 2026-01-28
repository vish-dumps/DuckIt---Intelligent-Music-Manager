export class ScriptManager {
    constructor() {
        this.injectedTabs = new Set();
    }

    async ensureSensor(tabId) {
        if (this.injectedTabs.has(tabId)) return;

        try {
            await chrome.tabs.sendMessage(tabId, { type: 'DUCKIT_PING' });
            this.injectedTabs.add(tabId);
            return;
        } catch (_) {
            // Falls through to injection below.
        }

        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['content/audio_sensor.js']
            });
            this.injectedTabs.add(tabId);
        } catch (e) {
            console.debug('DuckIt failed to inject sensor', tabId, e?.message || e);
        }
    }

    async send(tabId, payload) {
        await this.ensureSensor(tabId);
        try {
            return await chrome.tabs.sendMessage(tabId, payload);
        } catch (e) {
            console.debug('DuckIt message failed', tabId, e?.message || e);
            return null;
        }
    }

    async pause(tabId) {
        return this.send(tabId, { type: 'PAUSE_AUDIO' });
    }

    async resume(tabId) {
        return this.send(tabId, { type: 'RESUME_AUDIO' });
    }

    async duckVolume(tabId, intensity = 30) {
        const fraction = Math.max(0, Math.min(1, intensity / 100));
        return this.send(tabId, { type: 'SET_VOLUME', value: fraction });
    }

    async restoreVolume(tabId) {
        return this.send(tabId, { type: 'RESTORE_VOLUME' });
    }

    forget(tabId) {
        this.injectedTabs.delete(tabId);
    }
}
