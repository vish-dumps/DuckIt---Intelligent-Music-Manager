# 🦆 DuckIt — Smart Audio Manager for Chrome

DuckIt is a Chrome extension that automatically manages background music so it never interferes with important audio like lectures, meetings, or videos.

When another tab starts playing audio, DuckIt can **lower, pause, or mute your music automatically**. It also includes **Focus Modes** that transform music into a softer background sound for better productivity.

---

## 🚀 Live Demo
🔗 **Try it here:** https://chromewebstore.google.com/detail/lknekeleiajofocihoobbolhjhkidngh?utm_source=item-share-cb 
🔗 **GitHub Repo:** https://github.com/vish-dumps/DuckIt---Intelligent-Music-Manager

---

## ✨ Features

### 🎧 Automatic Audio Ducking
When another tab starts playing audio, DuckIt automatically:

- Lowers music volume
- Pauses music
- Mutes music

Music is **restored automatically** when the priority audio stops.

---

### 🧠 Focus Mode
Focus Mode reshapes music into a **less distracting background sound**, even when nothing else is playing.

Available modes:

| Mode | Description |
|-----|-------------|
| Normal | No processing |
| Warm Background | Softens sharp highs |
| Low Presence | Reduces attention-grabbing mid frequencies |
| Mono Background | Removes stereo immersion |
| Distant | Makes music feel far away |
| Voice Band | Telephone-style narrow band sound |

All effects are implemented using the **Web Audio API**.

---

### 🔍 Smart Music Tab Detection
DuckIt detects which tab contains background music.

Users can:
- Manually select the **Music Tab**
- Auto-detect platforms like **Spotify Web, YouTube Music, and SoundCloud**

---

### ⚡ Instant Audio Detection
Chrome’s `tab.audible` property has a delay (~2 seconds).  
DuckIt uses **content scripts + Web Audio detection** to react **almost instantly**.

---

### 🔔 Smart Notifications
DuckIt notifies users when:

- Music tab is detected
- Music is ducked
- Music is restored

---

### 🔒 Privacy First
DuckIt is designed to be **fully privacy-safe**.

- No analytics  
- No tracking  
- No data collection  
- No external servers  

Everything runs **locally inside the browser**.

---

## 🧩 Tech Stack
- JavaScript  
- Chrome Extension APIs  
- Web Audio API  
- Manifest V3  
- HTML / CSS  

---
