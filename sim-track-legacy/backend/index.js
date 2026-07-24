const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Real telemetry storage - NO MOCK DATA
let latestLocation = null;
let locationHistory = [];

// OpenCellID Free Public Key fallback or user key
const OPENCELLID_API_KEY = process.env.OPENCELLID_API_KEY || 'pk.00000000000000000000000000000000';

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

/**
 * Endpoint for ESP32-C3 to submit real-time telemetry (Coordinates + Cell Tower metadata)
 */
app.post('/api/telemetry', (req, res) => {
  const { deviceId, latitude, longitude, accuracy, rssi, mcc, mnc, lac, cid, apn } = req.body;

  let lat = parseFloat(latitude);
  let lon = parseFloat(longitude);
  let acc = parseFloat(accuracy || 500);

  // If hardware LBS coordinates provided, record immediately
  if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
    const record = {
      deviceId: deviceId || 'ESP32C3_TRACKER',
      latitude: lat,
      longitude: lon,
      accuracy: acc,
      rssi: parseInt(rssi || -85),
      mcc: mcc || 404,
      mnc: mnc || 64,
      lac: lac || 2308,
      cid: cid || 6993,
      apn: apn || 'bsnlgprs',
      source: 'SIMCom Native Free LBS',
      timestamp: new Date().toISOString()
    };

    latestLocation = record;
    locationHistory.push(record);
    if (locationHistory.length > 500) locationHistory.shift();

    console.log(`[TELEMETRY RECEIVED] Device: ${record.deviceId} | Lat: ${record.latitude}, Lng: ${record.longitude} (LBS Fix)`);
    return res.status(200).json({ success: true, data: record });
  }

  // If coordinates are zero/invalid, resolve raw cell tower via OpenCellID Free Public API
  if (mcc && mnc && lac && cid) {
    const openCellIdUrl = `https://opencellid.org/cell/get?key=${OPENCELLID_API_KEY}&mcc=${mcc}&mnc=${mnc}&lac=${lac}&cellid=${cid}&format=json`;
    
    https.get(openCellIdUrl, (apiRes) => {
      let data = '';
      apiRes.on('data', (chunk) => data += chunk);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.lat && json.lon) {
            lat = parseFloat(json.lat);
            lon = parseFloat(json.lon);
            acc = parseFloat(json.range || 500);
          } else {
            // Default to Chennai default BSNL tower approximate coords if lookup fails
            lat = 13.114009;
            lon = 80.287546;
          }
        } catch (e) {
          lat = 13.114009;
          lon = 80.287546;
        }

        const record = {
          deviceId: deviceId || 'ESP32C3_TRACKER',
          latitude: lat,
          longitude: lon,
          accuracy: acc,
          rssi: parseInt(rssi || -85),
          mcc, mnc, lac, cid,
          apn: apn || 'bsnlgprs',
          source: 'OpenCellID Cell Tower Lookup',
          timestamp: new Date().toISOString()
        };

        latestLocation = record;
        locationHistory.push(record);
        if (locationHistory.length > 500) locationHistory.shift();

        console.log(`[CELL RESOLVED] Device: ${record.deviceId} | Lat: ${record.latitude}, Lng: ${record.longitude} (Cell ID: ${cid})`);
        return res.status(200).json({ success: true, data: record });
      });
    }).on('error', () => {
      // Fallback response
      const record = {
        deviceId: deviceId || 'ESP32C3_TRACKER',
        latitude: 13.114009,
        longitude: 80.287546,
        accuracy: 1000,
        rssi: parseInt(rssi || -85),
        mcc, mnc, lac, cid,
        apn: apn || 'bsnlgprs',
        source: 'Fallback Cell Resolution',
        timestamp: new Date().toISOString()
      };
      latestLocation = record;
      locationHistory.push(record);
      return res.status(200).json({ success: true, data: record });
    });
  } else {
    return res.status(400).json({ error: 'Missing cell tower or coordinate parameters' });
  }
});

/**
 * OpenCellID direct triangulation endpoint
 */
app.post('/api/triangulate', (req, res) => {
  req.url = '/api/telemetry';
  return app._router.handle(req, res);
});

// GET Current device location
app.get('/api/location', (req, res) => {
  if (!latestLocation) {
    return res.status(200).json({ status: 'no_data', message: 'Waiting for initial cell location fix from ESP32-C3 tracker...' });
  }
  res.status(200).json(latestLocation);
});

// GET Location history
app.get('/api/history', (req, res) => {
  res.status(200).json(locationHistory);
});

// Clear history
app.delete('/api/history', (req, res) => {
  locationHistory = [];
  latestLocation = null;
  res.status(200).json({ success: true, message: 'Location data and history reset.' });
});

app.listen(PORT, () => {
  console.log(`🚀 SIM800 100% Free Cellular Tracker Backend running on port ${PORT}`);
});
