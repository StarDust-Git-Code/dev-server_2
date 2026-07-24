# ESP32-C3 Super Mini + SIM800L Cell Tower Tracker (PlatformIO & Arduino)

Complete GSM/GPRS cell tower triangulation tracker using an **ESP32-C3 Super Mini** MCU, **SIM800L** cellular module (configured for **BSNL 2G India**), an **Express Node.js Backend** (ready for Render deployment), and a **React Leaflet Dashboard** (ready for Vercel deployment).

---

## 🛠️ Hardware Wiring (ESP32-C3 Super Mini + SIM800L)

| ESP32-C3 Super Mini | SIM800L Module | Connection Description |
|---|---|---|
| **GPIO 7 (TX1)** | **SIM_RXD / RXD** | ESP32 Hardware Serial TX (GPIO7) -> SIM800L RXD |
| **GPIO 6 (RX1)** | **SIM_TXD / TXD** | ESP32 Hardware Serial RX (GPIO6) <- SIM800L TXD |
| **GND** | **GND** | Common Ground (Mandatory) |
| **External 3.7V-4.2V Power** | **VCC / VBAT** | **Dedicated 2A Power Source** (e.g. 18650 Li-ion or 4.0V Buck Converter) + 1000µF Low-ESR Capacitor |

---

## 📂 Project Structure

```
sim-track/
├── platformio.ini              # PlatformIO Configuration for ESP32-C3 Super Mini
├── config.h                    # Configuration file (TX=GPIO7, RX=GPIO6)
├── test_internet/              # GPRS Internet Diagnostic Tool (Arduino IDE)
│   └── test_internet.ino
├── src/                        # PlatformIO C++ Source Files
│   ├── main.cpp
│   ├── test_internet.cpp
│   ├── config.h
│   ├── SIM800C_Cellular.h
│   └── CellTriangulation.h
├── sim_track.ino               # Main Tracker Arduino Sketch
├── backend/                    # Node.js Express Backend (Deployment: Render)
└── frontend/                   # React + Vite + Leaflet Web App (Deployment: Vercel)
```
