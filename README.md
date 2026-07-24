# SIM-Track: ESP32-C3 + SIM800L Cellular Triangulation Tracker

**100% FREE** cellular location tracking using ESP32-C3 Super Mini + SIM800L on BSNL 2G India.

## Project Structure

```
├── firmware/                  # ESP32-C3 Arduino sketch (LATEST v4)
│   ├── ESP32_SIM800_Dashboard.ino   # Main tracker firmware
│   ├── config.h                     # Pin & network config
│   ├── CellTriangulation.h          # Cell tower triangulation logic
│   └── SIM800C_Cellular.h           # SIM800 AT command abstraction
│
├── backend/                   # Node.js Express telemetry server
│   ├── index.js               # REST API + real-time telemetry
│   ├── package.json
│   └── render.yaml            # Render.com deployment config
│
├── dashboard/                 # React + Vite map dashboard
│   ├── src/                   # React source (Leaflet map UI)
│   ├── index.html
│   ├── vite.config.js
│   └── vercel.json            # Vercel deployment config
│
└── sim-track-legacy/          # Original project files (reference)
    ├── sim_track.ino
    ├── test_internet.ino
    └── ...
```

## Hardware

- **MCU**: ESP32-C3 Super Mini
- **Modem**: SIM800L (2G GSM/GPRS)
- **SIM**: BSNL 2G (PLMN 40464, APN: `bsnlgprs`)
- **Wiring**: TX=GPIO7, RX=GPIO6, LED=GPIO8

## Strategy

1. **Multi-Cell Scan** (`AT+CENG`) — Scans serving + 6 neighbor towers
2. **Free Native LBS** (`AT+CIPGSMLOC`) — SIMCom's built-in location service
3. **HTTP Telemetry** — Posts JSON to backend every 15 seconds
4. **Map Dashboard** — Real-time Leaflet map with tower visualization

## Quick Start

### Flash Firmware
Open `firmware/ESP32_SIM800_Dashboard.ino` in Arduino IDE → Select ESP32-C3 → Flash

### Run Backend
```bash
cd backend && npm install && node index.js
```

### Run Dashboard
```bash
cd dashboard && npm install && npm run dev
```
