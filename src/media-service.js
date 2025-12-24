const { spawn, exec } = require('child_process');
const path = require('path');
const { BrowserWindow } = require('electron');

// --- Global State ---
let monitorBuffer = "";
let playerMap = {};
let playerStateMap = {};
let activeSenderId = null;

/**
 * Sends media event data to the first available BrowserWindow
 */
function sendToUI(channel, data) {
    const allWindows = BrowserWindow.getAllWindows();
    if (allWindows.length > 0) {
        allWindows[0].webContents.send(channel, data);
    }
}

/**
 * Resolves a well-known name (org.mpris...) to a unique D-Bus ID (:1.xxx)
 */
function getOwner(name) {
    return new Promise((resolve) => {
        exec(`dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.GetNameOwner string:"${name}"`, (err, stdout) => {
            if (err) return resolve(null);
            const match = stdout.match(/string "([^"]+)"/);
            resolve(match ? match[1] : null);
        });
    });
}

/**
 * Refreshes the internal map of unique IDs to human-readable player names
 */
async function refreshPlayerMap() {
    return new Promise((resolve) => {
        exec(`dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames`, async (err, stdout) => {
            if (err) return resolve({});
            const playerNames = stdout.match(/org\.mpris\.MediaPlayer2\.[^\s"]+/g) || [];
            const newMap = {};
            
            for (const name of playerNames) {
                try {
                    const owner = await getOwner(name);
                    if (owner) newMap[owner] = name;
                } catch (e) {}
            }
            playerMap = newMap;
            resolve(playerMap);
        });
    });
}

/**
 * Determines which player should be displayed in the UI.
 * Uses a scoring system: Playing > Paused, and favors known major players.
 */
function sendBestAvailablePlayer() {
    const players = Object.values(playerStateMap);
    if (players.length === 0) return;

    // Sort players to find the "best" one
    players.sort((a, b) => {
        // 1. Status Priority (Playing > Paused > Stopped)
        const statusWeight = { 'Playing': 3, 'Paused': 2, 'Stopped': 1 };
        const sA = statusWeight[a.status] || 0;
        const sB = statusWeight[b.status] || 0;
        if (sA !== sB) return sB - sA;

        // 2. Recency (favor the most recently updated player)
        const tA = a.lastUpdated || 0;
        const tB = b.lastUpdated || 0;
        // If the time difference is significant (>1s), favors the newer one
        if (Math.abs(tA - tB) > 1000) return tB - tA;

        // 3. Static Hierarchy (Tie breaker for startup or simultaneous updates)
        const getPriority = (p) => {
            const name = p.player.toLowerCase();
            if (name.includes('spotify')) return 100;
            if (name.includes('chrome') || name.includes('firefox')) return 50;
            if (name.includes('vlc')) return 10;
            return 0;
        };
        const pA = getPriority(a);
        const pB = getPriority(b);
        if (pA !== pB) return pB - pA;

        // 4. Metadata quality (Last resort tie breaker)
        const qualityA = (a.artUrl ? 2 : 0) + (a.album !== '---' ? 1 : 0);
        const qualityB = (b.artUrl ? 2 : 0) + (b.album !== '---' ? 1 : 0);
        return qualityB - qualityA;
    });

    const best = players[0];
    
    if (best) {
        activeSenderId = best.sender;
        sendToUI('media-update', best);
    }
}



/**
 * Main entry point. Starts monitoring and performs initial sync.
 */
async function startMediaMonitor() {
    console.log("[Media] Initializing Media Monitor...");
    await refreshPlayerMap();
    await syncAllPlayers();

    // 1. Monitor for track metadata/status changes
    const monitor = spawn('dbus-monitor', [
        "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='/org/mpris/MediaPlayer2'"
    ]);
    monitor.stdout.on('data', (data) => handleStreamData(data));

    // 2. Monitor for players opening/closing
    const systemMonitor = spawn('dbus-monitor', [
        "type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged'"
    ]);
    systemMonitor.stdout.on('data', (data) => handleStreamData(data));
    
    console.log("[Media] Monitoring active.");
}

function handleStreamData(data) {
    monitorBuffer += data.toString();

    // Split incoming data by signal start
    const signals = monitorBuffer.split(/signal time=\d+\.\d+ /);
    
    // Last element is potentially incomplete, keep it in buffer
    monitorBuffer = signals.pop();

    for (const signal of signals) {
        if (!signal.trim()) continue;
        processSignalBlock(signal);
    }

    // Process if it looks like a complete block even if it's the last one
    if (monitorBuffer.trim().endsWith(']') || monitorBuffer.trim().endsWith(')')) {
        processSignalBlock(monitorBuffer);
        monitorBuffer = "";
    }
}

async function processSignalBlock(block) {
    // A. Handle Player appearing/disappearing
    if (block.includes('member=NameOwnerChanged')) {
        const match = block.match(/string "([^"]+)"\s+string "([^"]+)"\s+string "([^"]+)"/);
        if (match) {
            const name = match[1];
            const oldOwner = match[2];
            const newOwner = match[3];

            if (name.startsWith('org.mpris.MediaPlayer2.')) {
                if (newOwner === "") {
                    console.log(`[Media] ${name} closed.`);
                    delete playerMap[oldOwner];
                    delete playerStateMap[oldOwner];
                    if (activeSenderId === oldOwner) {
                        activeSenderId = null;
                        sendBestAvailablePlayer();
                    }
                } else {
                    console.log(`[Media] ${name} opened.`);
                    playerMap[newOwner] = name;
                }
            }
        }
        return;
    }

    // B. Handle Property Changes
    const parsed = parseDBusBlock(block);
    if (!parsed || !parsed.sender || !parsed.sender.startsWith(':')) return;

    if (!playerMap[parsed.sender]) {
        await refreshPlayerMap();
    }

    const playerName = playerMap[parsed.sender] || parsed.sender;
    
    // Initialize or get state
    if (!playerStateMap[parsed.sender]) {
        playerStateMap[parsed.sender] = {
            player: playerName,
            sender: parsed.sender,
            status: 'Stopped',
            title: 'Unknown Title',
            artist: 'Unknown Artist',
            album: '---',
            artUrl: ''
        };
    }

    const state = playerStateMap[parsed.sender];
    
    // Track when this player was last "active" (signal received)
    state.lastUpdated = Date.now();

    // Update state fields
    if (parsed.status) state.status = parsed.status;
    if (parsed.title) state.title = parsed.title;
    if (parsed.artist) state.artist = parsed.artist;
    if (parsed.artUrl) state.artUrl = parsed.artUrl;
    if (parsed.album) state.album = parsed.album;
    if (parsed.url) state.url = parsed.url;


    // VLC/File Fallback: Use filename if title is missing
    if ((!state.title || state.title === 'Unknown Title' || state.title === 'Loading...') && state.url) {
        try {
            const decoded = decodeURIComponent(state.url);
            state.title = path.basename(decoded);
        } catch (e) {
            state.title = path.basename(state.url);
        }
    }

    // Use the comprehensive scoring logic to determine if we should switch UI focus
    sendBestAvailablePlayer();
}


function parseDBusBlock(block) {
    const metadata = {};
    
    // Sender ID
    const senderMatch = block.match(/sender=([^ \n]+)/);
    if (senderMatch) metadata.sender = senderMatch[1].trim();

    // Track ID
    const trackIdMatch = block.match(/string "mpris:trackid"[\s\S]+?variant\s+string "([^"]+)"/);
    if (trackIdMatch) metadata.trackId = trackIdMatch[1];

    // Status
    const statusMatch = block.match(/string "PlaybackStatus"[\s\S]+?variant\s+string "([^"]+)"/);
    if (statusMatch) metadata.status = statusMatch[1];

    // Metadata extraction helper
    const extract = (key) => {
        const regex = new RegExp(`string "${key}"[\\s\\S]+?variant\\s+string "([^"]+)"`);
        const match = block.match(regex);
        return match ? match[1] : null;
    };

    metadata.title = extract('xesam:title');
    metadata.artUrl = extract('mpris:artUrl');
    metadata.album = extract('xesam:album');
    metadata.url = extract('xesam:url');

    // Artist (Handles array [ string "..." ] or raw string)
    const artistArrayRegex = /string "xesam:artist"[\s\S]+?variant\s+array \[[\s\S]+?string "([^"]+)"/;
    const artistMatch = block.match(artistArrayRegex);
    metadata.artist = artistMatch ? artistMatch[1] : extract('xesam:artist');

    return metadata;
}

/**
 * Actively queries all discovered players for their current state
 */
async function syncAllPlayers() {
    const players = Object.values(playerMap);
    for (const playerName of players) {
        try {
            await updatePlayerStateManually(playerName);
        } catch (e) {
            // Ignore players that don't respond
        }
    }
    sendBestAvailablePlayer();
}

/**
 * Individual player state fetch
 */
async function updatePlayerStateManually(playerName) {
    return new Promise((resolve, reject) => {
        const cmd = `dbus-send --session --print-reply --dest=${playerName} /org/mpris/MediaPlayer2 org.freedesktop.DBus.Properties.GetAll string:"org.mpris.MediaPlayer2.Player"`;
        exec(cmd, async (err, stdout) => {
            if (err) return reject(err);
            const owner = await getOwner(playerName);
            if (!owner) return reject("No owner found");
            
            // Format it to look like a signal block for reuse
            const block = `sender=${owner}\n` + stdout;
            await processSignalBlock(block);
            resolve();
        });
    });
}

// These functions were used previously in main.js, keeping for compatibility if needed
/**
 * Toggles play/pause for the current active player or a specific one
 */
function togglePlayPause(senderId) {
    const targetId = senderId || activeSenderId;
    if (!targetId) return;

    const playerName = playerMap[targetId];
    if (!playerName) return;

    console.log(`[Media] Toggling Play/Pause for ${playerName} (${targetId})`);
    const cmd = `dbus-send --session --type=method_call --dest=${playerName} /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player.PlayPause`;
    exec(cmd, (err) => {
        if (err) console.error(`[Media] Failed to toggle Play/Pause:`, err);
    });
}

module.exports = {
    startMediaMonitor,
    togglePlayPause
};


