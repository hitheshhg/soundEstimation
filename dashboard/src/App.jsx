import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import Acoustic3DScene from './Acoustic3DScene.jsx';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Plug in ESP32 via USB and click Connect');
  const [viewMode, setViewMode] = useState('3d');

  const [angle, setAngle] = useState(0.0);
  const [level, setLevel] = useState(0.0);
  const [isActive, setIsActive] = useState(false);
  const [tdoaSamples, setTdoaSamples] = useState(0.0);
  const [tdoaUs, setTdoaUs] = useState(0.0);
  const [leftRms, setLeftRms] = useState(0);
  const [rightRms, setRightRms] = useState(0);
  const [peakConfidence, setPeakConfidence] = useState(0.85);
  const [directionLabel, setDirectionLabel] = useState('STANDBY / IDLE');

  const [isSimulator, setIsSimulator] = useState(false);
  const [isSweepActive, setIsSweepActive] = useState(false);
  const simAngleRef = useRef(0);
  const simDirRef = useRef(1);

  const [history, setHistory] = useState(() => Array(60).fill(0));

  const [rawLogs, setRawLogs] = useState([]);
  const [showConsole, setShowConsole] = useState(true);
  const [autoScrollLog, setAutoScrollLog] = useState(true);
  const terminalBoxRef = useRef(null);

  const portRef = useRef(null);
  const readerRef = useRef(null);
  const keepReadingRef = useRef(false);

  const isSerialSupported = typeof navigator !== 'undefined' && 'serial' in navigator;

  const connectSerial = async () => {
    if (!isSerialSupported) {
      alert('Web Serial is only supported in Google Chrome and Microsoft Edge.');
      return;
    }

    try {
      setStatusMsg('Selecting COM Port...');
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });

      portRef.current = port;
      keepReadingRef.current = true;
      setIsConnected(true);
      setIsSimulator(false);
      setStatusMsg('CONNECTED @ 115,200 BAUD');

      const decoder = new TextDecoderStream();
      port.readable.pipeTo(decoder.writable);
      const reader = decoder.readable.getReader();
      readerRef.current = reader;

      let buffer = '';

      while (keepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          setRawLogs((prev) => [...prev.slice(-49), trimmed]);

          const mRadar = trimmed.match(/A:(-?[\d.]+)\s+L:([\d.]+)\s+S:([01])/);
          if (mRadar) {
            const parsedAngle = parseFloat(mRadar[1]);
            const parsedLevel = parseFloat(mRadar[2]);
            const parsedActive = mRadar[3] === '1';

            const mLR = trimmed.match(/LR:([\d.]+),([\d.]+)/);
            if (mLR) {
              setLeftRms(Math.round(parseFloat(mLR[1])));
              setRightRms(Math.round(parseFloat(mLR[2])));
            }

            updateReadings(parsedAngle, parsedLevel, parsedActive);
            continue;
          }

          if (trimmed.includes('LEFT RMS:') || trimmed.includes('TDOA:') || trimmed.includes('ANGLE:')) {
            const mAng = trimmed.match(/ANGLE:\s*(-?[\d.]+)/);
            const mTdoaUs = trimmed.match(/TDOA:\s*(-?[\d.]+)\s*us/);
            const mSamples = trimmed.match(/TDOA:\s*(-?[\d.]+)\s*samples/);
            const mL = trimmed.match(/LEFT RMS:\s*([\d.]+)/);
            const mR = trimmed.match(/RIGHT RMS:\s*([\d.]+)/);
            const mPeak = trimmed.match(/Peak:\s*([\d.]+)/);

            if (mL) setLeftRms(Math.round(parseFloat(mL[1])));
            if (mR) setRightRms(Math.round(parseFloat(mR[1])));
            if (mTdoaUs) setTdoaUs(parseFloat(mTdoaUs[1]));
            if (mSamples) setTdoaSamples(parseFloat(mSamples[1]));
            if (mPeak) setPeakConfidence(parseFloat(mPeak[1]));

            if (mAng) {
              const ang = parseFloat(mAng[1]);
              const act = !trimmed.includes('SILENCE') && !trimmed.includes('IDLE');
              updateReadings(ang, 0.75, act);
            }
            continue;
          }

          const csv = trimmed.split(',');
          if (csv.length >= 7 && !isNaN(parseFloat(csv[5]))) {
            const lRms = parseFloat(csv[1]);
            const rRms = parseFloat(csv[2]);
            const samples = parseFloat(csv[3]);
            const us = parseFloat(csv[4]);
            const ang = parseFloat(csv[5]);
            const act = csv[6] === 'VALID';
            const peak = parseFloat(csv[7] || '0.85');

            setLeftRms(Math.round(lRms));
            setRightRms(Math.round(rRms));
            setTdoaSamples(samples);
            setTdoaUs(us);
            setPeakConfidence(peak);
            updateReadings(ang, Math.min(1.0, (lRms + rRms) / 50000.0), act);
          }
        }
      }
    } catch (err) {
      if (err.name === 'NetworkError' || err.message.includes('open')) {
        setStatusMsg('Port busy! Please close Arduino Serial Monitor.');
        alert('Could not open COM port because it is locked by another program.\n\nPlease close the Arduino IDE Serial Monitor / Plotter and try again.');
      } else {
        setStatusMsg(`Serial Notice: ${err.message}`);
      }
      disconnectSerial();
    }
  };

  const disconnectSerial = async () => {
    keepReadingRef.current = false;
    try {
      if (readerRef.current) {
        await readerRef.current.cancel();
        readerRef.current = null;
      }
    } catch (e) {}

    try {
      if (portRef.current) {
        await portRef.current.close();
        portRef.current = null;
      }
    } catch (e) {}

    setIsConnected(false);
    setStatusMsg('DISCONNECTED');
  };

  const updateReadings = (rawAngle, rawLevel, active) => {
    const clamped = Math.max(-90, Math.min(90, rawAngle));
    setAngle(clamped);
    setLevel(rawLevel);
    setIsActive(active);

    const d = 0.15;
    const c = 343.0;
    const fs = 16000;
    const tdoaSec = (d * Math.sin((clamped * Math.PI) / 180.0)) / c;
    const calcUs = tdoaSec * 1e6;
    const calcSamples = tdoaSec * fs;

    setTdoaUs(parseFloat(calcUs.toFixed(1)));
    setTdoaSamples(parseFloat(calcSamples.toFixed(2)));

    if (!active) {
      setDirectionLabel('STANDBY / IDLE');
    } else if (clamped < -12) {
      setDirectionLabel(`LEFT SECTOR (${clamped.toFixed(1)}°) — MIC 1`);
    } else if (clamped > 12) {
      setDirectionLabel(`RIGHT SECTOR (+${clamped.toFixed(1)}°) — MIC 2`);
    } else {
      setDirectionLabel('BROADSIDE / CENTER (0.0°)');
    }

    setHistory((prev) => [...prev.slice(1), clamped]);
  };

  useEffect(() => {
    if (!isSimulator || isConnected) return;

    const interval = setInterval(() => {
      if (isSweepActive) {
        simAngleRef.current += simDirRef.current * 2.5;
        if (simAngleRef.current >= 85) simDirRef.current = -1;
        if (simAngleRef.current <= -85) simDirRef.current = 1;

        const a = simAngleRef.current;
        const baseRms = 24000;
        const lBias = Math.max(5000, baseRms * (1 - a / 90));
        const rBias = Math.max(5000, baseRms * (1 + a / 90));
        setLeftRms(Math.round(lBias));
        setRightRms(Math.round(rBias));
        setPeakConfidence(0.92);

        updateReadings(a, 0.78, true);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isSimulator, isSweepActive, isConnected]);

  const triggerSim = (targetAngle, label) => {
    setIsSimulator(true);
    setIsSweepActive(false);
    simAngleRef.current = targetAngle;
    setStatusMsg(`[SIMULATOR] ${label} (${targetAngle}°)`);

    const baseRms = 27000;
    const lBias = Math.max(5000, baseRms * (1 - targetAngle / 90));
    const rBias = Math.max(5000, baseRms * (1 + targetAngle / 90));
    setLeftRms(Math.round(lBias));
    setRightRms(Math.round(rBias));
    setPeakConfidence(0.94);

    updateReadings(targetAngle, 0.85, true);
  };

  const handleDialClick = (e) => {
    const svgRect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - svgRect.left;
    const clickY = e.clientY - svgRect.top;

    const scaleX = 380 / svgRect.width;
    const scaleY = 205 / svgRect.height;
    const svgX = clickX * scaleX;
    const svgY = clickY * scaleY;

    const dx = svgX - 190;
    const dy = 180 - svgY;
    if (dy <= 0) return;

    const rad = Math.atan2(dx, dy);
    let deg = (rad * 180) / Math.PI;
    deg = Math.max(-90, Math.min(90, deg));
    triggerSim(parseFloat(deg.toFixed(1)), 'Manual Point');
  };

  useEffect(() => {
    if (showConsole && autoScrollLog && terminalBoxRef.current) {
      terminalBoxRef.current.scrollTop = terminalBoxRef.current.scrollHeight;
    }
  }, [rawLogs, showConsole, autoScrollLog]);

  const cx = 190;
  const cy = 180;
  const rArc = 135;

  const tickDegrees = [-90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90];

  return (
    <div className="dashboard-shell">
      <header className="header-card">
        <div className="inst-row">
          <div>
            <strong>NMAM Institute of Technology</strong> &bull; Nitte (Deemed to be University) &bull; CSE
          </div>
          <div>SRIP (2025–26) Defense &bull; 26 Sept 2026 &bull; Room LH210</div>
        </div>

        <div className="title-row">
          <div>
            <h1>Sound Direction Estimation using Machine Learning and TinyML</h1>
            <div className="meta-tags">
              <span>
                Candidate: <strong>Hithesh H G</strong> (CSE)
              </span>
              <span>&bull;</span>
              <span>
                Guide: <strong>Dr. Keerthana B Chigateri</strong>
              </span>
              <span>&bull;</span>
              <span>
                Coordinator: <strong>Dr. Rajalaxmi Hegde</strong>
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <span className="badge-pill active">STAGE 1: GCC-PHAT BASELINE</span>
            <span className="badge-pill">STAGE 2: TINYML DATASET</span>
          </div>
        </div>
      </header>

      <div className="toolbar-card">
        <div className="tool-cluster">
          {!isConnected ? (
            <button className="btn-solid" onClick={connectSerial}>
              Connect ESP32 (USB Serial)
            </button>
          ) : (
            <button className="btn-danger-outline" onClick={disconnectSerial}>
              Disconnect Port
            </button>
          )}

          <span className={`badge-pill ${isConnected ? 'status-connected' : ''}`}>
            <span className={`status-dot ${isConnected || isSimulator ? 'online' : ''}`} />
            {isConnected ? 'USB SERIAL CONNECTED' : isSimulator ? 'SIMULATION MODE' : 'STANDBY'}
          </span>
        </div>

        <div className="tool-cluster">
          <span style={{ fontSize: '11.5px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            {statusMsg}
          </span>
          <button className="btn-outline" onClick={() => setShowConsole(!showConsole)}>
            {showConsole ? 'Hide Console' : 'Show Console'}
          </button>
        </div>
      </div>

      <div className="main-grid">
        <div className="panel-card">
          <div className="panel-top">
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span className="panel-title">Direction of Arrival Visualizer</span>
              <div className="segmented-toggle">
                <button
                  className={`segmented-btn ${viewMode === '3d' ? 'active' : ''}`}
                  onClick={() => setViewMode('3d')}
                >
                  3D Spatial Dome
                </button>
                <button
                  className={`segmented-btn ${viewMode === '2d' ? 'active' : ''}`}
                  onClick={() => setViewMode('2d')}
                >
                  2D Dial
                </button>
              </div>
            </div>
            <span className="mono" style={{ fontSize: '11px', color: isActive ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {isActive ? '● SIGNAL ACTIVE' : '○ IDLE'}
            </span>
          </div>

          {viewMode === '3d' ? (
            <div>
              <Acoustic3DScene
                angle={angle}
                level={level}
                isActive={isActive}
                leftRms={leftRms}
                rightRms={rightRms}
                onSelectAngle={(deg) => triggerSim(deg, 'Manual Point')}
              />
              <div style={{ textAlign: 'center', fontSize: '10.5px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: '4px' }}>
                Drag to orbit &bull; Scroll to zoom &bull; 15 cm MEMS array
              </div>
            </div>
          ) : (
            <div className="radar-stage" onClick={handleDialClick} style={{ cursor: 'crosshair' }}>
              <svg className="radar-svg-canvas" viewBox="0 0 380 205">
                <path
                  d="M 55,180 A 135,135 0 0,1 325,180"
                  fill="none"
                  stroke="#22242c"
                  strokeWidth="2.5"
                />
                <path
                  d="M 85,180 A 105,105 0 0,1 295,180"
                  fill="none"
                  stroke="#1a1c22"
                  strokeWidth="1"
                  strokeDasharray="3"
                />

                <line x1="190" y1="180" x2="190" y2="40" stroke="#2c2f3a" strokeWidth="1" strokeDasharray="3" />

                {tickDegrees.map((deg) => {
                  const rad = (deg * Math.PI) / 180;
                  const isMajor = deg % 30 === 0;
                  const rInner = isMajor ? rArc - 10 : rArc - 5;
                  const x1 = cx + rArc * Math.sin(rad);
                  const y1 = cy - rArc * Math.cos(rad);
                  const x2 = cx + rInner * Math.sin(rad);
                  const y2 = cy - rInner * Math.cos(rad);

                  const xt = cx + (rArc + 17) * Math.sin(rad);
                  const yt = cy - (rArc + 17) * Math.cos(rad) + 4;

                  return (
                    <g key={deg}>
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke={isMajor ? '#4b4f5e' : '#282b35'}
                        strokeWidth={isMajor ? '1.5' : '1'}
                      />
                      {isMajor && (
                        <text
                          x={xt}
                          y={yt}
                          fill={deg === 0 ? '#f4f4f5' : '#71717a'}
                          fontSize="9.5"
                          fontFamily="var(--font-mono)"
                          fontWeight={deg === 0 ? '700' : '500'}
                          textAnchor="middle"
                        >
                          {deg === 0 ? '0°' : `${deg}°`}
                        </text>
                      )}
                    </g>
                  );
                })}

                {isActive && Math.abs(angle) > 0.5 && (() => {
                  const rad = (angle * Math.PI) / 180;
                  const targetX = cx + rArc * Math.sin(rad);
                  const targetY = cy - rArc * Math.cos(rad);
                  const sweepFlag = angle > 0 ? 1 : 0;
                  return (
                    <path
                      d={`M ${cx},${cy - rArc} A ${rArc},${rArc} 0 0,${sweepFlag} ${targetX},${targetY}`}
                      fill="none"
                      stroke="#d4d4d8"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                    />
                  );
                })()}

                <polygon
                  points="188,180 192,180 190.5,46 189.5,46"
                  fill="#ffffff"
                  transform={`rotate(${angle}, 190, 180)`}
                  style={{ transition: 'transform 0.12s linear' }}
                />

                <circle cx="190" cy="180" r="10" fill="#090a0d" stroke="#52525b" strokeWidth="2" />
                <circle cx="190" cy="180" r="3" fill="#ffffff" />
              </svg>
            </div>
          )}

          <div className="angle-hero-wrap">
            <div className="angle-hero-num">
              {angle > 0 ? `+${angle.toFixed(1)}°` : `${angle.toFixed(1)}°`}
            </div>
          </div>

          <div style={{ textAlign: 'center' }}>
            <span className={`sector-pill ${isActive ? 'active' : ''}`}>
              {directionLabel}
            </span>
          </div>

          <div className="meter-strip">
            <div className="meter-meta">
              <span>Acoustic Energy Level</span>
              <span className="mono">{Math.round(level * 100)}%</span>
            </div>
            <div className="meter-track">
              <div
                className="meter-bar"
                style={{ width: `${Math.min(100, Math.max(0, level * 100))}%` }}
              />
            </div>
          </div>

          <div className="array-wireframe">
            <span className={`array-node ${angle < -10 && isActive ? 'active' : ''}`}>
              [ MIC 1 (Left) &bull; L/R &rarr; GND ]
            </span>
            <div className="array-center-wire" />
            <span className={`array-node ${angle > 10 && isActive ? 'active' : ''}`}>
              [ MIC 2 (Right) &bull; L/R &rarr; 3.3V ]
            </span>
          </div>
        </div>

        <div className="panel-card">
          <div className="panel-top">
            <span className="panel-title">Acoustic Telemetry Readings</span>
            <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              16,000 Hz Fs
            </span>
          </div>

          <div className="tiles-quad">
            <div className="tile-box">
              <div className="tile-label">Estimated Angle</div>
              <div className="tile-value">
                {angle > 0 ? `+${angle.toFixed(1)}°` : `${angle.toFixed(1)}°`}
              </div>
              <div className="tile-sub">&theta; = arcsin((c &bull; TDOA) / d)</div>
            </div>

            <div className="tile-box">
              <div className="tile-label">Time Delay (TDOA)</div>
              <div className="tile-value">
                {tdoaUs > 0 ? `+${tdoaUs.toFixed(1)} μs` : `${tdoaUs.toFixed(1)} μs`}
              </div>
              <div className="tile-sub">Bounds: &plusmn;437.5 &mu;s</div>
            </div>

            <div className="tile-box">
              <div className="tile-label">Sample Delay</div>
              <div className="tile-value">
                {tdoaSamples > 0 ? `+${tdoaSamples.toFixed(2)}` : `${tdoaSamples.toFixed(2)}`}
              </div>
              <div className="tile-sub">Bounds: &plusmn;7 samples</div>
            </div>

            <div className="tile-box">
              <div className="tile-label">Peak Confidence</div>
              <div className="tile-value">{Math.round(peakConfidence * 100)}%</div>
              <div className="tile-sub">Direct path correlation</div>
            </div>
          </div>

          <div className="rms-monitor">
            <div className="rms-header">
              <span>Microphone Energy (24-bit RMS)</span>
              <span className="mono">
                &Delta;: {Math.abs(rightRms - leftRms).toLocaleString()}
              </span>
            </div>

            <div className="rms-channel-row">
              <div className="rms-channel-info">
                <span>MIC 1 (Left Channel):</span>
                <span className="mono">{leftRms.toLocaleString()}</span>
              </div>
              <div className="rms-bar-track">
                <div className="rms-bar-fill" style={{ width: `${Math.min(100, (leftRms / 35000) * 100)}%` }} />
              </div>
            </div>

            <div className="rms-channel-row">
              <div className="rms-channel-info">
                <span>MIC 2 (Right Channel):</span>
                <span className="mono">{rightRms.toLocaleString()}</span>
              </div>
              <div className="rms-bar-track">
                <div className="rms-bar-fill" style={{ width: `${Math.min(100, (rightRms / 35000) * 100)}%` }} />
              </div>
            </div>
          </div>

          <div className="sim-box">
            <div className="sim-title">Interactive Simulator (Click or Click 2D Dial)</div>
            <div className="sim-grid">
              <button className="btn-sim-key" onClick={() => triggerSim(-65.0, 'Left Snap')}>
                [ -65° Left ]
              </button>
              <button className="btn-sim-key" onClick={() => triggerSim(0.0, 'Center Clap')}>
                [ 0° Center ]
              </button>
              <button className="btn-sim-key" onClick={() => triggerSim(65.0, 'Right Snap')}>
                [ +65° Right ]
              </button>
              <button
                className={`btn-sim-key ${isSweepActive ? 'active' : ''}`}
                onClick={() => {
                  setIsSimulator(true);
                  setIsSweepActive(!isSweepActive);
                }}
              >
                {isSweepActive ? '[ Stop ]' : '[ Sweep ]'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="chart-card">
        <div className="panel-top" style={{ marginBottom: 0 }}>
          <span className="panel-title">Acoustic Angle Trajectory History</span>
          <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Last 60 Frames
          </span>
        </div>

        <div className="chart-container">
          <svg className="chart-svg-element" viewBox="0 0 600 110" preserveAspectRatio="none">
            <line x1="0" y1="18" x2="600" y2="18" stroke="#181a20" strokeDasharray="3" />
            <line x1="0" y1="55" x2="600" y2="55" stroke="#252833" />
            <line x1="0" y1="92" x2="600" y2="92" stroke="#181a20" strokeDasharray="3" />

            <polyline
              fill="none"
              stroke="#d4d4d8"
              strokeWidth="1.6"
              points={history
                .map((val, i) => {
                  const x = (i / (history.length - 1)) * 600;
                  const y = 55 - (val / 90) * 42;
                  return `${x},${y}`;
                })
                .join(' ')}
            />
          </svg>
        </div>
      </div>

      {showConsole && (
        <div className="terminal-card">
          <div className="panel-top">
            <span className="panel-title">Serial Packet Inspector (115,200 Baud)</span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {rawLogs.length} Packets
              </span>
              <button className="btn-outline" onClick={() => setRawLogs([])}>
                Clear
              </button>
              <button
                className="btn-outline"
                onClick={() => setAutoScrollLog(!autoScrollLog)}
              >
                {autoScrollLog ? 'Auto-Scroll: ON' : 'Auto-Scroll: OFF'}
              </button>
            </div>
          </div>

          <div className="terminal-viewport" ref={terminalBoxRef}>
            {rawLogs.length === 0 ? (
              <div>
                No packets received yet. Connect ESP32 or click a simulator preset above.
              </div>
            ) : (
              rawLogs.map((log, idx) => (
                <div key={idx} className={`terminal-row ${log.startsWith('A:') ? 'packet-active' : ''}`}>
                  &gt; {log}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <footer className="footer-bar">
        <div>
          c = 343.0 m/s &bull; d = 0.15 m &bull; Fs = 16,000 Hz &bull; Max Delay = &plusmn;437.5 &mu;s (&plusmn;7 samples)
        </div>
        <div>Candidate: Hithesh H G &bull; NMAMIT SRIP 2025–26</div>
      </footer>
    </div>
  );
}
