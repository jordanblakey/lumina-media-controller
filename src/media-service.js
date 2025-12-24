const { exec } = require('child_process');
const fs = require('fs');
const { BrowserWindow } = require('electron');

const LOG_FILE = '/tmp/lumina-media.log';

function debugLog(msg) {
    try {
        console.log(msg);
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {}
}

debugLog('--- Media Monitor Service V2 Started ---');
debugLog(`[Env] DBUS_SESSION_BUS_ADDRESS: ${process.env.DBUS_SESSION_BUS_ADDRESS}`);

// --- State ---
let activePlayerName = null;
let pollInterval = null;
let lastKnownState = { title: '', artist: '' };
let lastSysVol = null;
let lastPlayerListStr = '';

// --- Helpers ---

// Moved beautify here
function beautifyName(name) {
    if (name.includes('spotify')) return 'Spotify';
    if (name.includes('vlc')) return 'VLC';
    if (name.includes('firefox')) return 'Firefox';
    if (name.includes('chromium') || name.includes('chrome')) return 'Chrome';
    const parts = name.split('.');
    return parts[parts.length - 1] || 'Player';
}

/**
 * Executes a shell command with a timeout.
 * Resolves with stdout (trimmed) or null on failure.
 */
function execShell(cmd) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: 2000, env: process.env }, (error, stdout, stderr) => {
            if (error || stderr.trim()) {
                debugLog(`[Shell Error] ${cmd.slice(0, 50)}... -> ${error ? error.message : stderr.trim()}`);
                resolve(null);
                return;
            }
            resolve(stdout.trim());
        });
    });
}

// --- Core Logic ---

async function getRunningPlayers() {
    const cmd = `busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ListNames --json=short`;
    const output = await execShell(cmd);
    
    if (!output) return [];

    try {
        const json = JSON.parse(output);
        const names = json.data[0];
        if (Array.isArray(names)) {
             return names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
        }
        return [];
    } catch (e) {
        debugLog(`[Discovery Error] Failed to parse busctl output: ${e.message}`);
        return [];
    }
}

async function getPlayerMetadata(fullName) {
    // With proper AppArmor profile, we can use the Well-Known Name directly.
    const cmd = `busctl --user call ${fullName} /org/mpris/MediaPlayer2 org.freedesktop.DBus.Properties GetAll s org.mpris.MediaPlayer2.Player --json=short`;
    const output = await execShell(cmd);

    if (!output) return null;

    try {
        const json = JSON.parse(output);
        const props = json.data[0];
        
        const getVal = (key) => props[key] ? props[key].data : null;
        
        const status = getVal('PlaybackStatus') || 'Stopped';
        const metadata = getVal('Metadata') || {};
        
        const getMeta = (key) => metadata[key] ? metadata[key].data : null;
        
        let title = getMeta('xesam:title');
        const artistList = getMeta('xesam:artist');
        let artist = Array.isArray(artistList) ? artistList[0] : (artistList || 'Unknown Artist');
        const album = getMeta('xesam:album') || '';
        const artUrl = getMeta('mpris:artUrl') || '';
        const url = getMeta('xesam:url') || '';

        // VLC Fallback for local files
        if (!title && url) {
             try {
                const decoded = decodeURIComponent(url);
                title = decoded.split('/').pop();
                artist = 'Local Media';
            } catch (e) {
                title = 'Unknown File';
            }
        }

        return {
            player: beautifyName(fullName),
            title: title || 'Unknown Title',
            artist: artist,
            album: album,
            artUrl: artUrl,
            status: status,
            rawName: fullName
        };

    } catch (e) {
        debugLog(`[JSON Parse Error] ${e.message} for ${fullName}`);
        return null;
    }
}

async function getSystemVolume() {
    // Parse amixer output -> [50%]
    const output = await execShell('amixer -D pulse sget Master');
    if (!output) return null;
    
    // Limits: Left: ... [62%] ...
    const match = output.match(/\[(\d+)%\]/);
    if (match) {
        return parseInt(match[1]);
    }
    return null;
}

async function pollLoop(force = false) {
    try {
        // Parallelize system volume and player list checks for speed
        const [sysVol, players] = await Promise.all([
            getSystemVolume(),
            getRunningPlayers()
        ]);
        
        // 1. System Volume Sync
        if (sysVol !== null && (sysVol !== lastSysVol || force)) {
             sendToUI('system-volume-update', sysVol);
             lastSysVol = sysVol;
        }

        // 2. Player Metadata
        
        // If polling failed completely (dbus error), ABORT.
        // Do NOT clear state, preserve sticky active player.
        if (players === null) {
            // debugLog('[Poll] D-Bus ListNames failed. Preserving state.');
            return; 
        }

        if (players.length === 0) {
            // No players found (Success but empty)
            activePlayerName = null;
            sendToUI('media-update', {
                player: 'No Player',
                title: 'No Media Playing',
                artist: '',
                status: 'Stopped'
            });
            return;
        }

        // Auto-select logic: 
        // 1. If currently Active Player is Playing, keep it.
        // 2. If another player is Playing, switch to it (Auto-Focus).
        // 3. If Active Player is Paused, keep it (Manual override).
        // 4. If Active Player is gone, pick first available.

        let bestCandidate = null;
        let activeStillExists = false;
        const allPlayerStates = [];

        for (const p of players) {
            const data = await getPlayerMetadata(p);
            if (!data) continue;
            
            allPlayerStates.push(data);
            
            if (data.rawName === activePlayerName) {
                activeStillExists = true;
            }
            
            if (data.status === 'Playing') {
                // If we found a playing one
                if (!bestCandidate || bestCandidate.status !== 'Playing') {
                    // If our current best wasn't playing, this is the new best
                    bestCandidate = data;
                } else if (data.rawName === activePlayerName) {
                    // If we have multiple playing, prefer the one that was already active
                    bestCandidate = data;
                }
            }
        }
        
        // Use history if no clear winner
        if (!bestCandidate) {
            if (activeStillExists) {
                 bestCandidate = allPlayerStates.find(p => p.rawName === activePlayerName);
            } else if (allPlayerStates.length > 0) {
                 bestCandidate = allPlayerStates[0];
            }
        }

        // Send the list locally for UI chips
        const playerListPayload = allPlayerStates.map(p => ({
            id: p.rawName,
            sender: p.rawName,
            name: p.player,
            status: p.status,
            isActive: (bestCandidate && p.rawName === bestCandidate.rawName)
        }));
        
        const playerListStr = JSON.stringify(playerListPayload);
        if (playerListStr !== lastPlayerListStr || force) {
            sendToUI('player-list-update', playerListPayload);
            lastPlayerListStr = playerListStr;
        }


        if (bestCandidate) {
            activePlayerName = bestCandidate.rawName;
            
            if (JSON.stringify(bestCandidate) !== JSON.stringify(lastKnownState) || force) {
                debugLog(`[Media] Active: ${bestCandidate.player} - ${bestCandidate.title} (${bestCandidate.status})`);
                sendToUI('media-update', bestCandidate);
                lastKnownState = bestCandidate;
            }
        }

    } catch (e) {
        debugLog(`[Poll Error] ${e.message}`);
    }
}

// --- IPC / Control ---

function sendToUI(channel, data) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) wins[0].webContents.send(channel, data);
}

// Control Functions
async function simpleControl(method, targetId) {
    const target = targetId || activePlayerName;
    if (!target) return;
    
    // If explicit switch, update active
    if (targetId) activePlayerName = targetId;

    debugLog(`[Control] ${method} -> ${target}`);
    
    // Use well-known name directly
    execShell(`busctl --user call ${target} /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player ${method}`);
    
    // Trigger immediate poll update
    setTimeout(pollLoop, 100);
}

function togglePlayPause(targetId) { simpleControl('PlayPause', targetId); }
function next() { simpleControl('Next'); }
function previous() { simpleControl('Previous'); }

// System Volume Control
function setSystemVolume(val) {
    const vol = Math.max(0, Math.min(100, val));
    debugLog(`[Control] System Volume -> ${vol}%`);
    // Use amixer (more standard) since pactl is missing
    // Added 'unmute' to ensure sound comes back on
    execShell(`amixer -D pulse sset Master ${vol}% unmute`);
}

// --- Lifecycle ---

function startMediaMonitor() {
    debugLog('Starting Monitor Loop...');
    // Initial run
    pollLoop();
    // Loop every 1000ms (Compromise: Responsive volume, low CPU usage)
    pollInterval = setInterval(pollLoop, 1000);
}

function refreshUI() {
    pollLoop(true);
}

module.exports = {
    startMediaMonitor,
    togglePlayPause,
    next,
    previous,
    setSystemVolume,
    refreshUI
};
