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
const OPENCELLID_KEY    = process.env.OPENCELLID_API_KEY || '';
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

// ── OpenCellID Lookup ─────────────────────────────────────────
function lookupCell(mcc, mnc, lac, cid, rssi) {
  return new Promise((resolve) => {
    if (!OPENCELLID_KEY) {
      resolve({ latitude: null, longitude: null, accuracy: null, source: 'Cell Metadata (No OpenCellID Key)' });
      return;
    }

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
              source:    'OpenCellID Lookup'
            });
            return;
          }
        } catch (_) {}
        resolve({ latitude: null, longitude: null, accuracy: null, source: 'Cell Metadata (Lookup Failed)' });
      });
    }).on('error', () => {
      resolve({ latitude: null, longitude: null, accuracy: null, source: 'Cell Metadata (Network Error)' });
    });
  });
}

// ── Blynk Polling ─────────────────────────────────────────────
async function pollBlynk() {
  return new Promise((resolve) => {
    const url = `https://${BLYNK_HOST}/external/api/get?token=${BLYNK_TOKEN}&v1&v2&v3&v4&v5`;

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

          // Skip if no valid cell data
          if (mcc === 0 || cid === 0) { resolve(false); return; }

          // Skip if same as last known (no change)
          if (mcc === lastKnownCell.mcc && mnc === lastKnownCell.mnc &&
              lac === lastKnownCell.lac && cid === lastKnownCell.cid &&
              rssi === lastKnownCell.rssi) {
            resolve(false);
            return;
          }

          // New cell data!
          lastKnownCell = { mcc, mnc, lac, cid, rssi };
          console.log(`[BLYNK] New cell: MCC=${mcc} MNC=${mnc} LAC=${lac} CID=${cid} RSSI=${rssi}`);

          // Try OpenCellID lookup
          const geo = await lookupCell(mcc, mnc, lac, cid, rssi);

          const record = {
            deviceId:  'ESP32C3_SIM800L_TRACKER',
            mcc, mnc, lac, cid, rssi,
            arfcn:     0,
            apn:       'bsnlgprs',
            latitude:  geo.latitude,
            longitude: geo.longitude,
            accuracy:  geo.accuracy,
            source:    geo.source,
            timestamp: new Date().toISOString()
          };

          storeRecord(record);

          if (geo.latitude) {
            console.log(`[OPENCELLID] CID:${cid} → ${geo.latitude},${geo.longitude} ±${geo.accuracy}m`);
          } else {
            console.log(`[CELL] CID:${cid} → stored metadata (no coordinates)`);
          }

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
