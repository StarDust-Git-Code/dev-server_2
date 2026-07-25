// ══════════════════════════════════════════════════════════════
// ESP32-C3 + SIM800L → BLYNK CLOUD CELL TRACKER
// ══════════════════════════════════════════════════════════════
//
//  Architecture:
//    ESP32 scans cell towers (AT+CENG)
//    → Sends MCC/MNC/LAC/CID/RSSI to Blynk via plain HTTP:80
//    → Render backend polls Blynk, queries OpenCellID
//    → Dashboard shows location on map
//
//  Why Blynk: Plain HTTP on port 80 — no TLS, no SSL, no DNS
//  issues. One GET request sends all 5 values atomically.
//
//  Endpoint: GET /external/api/batch/update?token=T&v1=X&v2=Y...
// ══════════════════════════════════════════════════════════════

#include <Arduino.h>
#include "esp_task_wdt.h"

// ── Hardware ────────────────────────────────────────────────
#define SIM800_TX_PIN     7
#define SIM800_RX_PIN     6
#define SIM800_BAUD       9600
#define STATUS_LED        8

// ── Network ─────────────────────────────────────────────────
#define CELL_APN          "bsnlgprs"
#define UPDATE_INTERVAL   10   // seconds between scans

// ── Blynk IoT (plain HTTP bridge) ───────────────────────────
#define BLYNK_TOKEN       "9fq9knGHB9Txb33Mlv4_O-JrMpOgjtkv"
#define BLYNK_HOST        "blr1.blynk.cloud"
#define BLYNK_PORT        80

// ── Device ID ───────────────────────────────────────────────
#define DEVICE_ID         "ESP32C3_SIM800L_TRACKER"

HardwareSerial simSerial(1);

// ── Tower Data ──────────────────────────────────────────────
struct TowerData {
  int mcc, mnc, lac, cid, rssi, arfcn, bsic;
  bool isServing;
};

// ── Globals ─────────────────────────────────────────────────
uint32_t lastUpdateMs = 0;
unsigned long fixCount = 0;

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
void safeDelay(uint32_t ms) {
  vTaskDelay(pdMS_TO_TICKS(ms));
}

String sendAT(String cmd, uint32_t timeoutMs) {
  while (simSerial.available()) simSerial.read();
  simSerial.println(cmd);
  String resp = "";
  uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    while (simSerial.available()) resp += (char)simSerial.read();
    if (resp.indexOf("OK") != -1 || resp.indexOf("ERROR") != -1 ||
        resp.indexOf(">") != -1 || resp.indexOf("DOWNLOAD") != -1) break;
    safeDelay(10);
  }
  return resp;
}

String waitForResponse(String token, uint32_t timeoutMs) {
  String resp = "";
  uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    while (simSerial.available()) resp += (char)simSerial.read();
    if (resp.indexOf(token) != -1) break;
    safeDelay(10);
  }
  return resp;
}

void blinkLED(int count, int delayMs) {
  for (int i = 0; i < count; i++) {
    digitalWrite(STATUS_LED, LOW);
    safeDelay(delayMs);
    digitalWrite(STATUS_LED, HIGH);
    safeDelay(delayMs);
  }
}

// ══════════════════════════════════════════════════════════════
// CELL TOWER SCANNING (AT+CENG)
// ══════════════════════════════════════════════════════════════
int scanCellTowers(TowerData* towers, int maxTowers) {
  sendAT("AT+CENG=1,1", 2000);
  safeDelay(500);

  String raw = sendAT("AT+CENG?", 3000);
  Serial.println("  [CENG RAW] " + raw);

  int count = 0;
  int pos = 0;

  while (count < maxTowers) {
    int idx = raw.indexOf("+CENG:", pos);
    if (idx == -1) break;
    pos = idx + 6;

    int q1 = raw.indexOf('"', pos);
    int q2 = raw.indexOf('"', q1 + 1);
    if (q1 == -1 || q2 == -1) continue;

    String cell = raw.substring(q1 + 1, q2);
    // Format: "ARFCN,RSSI,BSIC,MCC,MNC,?,CID,?,?,LAC,?"  (serving)
    //     or: "ARFCN,RSSI,BSIC,CID,MCC,MNC,LAC"           (neighbor with data)
    //     or: "ARFCN,RSSI,BSIC,ffff,,,0000"                (neighbor no data)

    int commas[11];
    int ci = 0;
    commas[ci++] = -1;
    for (int j = 0; j < (int)cell.length() && ci < 11; j++) {
      if (cell[j] == ',') commas[ci++] = j;
    }

    if (ci < 4) continue;

    int arfcn = (int)strtol(cell.substring(0, commas[1]).c_str(), NULL, 10);
    int rxlev = (int)strtol(cell.substring(commas[1]+1, commas[2]).c_str(), NULL, 10);
    int rssi  = -(110 - rxlev);

    if (ci >= 10) {
      // Serving cell format
      int mcc = (int)strtol(cell.substring(commas[3]+1, commas[4]).c_str(), NULL, 10);
      int mnc = (int)strtol(cell.substring(commas[4]+1, commas[5]).c_str(), NULL, 10);
      int cid = (int)strtol(cell.substring(commas[6]+1, commas[7]).c_str(), NULL, 16);
      int lac = (int)strtol(cell.substring(commas[9]+1, (ci > 10 ? commas[10] : cell.length())).c_str(), NULL, 16);
      int bsic = (int)strtol(cell.substring(commas[2]+1, commas[3]).c_str(), NULL, 10);

      if (mcc > 0 && cid > 0 && cid != 0xFFFF) {
        towers[count++] = {mcc, mnc, lac, cid, rssi, arfcn, bsic, true};
      }
    } else if (ci >= 7) {
      // Neighbor cell with full data
      int cidVal = (int)strtol(cell.substring(commas[3]+1, commas[4]).c_str(), NULL, 16);
      int mcc    = (int)strtol(cell.substring(commas[4]+1, commas[5]).c_str(), NULL, 10);
      int mnc    = (int)strtol(cell.substring(commas[5]+1, commas[6]).c_str(), NULL, 10);
      int lac    = (int)strtol(cell.substring(commas[6]+1, cell.length()).c_str(), NULL, 16);
      int bsic   = (int)strtol(cell.substring(commas[2]+1, commas[3]).c_str(), NULL, 10);

      if (mcc > 0 && cidVal > 0 && cidVal != 0xFFFF) {
        towers[count++] = {mcc, mnc, lac, cidVal, rssi, arfcn, bsic, false};
      }
    }
  }

  return count;
}

// ══════════════════════════════════════════════════════════════
// GPRS MANAGEMENT
// ══════════════════════════════════════════════════════════════
String ensureGPRS() {
  String ip = sendAT("AT+CIFSR", 3000);
  ip.trim();

  if (ip.indexOf('.') != -1 && ip.indexOf("0.0.0.0") == -1 && ip.length() >= 7) {
    return ip;
  }

  Serial.println("  [GPRS] Reconnecting...");
  sendAT("AT+CIPSHUT", 5000);
  safeDelay(1000);
  sendAT("AT+CGATT=1", 10000);
  sendAT("AT+CIPMUX=0", 1500);
  sendAT("AT+CSTT=\"" CELL_APN "\",\"\",\"\"", 2000);
  sendAT("AT+CIICR", 15000);
  safeDelay(3000);
  sendAT("AT+CDNSCFG=\"8.8.8.8\",\"8.8.4.4\"", 2000);

  ip = sendAT("AT+CIFSR", 3000);
  ip.trim();
  Serial.println("  [GPRS] IP: " + ip);
  return ip;
}

// ══════════════════════════════════════════════════════════════
// SEND TO BLYNK VIA RAW TCP (CSTT STACK)
//
// Uses AT+CIPSTART to open plain TCP:80 to blynk.cloud
// CSTT DNS resolves the hostname (proven to work on BSNL 2G)
// Sends HTTP GET with all 5 cell values in one request
// ══════════════════════════════════════════════════════════════
bool sendToBlynk(const TowerData& cell) {
  Serial.print("[BLYNK] Sending... ");

  // 1. Ensure GPRS is active
  String gprsIP = ensureGPRS();
  if (gprsIP.indexOf('.') == -1 || gprsIP.indexOf("0.0.0.0") != -1) {
    Serial.println("✗ No GPRS");
    return false;
  }

  // 2. Build HTTP GET request
  //    /external/api/batch/update updates ALL pins atomically
  String path = "/external/api/batch/update?token=" BLYNK_TOKEN;
  path += "&v1=" + String(cell.mcc);
  path += "&v2=" + String(cell.mnc);
  path += "&v3=" + String(cell.lac);
  path += "&v4=" + String(cell.cid);
  path += "&v5=" + String(cell.rssi);

  String httpReq = "GET " + path + " HTTP/1.1\r\n";
  httpReq += "Host: " BLYNK_HOST "\r\n";
  httpReq += "Connection: close\r\n\r\n";

  // 3. Close any stale TCP connection
  sendAT("AT+CIPCLOSE", 1000);
  safeDelay(300);

  // 4. Open TCP to blynk.cloud:80 (DNS via CSTT stack)
  String connResp = sendAT("AT+CIPSTART=\"TCP\",\"" BLYNK_HOST "\",80", 10000);
  if (connResp.indexOf("CONNECT OK") == -1 && connResp.indexOf("ALREADY") == -1) {
    connResp += waitForResponse("CONNECT", 10000);
  }

  if (connResp.indexOf("CONNECT OK") == -1 && connResp.indexOf("ALREADY") == -1) {
    Serial.println("✗ TCP connect failed");
    Serial.println("  " + connResp);
    return false;
  }

  Serial.print("TCP✓ ");

  // 5. Send HTTP GET
  String sendCmd = "AT+CIPSEND=" + String(httpReq.length());
  String sendResp = sendAT(sendCmd, 3000);

  if (sendResp.indexOf(">") == -1) {
    Serial.println("✗ No > prompt");
    sendAT("AT+CIPCLOSE", 1000);
    return false;
  }

  simSerial.print(httpReq);
  String result = waitForResponse("SEND OK", 10000);

  if (result.indexOf("SEND OK") == -1) {
    Serial.println("✗ Send failed");
    sendAT("AT+CIPCLOSE", 1000);
    return false;
  }

  Serial.print("SENT✓ ");

  // 6. Read HTTP response (wait for status code)
  String httpResp = waitForResponse("HTTP/", 15000);

  // Drain remaining data
  safeDelay(1000);
  while (simSerial.available()) httpResp += (char)simSerial.read();

  // 7. Close connection
  sendAT("AT+CIPCLOSE", 1000);

  // 8. Check for success
  bool ok = (httpResp.indexOf("200") != -1);

  if (ok) {
    Serial.println("✅ 200 OK!");
  } else {
    Serial.println("✗ Failed");
    Serial.println("  Response: " + httpResp.substring(0, 120));
  }

  return ok;
}

// ══════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════
void setup() {
  esp_task_wdt_deinit();

  Serial.begin(115200);
  safeDelay(2500);

  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, HIGH);

  Serial.println("\n══════════════════════════════════════════════");
  Serial.println(" ESP32-C3 + SIM800L → BLYNK CELL TRACKER");
  Serial.println(" Network: BSNL 2G | APN: " CELL_APN);
  Serial.println(" Bridge:  blynk.cloud (plain HTTP:80)");
  Serial.println(" Token:   " BLYNK_TOKEN);
  Serial.println("══════════════════════════════════════════════\n");

  simSerial.begin(SIM800_BAUD, SERIAL_8N1, SIM800_RX_PIN, SIM800_TX_PIN);
  safeDelay(1500);

  sendAT("ATE1", 1000);
  sendAT("AT", 1500);
  sendAT("AT+CMEE=2", 1500);

  // Register on network
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
  Serial.println(registered ? "Registered! ✅" : "Pending...");

  // Bring up GPRS (CSTT stack)
  Serial.print("[GPRS] Connecting... ");
  sendAT("AT+CIPSHUT", 5000);
  safeDelay(1000);
  sendAT("AT+CGATT=1", 10000);
  sendAT("AT+CIPMUX=0", 1500);
  sendAT("AT+CSTT=\"" CELL_APN "\",\"\",\"\"", 2000);
  sendAT("AT+CIICR", 15000);
  safeDelay(3000);
  sendAT("AT+CDNSCFG=\"8.8.8.8\",\"8.8.4.4\"", 2000);

  String ip = sendAT("AT+CIFSR", 3000);
  ip.trim();
  Serial.println("IP: " + ip + " ✅");

  Serial.println("\n[READY] Scanning towers every " + String(UPDATE_INTERVAL) + "s\n");
}

// ══════════════════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════════════════
void loop() {
  uint32_t now = millis();

  if (now - lastUpdateMs >= (UPDATE_INTERVAL * 1000UL) || lastUpdateMs == 0) {
    lastUpdateMs = now;
    fixCount++;
    digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));

    Serial.printf("\n─── SCAN #%lu ────────────────────────────\n", fixCount);

    // 1. Scan cell towers
    TowerData towers[7];
    int count = scanCellTowers(towers, 7);
    TowerData primary;

    if (count > 0) {
      primary = towers[0];
      Serial.printf("[SCAN] %d tower(s)\n", count);
      for (int i = 0; i < count; i++) {
        Serial.printf("  %s #%d: MCC=%d MNC=%d LAC=%d CID=%d RSSI=%d dBm\n",
                      towers[i].isServing ? ">>>" : "   ",
                      i, towers[i].mcc, towers[i].mnc,
                      towers[i].lac, towers[i].cid, towers[i].rssi);
      }
    } else {
      primary = {404, 64, 0x0904, 0x1B51, -85, 104, 25, true};
      Serial.println("[SCAN] No towers parsed. Using BSNL default.");
    }

    // 2. Send to Blynk
    bool sent = sendToBlynk(primary);
    if (sent) blinkLED(3, 80);
  }

  safeDelay(100);
}
