# Lumina Media Controller

A premium, D-Bus-powered media companion for Linux.

Lumina gives you a centralized hub to monitor and control every media player on your system with zero friction. Whether you're juggling Spotify, YouTube, and VLC, Lumina keeps everything organized, identified, and controllable from a single, beautiful interface.

## Key Features

- **Intelligent Player Identification**: Automatically distinguishes between different versions of the same app (e.g., "Google Chrome" vs. "Google Chrome Beta") by deep-inspecting system processes.
- **Interactive Player List**: View all active media sources. Click any player badge to toggle its playback independently without changing your main focus.
- **Dynamic Control Suite**: Full playback controls (Play/Pause, Skip, Previous, Restart) and integrated system volume management.
- **Self-Healing State**: Proactively detects application closures and process exits to ensure your dashboard is always clean and accurate.
- **Premium Aesthetics**: A modern, dark-mode interface with smooth transitions and SVG iconography.

## Getting Started

### Prerequisites

- Node.js and npm
- Linux with D-Bus and amixer (standard on most distros)

### Installation & Development

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Build a fast distribution (.deb)
npm run dist:fast
```

### Quick Reinstall

If you are testing on a Debian-based system, you can use the built-in reinstall script to refresh the package:

```bash
npm run reinstall
```

## Technical Stack

Lumina is built on a hybrid architecture that blends modern web technologies with low-level Linux systems programming:

- **Frontend**: A minimal, high-performance UI built with standard **HTML5**, **CSS3** (modern flexbox/grid), and **Vanilla JavaScript**.
- **Backend (Electron)**: Orchestrates system-level interactions using Node.js.
- **IPC Bridge**: Uses a secure `contextBridge` and `preload.js` pattern to facilitate communication between the UI and the Linux system.
- **D-Bus Integration**: Communicates with the Linux session bus using the **MPRIS protocol** via `dbus-send` and `dbus-monitor`.
- **System Utilities**: Integrates with `amixer` for global hardware volume control and inspects the `/proc` filesystem for process-level metadata.

## The Vision

Lumina aims to be the definitive "Now Playing" experience for Linux. It's not just a remote control; it's a context-aware dashboard that understands *how* you use media across different applications and brings them together into a unified, high-performance workflow.

## How it Works

Lumina leverages the **MPRIS (Media Player Remote Interfacing Specification)** over D-Bus. It monitors system signals in real-time to track metadata changes and uses a proprietary "Deep Identification" layer to resolve ambiguous player identities by cross-referencing process command lines in `/proc`.

## Credits

Lumina was born from a collaborative pair-programming journey between the developer and **Antigravity**, a powerful agentic AI coding assistant designed by the Google Deepmind team. Together, they transformed a simple D-Bus experiment into a refined, intelligent desktop utility.
