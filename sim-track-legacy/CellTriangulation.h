#ifndef CELL_TRIANGULATION_H
#define CELL_TRIANGULATION_H

#include <Arduino.h>

struct TowerData {
  uint16_t mcc;
  uint16_t mnc;
  uint16_t lac;
  uint32_t cid;
  int16_t  rssi;
  bool     isServing;
};

struct LocationData {
  bool     valid;
  double   latitude;
  double   longitude;
  float    accuracyMeters;
  String   timestamp;
  uint16_t mcc;
  uint16_t mnc;
  uint16_t lac;
  uint32_t cid;
  int      rssi;
  int      neighborCount;
};

class CellTriangulation {
public:
  // Parse AT+CIPGSMLOC=1,1 response
  // Example response: +CIPGSMLOC: 0,77.594563,12.971598,2026/07/22,08:00:00
  static bool parseCIPGSMLOC(const String& response, LocationData& loc) {
    int idx = response.indexOf("+CIPGSMLOC:");
    if (idx == -1) return false;

    String data = response.substring(idx + 11);
    data.trim();

    // Split by comma
    int firstComma  = data.indexOf(',');
    int secondComma = data.indexOf(',', firstComma + 1);
    int thirdComma  = data.indexOf(',', secondComma + 1);
    int fourthComma = data.indexOf(',', thirdComma + 1);
    int fifthComma  = data.indexOf(',', fourthComma + 1);

    if (firstComma == -1 || secondComma == -1 || thirdComma == -1) return false;

    int status = data.substring(0, firstComma).toInt();
    if (status != 0) {
      // 0 means success
      return false;
    }

    String lonStr  = data.substring(firstComma + 1, secondComma);
    String latStr  = data.substring(secondComma + 1, thirdComma);
    String dateStr = (fourthComma != -1) ? data.substring(thirdComma + 1, fourthComma) : "";
    String timeStr = (fifthComma != -1)  ? data.substring(fourthComma + 1, fifthComma) : "";

    loc.longitude = lonStr.toDouble();
    loc.latitude  = latStr.toDouble();
    loc.timestamp = dateStr + " " + timeStr;
    loc.accuracyMeters = 500.0; // Typical single-cell LBS accuracy estimate
    loc.valid = (loc.latitude != 0.0 && loc.longitude != 0.0);

    return loc.valid;
  }

  // Parse +CENG: Engineering mode response for multi-cell scanning
  // Example +CENG: 0,"404,45,1A2F,3E1A,28,32"
  static int parseEngineeringMode(const String& cengOutput, TowerData towers[], int maxTowers) {
    int towerCount = 0;
    int pos = 0;

    while (pos < cengOutput.length() && towerCount < maxTowers) {
      int lineStart = cengOutput.indexOf("+CENG:", pos);
      if (lineStart == -1) break;

      int lineEnd = cengOutput.indexOf("\n", lineStart);
      if (lineEnd == -1) lineEnd = cengOutput.length();

      String line = cengOutput.substring(lineStart, lineEnd);
      line.trim();

      // Extract contents inside quotes
      int q1 = line.indexOf('"');
      int q2 = line.lastIndexOf('"');

      if (q1 != -1 && q2 > q1) {
        String content = line.substring(q1 + 1, q2);
        
        // Parse CSV fields inside quotes: MCC,MNC,LAC,CID,bsic,rxlev
        String tokens[7];
        int tokIdx = 0;
        int lastComma = 0;

        for (int i = 0; i <= content.length() && tokIdx < 7; i++) {
          if (i == content.length() || content.charAt(i) == ',') {
            tokens[tokIdx++] = content.substring(lastComma, i);
            lastComma = i + 1;
          }
        }

        if (tokIdx >= 4) {
          towers[towerCount].mcc = (uint16_t)strtoul(tokens[0].c_str(), NULL, 10);
          towers[towerCount].mnc = (uint16_t)strtoul(tokens[1].c_str(), NULL, 10);
          towers[towerCount].lac = (uint16_t)strtoul(tokens[2].c_str(), NULL, 16); // LAC is in Hex
          towers[towerCount].cid = (uint32_t)strtoul(tokens[3].c_str(), NULL, 16); // CID is in Hex

          if (tokIdx >= 6) {
            int rxlev = tokens[5].toInt();
            towers[towerCount].rssi = -111 + (rxlev * 2); // Convert rxlev to dBm
          } else {
            towers[towerCount].rssi = -90;
          }

          towers[towerCount].isServing = (line.indexOf("+CENG: 0,") != -1);
          towerCount++;
        }
      }

      pos = lineEnd + 1;
    }

    return towerCount;
  }
};

#endif // CELL_TRIANGULATION_H
