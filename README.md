# Lumina Media Controller

A premium, D-Bus-powered media companion for Linux.

Lumina gives you a centralized hub to monitor and control every media player on your system with zero friction. Whether you're juggling Spotify, YouTube, and VLC, Lumina keeps everything organized, identified, and controllable from a single, beautiful interface.

## Key Features

- **Intelligent Player Identification**: Automatically identifies active media players using D-Bus Well-Known Names for high reliability and security.
- **Interactive Player List**: View all active media sources. Click any player badge to toggle its playback independently.
- **Dynamic Control Suite**: Full playback controls (Play/Pause, Skip, Previous) and integrated system volume management.
- **Real-Time Sync**: Proactively monitors D-Bus signals for instant metadata and status updates.
- **Premium Aesthetics**: A modern, dark-mode interface with glassmorphism, smooth transitions, and custom iconography.

## Getting Started

### Prerequisites

- Node.js and npm
- Linux with D-Bus and `amixer` (standard on most distros)
- `busctl` (provided by systemd)

### Installation & Development

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Build a fast distribution (.deb)
npm run build:fast
```

### Quick Reinstall

If you are testing on a Debian-based system, you can use the built-in reinstall script to refresh the package:

```bash
npm run reinstall
```

## Technical Stack

Lumina is built on a hybrid architecture that blends modern web technologies with Linux systems programming:

- **Frontend**: A minimal, high-performance UI built with standard **HTML5**, **CSS3**, and **Vanilla JavaScript**.
- **Backend (Electron)**: Orchestrates system-level interactions using Node.js.
- **IPC Bridge**: Uses a secure `contextBridge` and `preload.js` pattern with an asynchronous "UI Ready" handshake for reliable initialization.
- **D-Bus Integration**: Communicates with the MPRIS protocol using **`busctl`** for high-efficiency JSON output parsing.
- **System Utilities**: Integrates with `amixer` for global hardware volume control.

## Security & Sandboxing

Lumina includes a custom **AppArmor profile** designed to resolve permission issues when communicating with players installed via **Flatpak** or **Snap**. This profile ensures the application has the necessary permissions to talk to the session bus while maintaining a secure security posture.

## How it Works

Lumina leverages the **MPRIS (Media Player Remote Interfacing Specification)** over D-Bus. It uses `busctl` to query player metadata and status in real-time. By utilizing Well-Known Names (e.g., `org.mpris.MediaPlayer2.spotify`), Lumina ensures consistent identification across different distribution methods (Native, Flatpak, Snap).

## Credits

Lumina was born from a collaborative pair-programming journey between the developer and **Antigravity**, a powerful agentic AI coding assistant designed by the Google Deepmind team. Together, they transformed a simple D-Bus experiment into a refined, intelligent desktop utility.
