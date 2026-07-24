/*
 * ESP32-C3 Super Mini + SIM800L GPRS Internet Connectivity Diagnostic Test
 * Open in Arduino IDE or flash via PlatformIO env:esp32c3_internet_test
 */

#include <Arduino.h>
#include "config.h"

HardwareSerial simSerial(1);

String sendATCommand(const String& cmd, uint32_t timeoutMs = 2000) {
  while (simSerial.available()) simSerial.read();
  simSerial.println(cmd);
  
  String response = "";
  uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    while (simSerial.available()) {
      char c = simSerial.read();
      response += c;
    }
  }
  return response;
}

void blinkLED(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(STATUS_LED_PIN, LOW);
    delay(delayMs);
    digitalWrite(STATUS_LED_PIN, HIGH);
    delay(delayMs);
  }
}

void setup() {
  Serial.begin(115200);
  delay(2000);

  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, HIGH);

  Serial.println("\n==================================================");
  Serial.println("  SIM800L GPRS INTERNET CONNECTIVITY DIAGNOSTIC");
  Serial.println("  ESP32-C3 Super Mini • APN: " CELL_APN);
  Serial.println("==================================================\n");

  simSerial.begin(SIM800_BAUD, SERIAL_8N1, SIM800_RX_PIN, SIM800_TX_PIN);
  delay(1000);

  bool allPassed = true;

  // STEP 1: Check Serial Communication
  Serial.print("[STEP 1/7] Testing SIM800L Serial connection (AT)... ");
  String resp = sendATCommand("AT", 1500);
  if (resp.indexOf("OK") != -1) {
    Serial.println("PASS! ✅");
  } else {
    Serial.println("FAIL! ❌");
    allPassed = false;
  }

  // STEP 2: Check SIM Card Insertion
  if (allPassed) {
    Serial.print("[STEP 2/7] Checking SIM Card Status (AT+CPIN?)... ");
    resp = sendATCommand("AT+CPIN?", 1500);
    if (resp.indexOf("READY") != -1) {
      Serial.println("PASS! (SIM Card Ready) ✅");
    } else {
      Serial.println("FAIL! ❌");
      allPassed = false;
    }
  }

  // STEP 3: Check Signal Strength
  if (allPassed) {
    Serial.print("[STEP 3/7] Checking Signal Quality RSSI (AT+CSQ)... ");
    resp = sendATCommand("AT+CSQ", 1500);
    int idx = resp.indexOf("+CSQ:");
    if (idx != -1) {
      int comma = resp.indexOf(',', idx);
      int rawRssi = resp.substring(idx + 6, comma).toInt();
      int dbm = -113 + (rawRssi * 2);
      Serial.printf("PASS! (RSSI: %d dBm) ✅\n", dbm);
    } else {
      Serial.println("FAIL! ❌");
      allPassed = false;
    }
  }

  // STEP 4: Check Network Registration
  if (allPassed) {
    Serial.print("[STEP 4/7] Checking Cellular Network Registration (AT+CREG?)... ");
    resp = sendATCommand("AT+CREG?", 2000);
    if (resp.indexOf(",1") != -1 || resp.indexOf(",5") != -1) {
      Serial.println("PASS! Registered on cellular network! ✅");
    } else {
      Serial.println("FAIL! ❌");
      allPassed = false;
    }
  }

  // STEP 5: Attach GPRS & APN
  if (allPassed) {
    Serial.print("[STEP 5/7] Configuring GPRS APN (" CELL_APN ")... ");
    sendATCommand("AT+CIPSHUT", 2000);
    sendATCommand("AT+CGATT=1", 3000);
    sendATCommand("AT+CIPMUX=0", 1000);
    sendATCommand("AT+CSTT=\"" CELL_APN "\",\"" CELL_APN_USER "\",\"" CELL_APN_PASS "\"", 2000);
    sendATCommand("AT+CIICR", 5000);
    Serial.println("PASS! GPRS Connection Initialized ✅");
  }

  // STEP 6: Get IP Address
  if (allPassed) {
    Serial.print("[STEP 6/7] Requesting GPRS Local IP Address (AT+CIFSR)... ");
    resp = sendATCommand("AT+CIFSR", 3000);
    resp.trim();
    if (resp.length() > 0 && resp.indexOf("ERROR") == -1) {
      Serial.println("PASS! ✅");
      Serial.println("  -> Cellular IP: " + resp);
    } else {
      Serial.println("FAIL! ❌");
      allPassed = false;
    }
  }

  // STEP 7: Live HTTP GET Internet Request
  if (allPassed) {
    Serial.print("[STEP 7/7] Performing Live HTTP GET request to http://api.ipify.org ... ");
    sendATCommand("AT+HTTPTERM", 1000);
    sendATCommand("AT+HTTPINIT", 2000);
    sendATCommand("AT+HTTPPARA=\"CID\",1", 1000);
    sendATCommand("AT+HTTPPARA=\"URL\",\"http://api.ipify.org\"", 1000);
    
    String actionResp = sendATCommand("AT+HTTPACTION=0", 6000);
    if (actionResp.indexOf("+HTTPACTION: 0,200") != -1 || actionResp.indexOf(",200") != -1) {
      String body = sendATCommand("AT+HTTPREAD", 3000);
      Serial.println("PASS! ✅");
      Serial.println("\n--------------------------------------------------");
      Serial.println(" 🎉 INTERNET CONNECTION IS WORKING PERFECTLY!");
      Serial.println(" 🌐 Public Gateway IP: " + body);
      Serial.println("--------------------------------------------------\n");
      blinkLED(10, 100);
    } else {
      Serial.println("FAIL! ❌");
      allPassed = false;
    }
    sendATCommand("AT+HTTPTERM", 1000);
  }

  if (!allPassed) {
    Serial.println("\n--------------------------------------------------");
    Serial.println(" ❌ GPRS INTERNET TEST FAILED.");
    Serial.println("--------------------------------------------------\n");
    blinkLED(3, 800);
  }
}

void loop() {
  delay(30000);
  setup();
}
