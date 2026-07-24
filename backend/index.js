const express = require('express');
const cors    = require('cors');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Persist history to /tmp on Render ─────────────────────────
const HISTORY_FILE = path.join('/tmp', 'sim-track-history.json');
const MAX_RECORDS  = 2000;

let latestLocation  = null;
let locationHistory = [];

// Load saved history on startup
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    locationHistory = saved.history || [];
    latestLocation  = locationHistory.filter(r => r.latitude).slice(-1)[0] || null;
    console.log(`[STARTUP] Loaded ${locationHistory.length} records from disk`);
  }
} catch (e) {
  console.warn('[STARTUP] Could not load history:', e.message);
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ history: locationHistory }));
  } catch (e) {
    console.warn('[SAVE] Could not write history:', e.message);
  }
}

function storeRecord(record) {
  // Deduplicate: skip if same cid + same lat/lon as last record
  const last = locationHistory[locationHistory.length - 1];
  if (last && last.cid === record.cid &&
      last.latitude === record.latitude &&
      last.longitude === record.longitude) {
    latestLocation = record; // update timestamp only
    return;
  }

  if (record.latitude) latestLocation = record;
  locationHistory.push(record);
  if (locationHistory.length > MAX_RECORDS) locationHistory.shift();
  saveHistory();
}

// ── Middleware ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Health ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), records: locationHistory.length });
});

// ── OpenCellID lookup helper ───────────────────────────────────
function lookupOpenCellID(mcc, mnc, lac, cid, base, res) {
  const key = process.env.OPENCELLID_API_KEY || '';
  if (!key) {
    const record = { ...base, latitude: null, longitude: null, source: 'Cell Metadata Only (No API Key)' };
    storeRecord(record);
    return res.status(200).json({ success: true, data: record });
  }

  const url = `https://opencellid.org/cell/get?key=${key}&mcc=${mcc}&mnc=${mnc}&lac=${lac}&cellid=${cid}&format=json`;

  https.get(url, (apiRes) => {
    let raw = '';
    apiRes.on('data', c => raw += c);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(raw);
        if (json.lat && json.lon) {
          const record = { ...base, latitude: parseFloat(json.lat), longitude: parseFloat(json.lon),
                           accuracy: parseFloat(json.range || 500), source: 'OpenCellID Cell Tower Lookup' };
          storeRecord(record);
          return res.status(200).json({ success: true, data: record });
        }
      } catch (_) {}
      const record = { ...base, latitude: null, longitude: null, source: 'Cell Metadata Only (Lookup Failed)' };
      storeRecord(record);
      return res.status(200).json({ success: true, data: record });
    });
  }).on('error', () => {
    const record = { ...base, latitude: null, longitude: null, source: 'Cell Metadata Only (Network Error)' };
    storeRecord(record);
    return res.status(200).json({ success: true, data: record });
  });
}

// ── POST /api/telemetry ────────────────────────────────────────
app.post('/api/telemetry', (req, res) => {
  const { deviceId, latitude, longitude, accuracy, rssi, mcc, mnc, lac, cid, arfcn, apn } = req.body;

  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  const acc = parseFloat(accuracy || 500);

  const base = {
    deviceId:  deviceId || 'ESP32C3_TRACKER',
    rssi:      parseInt(rssi  || -85),
    mcc:       parseInt(mcc   || 404),
    mnc:       parseInt(mnc   || 64),
    lac:       parseInt(lac   || 0),
    cid:       parseInt(cid   || 0),
    arfcn:     parseInt(arfcn || 0),
    apn:       apn || 'bsnlgprs',
    timestamp: new Date().toISOString()
  };

  // Valid LBS fix
  if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0 && acc < 1500) {
    const record = { ...base, latitude: lat, longitude: lon, accuracy: acc, source: 'SIMCom Native Free LBS' };
    storeRecord(record);
    console.log(`[LBS] ${deviceId} → ${lat.toFixed(5)},${lon.toFixed(5)} ±${acc.toFixed(0)}m`);
    return res.status(200).json({ success: true, data: record });
  }

  // Cell tower lookup
  if (mcc && mnc && lac && cid) return lookupOpenCellID(mcc, mnc, lac, cid, base, res);

  return res.status(400).json({ error: 'Missing required parameters' });
});

// ── GET /api/location ──────────────────────────────────────────
app.get('/api/location', (req, res) => {
  if (!latestLocation) {
    return res.status(200).json({ status: 'no_data', message: 'Waiting for ESP32 telemetry…' });
  }
  res.status(200).json(latestLocation);
});

// ── GET /api/history ───────────────────────────────────────────
// Optional ?date=YYYY-MM-DD to filter by day
app.get('/api/history', (req, res) => {
  const { date } = req.query;
  if (date) {
    const filtered = locationHistory.filter(r => r.timestamp && r.timestamp.startsWith(date));
    return res.status(200).json(filtered);
  }
  res.status(200).json(locationHistory);
});

// ── GET /api/sessions ──────────────────────────────────────────
// Returns list of unique dates that have records, with count + bbox
app.get('/api/sessions', (req, res) => {
  const days = {};

  locationHistory.forEach(r => {
    if (!r.timestamp) return;
    const day = r.timestamp.slice(0, 10); // YYYY-MM-DD
    if (!days[day]) days[day] = { date: day, count: 0, fixes: 0, firstTs: r.timestamp, lastTs: r.timestamp };
    days[day].count++;
    days[day].lastTs = r.timestamp;
    if (r.latitude) days[day].fixes++;
  });

  const sessions = Object.values(days).sort((a, b) => b.date.localeCompare(a.date));
  res.status(200).json(sessions);
});

// ── DELETE /api/history ────────────────────────────────────────
app.delete('/api/history', (req, res) => {
  locationHistory = [];
  latestLocation  = null;
  saveHistory();
  res.status(200).json({ success: true });
});

app.listen(PORT, () => console.log(`🚀 SIM-Track backend on port ${PORT} | ${locationHistory.length} records loaded`));
