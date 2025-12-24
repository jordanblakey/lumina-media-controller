const { spawn, spawnSync, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const fs = require('fs');
const { BrowserWindow } = require('electron');

/**
 * Helper to perform a D-Bus Property Get using spawn (Safety first)
 */
async function dbusGet(dest, path, interface, prop) {
    return new Promise((resolve) => {
        const child = spawn('/usr/bin/dbus-send', [
            '--session', '--print-reply', `--dest=${dest}`, path,
            'org.freedesktop.DBus.Properties.Get', `string:${interface}`, `string:${prop}`
        ]);
        let stdout = '';
        child.stdout.on('data', (d) => stdout += d);
        child.on('close', () => resolve(stdout));
        child.on('error', () => resolve(''));
    });
}

// --- Global State ---
let monitorBuffer = "";
let playerMap = {};
let playerStateMap = {};
let playerCache = {}; // Cache for Deep Identification (Identity, PID, etc)
let activeSenderId = null;

/**
 * Unified state updater. Performs strictly additive merging.
 */
function updatePlayerState(sender, data) {
    if (!sender) return;
    
    // Initialize if new
    if (!playerStateMap[sender]) {
        playerStateMap[sender] = {
            sender,
            player: 'Media Player',
            status: 'Stopped',
            title: 'Unknown Title',
            artist: 'Unknown Artist',
            album: '---',
            artUrl: ''
        };
    }

    const state = playerStateMap[sender];
    const playerName = playerMap[sender];

    // Merge non-null fields
    for (const key in data) {
        if (data[key] !== null && data[key] !== undefined) {
             // Handle player name specifically
             if (key === 'player') {
                 const newName = data[key];
                 // Prioritize cache if we have a better name
                 if (playerCache[playerName]) {
                     state.player = playerCache[playerName];
                 } else if (state.player === 'Media Player' || state.player === 'Unknown' || state.player === 'VLC' || state.player === 'Chromium') {
                     // Upgrade generic name
                     state.player = newName;
                 }
                 continue;
             }
             state[key] = data[key];
        }
    }

    // Always try to force the cached identity if we have it
    if (playerName && playerCache[playerName]) {
        state.player = playerCache[playerName];
    }

    // VLC / Local File Fallback
    if ((!state.title || state.title === 'Unknown Title') && state.url) {
        try {
            state.title = path.basename(decodeURIComponent(state.url));
        } catch(e) {
            state.title = path.basename(state.url);
        }
    }

    state.lastUpdated = Date.now();
    sendBestAvailablePlayer();
}

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
        const child = spawn('/usr/bin/dbus-send', [
            '--session', '--dest=org.freedesktop.DBus', '--type=method_call', '--print-reply',
            '/org/freedesktop/DBus', 'org.freedesktop.DBus.GetNameOwner', `string:${name}`
        ]);
        let stdout = '';
        child.stdout.on('data', (d) => stdout += d);
        child.on('close', () => {
            const match = stdout.match(/string "([^"]+)"/);
            resolve(match ? match[1] : null);
        });
        child.on('error', () => resolve(null));
    });
}

/**
 * Cleans up technical D-Bus names for the UI.
 * e.g. "org.mpris.MediaPlayer2.spotify" -> "Spotify"
 * e.g. "org.mpris.MediaPlayer2.chromium.instance123" -> "Chromium"
 */
function beautifyPlayerName(name) {
    if (!name || name.startsWith(':')) return null;
    
    // 1. Remove prefix
    let clean = name.replace(/^org\.mpris\.MediaPlayer2\./, '');
    
    // 2. Split by segments
    let segments = clean.split('.');
    
    // 3. Filter out predictable technical parts like "instance123" or "instance_1_40842"
    segments = segments.filter(s => !s.toLowerCase().startsWith('instance'));
    
    // 4. Fallback if empty (shouldn't happen for valid MPRIS)
    if (segments.length === 0) return "Media Player";
    
    // 5. Format the remaining segments
    return segments.map(s => {
        // Replace punctuation with spaces
        let word = s.replace(/[_-]/g, ' ');
        // Title Case
        return word.split(' ').map(w => {
            if (w.toLowerCase() === 'vlc') return 'VLC';
            if (w.toLowerCase() === 'spotify') return 'Spotify';
            return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        }).join(' ');
    }).join(' ');
}

/**
 * Refreshes the internal map of unique IDs to human-readable player names
 */
async function refreshPlayerMap() {
    return new Promise((resolve) => {
        const child = spawn('/usr/bin/dbus-send', [
            '--session', '--dest=org.freedesktop.DBus', '--type=method_call', '--print-reply',
            '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames'
        ]);
        let stdout = '';
        child.stdout.on('data', (d) => stdout += d);
        child.on('close', async () => {
            const playerNames = stdout.match(/org\.mpris\.MediaPlayer2\.[^\s"]+/g) || [];
            const newMap = {};
            
            for (const name of playerNames) {
                try {
                    const owner = await getOwner(name);
                    if (owner) newMap[owner] = name;
                } catch (e) {}
            }
            playerMap = newMap;

            // 1. Sync any newly discovered players that don't have state yet
            for (const owner in playerMap) {
                if (!playerStateMap[owner]) {
                    updatePlayerStateManually(playerMap[owner]).catch(() => {});
                }
            }

            // 2. Purge playerStateMap of stale entries
            const currentSenders = new Set(Object.keys(playerMap));
            for (const sender in playerStateMap) {
                if (!currentSenders.has(sender)) {
                    console.log(`[Media] Purging stale state for ${sender} (${playerStateMap[sender].player})`);
                    delete playerStateMap[sender];
                }
            }

            // 3. Always update UI to ensure it reflects current reality
            sendBestAvailablePlayer();
            resolve(playerMap);
        });
        child.on('error', () => resolve({}));
    });
}

/**
 * Determines which player should be displayed in the UI.
 * Uses a scoring system: Playing > Paused, and favors known major players.
 */
function sendBestAvailablePlayer() {
    const players = Object.values(playerStateMap);
    
    // If no players, notify the UI to show the "Waiting for Media" state
    if (players.length === 0) {
        activeSenderId = null;
        sendToUI('media-update', {
            player: 'No Player Detected',
            status: 'Stopped',
            title: 'Waiting for Media...',
            artist: '---',
            album: '---',
            artUrl: ''
        });
        sendPlayerList();
        return;
    }

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
        const hasSwitched = activeSenderId !== best.sender;
        activeSenderId = best.sender;
        sendToUI('media-update', best);

        // Force refresh if switched OR metadata is missing/generic
        if (hasSwitched || !best.title || best.title === 'Unknown Title') {
            const playerName = playerMap[best.sender];
            if (playerName) {
                const now = Date.now();
                const lastUpdate = best.lastManualUpdate || 0;
                // Throttle manual updates to once per 5 seconds per player
                if (hasSwitched || (now - lastUpdate > 5000)) {
                    if (hasSwitched) console.log(`[Media] Player switch to ${playerName} detected, forcing update...`);
                    updatePlayerStateManually(playerName).catch(() => {});
                }
            }
        }
    }
    
    // Also send the full list of active players for the UI list feature
    sendPlayerList();
}

/**
 * Sends a simplified list of all active players to the UI
 */
function sendPlayerList() {
    // Filter out any entries that somehow ended up without a valid player name
    const rawList = Object.values(playerStateMap)
        .filter(p => p.player && p.player !== 'No Player Detected');
        
    // De-duplicate names by adding suffixes if necessary
    const nameCounts = {};
    const list = rawList.map(p => {
        let displayName = p.player;
        if (nameCounts[displayName]) {
            nameCounts[displayName]++;
            displayName = `${displayName} (${nameCounts[displayName]})`;
        } else {
            nameCounts[displayName] = 1;
        }
        
        return {
            name: displayName,
            sender: p.sender,
            status: p.status,
            isActive: p.sender === activeSenderId
        };
    });

    sendToUI('player-list-update', list);
}



/**
 * Main entry point. Starts monitoring and performs initial sync.
 */
async function startMediaMonitor() {
    console.log("[Media] Initializing Media Monitor...");
    await refreshPlayerMap();
    await syncAllPlayers();

    // 1. Monitor for track metadata/status changes
    const monitor = spawn('/usr/bin/dbus-monitor', [
        "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='/org/mpris/MediaPlayer2'"
    ]);
    monitor.stdout.on('data', (data) => handleStreamData(data));

    // 2. Monitor for players opening/closing
    const systemMonitor = spawn('/usr/bin/dbus-monitor', [
        "type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged'"
    ]);
    systemMonitor.stdout.on('data', (data) => handleStreamData(data));
    
    console.log("[Media] Monitoring active.");

    // Periodic cleanup to ensure state doesn't drift if signals are missed
    setInterval(async () => {
        await refreshPlayerMap();
    }, 5000);
}

function handleStreamData(data) {
    monitorBuffer += data.toString();

    // Split by signal headers using lookahead to keep the header with the block
    const signals = monitorBuffer.split(/(?=signal time=\d+\.\d+ )/);
    
    const readySignals = [];
    let remainingBuffer = "";

    for (let i = 0; i < signals.length; i++) {
        const s = signals[i];
        if (!s.trim()) continue;

        const isLast = i === signals.length - 1;
        
        if (!isLast) {
            readySignals.push(s);
        } else {
            // Heuristic for "complete" signal block
            const trimmed = s.trim();
            const isNameOwner = trimmed.includes('member=NameOwnerChanged');
            const isProps = trimmed.includes('member=PropertiesChanged');
            
            let isComplete = false;
            if (isNameOwner) {
                // NameOwnerChanged has 3 string arguments. Check for the final quote/line.
                const stringCount = (trimmed.match(/string "/g) || []).length;
                if (stringCount >= 3 && (trimmed.endsWith('"') || trimmed.endsWith('\n'))) isComplete = true;
            } else if (isProps) {
                // PropertiesChanged ends with a closing brace for the dictionary or array
                if (trimmed.endsWith('}') || trimmed.endsWith(']')) isComplete = true;
            }

            if (isComplete) {
                readySignals.push(s);
                remainingBuffer = "";
            } else {
                remainingBuffer = s;
            }
        }
    }

    monitorBuffer = remainingBuffer;
    for (const signal of readySignals) {
        processSignalBlock(signal);
    }
}

async function processSignalBlock(block) {
    // A. Handle Player appearing/disappearing
    if (block.includes('member=NameOwnerChanged')) {
        const match = block.match(/string "([^"]*)"\s+string "([^"]*)"\s+string "([^"]*)"/);
        if (match) {
            const name = match[1];
            const oldOwner = match[2];
            const newOwner = match[3];

            if (name.startsWith('org.mpris.MediaPlayer2.')) {
                if (newOwner === "") {
                    console.log(`[Media] Name dropped: ${name} (Owner: ${oldOwner})`);
                    delete playerMap[oldOwner];
                    delete playerStateMap[oldOwner];
                    if (activeSenderId === oldOwner) activeSenderId = null;
                    sendBestAvailablePlayer();
                } else {
                    console.log(`[Media] Name assigned: ${name} -> ${newOwner}`);
                    playerMap[newOwner] = name;
                    // Force initial sync for newly opened player
                    updatePlayerStateManually(name).catch(() => {});
                }
            } else if (name.startsWith(':') && newOwner === "") {
                // Also clean up if the unique process ID (owner) disappears
                if (playerMap[name]) {
                    console.log(`[Media] ID disappeared: ${name} (${playerMap[name]})`);
                    delete playerMap[name];
                    delete playerStateMap[name];
                    if (activeSenderId === name) activeSenderId = null;
                    sendBestAvailablePlayer();
                }
            }
        }
        return;
    }

    // Handle Property Changes
    const parsed = parseDBusBlock(block);
    if (!parsed || !parsed.sender || !parsed.sender.startsWith(':')) return;

    // Reject unknown MPRIS players
    if (!playerMap[parsed.sender]) return;

    const playerName = playerMap[parsed.sender];
    const beautifiedName = beautifyPlayerName(playerName);
    
    // Use the unified updater
    updatePlayerState(parsed.sender, {
        ...parsed,
        player: beautifiedName
    });
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
        // Handle various string variant formats
        const regex = new RegExp(`string "${key}"[\\s\\S]+?variant\\s+(?:string|objpath)\\s+"([^"]+)"`);
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

    // Number extraction for volume
    const volumeRegex = /string "Volume"[\s\S]*?variant\s+double\s+([\d.]+)/;
    const volMatch = block.match(volumeRegex);
    if (volMatch) metadata.volume = parseFloat(volMatch[1]);

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

async function updatePlayerStateManually(playerName) {
    try {
        const owner = await getOwner(playerName);
        if (!owner) return;

        // 1. Get Cache or perform Deep Identification
        if (!playerCache[playerName]) {
            let identity = "";
            let desktopEntry = "";
            let pid = null;

            // Identity
            const idStdout = await dbusGet(playerName, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2', 'Identity');
            const idMatch = idStdout.match(/variant\s+string "([^"]+)"/);
            if (idMatch) identity = idMatch[1];

            // DesktopEntry
            const dsStdout = await dbusGet(playerName, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2', 'DesktopEntry');
            const dsMatch = dsStdout.match(/variant\s+string "([^"]+)"/);
            if (dsMatch) desktopEntry = dsMatch[1];

            // PID
            const pidStdout = await new Promise((resolve) => {
                const child = spawn('/usr/bin/dbus-send', [
                    '--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
                    'org.freedesktop.DBus.GetConnectionUnixProcessID', `string:${owner}`
                ]);
                let out = '';
                child.stdout.on('data', (d) => out += d);
                child.on('close', () => resolve(out));
                child.on('error', () => resolve(''));
            });
            const pidMatch = pidStdout.match(/uint32 (\d+)/);
            if (pidMatch) pid = parseInt(pidMatch[1]);

            const beautified = beautifyPlayerName(playerName);
            let finalName = identity || beautified || "Unknown Player";

            const checkStrings = [playerName, desktopEntry];
            if (pid) {
                try {
                    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
                    checkStrings.push(cmdline);
                } catch (e) {}
            }

            const combined = checkStrings.join(' ').toLowerCase();
            const lowerName = finalName.toLowerCase();
            
            if (combined.includes('beta') && !lowerName.includes('beta')) finalName += " Beta";
            else if (combined.includes('dev') && !lowerName.includes('dev')) finalName += " Dev";
            else if (combined.includes('canary') && !lowerName.includes('canary')) finalName += " Canary";

            console.log(`[Media] Deep Resolved: "${finalName}" for ${playerName}`);
            playerCache[playerName] = finalName;
        }

        const finalName = playerCache[playerName];

        // 2. Get Player Properties (Status, Metadata, etc) using GetAll
        const playerStdout = await new Promise((resolve) => {
            const child = spawn('/usr/bin/dbus-send', [
                '--session', '--print-reply', `--dest=${playerName}`, '/org/mpris/MediaPlayer2',
                'org.freedesktop.DBus.Properties.GetAll', 'string:org.mpris.MediaPlayer2.Player'
            ]);
            let out = '';
            child.stdout.on('data', (d) => out += d);
            child.on('close', () => resolve(out));
            child.on('error', () => resolve(''));
        });
        
        const block = `sender=${owner}\n` + playerStdout;
        const parsed = parseDBusBlock(block);
        
        if (parsed) {
            // Use unified updater
            updatePlayerState(owner, {
                ...parsed,
                player: finalName,
                lastManualUpdate: Date.now()
            });
        }
    } catch (err) {
        // ... cleanup logic ...
        if (err.message.includes('ServiceUnknown') || err.message.includes('NoOwner')) {
            console.log(`[Media] ${playerName} is gone, removing from state.`);
            for (const sender in playerMap) {
                if (playerMap[sender] === playerName) {
                    delete playerMap[sender];
                    delete playerStateMap[sender];
                    if (activeSenderId === sender) activeSenderId = null;
                }
            }
            sendBestAvailablePlayer();
        } else {
            console.error(`[Media] Error manually updating ${playerName}:`, err.message);
        }
        throw err;
    }
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
    spawn('/usr/bin/dbus-send', [
        '--session', '--type=method_call', `--dest=${playerName}`,
        '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player.PlayPause'
    ]);
}

/**
 * Navigation and Volume Control
 */
function next() {
    if (!activeSenderId) return;
    const playerName = playerMap[activeSenderId];
    if (!playerName) return;
    console.log(`[Media] Sending Next command to ${playerName}`);
    spawn('/usr/bin/dbus-send', [
        '--session', '--type=method_call', `--dest=${playerName}`,
        '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player.Next'
    ]);
}

function previous() {
    if (!activeSenderId) return;
    const playerName = playerMap[activeSenderId];
    if (!playerName) return;
    console.log(`[Media] Sending Previous command to ${playerName}`);
    spawn('/usr/bin/dbus-send', [
        '--session', '--type=method_call', `--dest=${playerName}`,
        '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player.Previous'
    ]);
}

function restartTrack() {
    if (!activeSenderId) return;
    const playerName = playerMap[activeSenderId];
    if (!playerName) return;
    console.log(`[Media] Restarting track for ${playerName}`);
    spawn('/usr/bin/dbus-send', [
        '--session', '--type=method_call', `--dest=${playerName}`,
        '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player.SetPosition',
        "objectpath:'/org/mpris/MediaPlayer2'", "int64:0"
    ]);
}

function setVolume(val) {
    if (!activeSenderId) return;
    const playerName = playerMap[activeSenderId];
    if (!playerName) return;
    // val is 0 to 100, MPRIS expects 0.0 to 1.0
    const volume = val / 100;
    spawn('/usr/bin/dbus-send', [
        '--session', '--type=method_call', `--dest=${playerName}`,
        '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties.Set',
        'string:org.mpris.MediaPlayer2.Player', 'string:Volume', `variant:double:${volume}`
    ]);
}

/**
 * System Volume Control (via /usr/bin/amixer)
 */
function getSystemVolume() {
    return new Promise((resolve) => {
        const child = spawn('/usr/bin/amixer', ['sget', 'Master']);
        let stdout = '';
        child.stdout.on('data', (d) => stdout += d);
        child.on('close', () => {
            const match = stdout.match(/\[(\d+)%\]/);
            resolve(match ? parseInt(match[1]) : null);
        });
        child.on('error', () => resolve(null));
    });
}

function setSystemVolume(val) {
    // val is 0 to 100
    // Always include 'unmute' to ensure volume is restored if it was muted at 0%
    spawn('/usr/bin/amixer', ['sset', 'Master', `${val}%`, 'unmute']);
}

// Polling for system volume (ultra-fast for zero-latency feel)
setInterval(async () => {
    const vol = await getSystemVolume();
    if (vol !== null) {
        sendToUI('system-volume-update', vol);
    }
}, 100);

module.exports = {
    startMediaMonitor,
    togglePlayPause,
    next,
    previous,
    restartTrack,
    setSystemVolume
};
