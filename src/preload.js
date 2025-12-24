const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Listeners for the UI to use
    onMediaUpdate: (callback) => ipcRenderer.on('media-update', (_event, value) => callback(value)),
    togglePlayPause: () => ipcRenderer.send('media-toggle-play-pause')
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
