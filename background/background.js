// Background Service Worker Entry Point
import { AudioAgent } from './audio_agent.js';
import { StorageManager } from './storage.js';

// Top-level await is disallowed in MV3 service workers. Bootstrap explicitly.
(async () => {
    const storageManager = new StorageManager();
    await storageManager.whenReady();

    const audioAgent = new AudioAgent(storageManager);
    await audioAgent.ready;

    console.log("DuckIt background service started.");
})();
