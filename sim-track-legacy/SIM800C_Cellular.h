#ifndef SIM800C_CELLULAR_H
#define SIM800C_CELLULAR_H

#include <Arduino.h>
#include "esp_task_wdt.h"
#include "config.h"
#include "CellTriangulation.h"

class SIM800C_Cellular {
private:
  HardwareSerial& _serial;
  bool _gprsConnected;

  inline void wdtFeed() {
    esp_task_wdt_reset();
    yield();
  }

public:
  SIM800C_Cellular(HardwareSerial& serial) : _serial(serial), _gprsConnected(false) {}

  void begin(uint32_t baud = SIM800_BAUD, int rxPin = SIM800_RX_PIN, int txPin = SIM800_TX_PIN) {
    _serial.begin(baud, SERIAL_8N1, rxPin, txPin);
    delay(1500);
    wdtFeed();
  }

  String sendCommand(const String& cmd, uint32_t timeoutMs = 3000) {
    while (_serial.available()) _serial.read();
    _serial.println(cmd);
    
    String response = "";
    uint32_t start = millis();
    while (millis() - start < timeoutMs) {
      wdtFeed();
      while (_serial.available()) {
        char c = _serial.read();
        response += c;
      }
      if (response.indexOf("OK") != -1 || response.indexOf("ERROR") != -1) {
        delay(100);
        while (_serial.available()) response += (char)_serial.read();
        break;
      }
      delay(10);
    }
    return response;
  }

  bool checkModemReady() {
    String resp = sendCommand("AT", 1500);
    return (resp.indexOf("OK") != -1);
  }

  int getSignalQuality() {
    String resp = sendCommand("AT+CSQ", 2000);
    int idx = resp.indexOf("+CSQ:");
    if (idx != -1) {
      int comma = resp.indexOf(',', idx);
      if (comma != -1) {
        int rawRssi = resp.substring(idx + 6, comma).toInt();
        if (rawRssi == 99 || rawRssi == 0) return -113;
        return -113 + (rawRssi * 2);
      }
    }
    return -113;
  }

  bool isNetworkRegistered() {
    String resp = sendCommand("AT+CREG?", 1500);
    return (resp.indexOf(",1") != -1 || resp.indexOf(",5") != -1);
  }

  bool setupGPRS(const char* apn = CELL_APN) {
    Serial.println("[GSM] Attaching to GPRS APN: " + String(apn));
    sendCommand("AT+CIPSHUT", 5000);
    delay(1000);
    wdtFeed();

    sendCommand("AT+CGATT=1", 10000);
    sendCommand("AT+CIPMUX=0", 1500);
    
    String apnCmd = "AT+CSTT=\"" + String(apn) + "\",\"\",\"\"";
    sendCommand(apnCmd, 2000);

    sendCommand("AT+CIICR", 15000);
    delay(3000);
    wdtFeed();

    // Set Google DNS
    sendCommand("AT+CDNSCFG=\"8.8.8.8\",\"8.8.4.4\"", 2000);

    String ipResp = sendCommand("AT+CIFSR", 3000);
    ipResp.trim();

    if (ipResp.length() > 6 && ipResp.indexOf("ERROR") == -1 && ipResp.indexOf('.') != -1) {
      Serial.println("[GSM] GPRS Attached! IP: " + ipResp);
      _gprsConnected = true;
      return true;
    }

    _gprsConnected = false;
    return false;
  }

  /**
   * Free Location Method 1: Native SIMCom CIPGSMLOC (LBS)
   */
  bool getCIPGSMLocation(LocationData& loc) {
    // Configure SAPBR bearer profile for CIPGSMLOC
    sendCommand("AT+SAPBR=3,1,\"Contype\",\"GPRS\"", 2000);
    sendCommand("AT+SAPBR=3,1,\"APN\",\"" + String(CELL_APN) + "\"", 2000);
    sendCommand("AT+SAPBR=1,1", 15000);
    delay(2000);
    wdtFeed();

    String resp = sendCommand("AT+CIPGSMLOC=1,1", 10000);
    Serial.println("[GSM LBS] CIPGSMLOC Response: " + resp);

    bool success = CellTriangulation::parseCIPGSMLOC(resp, loc);
    if (success) {
      loc.rssi = getSignalQuality();
    }
    return success;
  }

  int scanCellTowers(TowerData towers[], int maxTowers) {
    sendCommand("AT+CENG=1,1", 1000);
    delay(1000);
    wdtFeed();
    String resp = sendCommand("AT+CENG?", 3000);
    return CellTriangulation::parseEngineeringMode(resp, towers, maxTowers);
  }

  /**
   * Submit telemetry packet containing coordinates or cell metadata to local/remote server
   */
  bool sendTelemetry(const LocationData& loc, const TowerData& servingCell) {
    if (!_gprsConnected) {
      if (!setupGPRS()) return false;
    }

    String jsonPayload = "{";
    jsonPayload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
    jsonPayload += "\"latitude\":" + String(loc.latitude, 6) + ",";
    jsonPayload += "\"longitude\":" + String(loc.longitude, 6) + ",";
    jsonPayload += "\"accuracy\":" + String(loc.accuracyMeters, 1) + ",";
    jsonPayload += "\"rssi\":" + String(loc.rssi) + ",";
    jsonPayload += "\"mcc\":" + String(servingCell.mcc) + ",";
    jsonPayload += "\"mnc\":" + String(servingCell.mnc) + ",";
    jsonPayload += "\"lac\":" + String(servingCell.lac) + ",";
    jsonPayload += "\"cid\":" + String(servingCell.cid) + ",";
    jsonPayload += "\"apn\":\"" + String(CELL_APN) + "\"";
    jsonPayload += "}";

    Serial.println("[TELEMETRY] Payload: " + jsonPayload);

    sendCommand("AT+HTTPTERM", 1000);
    sendCommand("AT+HTTPINIT", 2000);
    sendCommand("AT+HTTPPARA=\"CID\",1", 1000);
    
    String urlCmd = "AT+HTTPPARA=\"URL\",\"http://" + String(SERVER_HOST) + ":" + String(SERVER_PORT) + String(SERVER_PATH) + "\"";
    sendCommand(urlCmd, 1000);
    sendCommand("AT+HTTPPARA=\"CONTENT\",\"application/json\"", 1000);

    String dataCmd = "AT+HTTPDATA=" + String(jsonPayload.length()) + ",10000";
    String dataResp = sendCommand(dataCmd, 2000);
    
    if (dataResp.indexOf("DOWNLOAD") != -1) {
      _serial.print(jsonPayload);
      delay(500);
    }

    String actionResp = sendCommand("AT+HTTPACTION=1", 8000);
    bool ok = (actionResp.indexOf("+HTTPACTION: 1,200") != -1 || actionResp.indexOf(",20") != -1);

    sendCommand("AT+HTTPTERM", 1000);
    return ok;
  }
};

#endif // SIM800C_CELLULAR_H
