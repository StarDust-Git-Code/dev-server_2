import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import { 
  Radio, 
  Signal, 
  Server, 
  Activity, 
  RefreshCw, 
  Crosshair,
  Loader2,
  AlertCircle
} from 'lucide-react';
import './App.css';

// Custom Animated Pulse Marker Icon for ESP32-C3 Tracker
const createPulseIcon = () => {
  return L.divIcon({
    className: 'custom-pulse-marker',
    html: `
      <div style="
        position: relative;
        width: 24px;
        height: 24px;
        background: #06b6d4;
        border: 3px solid #ffffff;
        border-radius: 50%;
        box-shadow: 0 0 15px #06b6d4;
      ">
        <div style="
          position: absolute;
          top: -8px; left: -8px; right: -8px; bottom: -8px;
          border: 2px solid #06b6d4;
          border-radius: 50%;
          animation: pulse-ring 2s infinite;
        "></div>
      </div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
};

// Map Recenter Helper
function RecenterMap({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center && center[0] && center[1]) {
      map.flyTo(center, 15, { animate: true, duration: 1.2 });
    }
  }, [center, map]);
  return null;
}

export default function App() {
  const [backendUrl, setBackendUrl] = useState('http://localhost:3000');
  const [inputUrl, setInputUrl] = useState('http://localhost:3000');
  
  // Real device state - NO MOCK DATA
  const [location, setLocation] = useState(null);
  const [history, setHistory] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [lastFetch, setLastFetch] = useState(null);
  const [autoRecenter, setAutoRecenter] = useState(true);

  // Fetch Telemetry Data from Backend
  const fetchData = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/location`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.latitude && data.longitude) {
          setLocation(data);
        } else {
          setLocation(null); // Waiting for real hardware data
        }
        setIsConnected(true);
        setLastFetch(new Date().toLocaleTimeString());
      } else {
        setIsConnected(false);
      }

      const historyRes = await fetch(`${backendUrl}/api/history`);
      if (historyRes.ok) {
        const histData = await historyRes.json();
        setHistory(histData || []);
      }
    } catch (err) {
      console.warn('Backend connection error:', err);
      setIsConnected(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 4000); // Poll every 4 seconds
    return () => clearInterval(interval);
  }, [backendUrl]);

  const handleUpdateBackendUrl = (e) => {
    e.preventDefault();
    setBackendUrl(inputUrl.trim().replace(/\/$/, ''));
  };

  const polylineCoords = history
    .filter(item => item.latitude && item.longitude)
    .map(item => [item.latitude, item.longitude]);

  // Calculate RSSI Signal Strength Bars (0 to 4)
  const getSignalBars = (rssi) => {
    if (!rssi) return 0;
    if (rssi >= -70) return 4;
    if (rssi >= -85) return 3;
    if (rssi >= -100) return 2;
    if (rssi >= -110) return 1;
    return 0;
  };

  const activeSignalBars = getSignalBars(location?.rssi);

  return (
    <div className="dashboard-container">
      {/* Top Navbar */}
      <header className="navbar">
        <div className="brand">
          <div className="brand-icon">
            <Radio size={22} color="#ffffff" />
          </div>
          <div className="brand-text">
            <h1>SIM800L Cell Tracker</h1>
            <p>ESP32-C3 Super Mini • OpenCellID Triangulation • BSNL 2G</p>
          </div>
        </div>

        <div className="header-status">
          <div className={`status-badge ${isConnected ? '' : 'offline'}`}>
            <span className="pulse-dot"></span>
            {isConnected ? 'BACKEND ONLINE' : 'OFFLINE'}
          </div>
        </div>
      </header>

      {/* Main Grid Layout */}
      <div className="main-layout">
        {/* Sidebar Controls */}
        <aside className="sidebar">
          {/* Real-time Status Card */}
          <div className="card">
            <div className="card-title">
              <Activity size={16} /> Device Telemetry
            </div>
            
            <div className="stat-grid">
              <div className="stat-box">
                <div className="stat-label">Device ID</div>
                <div className="stat-value highlight">{location?.deviceId || 'ESP32C3_SIM800L'}</div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Network / APN</div>
                <div className="stat-value">{location?.apn || 'bsnlnet'}</div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Latitude</div>
                <div className="stat-value">{location?.latitude ? location.latitude.toFixed(5) : 'Waiting...'}</div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Longitude</div>
                <div className="stat-value">{location?.longitude ? location.longitude.toFixed(5) : 'Waiting...'}</div>
              </div>
            </div>
          </div>

          {/* Signal & Accuracy Card */}
          <div className="card">
            <div className="card-title">
              <Signal size={16} /> OpenCellID Base Station
            </div>

            <div className="stat-grid">
              <div className="stat-box">
                <div className="stat-label">Signal (RSSI)</div>
                <div className="stat-value">{location?.rssi ? `${location.rssi} dBm` : 'N/A'}</div>
                <div className="signal-bar-container">
                  {[1, 2, 3, 4].map((bar) => (
                    <div
                      key={bar}
                      className={`signal-bar ${bar <= activeSignalBars ? 'active' : ''}`}
                      style={{ height: `${bar * 4 + 4}px` }}
                    />
                  ))}
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-label">Cell Tower Radius</div>
                <div className="stat-value highlight">
                  {location?.accuracy ? `~${location.accuracy}m` : 'N/A'}
                </div>
              </div>
            </div>
          </div>

          {/* Server Config Card */}
          <div className="card">
            <div className="card-title">
              <Server size={16} /> Telemetry Server
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Backend Endpoint URL:
            </p>
            <form onSubmit={handleUpdateBackendUrl} className="input-group">
              <input
                type="text"
                className="api-input"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                placeholder="http://localhost:3000 or Render URL"
              />
              <button type="submit" className="btn-primary">
                Connect
              </button>
            </form>
          </div>

          {/* Info Badge */}
          <div className="card" style={{ marginTop: 'auto' }}>
            <div className="stat-label">Last Polled</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              {lastFetch || 'Connecting...'}
            </div>
          </div>
        </aside>

        {/* Map View or Waiting Screen */}
        <main className="map-wrapper">
          {location && location.latitude && location.longitude ? (
            <>
              <div className="map-controls-floating">
                <button 
                  className="btn-float" 
                  onClick={() => setAutoRecenter(!autoRecenter)}
                  style={{ borderColor: autoRecenter ? 'var(--accent-cyan)' : 'var(--border-color)' }}
                >
                  <Crosshair size={16} color={autoRecenter ? '#06b6d4' : '#fff'} />
                  {autoRecenter ? 'Auto-Center ON' : 'Auto-Center OFF'}
                </button>
                <button className="btn-float" onClick={fetchData}>
                  <RefreshCw size={16} /> Refresh
                </button>
              </div>

              <MapContainer
                center={[location.latitude, location.longitude]}
                zoom={14}
                scrollWheelZoom={true}
              >
                {/* OpenStreetMap Dark Tiles */}
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                />

                {autoRecenter && <RecenterMap center={[location.latitude, location.longitude]} />}

                {/* Device Marker */}
                <Marker 
                  position={[location.latitude, location.longitude]}
                  icon={createPulseIcon()}
                >
                  <Popup>
                    <div style={{ color: '#000', fontSize: '0.85rem' }}>
                      <strong>Device:</strong> {location.deviceId}<br />
                      <strong>Latitude:</strong> {location.latitude}<br />
                      <strong>Longitude:</strong> {location.longitude}<br />
                      <strong>Signal:</strong> {location.rssi} dBm<br />
                      <strong>APN:</strong> {location.apn}
                    </div>
                  </Popup>
                </Marker>

                {/* Cell Tower Accuracy Radius Circle */}
                <Circle
                  center={[location.latitude, location.longitude]}
                  radius={location.accuracy || 500}
                  pathOptions={{
                    color: '#06b6d4',
                    fillColor: '#06b6d4',
                    fillOpacity: 0.15,
                    weight: 1.5,
                    dashArray: '4, 8'
                  }}
                />

                {/* Path Trajectory */}
                {polylineCoords.length > 1 && (
                  <Polyline
                    positions={polylineCoords}
                    pathOptions={{
                      color: '#6366f1',
                      weight: 3,
                      opacity: 0.8
                    }}
                  />
                )}
              </MapContainer>
            </>
          ) : (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              backgroundColor: '#090d16',
              color: '#94a3b8',
              gap: '1rem',
              padding: '2rem',
              textAlign: 'center'
            }}>
              <div style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: 'rgba(6, 182, 212, 0.1)',
                border: '1px solid rgba(6, 182, 212, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <Loader2 size={32} color="#06b6d4" className="spin-icon" style={{ animation: 'spin 2s linear infinite' }} />
              </div>
              <h2 style={{ fontFamily: 'Outfit, sans-serif', color: '#f8fafc', fontWeight: 600 }}>
                Waiting for Live Cell Tower Fix...
              </h2>
              <p style={{ maxWidth: '440px', fontSize: '0.9rem', lineHeight: '1.5' }}>
                Once your ESP32-C3 Super Mini powers up with the BSNL SIM800L module and scans cell towers, coordinates will map here in real-time using OpenCellID.
              </p>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.8rem',
                background: 'rgba(255,255,255,0.05)',
                padding: '0.5rem 1rem',
                borderRadius: '20px',
                marginTop: '0.5rem'
              }}>
                <AlertCircle size={15} color="#f59e0b" />
                <span>Status: Backend connected at <code>{backendUrl}</code></span>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
