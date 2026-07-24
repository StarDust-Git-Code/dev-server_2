const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory store (persists until Render restarts)
let latestLocation  = null;
let locationHistory = [];

// ── Helpers ──────────────────────────────────────────────────
function storeRecord(record) {
  latestLocation = record;
  locationHistory.push(record);
  if (locationHistory.length > 500) locationHistory.shift();
}

function lookupOpenCellID(mcc, mnc, lac, cid, fallbackRecord, res) {
  const key = process.env.OPENCELLID_API_KEY || '';
  if (!key) {
    // No API key — store with cell metadata but no coordinates
    const record = { ...fallbackRecord, latitude: null, longitude: null, source: 'Cell Metadata Only (No API Key)' };
    storeRecord(record);
    console.log(`[CELL META] CID:${cid} LAC:${lac} — no OpenCellID key, stored metadata only`);
    return res.status(200).json({ success: true, data: record });
  }

  const url = `https://opencellid.org/cell/get?key=${key}&mcc=${mcc}&mnc=${mnc}&lac=${lac}&cellid=${cid}&format=json`;

  https.get(url, (apiRes) => {
    let raw = '';
    apiRes.on('data', chunk => raw += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(raw);
        if (json.lat && json.lon) {
          const record = {
            ...fallbackRecord,
            latitude:  parseFloat(json.lat),
            longitude: parseFloat(json.lon),
            accuracy:  parseFloat(json.range || 500),
            source:    'OpenCellID Cell Tower Lookup'
          };
          storeRecord(record);
          console.log(`[OPENCELLID] CID:${cid} → ${json.lat},${json.lon}`);
          return res.status(200).json({ success: true, data: record });
        }
      } catch (_) {}

      // OpenCellID returned no coords — store metadata only (no fake fallback!)
      const record = { ...fallbackRecord, latitude: null, longitude: null, source: 'Cell Metadata Only (Lookup Failed)' };
      storeRecord(record);
      console.log(`[CELL META] CID:${cid} LAC:${lac} — lookup failed, stored metadata only`);
      return res.status(200).json({ success: true, data: record });
    });
  }).on('error', () => {
    const record = { ...fallbackRecord, latitude: null, longitude: null, source: 'Cell Metadata Only (Network Error)' };
    storeRecord(record);
    return res.status(200).json({ success: true, data: record });
  });
}

// ── Health ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), records: locationHistory.length });
});

// ── POST /api/telemetry (ESP32 → Server) ─────────────────────
app.post('/api/telemetry', (req, res) => {
  const { deviceId, latitude, longitude, accuracy, rssi, mcc, mnc, lac, cid, arfcn, apn } = req.body;

  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  const acc = parseFloat(accuracy || 500);

  const base = {
    deviceId:  deviceId || 'ESP32C3_TRACKER',
    rssi:      parseInt(rssi || -85),
    mcc:       parseInt(mcc  || 404),
    mnc:       parseInt(mnc  || 64),
    lac:       parseInt(lac  || 0),
    cid:       parseInt(cid  || 0),
    arfcn:     parseInt(arfcn || 0),
    apn:       apn || 'bsnlgprs',
    timestamp: new Date().toISOString()
  };

  // Case 1: Valid GPS/LBS coordinates from hardware
  if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0 && acc < 1500) {
    const record = { ...base, latitude: lat, longitude: lon, accuracy: acc, source: 'SIMCom Native Free LBS' };
    storeRecord(record);
    console.log(`[LBS FIX] ${deviceId} → ${lat},${lon} ±${acc}m`);
    return res.status(200).json({ success: true, data: record });
  }

  // Case 2: Coordinates provided but high accuracy (>1500m = fallback coords in firmware)
  //         Try OpenCellID lookup instead of trusting the firmware fallback value
  if (mcc && mnc && lac && cid) {
    return lookupOpenCellID(mcc, mnc, lac, cid, base, res);
  }

  return res.status(400).json({ error: 'Missing required cell tower parameters' });
});

// ── GET /api/location ─────────────────────────────────────────
app.get('/api/location', (req, res) => {
  if (!latestLocation) {
    return res.status(200).json({ status: 'no_data', message: 'Waiting for ESP32 telemetry…' });
  }
  res.status(200).json(latestLocation);
});

// ── GET /api/history ──────────────────────────────────────────
app.get('/api/history', (req, res) => {
  res.status(200).json(locationHistory);
});

// ── DELETE /api/history ───────────────────────────────────────
app.delete('/api/history', (req, res) => {
  locationHistory = [];
  latestLocation  = null;
  res.status(200).json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 SIM-Track backend on port ${PORT}`);
});
