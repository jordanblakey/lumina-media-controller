const { app, protocol, BrowserWindow, Menu, nativeImage, net, ipcMain } = require('electron');
const path = require('node:path');
const { startMediaMonitor, togglePlayPause, next, previous, setSystemVolume, refreshUI } = require('./media-service');

// IPC Handlers
ipcMain.on('ui-ready', () => refreshUI() );
ipcMain.on('media-toggle-play-pause', (_, id) => togglePlayPause(id));
ipcMain.on('media-next', next);
ipcMain.on('media-previous', previous);
ipcMain.on('media-set-system-volume', (_, vol) => setSystemVolume(vol));

// 1. Register scheme (Must be before 'ready')
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
    minWidth: 400,
    minHeight: 200,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  Menu.setApplicationMenu(null);
};

app.whenReady().then(() => {
  console.log('[Main Process] Lumina Ready');

  // 2. Optimized Protocol Handler
  protocol.handle('media', (req) => {
    const urlPath = req.url.replace('media://', '').replace(/\/$/, '');
    const absolutePath = path.join(__dirname, '../assets', urlPath);
    return net.fetch(`file://${absolutePath}`);
  });

  createWindow();
  startMediaMonitor();
});