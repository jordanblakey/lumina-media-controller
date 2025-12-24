const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Listeners for the UI to use
    onMediaUpdate: (callback) => ipcRenderer.on('media-update', (_event, value) => callback(value)),
    togglePlayPause: (senderId) => ipcRenderer.send('media-toggle-play-pause', senderId),
    next: () => ipcRenderer.send('media-next'),
    previous: () => ipcRenderer.send('media-previous'),
    restart: () => ipcRenderer.send('media-restart'),
    setSystemVolume: (val) => ipcRenderer.send('media-set-system-volume', val),
    onSystemVolumeUpdate: (callback) => ipcRenderer.on('system-volume-update', (_event, value) => callback(value)),
    onPlayerListUpdate: (callback) => ipcRenderer.on('player-list-update', (_event, value) => callback(value))
});




window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type])
  }
})
