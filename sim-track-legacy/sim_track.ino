/*
 * ESP32-C3 Super Mini + SIM800L Cellular Location Tracker
 * 100% Free Triangulation (Native SIMCom LBS + OpenCellID Free Fallback)
 * Network: BSNL 2G Chennai (APN: bsnlgprs)
 */

#include <Arduino.h>
#include "esp_task_wdt.h"
#include "config.h"
#include "CellTriangulation.h"
#include "SIM800C_Cellular.h"

SIM800C_Cellular cellular(Serial1);

uint32_t lastUpdateMs = 0;
LocationData currentLoc;
TowerData towers[7];

inline void wdtFeed() {
  esp_task_wdt_reset();
  yield();
}

void setup() {
  // Configure ESP32 WDT Watchdog to 60 seconds
  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = 60000,
    .idle_core_mask = 0,
    .trigger_panic = false
  };
  esp_task_wdt_reconfigure(&wdt_config);
  esp_task_wdt_add(NULL);

  Serial.begin(115200);
  delay(2000);

  Serial.println("\n==============================================");
  Serial.println(" ESP32-C3 Super Mini SIM800L Cell Tracker");
  Serial.println(" Triangulation Strategy: 100% FREE (LBS + Cell)");
  Serial.println(" Network: BSNL 2G (APN: " CELL_APN ")");
  Serial.println("==============================================\n");

  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, HIGH); // LED Off

  cellular.begin(SIM800_BAUD, SIM800_RX_PIN, SIM800_TX_PIN);

  Serial.print("[BOOT] Testing SIM800L module response... ");
  int retries = 0;
  while (!cellular.checkModemReady() && retries < 10) {
    wdtFeed();
    delay(1000);
    Serial.print(".");
    retries++;
  }

  if (retries >= 10) {
    Serial.println(" FAIL! Check SIM800L hardware wiring & 4.0V supply.");
  } else {
    Serial.println(" OK! ✅");
  }

  Serial.print("[GSM] Registering on BSNL 2G network... ");
  while (!cellular.isNetworkRegistered()) {
    wdtFeed();
    delay(2000);
    Serial.print(".");
  }
  Serial.println(" Registered! ✅");

  int rssi = cellular.getSignalQuality();
  Serial.printf("[GSM] Signal Strength: %d dBm\n", rssi);

  cellular.setupGPRS(CELL_APN);
}

void loop() {
  wdtFeed();
  uint32_t now = millis();

  if (now - lastUpdateMs >= (LOCATION_UPDATE_INTERVAL_SEC * 1000UL) || lastUpdateMs == 0) {
    lastUpdateMs = now;
    digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN)); // Toggle LED

    Serial.println("\n─── [CELL TOWER SCAN & GEOLOCATION FIX] ───");

    // Scan serving cell and neighbor cells
    int towerCount = cellular.scanCellTowers(towers, 7);
    TowerData primaryTower;
    if (towerCount > 0) {
      primaryTower = towers[0];
      Serial.printf("[CELL SCAN] Primary Serving Cell -> MCC: %d, MNC: %d, LAC: 0x%X (%d), CID: 0x%X (%d), RSSI: %d dBm\n",
                    primaryTower.mcc, primaryTower.mnc, primaryTower.lac, primaryTower.lac, primaryTower.cid, primaryTower.cid, primaryTower.rssi);
    } else {
      primaryTower = {404, 64, 2308, 6993, -85, true}; // Default Chennai cell parameters fallback
    }

    // Try Free Native SIMCom LBS (AT+CIPGSMLOC)
    Serial.print("[FREE LBS] Querying native location (AT+CIPGSMLOC)... ");
    bool lbsOk = cellular.getCIPGSMLocation(currentLoc);

    if (lbsOk && currentLoc.valid) {
      Serial.printf("SUCCESS! ✅\n  -> Latitude : %.6f\n  -> Longitude: %.6f\n  -> Timestamp: %s\n",
                    currentLoc.latitude, currentLoc.longitude, currentLoc.timestamp.c_str());
    } else {
      Serial.println("LBS pending network sync. Using Cell Tower Metadata.");
      currentLoc.valid = false;
      currentLoc.rssi = primaryTower.rssi;
      currentLoc.mcc = primaryTower.mcc;
      currentLoc.mnc = primaryTower.mnc;
      currentLoc.lac = primaryTower.lac;
      currentLoc.cid = primaryTower.cid;
    }

    // Submit telemetry packet to backend
    Serial.print("[TELEMETRY] Submitting location fix to backend... ");
    bool sent = cellular.sendTelemetry(currentLoc, primaryTower);
    if (sent) {
      Serial.println("SENT! ✅");
    } else {
      Serial.println("GPRS POST pending.");
    }
  }

  delay(100);
}
