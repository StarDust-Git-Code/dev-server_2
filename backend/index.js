const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────
const BLYNK_TOKEN       = process.env.BLYNK_TOKEN || '9fq9knGHB9Txb33Mlv4_O-JrMpOgjtkv';
const BLYNK_HOST        = 'blr1.blynk.cloud';
const OPENCELLID_KEY    = process.env.OPENCELLID_API_KEY || 'pk.69cdaed7edb06e2237aacbfb1426a440';
const POLL_INTERVAL_MS  = 12000;  // Poll Blynk every 12 seconds
const HISTORY_FILE      = path.join('/tmp', 'sim-track-history.json');
const MAX_RECORDS       = 2000;

// ── State ─────────────────────────────────────────────────────
let latestLocation   = null;
let locationHistory  = [];
let lastKnownCell    = { mcc: 0, mnc: 0, lac: 0, cid: 0, rssi: 0 };
let blynkPollActive  = true;

// ── Load persisted history ────────────────────────────────────
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    locationHistory = saved.history || [];
    latestLocation = locationHistory.filter(r => r.latitude).slice(-1)[0] || null;
    console.log(`[STARTUP] Loaded ${locationHistory.length} records`);
  }
} catch (e) {
  console.warn('[STARTUP] Could not load history:', e.message);
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ history: locationHistory }));
  } catch (_) {}
}

function storeRecord(record) {
  const last = locationHistory[locationHistory.length - 1];
  if (last && last.cid === record.cid && last.latitude === record.latitude && last.longitude === record.longitude) {
    if (record.latitude) latestLocation = record;
    return;
  }
  if (record.latitude) latestLocation = record;
  locationHistory.push(record);
  if (locationHistory.length > MAX_RECORDS) locationHistory.shift();
  saveHistory();
}

// ── Cell Location Lookup (multi-source) ───────────────────────
// 1. OpenCellID (if API key set)
// 2. BSNL Chennai LAC-based fallback (known tower areas)
function lookupCell(mcc, mnc, lac, cid, rssi) {
  return new Promise((resolve) => {
    // BSNL Chennai tower area approximation by LAC
    // These are center-of-LAC coordinates for BSNL 2G in Tamil Nadu
    const bsnlLacMap = {
      2304: { lat: 13.0827, lng: 80.2707, name: 'Chennai Central' },
      2305: { lat: 13.0674, lng: 80.2376, name: 'Chennai West' },
      2306: { lat: 13.1143, lng: 80.2849, name: 'Chennai North' },
      2307: { lat: 12.9716, lng: 80.2209, name: 'Chennai South' },
      2308: { lat: 13.0524, lng: 80.2508, name: 'T Nagar / Kodambakkam' },
      2309: { lat: 13.0400, lng: 80.2330, name: 'Ashok Nagar' },
      2310: { lat: 13.0850, lng: 80.2100, name: 'Anna Nagar' },
      2311: { lat: 12.9900, lng: 80.2300, name: 'Velachery' },
      2312: { lat: 13.1200, lng: 80.2300, name: 'Kolathur' },
      2313: { lat: 13.0100, lng: 80.2600, name: 'Adyar' },
      2314: { lat: 13.0600, lng: 80.2800, name: 'Triplicane' },
      2315: { lat: 12.8600, lng: 80.2200, name: 'Tambaram' },
      2316: { lat: 13.1500, lng: 80.2100, name: 'Ambattur' },
      2317: { lat: 13.0475, lng: 80.2090, name: 'Porur / Valasaravakkam' },
      2318: { lat: 13.0300, lng: 80.1700, name: 'Kundrathur' },
      2319: { lat: 13.0950, lng: 80.1560, name: 'Poonamallee / Avadi' },
      2320: { lat: 12.9500, lng: 80.1500, name: 'Guduvanchery' },
      2321: { lat: 13.1600, lng: 80.3000, name: 'Ennore / Thiruvottiyur' },
      2322: { lat: 12.9000, lng: 80.2400, name: 'Chrompet' },
      2323: { lat: 13.0800, lng: 80.1600, name: 'Poonamallee' },
      2324: { lat: 13.1300, lng: 80.1100, name: 'Avadi' },
      2325: { lat: 12.9200, lng: 80.1200, name: 'Sriperumbudur' },
      2326: { lat: 13.0200, lng: 80.1900, name: 'Mangadu' },
      2327: { lat: 12.9800, lng: 80.1600, name: 'Pammal' },
      2328: { lat: 13.0100, lng: 80.2100, name: 'Guindy' },
      2329: { lat: 13.0700, lng: 80.2200, name: 'Koyambedu' },
      2330: { lat: 13.1000, lng: 80.2600, name: 'Perambur' },
      2331: { lat: 12.9400, lng: 80.2000, name: 'Pallavaram' },
      2332: { lat: 12.9600, lng: 80.2500, name: 'Medavakkam' },
      2333: { lat: 13.0500, lng: 80.2000, name: 'Virugambakkam / Saligramam' },
      2334: { lat: 13.0000, lng: 80.2700, name: 'Mylapore' },
      2335: { lat: 13.1100, lng: 80.1500, name: 'Maduravoyal' },
    };

    function fallback() {
      // LAC-based BSNL lookup
      if (mcc === 404 && mnc === 64 && bsnlLacMap[lac]) {
        const area = bsnlLacMap[lac];
        // Add slight CID-based offset (each CID shifts ~100m)
        const cidOffset = (cid % 100) * 0.0008;
        const latOffset = ((cid % 17) - 8) * 0.001;
        resolve({
          latitude:  area.lat + latOffset,
          longitude: area.lng + cidOffset,
          accuracy:  800,
          source:    `BSNL LAC Map (${area.name})`
        });
      } else {
        resolve({ latitude: null, longitude: null, accuracy: null, source: 'Cell Metadata (Unknown LAC)' });
      }
    }

    // Try OpenCellID first
    if (OPENCELLID_KEY) {
      const url = `https://opencellid.org/cell/get?key=${OPENCELLID_KEY}&mcc=${mcc}&mnc=${mnc}&lac=${lac}&cellid=${cid}&format=json`;
      https.get(url, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(raw);
            if (j.lat && j.lon) {
              resolve({
                latitude:  parseFloat(j.lat),
                longitude: parseFloat(j.lon),
                accuracy:  parseFloat(j.range || 500),
                source:    'OpenCellID'
              });
              return;
            }
          } catch (_) {}
          fallback();
        });
      }).on('error', () => fallback());
    } else {
      fallback();
    }
  });
}

// ── Single cell OpenCellID lookup (for triangulation) ─────────
function lookupSingleCell(mcc, mnc, lac, cid) {
  return new Promise((resolve) => {
    if (!OPENCELLID_KEY) { resolve({}); return; }
    const url = `https://opencellid.org/cell/get?key=${OPENCELLID_KEY}&mcc=${mcc}&mnc=${mnc}&lac=${lac}&cellid=${cid}&format=json`;
    https.get(url, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (j.lat && j.lon) {
            resolve({ lat: parseFloat(j.lat), lon: parseFloat(j.lon), range: parseFloat(j.range || 500) });
          } else { resolve({}); }
        } catch (_) { resolve({}); }
      });
    }).on('error', () => resolve({}));
  });
}

// ── Blynk Polling ─────────────────────────────────────────────
async function pollBlynk() {
  return new Promise((resolve) => {
    const url = `https://${BLYNK_HOST}/external/api/get?token=${BLYNK_TOKEN}&v1&v2&v3&v4&v5&v6`;

    https.get(url, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', async () => {
        try {
          const data = JSON.parse(raw);
          const mcc  = parseInt(data.v1 || 0);
          const mnc  = parseInt(data.v2 || 0);
          const lac  = parseInt(data.v3 || 0);
          const cid  = parseInt(data.v4 || 0);
          const rssi = parseInt(data.v5 || -85);
          const neighborsStr = data.v6 || '';

          // Skip if no valid cell data
          if (mcc === 0 || cid === 0) { resolve(false); return; }

          // Skip if same as last known (no change)
          if (mcc === lastKnownCell.mcc && mnc === lastKnownCell.mnc &&
              lac === lastKnownCell.lac && cid === lastKnownCell.cid &&
              rssi === lastKnownCell.rssi && neighborsStr === lastKnownCell.neighbors) {
            resolve(false);
            return;
          }

          lastKnownCell = { mcc, mnc, lac, cid, rssi, neighbors: neighborsStr };

          // Parse ALL towers from V6: "CID:RSSI,CID:RSSI,..."
          const allTowers = [];
          if (neighborsStr) {
            const pairs = neighborsStr.split(',');
            for (const pair of pairs) {
              const [cidStr, rssiStr] = pair.split(':');
              const c = parseInt(cidStr);
              const r = parseInt(rssiStr);
              if (c > 0 && c !== 0xFFFF && !isNaN(r)) {
                allTowers.push({ cid: c, rssi: r });
              }
            }
          }
          // Fallback: if V6 empty, use serving cell only
          if (allTowers.length === 0) {
            allTowers.push({ cid, rssi });
          }

          console.log(`[BLYNK] ${allTowers.length} tower(s): ${allTowers.map(t => `CID:${t.cid}(${t.rssi}dBm)`).join(' ')}`);

          // ── TRIANGULATION: look up ALL towers, compute weighted centroid ──
          const towerCoords = [];
          for (const tower of allTowers) {
            try {
              const geo = await lookupSingleCell(mcc, mnc, lac, tower.cid);
              if (geo.lat && geo.lon) {
                // RSSI to linear weight: stronger signal (less negative) = higher weight
                // w = 10^(rssi/10) — but normalized to avoid tiny numbers
                const weight = Math.pow(10, (tower.rssi + 110) / 20);
                towerCoords.push({ lat: geo.lat, lon: geo.lon, weight, cid: tower.cid, rssi: tower.rssi, range: geo.range });
                console.log(`  [OCID] CID:${tower.cid} → ${geo.lat.toFixed(5)},${geo.lon.toFixed(5)} w=${weight.toFixed(2)}`);
              }
            } catch (_) {}
          }

          let latitude, longitude, accuracy, source;

          if (towerCoords.length >= 2) {
            // Weighted centroid
            let totalWeight = 0, wLat = 0, wLon = 0;
            for (const t of towerCoords) {
              wLat += t.lat * t.weight;
              wLon += t.lon * t.weight;
              totalWeight += t.weight;
            }
            latitude  = wLat / totalWeight;
            longitude = wLon / totalWeight;
            // Accuracy improves with more towers
            accuracy = Math.round(500 / Math.sqrt(towerCoords.length));
            source = `Triangulated (${towerCoords.length} towers)`;
            console.log(`[TRIANGULATE] ${towerCoords.length} towers → ${latitude.toFixed(5)},${longitude.toFixed(5)} ±${accuracy}m`);
          } else if (towerCoords.length === 1) {
            latitude  = towerCoords[0].lat;
            longitude = towerCoords[0].lon;
            accuracy  = towerCoords[0].range || 500;
            source    = 'OpenCellID (single tower)';
          } else {
            // Fallback to LAC map
            const geo = await lookupCell(mcc, mnc, lac, cid, rssi);
            latitude  = geo.latitude;
            longitude = geo.longitude;
            accuracy  = geo.accuracy;
            source    = geo.source;
          }

          const record = {
            deviceId:  'ESP32C3_SIM800L_TRACKER',
            mcc, mnc, lac, cid, rssi,
            towersUsed: towerCoords.length,
            arfcn:     0,
            apn:       'bsnlgprs',
            latitude, longitude, accuracy, source,
            timestamp: new Date().toISOString()
          };

          storeRecord(record);
          console.log(`[RESULT] ${source}: ${latitude?.toFixed(5)},${longitude?.toFixed(5)} ±${accuracy}m`);
          resolve(true);
        } catch (e) {
          console.warn('[BLYNK] Parse error:', e.message);
          resolve(false);
        }
      });
    }).on('error', (e) => {
      console.warn('[BLYNK] Poll error:', e.message);
      resolve(false);
    });
  });
}

// Start polling loop
setInterval(async () => {
  if (blynkPollActive) await pollBlynk();
}, POLL_INTERVAL_MS);

// Initial poll on startup
setTimeout(() => pollBlynk(), 3000);

// ── Middleware ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Health ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    records: locationHistory.length,
    lastCell: lastKnownCell,
    blynkPolling: blynkPollActive
  });
});

// ── POST /api/telemetry (direct send — test script, webhook) ──
app.post('/api/telemetry', async (req, res) => {
  const { deviceId, latitude, longitude, accuracy, rssi, mcc, mnc, lac, cid, arfcn, apn } = req.body;

  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  const acc = parseFloat(accuracy || 500);

  const base = {
    deviceId: deviceId || 'ESP32C3_TRACKER',
    rssi:     parseInt(rssi  || -85),
    mcc:      parseInt(mcc   || 404),
    mnc:      parseInt(mnc   || 64),
    lac:      parseInt(lac   || 0),
    cid:      parseInt(cid   || 0),
    arfcn:    parseInt(arfcn || 0),
    apn:      apn || 'bsnlgprs',
    timestamp: new Date().toISOString()
  };

  // Valid coordinates provided directly
  if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0 && acc < 1500) {
    const record = { ...base, latitude: lat, longitude: lon, accuracy: acc, source: 'Direct LBS Fix' };
    storeRecord(record);
    console.log(`[DIRECT] ${lat.toFixed(5)},${lon.toFixed(5)} ±${acc.toFixed(0)}m`);
    return res.status(200).json({ success: true, data: record });
  }

  // Cell tower lookup
  if (mcc && mnc && lac && cid) {
    const geo = await lookupCell(mcc, mnc, lac, cid, rssi);
    const record = { ...base, ...geo };
    storeRecord(record);
    return res.status(200).json({ success: true, data: record });
  }

  return res.status(400).json({ error: 'Missing cell tower data' });
});

// ── GET /api/location ─────────────────────────────────────────
app.get('/api/location', (req, res) => {
  if (!latestLocation) {
    return res.status(200).json({
      status: 'no_data',
      message: 'Waiting for ESP32 → Blynk → server pipeline…',
      lastCell: lastKnownCell
    });
  }
  res.status(200).json(latestLocation);
});

// ── GET /api/history ──────────────────────────────────────────
app.get('/api/history', (req, res) => {
  const { date } = req.query;
  if (date) {
    return res.status(200).json(locationHistory.filter(r => r.timestamp?.startsWith(date)));
  }
  res.status(200).json(locationHistory);
});

// ── GET /api/sessions ─────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  const days = {};
  locationHistory.forEach(r => {
    if (!r.timestamp) return;
    const day = r.timestamp.slice(0, 10);
    if (!days[day]) days[day] = { date: day, count: 0, fixes: 0, firstTs: r.timestamp, lastTs: r.timestamp };
    days[day].count++;
    days[day].lastTs = r.timestamp;
    if (r.latitude) days[day].fixes++;
  });
  res.status(200).json(Object.values(days).sort((a, b) => b.date.localeCompare(a.date)));
});

// ── DELETE /api/history ───────────────────────────────────────
app.delete('/api/history', (req, res) => {
  locationHistory = [];
  latestLocation = null;
  lastKnownCell = { mcc: 0, mnc: 0, lac: 0, cid: 0, rssi: 0 };
  saveHistory();
  res.status(200).json({ success: true });
});

// ── GET /api/blynk-status ─────────────────────────────────────
app.get('/api/blynk-status', (req, res) => {
  res.json({ polling: blynkPollActive, lastCell: lastKnownCell, token: BLYNK_TOKEN.slice(0, 6) + '...' });
});

app.listen(PORT, () => {
  console.log(`🚀 SIM-Track backend on port ${PORT}`);
  console.log(`📡 Polling Blynk every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`📦 ${locationHistory.length} records loaded`);
});
