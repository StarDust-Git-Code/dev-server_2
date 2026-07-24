import React, { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  Radio, Signal, Server, Activity, RefreshCw, Crosshair,
  Loader2, AlertCircle, Wifi, WifiOff, MapPin, Layers,
  Clock, Trash2, ChevronDown, ChevronUp
} from 'lucide-react';
import './App.css';

// ── Pulse marker icon ──────────────────────────────
const createPulseIcon = () => L.divIcon({
  className: 'custom-pulse-marker',
  html: `
    <div style="position:relative;width:22px;height:22px;background:#06b6d4;border:3px solid #fff;border-radius:50%;box-shadow:0 0 14px #06b6d4;">
      <div style="position:absolute;top:-9px;left:-9px;right:-9px;bottom:-9px;border:2px solid rgba(6,182,212,0.6);border-radius:50%;animation:pulse-ring 2s infinite;"></div>
    </div>`,
  iconSize: [22, 22], iconAnchor: [11, 11]
});

function RecenterMap({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center?.[0] && center?.[1]) map.flyTo(center, 15, { animate: true, duration: 1.2 });
  }, [center, map]);
  return null;
}

// ── Source badge colour ────────────────────────────
const SOURCE_COLORS = {
  'SIMCom Native Free LBS': '#10b981',
  'OpenCellID Cell Tower Lookup': '#6366f1',
  'Fallback Cell Resolution': '#f59e0b',
  default: '#64748b'
};

export default function App() {
  const [backendUrl, setBackendUrl] = useState('https://dev-server-2.onrender.com');
  const [inputUrl, setInputUrl]     = useState('https://dev-server-2.onrender.com');

  const [status, setStatus]         = useState('connecting'); // 'connecting'|'online'|'offline'
  const [location, setLocation]     = useState(null);
  const [history, setHistory]       = useState([]);
  const [lastFetch, setLastFetch]   = useState(null);
  const [autoRecenter, setAutoRecenter] = useState(true);
  const [showHistory, setShowHistory]   = useState(false);

  // ── Fetch with 8 s timeout ────────────────────────
  const fetchWithTimeout = useCallback(async (url, ms = 8000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${backendUrl}/api/location`);
      if (!res.ok) { setStatus('offline'); return; }

      const data = await res.json();
      // data may be: { status:'no_data' } | full location record
      if (data?.latitude && data?.longitude) {
        setLocation(data);
      } else {
        setLocation(null);
      }
      setStatus('online');
      setLastFetch(new Date().toLocaleTimeString());

      // History
      const hRes = await fetchWithTimeout(`${backendUrl}/api/history`);
      if (hRes.ok) setHistory((await hRes.json()) || []);

    } catch {
      setStatus('offline');
    }
  }, [backendUrl, fetchWithTimeout]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, [fetchData]);

  const handleClearData = async () => {
    await fetch(`${backendUrl}/api/history`, { method: 'DELETE' });
    setLocation(null);
    setHistory([]);
  };

  // ── Signal bars (RSSI) ────────────────────────────
  const getSignalBars = (rssi) => {
    if (rssi == null) return 0;
    if (rssi >= -70) return 4;
    if (rssi >= -85) return 3;
    if (rssi >= -100) return 2;
    if (rssi >= -110) return 1;
    return 0;
  };

  const activeBars     = getSignalBars(location?.rssi);
  const polylineCoords = history.filter(i => i.latitude && i.longitude).map(i => [i.latitude, i.longitude]);
  const srcColor       = SOURCE_COLORS[location?.source] || SOURCE_COLORS.default;

  return (
    <div className="dashboard-container">
      {/* ── Navbar ── */}
      <header className="navbar">
        <div className="brand">
          <div className="brand-icon"><Radio size={20} color="#fff" /></div>
          <div className="brand-text">
            <h1>SIM800L Cell Tracker</h1>
            <p>ESP32-C3 Super Mini • BSNL 2G • CIPGSMLOC + OpenCellID</p>
          </div>
        </div>
        <div className="header-right">
          <div className={`status-badge ${status === 'online' ? '' : status === 'connecting' ? 'connecting' : 'offline'}`}>
            <span className="pulse-dot" />
            {status === 'online' ? 'BACKEND ONLINE' : status === 'connecting' ? 'CONNECTING…' : 'OFFLINE'}
          </div>
          <button className="btn-icon" onClick={fetchData} title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      {/* ── Main ── */}
      <div className="main-layout">
        {/* ─── Sidebar ─── */}
        <aside className="sidebar">

          {/* Device Telemetry */}
          <div className="card">
            <div className="card-title"><Activity size={14} /> Device Telemetry</div>
            <div className="stat-grid">
              <div className="stat-box full">
                <div className="stat-label">Device ID</div>
                <div className="stat-value highlight">{location?.deviceId ?? '—'}</div>
              </div>
              <div className="stat-box">
                <div className="stat-label">APN</div>
                <div className="stat-value">{location?.apn ?? '—'}</div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Accuracy</div>
                <div className="stat-value">{location?.accuracy ? `~${location.accuracy}m` : '—'}</div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Latitude</div>
                <div className="stat-value mono">{location?.latitude?.toFixed(5) ?? 'Waiting…'}</div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Longitude</div>
                <div className="stat-value mono">{location?.longitude?.toFixed(5) ?? 'Waiting…'}</div>
              </div>
            </div>
            {location?.source && (
              <div className="source-badge" style={{ borderColor: srcColor, color: srcColor }}>
                <MapPin size={11} /> {location.source}
              </div>
            )}
          </div>

          {/* Cell Tower Info */}
          <div className="card">
            <div className="card-title"><Signal size={14} /> Serving Cell Tower</div>
            <div className="cell-tower-grid">
              <div className="cell-item"><span className="cell-key">MCC</span><span className="cell-val">{location?.mcc ?? '—'}</span></div>
              <div className="cell-item"><span className="cell-key">MNC</span><span className="cell-val">{location?.mnc ?? '—'}</span></div>
              <div className="cell-item"><span className="cell-key">LAC</span><span className="cell-val">{location?.lac ?? '—'}</span></div>
              <div className="cell-item"><span className="cell-key">CID</span><span className="cell-val">{location?.cid ?? '—'}</span></div>
            </div>
            {/* Signal bars */}
            <div className="rssi-row">
              <span className="cell-key">RSSI</span>
              <span className="cell-val">{location?.rssi != null ? `${location.rssi} dBm` : 'N/A'}</span>
              <div className="signal-bar-container">
                {[1, 2, 3, 4].map(b => (
                  <div key={b} className={`signal-bar ${b <= activeBars ? 'active' : ''}`} style={{ height: `${b * 4 + 4}px` }} />
                ))}
              </div>
            </div>
          </div>

          {/* Server Config */}
          <div className="card">
            <div className="card-title"><Server size={14} /> Backend Server</div>
            <form onSubmit={e => { e.preventDefault(); setBackendUrl(inputUrl.trim().replace(/\/$/, '')); }} className="input-group">
              <input type="text" className="api-input" value={inputUrl}
                onChange={e => setInputUrl(e.target.value)} placeholder="https://..." />
              <button type="submit" className="btn-primary">Connect</button>
            </form>
          </div>

          {/* History */}
          <div className="card">
            <div className="card-title" style={{ cursor: 'pointer' }} onClick={() => setShowHistory(v => !v)}>
              <Layers size={14} /> History ({history.length})
              {showHistory ? <ChevronUp size={13} style={{ marginLeft: 'auto' }} /> : <ChevronDown size={13} style={{ marginLeft: 'auto' }} />}
            </div>
            {showHistory && (
              <div className="history-list">
                {history.length === 0 ? (
                  <div className="history-empty">No records yet</div>
                ) : [...history].reverse().slice(0, 10).map((h, i) => (
                  <div key={i} className="history-item">
                    <span className="history-time">{new Date(h.timestamp).toLocaleTimeString()}</span>
                    <span className="history-coords">{h.latitude?.toFixed(4)}, {h.longitude?.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="card sidebar-footer">
            <div className="footer-row">
              <Clock size={12} />
              <span>{lastFetch ? `Polled: ${lastFetch}` : 'Waiting…'}</span>
            </div>
            <button className="btn-danger" onClick={handleClearData} title="Clear all data">
              <Trash2 size={12} /> Clear Data
            </button>
          </div>
        </aside>

        {/* ─── Map / Waiting ─── */}
        <main className="map-wrapper">
          {location?.latitude && location?.longitude ? (
            <>
              <div className="map-controls-floating">
                <button className="btn-float"
                  onClick={() => setAutoRecenter(v => !v)}
                  style={{ borderColor: autoRecenter ? '#06b6d4' : 'var(--border-color)' }}>
                  <Crosshair size={14} color={autoRecenter ? '#06b6d4' : '#fff'} />
                  {autoRecenter ? 'Lock ON' : 'Lock OFF'}
                </button>
                <button className="btn-float" onClick={fetchData}>
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>

              <MapContainer center={[location.latitude, location.longitude]} zoom={15} scrollWheelZoom>
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                />
                {autoRecenter && <RecenterMap center={[location.latitude, location.longitude]} />}

                <Marker position={[location.latitude, location.longitude]} icon={createPulseIcon()}>
                  <Popup>
                    <div style={{ fontSize: '0.85rem', minWidth: 160 }}>
                      <b>{location.deviceId}</b><br />
                      {location.latitude?.toFixed(5)}, {location.longitude?.toFixed(5)}<br />
                      RSSI: {location.rssi} dBm<br />
                      CID: {location.cid} | LAC: {location.lac}<br />
                      <span style={{ color: srcColor }}>{location.source}</span>
                    </div>
                  </Popup>
                </Marker>

                <Circle center={[location.latitude, location.longitude]}
                  radius={location.accuracy || 500}
                  pathOptions={{ color: '#06b6d4', fillColor: '#06b6d4', fillOpacity: 0.12, weight: 1.5, dashArray: '4 8' }} />

                {polylineCoords.length > 1 && (
                  <Polyline positions={polylineCoords}
                    pathOptions={{ color: '#6366f1', weight: 2.5, opacity: 0.75 }} />
                )}
              </MapContainer>
            </>
          ) : (
            <div className="waiting-screen">
              <div className="waiting-icon">
                {status === 'offline'
                  ? <WifiOff size={32} color="#f43f5e" />
                  : <Loader2 size={32} color="#06b6d4" className="spin" />}
              </div>
              <h2>{status === 'offline' ? 'Backend Unreachable' : 'Waiting for Live Fix…'}</h2>
              <p>
                {status === 'offline'
                  ? 'Cannot reach the backend. Check Render logs or retry.'
                  : 'ESP32-C3 + SIM800L is scanning BSNL towers. Once telemetry is received, the map will populate here.'}
              </p>
              <div className="waiting-status-pill">
                {status === 'online'
                  ? <><Wifi size={13} color="#10b981" /> Connected to <code>{backendUrl}</code> — awaiting ESP32 data</>
                  : <><AlertCircle size={13} color="#f59e0b" /> {status === 'connecting' ? 'Connecting…' : 'Offline'}</>}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
