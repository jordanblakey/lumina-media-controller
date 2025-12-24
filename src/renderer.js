/**
 * Lumina Renderer - Handles UI updates and IPC communication
 */

const elements = {
    title: document.getElementById('title'),
    artist: document.getElementById('artist'),
    album: document.getElementById('album'),
    player: document.getElementById('player'),
    status: document.getElementById('status'),
    artImg: document.getElementById('media-art'),
    toggleBtn: document.getElementById('toggle-btn'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    volumeSlider: document.getElementById('volume-slider'),
    playerList: document.getElementById('player-list'),
    ppIcon: document.getElementById('play-pause-icon'),
    lowVolIcon: document.getElementById('volume-low-icon')
};

let isDraggingVolume = false;
let volumeThrottleTimer = null;

// --- Initialize ---
elements.artImg.src = 'media://placeholder.png';
elements.artImg.style.display = 'block';

// --- Event Listeners ---
elements.toggleBtn.addEventListener('click', () => window.electronAPI.togglePlayPause());
elements.prevBtn.addEventListener('click', () => window.electronAPI.previous());
elements.nextBtn.addEventListener('click', () => window.electronAPI.next());

elements.volumeSlider.addEventListener('mousedown', () => isDraggingVolume = true);
elements.volumeSlider.addEventListener('touchstart', () => isDraggingVolume = true);
window.addEventListener('mouseup', () => isDraggingVolume = false);
window.addEventListener('touchend', () => isDraggingVolume = false);

elements.volumeSlider.addEventListener('input', (e) => {
    if (volumeThrottleTimer) return;
    volumeThrottleTimer = setTimeout(() => {
        window.electronAPI.setSystemVolume(parseInt(e.target.value));
        volumeThrottleTimer = null;
    }, 50);
});

// --- IPC Updates ---

window.electronAPI.onMediaUpdate((metadata) => {
    elements.title.innerText = metadata.title || "Unknown Title";
    elements.title.title = metadata.title || "";
    elements.artist.innerText = metadata.artist || "Unknown Artist";
    elements.artist.title = metadata.artist || "";
    elements.album.innerText = metadata.album || "---";
    elements.album.title = metadata.album || "";
    elements.player.innerText = metadata.player || "unknown";
    
    // Artwork handling
    if (metadata.artUrl && (metadata.artUrl.startsWith('http') || metadata.artUrl.startsWith('file://'))) {
        elements.artImg.src = metadata.artUrl;
    } else {
        elements.artImg.src = 'media://placeholder.png';
    }

    // Status & Icons
    const status = metadata.status || 'Stopped';
    elements.status.innerText = status;
    
    if (status === 'Playing') {
        elements.ppIcon.className = 'icon pause-icon';
        elements.status.style.background = 'rgba(34, 197, 94, 0.15)';
        elements.status.style.color = '#4ade80';
    } else {
        elements.ppIcon.className = 'icon play-icon';
        elements.status.style.background = 'rgba(56, 189, 248, 0.15)';
        elements.status.style.color = '#38bdf8';
    }
});

window.electronAPI.onSystemVolumeUpdate((vol) => {
    if (!isDraggingVolume) {
        elements.volumeSlider.value = vol;
    }

    // Update volume icons based on level
    if (vol === 0) {
        elements.lowVolIcon.className = 'icon volume-mute-icon';
    } else if (vol < 50) {
        elements.lowVolIcon.className = 'icon volume-down-icon';
    } else {
        elements.lowVolIcon.className = 'icon volume-icon';
    }
});

window.electronAPI.onPlayerListUpdate((players) => {
    if (!elements.playerList) return;
    
    elements.playerList.innerHTML = players.map(p => `
        <div class="player-pill ${p.isActive ? 'active' : ''} ${p.status}" 
             onclick="window.electronAPI.togglePlayPause('${p.sender}')">
            <span class="player-stat-dot"></span>
            ${p.name}
        </div>
    `).join('');
});

// Signal that the UI is ready to receive updates
window.electronAPI.sendUIReady();
