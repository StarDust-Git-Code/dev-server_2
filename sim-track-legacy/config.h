#ifndef CONFIG_H
#define CONFIG_H

// ==========================================
// PIN DEFINITIONS FOR ESP32-C3 SUPER MINI + SIM800L
// ==========================================
#define SIM800_TX_PIN 7  // ESP32 TX Pin (GPIO7) -> SIM800L RXD Pin
#define SIM800_RX_PIN 6  // ESP32 RX Pin (GPIO6) -> SIM800L TXD Pin
#define SIM800_BAUD   9600

#define STATUS_LED_PIN 8  // Onboard LED for ESP32-C3 Super Mini (GPIO8)

// ==========================================
// CELLULAR NETWORK & APN CONFIGURATION (BSNL 2G CHENNAI)
// ==========================================
#define CELL_APN      "bsnlgprs"
#define CELL_APN_USER ""
#define CELL_APN_PASS ""

// ==========================================
// TELEMETRY BACKEND SERVER
// ==========================================
// Replace with your computer's local IP or deployed backend domain
#define SERVER_HOST   "192.168.1.100" 
#define SERVER_PORT   3000
#define SERVER_PATH   "/api/telemetry"
#define DEVICE_ID     "ESP32C3_SIM800L_TRACKER"

// ==========================================
// GEOLOCATION STRATEGY (100% FREE - NO PAID KEYS)
// ==========================================
// 1 = Native Free SIM800 LBS (AT+CIPGSMLOC)
// 2 = Raw Cell Tower Telemetry -> Backend Free OpenCellID Resolution
#define PRIMARY_LOC_METHOD 1

// Tracking Interval in Seconds
#define LOCATION_UPDATE_INTERVAL_SEC 15

#endif // CONFIG_H
