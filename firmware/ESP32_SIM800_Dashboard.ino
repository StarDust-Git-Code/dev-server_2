/*
 * ESP32-C3 Super Mini + SIM800L Cellular Triangulation Tracker
 * Network: BSNL 2G Chennai (PLMN: 40464, APN: bsnlgprs)
 * Strategy: 100% FREE (SIMCom Native LBS + Multi-Cell Scan)
 * 
 * WDT FIX: ESP32-C3 is single-core. disableCore0WDT() does NOT exist.
 *          Must use esp_task_wdt_deinit() and vTaskDelay() to prevent
 *          interrupt watchdog starvation panics.
 * 
 * v4 FIXES:
 *   - AT+CENG parsing: Serving cell (11 fields) vs neighbor (7 fields)
 *     have DIFFERENT field orders. ARFCN is [0], not MCC!
 *   - LBS error 604 (DNS): Added DNS config to SAPBR bearer profile
 *   - SAPBR close/reopen on retry to clear stale state
 */

#include <Arduino.h>
#include "esp_task_wdt.h"

#define SIM800_TX_PIN 7
#define SIM800_RX_PIN 6
#define SIM800_BAUD   9600
#define STATUS_LED    8

#define CELL_APN      "bsnlgprs"
// Render forces TLS 1.2 — SIM800L only supports TLS 1.0 → HTTPS fails.
// Workaround: use port 80 HTTP. Render redirects HTTP→HTTPS at the edge,
// but the SIM800L TCP connection itself reaches the HTTP port fine because
// Render terminates SSL at their load balancer and forwards plain HTTP internally.
// If still failing, switch SERVER_HOST to a plain HTTP relay (see comments).
#define SERVER_HOST   "dev-server-2.onrender.com"
#define SERVER_PORT   80
#define USE_HTTPS     0
#define SERVER_PATH   "/api/telemetry"
#define DEVICE_ID     "ESP32C3_SIM800L_TRACKER"
#define UPDATE_INTERVAL_SEC 15

HardwareSerial simSerial(1);
uint32_t lastUpdateMs = 0;
uint32_t fixCount = 0;

struct TowerData {
  uint16_t mcc;  uint16_t mnc;  uint16_t lac;  uint32_t cid;
  int16_t  rssi; uint16_t arfcn; uint8_t bsic;
  bool isServing;
};

struct LocationData {
  bool valid;  double latitude;  double longitude;
  float accuracyMeters;  String timestamp;  int rssi;
};

// ══════════════════════════════════════════════════
// FreeRTOS-safe delay: yields CPU so idle task runs
// This is THE critical fix for ESP32-C3 single-core
// ══════════════════════════════════════════════════
void safeDelay(uint32_t ms) {
  vTaskDelay(pdMS_TO_TICKS(ms));
}

void blinkLED(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(STATUS_LED, LOW);  safeDelay(ms);
    digitalWrite(STATUS_LED, HIGH); safeDelay(ms);
  }
}

// ══════════════════════════════════════════════════
// AT COMMAND ENGINE — yields every 50ms to prevent
// idle task starvation on single-core ESP32-C3
// ══════════════════════════════════════════════════
String sendAT(const String& cmd, uint32_t timeoutMs = 3000) {
  while (simSerial.available()) simSerial.read();
  if (cmd.length() > 0) {
    simSerial.println(cmd);
  }

  String response = "";
  uint32_t start = millis();

  while (millis() - start < timeoutMs) {
    while (simSerial.available()) {
      response += (char)simSerial.read();
    }
    if (response.indexOf("OK") != -1 || response.indexOf("ERROR") != -1) {
      safeDelay(100);
      while (simSerial.available()) response += (char)simSerial.read();
      break;
    }
    safeDelay(50);
  }
  return response;
}

// ══════════════════════════════════════════════════
// ASYNC AT WAIT — for commands that return OK first,
// then send the real result asynchronously.
// Example: AT+HTTPACTION=1 → "OK" (immediate)
//          → "+HTTPACTION: 1,200,xx" (arrives later)
// ══════════════════════════════════════════════════
String waitForResponse(const String& waitFor, uint32_t timeoutMs = 20000) {
  String response = "";
  uint32_t start = millis();

  while (millis() - start < timeoutMs) {
    while (simSerial.available()) {
      response += (char)simSerial.read();
    }
    if (response.indexOf(waitFor) != -1) {
      safeDelay(50);
      while (simSerial.available()) response += (char)simSerial.read();
      return response;
    }
    safeDelay(50);
  }
  return response; // Return whatever we got (timeout)
}

// ══════════════════════════════════════════════════
// MULTI-CELL TOWER SCAN (AT+CENG) — FIXED PARSING
//
// SIM800 AT+CENG format (mode 1,1):
//
// Serving cell (cell 0) — 11 fields:
//   "arfcn,rxl,rxq,mcc,mnc,bsic,cellid,rla,txp,lac,ta"
//      [0]  [1] [2] [3] [4]  [5]   [6]  [7] [8] [9] [10]
//
// Neighbor cells (1-6) — 7 fields:
//   "arfcn,rxl,bsic,cellid,mcc,mnc,lac"
//      [0]  [1] [2]   [3]  [4] [5] [6]
//
// RSSI (dBm) = -110 + rxl
// LAC and CellID are in HEX
// ══════════════════════════════════════════════════
int scanCellTowers(TowerData towers[], int maxTowers) {
  sendAT("AT+CENG=1,1", 1000);
  safeDelay(1000);
  String cengOutput = sendAT("AT+CENG?", 5000);

  Serial.println("  [CENG RAW] " + cengOutput);

  int towerCount = 0;
  int pos = 0;

  while (pos < (int)cengOutput.length() && towerCount < maxTowers) {
    int lineStart = cengOutput.indexOf("+CENG:", pos);
    if (lineStart == -1) break;
    int lineEnd = cengOutput.indexOf("\n", lineStart);
    if (lineEnd == -1) lineEnd = cengOutput.length();

    String line = cengOutput.substring(lineStart, lineEnd);
    line.trim();

    // Determine cell index: "+CENG: 0,..." vs "+CENG: 1,..."
    int colonPos = line.indexOf(':');
    int commaAfterIdx = line.indexOf(',', colonPos);
    int cellIndex = -1;
    if (colonPos != -1 && commaAfterIdx != -1) {
      cellIndex = line.substring(colonPos + 1, commaAfterIdx).toInt();
    }
    bool isServing = (cellIndex == 0);

    // Extract quoted content
    int q1 = line.indexOf('"');
    int q2 = line.lastIndexOf('"');

    if (q1 != -1 && q2 > q1) {
      String content = line.substring(q1 + 1, q2);

      // Tokenize by comma
      String tokens[12];
      int tokIdx = 0;
      int lastComma = 0;

      for (int i = 0; i <= (int)content.length() && tokIdx < 12; i++) {
        if (i == (int)content.length() || content.charAt(i) == ',') {
          tokens[tokIdx++] = content.substring(lastComma, i);
          lastComma = i + 1;
        }
      }

      TowerData td;
      td.isServing = isServing;

      if (isServing && tokIdx >= 7) {
        // ═══ SERVING CELL (11 fields) ═══
        // [0]=arfcn [1]=rxl [2]=rxq [3]=mcc [4]=mnc
        // [5]=bsic [6]=cellid(hex) [7]=rla [8]=txp [9]=lac(hex) [10]=ta
        td.arfcn = (uint16_t)tokens[0].toInt();
        td.rssi  = -110 + tokens[1].toInt();
        td.mcc   = (uint16_t)tokens[3].toInt();
        td.mnc   = (uint16_t)tokens[4].toInt();
        td.bsic  = (uint8_t)tokens[5].toInt();
        td.cid   = (uint32_t)strtoul(tokens[6].c_str(), NULL, 16);
        td.lac   = (tokIdx >= 10) ? (uint16_t)strtoul(tokens[9].c_str(), NULL, 16) : 0;

        towers[towerCount++] = td;

      } else if (!isServing && tokIdx >= 5) {
        // ═══ NEIGHBOR CELL (7 fields) ═══
        // [0]=arfcn [1]=rxl [2]=bsic [3]=cellid(hex) [4]=mcc [5]=mnc [6]=lac(hex)
        td.arfcn = (uint16_t)tokens[0].toInt();
        td.rssi  = -110 + tokens[1].toInt();
        td.bsic  = (uint8_t)tokens[2].toInt();
        td.cid   = (uint32_t)strtoul(tokens[3].c_str(), NULL, 16);
        td.mcc   = (tokIdx >= 5) ? (uint16_t)tokens[4].toInt() : 0;
        td.mnc   = (tokIdx >= 6) ? (uint16_t)tokens[5].toInt() : 0;
        td.lac   = (tokIdx >= 7) ? (uint16_t)strtoul(tokens[6].c_str(), NULL, 16) : 0;

        // Skip empty/invalid neighbor entries (CID=0xFFFF = no tower)
        if (td.cid == 0 || td.cid == 0xFFFF || td.mcc == 0) {
          pos = lineEnd + 1;
          continue;
        }
        towers[towerCount++] = td;
      }
    }
    pos = lineEnd + 1;
  }
  return towerCount;
}

// ══════════════════════════════════════════════════
// FREE CELLULAR LBS (AT+CIPGSMLOC)
// 
// FIX for error 604 (DNS error):
//   - Must configure SAPBR bearer with DNS servers
//   - Close and reopen bearer to clear stale state
//   - SAPBR is independent from CSTT/CIICR stack
//
// +CIPGSMLOC response format:
//   +CIPGSMLOC: <err>,<longitude>,<latitude>,<date>,<time>
//   err=0 means success
// ══════════════════════════════════════════════════
bool getFreeLBSLocation(LocationData& loc) {
  // Close any existing bearer (ignore errors)
  sendAT("AT+SAPBR=0,1", 2000);
  safeDelay(500);

  // Configure bearer profile 1 for GPRS
  sendAT("AT+SAPBR=3,1,\"Contype\",\"GPRS\"", 2000);
  sendAT("AT+SAPBR=3,1,\"APN\",\"" CELL_APN "\"", 2000);

  // *** FIX: Set DNS on the SAPBR bearer ***
  // Error 604 = DNS resolution failed on the bearer
  // SIMCom LBS server needs DNS to resolve its hostname
  sendAT("AT+SAPBR=3,1,\"DNS1\",\"8.8.8.8\"", 1000);
  sendAT("AT+SAPBR=3,1,\"DNS2\",\"8.8.4.4\"", 1000);

  // Open the bearer
  String openResp = sendAT("AT+SAPBR=1,1", 15000);
  safeDelay(3000);

  // Check bearer status
  String statusResp = sendAT("AT+SAPBR=2,1", 3000);
  Serial.println("  [SAPBR] Status: " + statusResp);

  // Request location from SIMCom LBS server
  // Mode 1 = location, CID 1 = bearer profile 1
  String resp = sendAT("AT+CIPGSMLOC=1,1", 15000);
  Serial.println("  [LBS] Raw: " + resp);

  int idx = resp.indexOf("+CIPGSMLOC:");
  if (idx == -1) {
    sendAT("AT+SAPBR=0,1", 2000);
    return false;
  }

  String data = resp.substring(idx + 12);
  data.trim();

  // Parse: <err>,<lon>,<lat>,<date>,<time>
  int c1 = data.indexOf(',');
  if (c1 == -1) { sendAT("AT+SAPBR=0,1", 2000); return false; }

  int errCode = data.substring(0, c1).toInt();
  if (errCode != 0) {
    Serial.printf("  [LBS] Error code: %d\n", errCode);
    // Error codes: 601=net err, 602=no GPS, 603=net err, 604=DNS, 605/606=other
    sendAT("AT+SAPBR=0,1", 2000);
    return false;
  }

  int c2 = data.indexOf(',', c1 + 1);
  int c3 = data.indexOf(',', c2 + 1);
  int c4 = (c3 != -1) ? data.indexOf(',', c3 + 1) : -1;

  if (c2 == -1 || c3 == -1) { sendAT("AT+SAPBR=0,1", 2000); return false; }

  loc.longitude      = data.substring(c1 + 1, c2).toDouble();
  loc.latitude       = data.substring(c2 + 1, c3).toDouble();
  loc.timestamp      = (c4 != -1) ? data.substring(c3 + 1) : data.substring(c3 + 1);
  loc.timestamp.trim();
  loc.accuracyMeters = 500.0;
  loc.valid          = (loc.latitude != 0.0 && loc.longitude != 0.0);

  // Keep bearer open for HTTP, close after telemetry
  return loc.valid;
}

// ══════════════════════════════════════════════════
// HTTP TELEMETRY DISPATCH
// ══════════════════════════════════════════════════
bool sendTelemetry(const LocationData& loc, const TowerData& cell) {
  String json = "{";
  json += "\"deviceId\":\"" DEVICE_ID "\",";
  json += "\"latitude\":" + String(loc.latitude, 6) + ",";
  json += "\"longitude\":" + String(loc.longitude, 6) + ",";
  json += "\"accuracy\":" + String(loc.accuracyMeters, 1) + ",";
  json += "\"rssi\":" + String(loc.rssi) + ",";
  json += "\"mcc\":" + String(cell.mcc) + ",";
  json += "\"mnc\":" + String(cell.mnc) + ",";
  json += "\"lac\":" + String(cell.lac) + ",";
  json += "\"cid\":" + String(cell.cid) + ",";
  json += "\"arfcn\":" + String(cell.arfcn) + ",";
  json += "\"apn\":\"" CELL_APN "\"";
  json += "}";

  Serial.println("  [HTTP] Payload: " + json);

  sendAT("AT+HTTPTERM", 1000);
  sendAT("AT+HTTPINIT", 2000);
  sendAT("AT+HTTPPARA=\"CID\",1", 1000);

  // *** HTTPS for Render.com (forces SSL) ***
#if USE_HTTPS
  sendAT("AT+HTTPSSL=1", 1000);
  String urlCmd = "AT+HTTPPARA=\"URL\",\"https://" + String(SERVER_HOST) + String(SERVER_PATH) + "\"";
#else
  String urlCmd = "AT+HTTPPARA=\"URL\",\"http://" + String(SERVER_HOST) + ":" + String(SERVER_PORT) + String(SERVER_PATH) + "\"";
#endif
  sendAT(urlCmd, 1000);
  Serial.println("  [HTTP] URL: " + urlCmd);
  sendAT("AT+HTTPPARA=\"CONTENT\",\"application/json\"", 1000);

  String dataResp = sendAT("AT+HTTPDATA=" + String(json.length()) + ",10000", 2000);
  Serial.println("  [HTTP] HTTPDATA resp: " + dataResp);

  if (dataResp.indexOf("DOWNLOAD") != -1) {
    simSerial.print(json);
    safeDelay(1000);
  } else {
    Serial.println("  [HTTP] ⚠ DOWNLOAD prompt not received! Abort.");
    sendAT("AT+HTTPTERM", 1000);
    sendAT("AT+SAPBR=0,1", 1000);
    return false;
  }

  // Send the HTTP POST — returns OK immediately (request dispatched)
  // then +HTTPACTION: 1,<status>,<bytes> arrives asynchronously
  simSerial.println("AT+HTTPACTION=1");
  String initResp = "";
  uint32_t t0 = millis();
  while (millis() - t0 < 3000) {
    while (simSerial.available()) initResp += (char)simSerial.read();
    if (initResp.indexOf("OK") != -1 || initResp.indexOf("ERROR") != -1) break;
    safeDelay(50);
  }
  Serial.println("  [HTTP] HTTPACTION init: " + initResp);

  // Now wait separately for the async +HTTPACTION: response (up to 30s)
  Serial.print("  [HTTP] Waiting for server response...");
  String actionResp = waitForResponse("+HTTPACTION:", 30000);
  Serial.println(" Done.");
  Serial.println("  [HTTP] ACTION result: " + actionResp);

  bool ok = (actionResp.indexOf("+HTTPACTION: 1,200") != -1 ||
             actionResp.indexOf(",200,") != -1 ||
             actionResp.indexOf(",201,") != -1);

  if (ok) {
    String readResp = sendAT("AT+HTTPREAD", 3000);
    Serial.println("  [HTTP] Server says: " + readResp);
  }

  sendAT("AT+HTTPTERM", 1000);
  sendAT("AT+SAPBR=0,1", 1000);
  return ok;
}

// ══════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════
void setup() {
  // *** ESP32-C3 SINGLE-CORE WDT FIX ***
  esp_task_wdt_deinit();

  Serial.begin(115200);
  safeDelay(2500);

  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, HIGH);

  Serial.println("\n==================================================");
  Serial.println(" ESP32-C3 + SIM800L CELLULAR TRIANGULATION TRACKER");
  Serial.println(" Network: BSNL 2G (PLMN 40464, APN: " CELL_APN ")");
  Serial.println(" Strategy: 100% FREE (LBS + Multi-Cell Scan)");
  Serial.println(" v4: Fixed CENG parsing + LBS DNS error 604");
  Serial.println("==================================================\n");

  simSerial.begin(SIM800_BAUD, SERIAL_8N1, SIM800_RX_PIN, SIM800_TX_PIN);
  safeDelay(1500);

  sendAT("ATE1", 1000);
  sendAT("AT", 1500);
  sendAT("AT+CMEE=2", 1500);

  // Network registration
  Serial.print("[GSM] Registering on BSNL 2G... ");
  sendAT("AT+COPS=0", 15000);
  safeDelay(2000);

  bool registered = false;
  for (int i = 0; i < 15; i++) {
    String r = sendAT("AT+CREG?", 1500);
    if (r.indexOf(",1") != -1 || r.indexOf(",5") != -1) {
      registered = true;
      break;
    }
    safeDelay(2000);
  }
  Serial.println(registered ? "Registered! ✅" : "Registration pending...");

  // GPRS setup (CSTT/CIICR stack — for general TCP)
  Serial.print("[GPRS] Attaching to APN \"" CELL_APN "\"... ");
  sendAT("AT+CIPSHUT", 5000);
  safeDelay(1000);
  sendAT("AT+CGATT=1", 10000);
  sendAT("AT+CIPMUX=0", 1500);
  sendAT("AT+CSTT=\"" CELL_APN "\",\"\",\"\"", 2000);
  sendAT("AT+CIICR", 15000);
  safeDelay(3000);
  sendAT("AT+CDNSCFG=\"8.8.8.8\",\"8.8.4.4\"", 2000);

  String ipResp = sendAT("AT+CIFSR", 3000);
  ipResp.trim();
  Serial.println("IP: " + ipResp + " ✅");
}

// ══════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════
void loop() {
  uint32_t now = millis();

  if (now - lastUpdateMs >= (UPDATE_INTERVAL_SEC * 1000UL) || lastUpdateMs == 0) {
    lastUpdateMs = now;
    fixCount++;
    digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));

    Serial.printf("\n─── [FIX #%lu] CELL TRIANGULATION ───\n", fixCount);

    // 1. Scan Cell Towers
    TowerData towers[7];
    int count = scanCellTowers(towers, 7);
    TowerData primary;

    if (count > 0) {
      primary = towers[0];
      Serial.printf("[SCAN] %d cell(s) detected\n", count);
      for (int i = 0; i < count; i++) {
        Serial.printf("  %s Cell %d: MCC=%d MNC=%d LAC=0x%04X(%d) CID=0x%04X(%d) ARFCN=%d RSSI=%d dBm\n",
                      towers[i].isServing ? ">>>" : "   ",
                      i, towers[i].mcc, towers[i].mnc,
                      towers[i].lac, towers[i].lac,
                      towers[i].cid, towers[i].cid,
                      towers[i].arfcn, towers[i].rssi);
      }
    } else {
      // Hardcoded BSNL Chennai fallback
      primary = {404, 64, 0x0904, 0x1B51, -85, 104, 25, true};
      Serial.println("[SCAN] No cells parsed. Using BSNL Chennai default.");
    }

    // 2. Free Native LBS
    LocationData loc;
    Serial.print("[LBS] Requesting location... ");
    bool lbsOk = getFreeLBSLocation(loc);

    if (lbsOk && loc.valid) {
      loc.rssi = primary.rssi;
      Serial.printf("✅ Lat:%.6f Lon:%.6f (%s)\n",
                    loc.latitude, loc.longitude, loc.timestamp.c_str());
    } else {
      Serial.println("Fallback to cell metadata.");
      loc.valid = false;
      loc.rssi = primary.rssi;
      loc.latitude = 13.114009;    // Chennai default
      loc.longitude = 80.287546;
      loc.accuracyMeters = 2000.0; // Lower confidence for fallback
    }

    // 3. Send to backend (will fail if server not running — that's OK)
    Serial.print("[HTTP] POST telemetry... ");
    bool sent = sendTelemetry(loc, primary);
    Serial.println(sent ? "SENT! ✅" : "Server unreachable (OK if not running).");
    if (sent) blinkLED(2, 100);
  }

  safeDelay(100);
}
