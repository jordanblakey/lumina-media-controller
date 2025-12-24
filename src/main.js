const { app, protocol, BrowserWindow, nativeImage, net, ipcMain } = require('electron');
const path = require('node:path');
const { startMediaMonitor, togglePlayPause } = require('./media-service');

// Listen for playback control events from the renderer
ipcMain.on('media-toggle-play-pause', () => {
    togglePlayPause();
});


// 1. Register scheme as privileged (Must be before 'ready')
protocol.registerSchemesAsPrivileged([
  { 
    scheme: 'media', 
    privileges: { 
      standard: true, 
      secure: true, 
      supportFetchAPI: true, 
      bypassCSP: true, 
      stream: true,
      sandbox: true
    } 
  }
]);

const createWindow = () => {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        icon: path.join(__dirname, '../assets/icon.png'),
        webPreferences: {
            autoplayPolicy: 'no-user-gesture-required',
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });
    win.loadFile(path.join(__dirname, 'index.html'));
};

app.whenReady().then(() => {
    // 2. Register the handler BEFORE creating the window
    protocol.handle('media', (request) => {
        let urlPath = request.url.replace('media://', '');
        if (urlPath.endsWith('/')) {
            urlPath = urlPath.slice(0, -1);
        }
        
        const absolutePath = path.join(__dirname, '../assets', urlPath);
        console.log('[Main Process] Fetching asset from:', absolutePath);

        const fileUrl = `file://${absolutePath.startsWith('/') ? '' : '/'}${absolutePath}`;
        return net.fetch(fileUrl);
    });

    createWindow();
    
    // Start media monitoring AFTER the window exists to ensure IPC is ready
    startMediaMonitor();
});