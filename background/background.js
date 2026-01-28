// Background Service Worker Entry Point
import { AudioAgent } from './audio_agent.js';
import { StorageManager } from './storage.js';

// Wrap startup to avoid top-level await restrictions in MV3 service workers.
(async () => {
    const storageManager = new StorageManager();
    await storageManager.whenReady();

    const audioAgent = new AudioAgent(storageManager);
    await audioAgent.ready;

    console.log('DuckIt background service started.');
})();
