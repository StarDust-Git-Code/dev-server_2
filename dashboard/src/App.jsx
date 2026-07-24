import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import {
  Radio, Signal, Server, Activity, RefreshCw, Crosshair,
  Loader2, AlertCircle, Wifi, WifiOff, MapPin, Layers,
  Clock, Trash2, ChevronDown, ChevronUp, History, Zap,
  Calendar, Navigation, BarChart2
} from 'lucide-react';
import './App.css';

// ── Icons ─────────────────────────────────────────────────────
const createLiveIcon = () => L.divIcon({
  className: '',
  html: `<div class="live-marker"><div class="live-ring"></div></div>`,
  iconSize: [22, 22], iconAnchor: [11, 11]
});

const createHistIcon = () => L.divIcon({
  className: '',
  html: `<div class="hist-marker-start"></div>`,
  iconSize: [14, 14], iconAnchor: [7, 7]
});

const createHistEndIcon = () => L.divIcon({
  className: '',
  html: `<div class="hist-marker-end"></div>`,
  iconSize: [14, 14], iconAnchor: [7, 7]
});

function RecenterMap({ center, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (center?.[0] && center?.[1]) map.flyTo(center, zoom || 15, { animate: true, duration: 1 });
  }, [center, zoom, map]);
  return null;
}

function FitBoundsMap({ coords }) {
  const map = useMap();
  useEffect(() => {
    if (coords?.length > 1) {
      const bounds = L.latLngBounds(coords);
      map.fitBounds(bounds, { padding: [40, 40], animate: true });
    }
  }, [coords, map]);
  return null;
}

// ── Source badge colour ────────────────────────────────────────
const SOURCE_COLORS = {
  'SIMCom Native Free LBS':            '#10b981',
  'OpenCellID Cell Tower Lookup':       '#6366f1',
  'Fallback Cell Resolution':           '#f59e0b',
  'Cell Metadata Only (No API Key)':    '#64748b',
  'Cell Metadata Only (Lookup Failed)': '#64748b',
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

// ── Fetch with timeout ─────────────────────────────────────────
async function fetchT(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) { clearTimeout(timer); throw e; }
}

// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [backendUrl, setBackendUrl] = useState('https://dev-server-2.onrender.com');
  const [inputUrl, setInputUrl]     = useState('https://dev-server-2.onrender.com');

  // Live state
  const [connStatus, setConnStatus] = useState('connecting');
  const [location,   setLocation]   = useState(null);
  const [liveHistory, setLiveHistory] = useState([]); // all records in current session
  const [lastFetch,  setLastFetch]  = useState(null);
  const [autoRecenter, setAutoRecenter] = useState(true);

  // History / sessions state
  const [viewMode,     setViewMode]     = useState('live');   // 'live' | 'history'
  const [sessions,     setSessions]     = useState([]);
  const [activeSession, setActiveSession] = useState(null);   // selected date string
  const [sessionTrack,  setSessionTrack] = useState([]);      // records for selected date
  const [loadingSession, setLoadingSession] = useState(false);

  // UI state
  const [showSidebar,  setShowSidebar]  = useState(true);

  // ── Fetch Live Data ─────────────────────────────────────────
  const fetchLive = useCallback(async () => {
    try {
      const [locRes, histRes] = await Promise.all([
        fetchT(`${backendUrl}/api/location`),
        fetchT(`${backendUrl}/api/history`)
      ]);

      if (!locRes.ok) { setConnStatus('offline'); return; }

      const locData  = await locRes.json();
      const histData = histRes.ok ? await histRes.json() : [];

      setConnStatus('online');
      setLastFetch(new Date().toLocaleTimeString());
      setLiveHistory(histData || []);

      if (locData?.latitude && locData?.longitude) {
        setLocation(locData);
      } else {
        setLocation(null);
      }
    } catch {
      setConnStatus('offline');
    }
  }, [backendUrl]);

  // ── Fetch Sessions list ─────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    try {
      const r = await fetchT(`${backendUrl}/api/sessions`);
      if (r.ok) setSessions(await r.json());
    } catch {}
  }, [backendUrl]);

  // ── Load a specific session's track ────────────────────────
  const loadSession = useCallback(async (date) => {
    setLoadingSession(true);
    setActiveSession(date);
    try {
      const r = await fetchT(`${backendUrl}/api/history?date=${date}`);
      if (r.ok) {
        const data = await r.json();
        setSessionTrack(data.filter(r => r.latitude && r.longitude));
      }
    } catch {}
    setLoadingSession(false);
  }, [backendUrl]);

  // ── Polling ─────────────────────────────────────────────────
  useEffect(() => {
    fetchLive();
    fetchSessions();
    const id = setInterval(() => {
      fetchLive();
      fetchSessions();
    }, 5000);
    return () => clearInterval(id);
  }, [fetchLive, fetchSessions]);

  const handleClearData = async () => {
    await fetch(`${backendUrl}/api/history`, { method: 'DELETE' });
    setLocation(null);
    setLiveHistory([]);
    setSessions([]);
    setSessionTrack([]);
    setActiveSession(null);
  };

  // ── Computed ────────────────────────────────────────────────
  const livePolyline   = liveHistory.filter(r => r.latitude && r.longitude).map(r => [r.latitude, r.longitude]);
  const sessionPolyline = sessionTrack.map(r => [r.latitude, r.longitude]);

  const getSignalBars = (rssi) => {
    if (rssi == null) return 0;
    if (rssi >= -70)  return 4;
    if (rssi >= -85)  return 3;
    if (rssi >= -100) return 2;
    if (rssi >= -110) return 1;
    return 0;
  };
  const activeBars = getSignalBars(location?.rssi);
  const srcColor   = SOURCE_COLORS[location?.source] || '#64748b';

  const mapCenter = viewMode === 'live'
    ? (location ? [location.latitude, location.longitude] : [13.114009, 80.287546])
    : (sessionTrack[0] ? [sessionTrack[0].latitude, sessionTrack[0].longitude] : [13.114009, 80.287546]);

  return (
    <div className="dashboard-container">
      {/* ── Navbar ── */}
      <header className="navbar">
        <div className="brand">
          <div className="brand-icon"><Radio size={18} color="#fff" /></div>
          <div className="brand-text">
            <h1>SIM800L Cell Tracker</h1>
            <p>ESP32-C3 • BSNL 2G • OpenCellID</p>
          </div>
        </div>

        {/* Mode Toggle */}
        <div className="mode-toggle">
          <button className={`mode-btn ${viewMode === 'live' ? 'active' : ''}`} onClick={() => setViewMode('live')}>
            <Zap size={13} /> Live
          </button>
          <button className={`mode-btn ${viewMode === 'history' ? 'active' : ''}`} onClick={() => setViewMode('history')}>
            <History size={13} /> History
          </button>
        </div>

        <div className="header-right">
          <div className={`status-badge ${connStatus === 'online' ? '' : connStatus === 'connecting' ? 'connecting' : 'offline'}`}>
            <span className="pulse-dot" />
            {connStatus === 'online' ? 'ONLINE' : connStatus === 'connecting' ? 'CONNECTING…' : 'OFFLINE'}
          </div>
          <button className="btn-icon" onClick={() => { fetchLive(); fetchSessions(); }} title="Refresh"><RefreshCw size={14} /></button>
        </div>
      </header>

      {/* ── Main ── */}
      <div className="main-layout">
        {/* ── Sidebar ── */}
        <aside className={`sidebar ${showSidebar ? '' : 'collapsed'}`}>

          {/* ── LIVE MODE SIDEBAR ── */}
          {viewMode === 'live' && (<>
            {/* Device Telemetry */}
            <div className="card">
              <div className="card-title"><Activity size={13} /> Live Telemetry</div>
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
                  <div className="stat-value">{location?.accuracy ? `~${Math.round(location.accuracy)}m` : '—'}</div>
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
                  <MapPin size={10} /> {location.source}
                </div>
              )}
            </div>

            {/* Cell Tower */}
            <div className="card">
              <div className="card-title"><Signal size={13} /> Serving Cell</div>
              <div className="cell-tower-grid">
                <div className="cell-item"><span className="cell-key">MCC</span><span className="cell-val">{location?.mcc ?? '—'}</span></div>
                <div className="cell-item"><span className="cell-key">MNC</span><span className="cell-val">{location?.mnc ?? '—'}</span></div>
                <div className="cell-item"><span className="cell-key">LAC</span><span className="cell-val">{location?.lac ?? '—'}</span></div>
                <div className="cell-item"><span className="cell-key">CID</span><span className="cell-val">{location?.cid ?? '—'}</span></div>
              </div>
              <div className="rssi-row">
                <span className="cell-key">RSSI</span>
                <span className="cell-val">{location?.rssi != null ? `${location.rssi} dBm` : 'N/A'}</span>
                <div className="signal-bar-container">
                  {[1,2,3,4].map(b => <div key={b} className={`signal-bar ${b <= activeBars ? 'active' : ''}`} style={{ height: `${b*4+4}px` }} />)}
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="card">
              <div className="card-title"><BarChart2 size={13} /> Session Stats</div>
              <div className="stat-grid">
                <div className="stat-box">
                  <div className="stat-label">Total Records</div>
                  <div className="stat-value highlight">{liveHistory.length}</div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">With Fix</div>
                  <div className="stat-value">{liveHistory.filter(r => r.latitude).length}</div>
                </div>
                <div className="stat-box full">
                  <div className="stat-label">Last Update</div>
                  <div className="stat-value mono" style={{ fontSize: '0.8rem' }}>{lastFetch ?? 'Connecting…'}</div>
                </div>
              </div>
            </div>
          </>)}

          {/* ── HISTORY MODE SIDEBAR ── */}
          {viewMode === 'history' && (<>
            <div className="card">
              <div className="card-title"><Calendar size={13} /> Past Sessions</div>
              {sessions.length === 0 ? (
                <div className="history-empty">No sessions recorded yet.<br />Send some telemetry first.</div>
              ) : (
                <div className="session-list">
                  {sessions.map(s => (
                    <button
                      key={s.date}
                      className={`session-item ${activeSession === s.date ? 'active' : ''}`}
                      onClick={() => loadSession(s.date)}
                    >
                      <div className="session-date">{fmtDate(s.date + 'T00:00:00')}</div>
                      <div className="session-meta">
                        <span><Navigation size={10} /> {s.fixes} fixes</span>
                        <span><Layers size={10} /> {s.count} records</span>
                      </div>
                      <div className="session-time">
                        {fmtTime(s.firstTs)} → {fmtTime(s.lastTs)}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {activeSession && sessionTrack.length > 0 && (
              <div className="card">
                <div className="card-title"><Navigation size={13} /> Track: {activeSession}</div>
                <div className="stat-grid">
                  <div className="stat-box">
                    <div className="stat-label">Fix Points</div>
                    <div className="stat-value highlight">{sessionTrack.length}</div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">Start</div>
                    <div className="stat-value mono" style={{ fontSize: '0.78rem' }}>{fmtTime(sessionTrack[0]?.timestamp)}</div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">End</div>
                    <div className="stat-value mono" style={{ fontSize: '0.78rem' }}>{fmtTime(sessionTrack[sessionTrack.length-1]?.timestamp)}</div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">Avg RSSI</div>
                    <div className="stat-value">
                      {Math.round(sessionTrack.reduce((s, r) => s + (r.rssi || 0), 0) / sessionTrack.length)} dBm
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Individual waypoints */}
            {sessionTrack.length > 0 && (
              <div className="card">
                <div className="card-title"><Clock size={13} /> Waypoints</div>
                <div className="history-list">
                  {[...sessionTrack].reverse().map((r, i) => (
                    <div key={i} className="history-item">
                      <span className="history-time">{fmtTime(r.timestamp)}</span>
                      <span className="history-coords">{r.latitude.toFixed(4)}, {r.longitude.toFixed(4)}</span>
                      <span className="history-rssi">{r.rssi} dBm</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>)}

          {/* ── Shared footer ── */}
          <div className="card sidebar-footer" style={{ marginTop: 'auto' }}>
            {viewMode === 'live' && (
              <div className="input-group" style={{ marginBottom: '0.5rem' }}>
                <input type="text" className="api-input" value={inputUrl}
                  onChange={e => setInputUrl(e.target.value)} placeholder="https://..." />
                <button className="btn-primary" onClick={() => setBackendUrl(inputUrl.trim().replace(/\/$/, ''))}>
                  <Server size={12} />
                </button>
              </div>
            )}
            <button className="btn-danger" onClick={handleClearData}>
              <Trash2 size={12} /> Clear All Data
            </button>
          </div>
        </aside>

        {/* ── Map Area ── */}
        <main className="map-wrapper">
          {/* LIVE VIEW */}
          {viewMode === 'live' && (
            location?.latitude && location?.longitude ? (<>
              <div className="map-controls-floating">
                <button className="btn-float" onClick={() => setAutoRecenter(v => !v)}
                  style={{ borderColor: autoRecenter ? '#06b6d4' : 'var(--border)' }}>
                  <Crosshair size={13} color={autoRecenter ? '#06b6d4' : '#fff'} />
                  {autoRecenter ? 'Lock ON' : 'Lock OFF'}
                </button>
                <button className="btn-float" onClick={fetchLive}><RefreshCw size={13} /> Refresh</button>
              </div>

              <MapContainer center={[location.latitude, location.longitude]} zoom={15} scrollWheelZoom>
                <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
                {autoRecenter && <RecenterMap center={[location.latitude, location.longitude]} />}

                {/* Past track polyline */}
                {livePolyline.length > 1 && (
                  <Polyline positions={livePolyline}
                    pathOptions={{ color: '#6366f1', weight: 2, opacity: 0.6, dashArray: '6 4' }} />
                )}

                {/* Live marker */}
                <Marker position={[location.latitude, location.longitude]} icon={createLiveIcon()}>
                  <Popup>
                    <div style={{ fontSize: '0.82rem', minWidth: 160 }}>
                      <b>{location.deviceId}</b><br />
                      {location.latitude?.toFixed(5)}, {location.longitude?.toFixed(5)}<br />
                      RSSI: {location.rssi} dBm | Acc: ±{Math.round(location.accuracy)}m<br />
                      CID: {location.cid} | LAC: {location.lac}<br />
                      <span style={{ color: srcColor }}>{location.source}</span>
                    </div>
                  </Popup>
                </Marker>

                <Circle center={[location.latitude, location.longitude]}
                  radius={location.accuracy || 500}
                  pathOptions={{ color: '#06b6d4', fillColor: '#06b6d4', fillOpacity: 0.1, weight: 1.5, dashArray: '5 8' }} />
              </MapContainer>
            </>) : (
              <div className="waiting-screen">
                <div className="waiting-icon">
                  {connStatus === 'offline'
                    ? <WifiOff size={30} color="#f43f5e" />
                    : <Loader2 size={30} color="#06b6d4" className="spin" />}
                </div>
                <h2>{connStatus === 'offline' ? 'Backend Unreachable' : 'Waiting for Live Fix…'}</h2>
                <p>{connStatus === 'offline'
                  ? 'Cannot reach backend. Check Render logs.'
                  : 'ESP32-C3 + SIM800L is scanning BSNL towers. Map populates once telemetry arrives.'}</p>
                <div className="waiting-status-pill">
                  {connStatus === 'online'
                    ? <><Wifi size={13} color="#10b981" /> Connected — awaiting ESP32 data</>
                    : <><AlertCircle size={13} color="#f59e0b" /> {connStatus === 'connecting' ? 'Connecting to Render…' : 'Offline'}</>}
                </div>
              </div>
            )
          )}

          {/* HISTORY VIEW */}
          {viewMode === 'history' && (
            loadingSession ? (
              <div className="waiting-screen">
                <div className="waiting-icon"><Loader2 size={30} color="#6366f1" className="spin" /></div>
                <h2>Loading Track…</h2>
              </div>
            ) : sessionTrack.length > 0 ? (<>
              <div className="map-controls-floating">
                <div className="hist-label">📅 {activeSession}</div>
                <button className="btn-float" onClick={() => loadSession(activeSession)}><RefreshCw size={13} /></button>
              </div>

              <MapContainer center={mapCenter} zoom={14} scrollWheelZoom>
                <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
                <FitBoundsMap coords={sessionPolyline} />

                {/* Full historical track */}
                <Polyline positions={sessionPolyline}
                  pathOptions={{ color: '#6366f1', weight: 3, opacity: 0.85 }} />

                {/* Start marker */}
                <Marker position={sessionPolyline[0]} icon={createHistIcon()}>
                  <Popup><b>Start</b><br />{fmtTime(sessionTrack[0]?.timestamp)}</Popup>
                </Marker>

                {/* End marker */}
                {sessionPolyline.length > 1 && (
                  <Marker position={sessionPolyline[sessionPolyline.length - 1]} icon={createHistEndIcon()}>
                    <Popup><b>End</b><br />{fmtTime(sessionTrack[sessionTrack.length - 1]?.timestamp)}</Popup>
                  </Marker>
                )}

                {/* Individual waypoints */}
                {sessionTrack.map((r, i) => (
                  <Circle key={i}
                    center={[r.latitude, r.longitude]}
                    radius={30}
                    pathOptions={{ color: '#6366f1', fillColor: '#6366f1', fillOpacity: 0.5, weight: 1 }}>
                    <Popup>
                      <div style={{ fontSize: '0.8rem' }}>
                        #{i + 1} | {fmtTime(r.timestamp)}<br />
                        {r.latitude.toFixed(5)}, {r.longitude.toFixed(5)}<br />
                        RSSI: {r.rssi} dBm
                      </div>
                    </Popup>
                  </Circle>
                ))}
              </MapContainer>
            </>) : (
              <div className="waiting-screen">
                <div className="waiting-icon"><History size={30} color="#6366f1" /></div>
                <h2>{sessions.length === 0 ? 'No History Yet' : 'Select a Session'}</h2>
                <p>{sessions.length === 0
                  ? 'Telemetry data will appear here once the ESP32 starts sending.'
                  : 'Pick a date from the sidebar to view that session\'s track on the map.'}</p>
              </div>
            )
          )}
        </main>
      </div>
    </div>
  );
}
