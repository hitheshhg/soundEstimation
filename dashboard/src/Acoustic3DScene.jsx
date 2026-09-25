import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

export default function Acoustic3DScene({ angle, level, isActive, leftRms, rightRms, onSelectAngle }) {
  const containerRef = useRef(null);
  const sceneRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const rayGroupRef = useRef(null);
  const mic1GlowRef = useRef(null);
  const mic2GlowRef = useRef(null);
  const waveRingsRef = useRef([]);

  const targetAngleRef = useRef(angle);
  const currentAngleRef = useRef(angle);
  const levelRef = useRef(level);
  const activeRef = useRef(isActive);
  const leftRmsRef = useRef(leftRms);
  const rightRmsRef = useRef(rightRms);

  const isDraggingRef = useRef(false);
  const prevMouseRef = useRef({ x: 0, y: 0 });
  const orbitRef = useRef({ rotX: 0.32, rotY: 0, zoom: 7.2 });

  useEffect(() => {
    targetAngleRef.current = angle;
  }, [angle]);

  useEffect(() => {
    levelRef.current = level;
    activeRef.current = isActive;
    leftRmsRef.current = leftRms;
    rightRmsRef.current = rightRms;
  }, [level, isActive, leftRms, rightRms]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 400;
    const height = container.clientHeight || 240;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.set(0, 4.0, 7.2);
    camera.lookAt(0, 0.25, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(6, 12, 8);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xa1a1aa, 0.9);
    rimLight.position.set(-6, 4, -6);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(8, 20, 0x22242a, 0x121316);
    grid.position.y = -0.01;
    scene.add(grid);

    const barGeo = new THREE.BoxGeometry(3.6, 0.07, 0.32);
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x1c1e24,
      metalness: 0.6,
      roughness: 0.35
    });
    const barMesh = new THREE.Mesh(barGeo, barMat);
    barMesh.position.set(0, 0.035, 0);
    scene.add(barMesh);

    const baselineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.5, 0.075, 0),
      new THREE.Vector3(1.5, 0.075, 0)
    ]);
    const baselineMat = new THREE.LineBasicMaterial({ color: 0x484b54 });
    const baseline = new THREE.Line(baselineGeo, baselineMat);
    scene.add(baseline);

    const chipGeo = new THREE.BoxGeometry(0.48, 0.07, 0.48);
    const chipMat = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.4, metalness: 0.3 });
    const portGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.03, 32);
    const portMat = new THREE.MeshStandardMaterial({ color: 0xc4a052, metalness: 0.8, roughness: 0.25 });

    const mic1Group = new THREE.Group();
    const mic1Chip = new THREE.Mesh(chipGeo, chipMat);
    const mic1Port = new THREE.Mesh(portGeo, portMat);
    mic1Port.position.y = 0.04;
    mic1Group.add(mic1Chip);
    mic1Group.add(mic1Port);
    mic1Group.position.set(-1.5, 0.105, 0);
    scene.add(mic1Group);

    const mic2Group = new THREE.Group();
    const mic2Chip = new THREE.Mesh(chipGeo, chipMat);
    const mic2Port = new THREE.Mesh(portGeo, portMat);
    mic2Port.position.y = 0.04;
    mic2Group.add(mic2Chip);
    mic2Group.add(mic2Port);
    mic2Group.position.set(1.5, 0.105, 0);
    scene.add(mic2Group);

    const auraGeo = new THREE.RingGeometry(0.16, 0.38, 36);
    auraGeo.rotateX(-Math.PI / 2);

    const mic1AuraMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
    const mic1Aura = new THREE.Mesh(auraGeo, mic1AuraMat);
    mic1Aura.position.set(-1.5, 0.13, 0);
    scene.add(mic1Aura);
    mic1GlowRef.current = mic1Aura;

    const mic2AuraMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
    const mic2Aura = new THREE.Mesh(auraGeo, mic2AuraMat);
    mic2Aura.position.set(1.5, 0.13, 0);
    scene.add(mic2Aura);
    mic2GlowRef.current = mic2Aura;

    const arcRadius = 2.9;
    const arcPts = [];
    for (let deg = -90; deg <= 90; deg += 2) {
      const rad = (deg * Math.PI) / 180;
      arcPts.push(new THREE.Vector3(arcRadius * Math.sin(rad), 0.02, -arcRadius * Math.cos(rad)));
    }
    const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
    const arcMat = new THREE.LineBasicMaterial({ color: 0x2e313b });
    const arc = new THREE.Line(arcGeo, arcMat);
    scene.add(arc);

    const createTextSprite = (text, isZero) => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 128, 64);
      ctx.font = isZero ? 'bold 32px monospace' : '26px monospace';
      ctx.fillStyle = isZero ? '#f4f4f5' : '#71717a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 64, 32);

      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.scale.set(0.68, 0.34, 1);
      return sprite;
    };

    [-90, -60, -30, 0, 30, 60, 90].forEach((deg) => {
      const rad = (deg * Math.PI) / 180;
      const x1 = arcRadius * Math.sin(rad);
      const z1 = -arcRadius * Math.cos(rad);
      const len = deg === 0 ? 0.3 : 0.18;
      const x2 = (arcRadius - len) * Math.sin(rad);
      const z2 = -(arcRadius - len) * Math.cos(rad);
      const tickGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x1, 0.02, z1),
        new THREE.Vector3(x2, 0.02, z2)
      ]);
      const tickMat = new THREE.LineBasicMaterial({ color: deg === 0 ? 0xe4e4e7 : 0x52525b });
      scene.add(new THREE.Line(tickGeo, tickMat));

      const labelDist = arcRadius + 0.38;
      const textSprite = createTextSprite(deg === 0 ? '0°' : (deg > 0 ? `+${deg}°` : `${deg}°`), deg === 0);
      textSprite.position.set(labelDist * Math.sin(rad), 0.08, -labelDist * Math.cos(rad));
      scene.add(textSprite);
    });

    const mic1Text = createTextSprite('MIC L', false);
    mic1Text.position.set(-1.5, 0.38, 0);
    mic1Text.scale.set(0.55, 0.28, 1);
    scene.add(mic1Text);

    const mic2Text = createTextSprite('MIC R', false);
    mic2Text.position.set(1.5, 0.38, 0);
    mic2Text.scale.set(0.55, 0.28, 1);
    scene.add(mic2Text);

    const rayGroup = new THREE.Group();
    scene.add(rayGroup);
    rayGroupRef.current = rayGroup;

    const beamGeo = new THREE.CylinderGeometry(0.022, 0.022, 3.25, 24);
    beamGeo.translate(0, 1.625, 0);
    beamGeo.rotateX(Math.PI / 2);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    rayGroup.add(beam);

    const sourcePointGeo = new THREE.SphereGeometry(0.09, 24, 24);
    const sourcePointMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const sourcePoint = new THREE.Mesh(sourcePointGeo, sourcePointMat);
    sourcePoint.position.set(0, 0, 3.25);
    rayGroup.add(sourcePoint);

    const waveRings = [];
    for (let i = 0; i < 3; i++) {
      const ringGeo = new THREE.RingGeometry(0.12, 0.17, 36);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.set(0, 0.04, 3.25);
      rayGroup.add(ringMesh);
      waveRings.push({ mesh: ringMesh, offset: i * 0.33 });
    }
    waveRingsRef.current = waveRings;

    const onMouseDown = (e) => {
      isDraggingRef.current = true;
      prevMouseRef.current = { x: e.clientX, y: e.clientY };
    };

    const onMouseMove = (e) => {
      if (!isDraggingRef.current) return;
      const dx = e.clientX - prevMouseRef.current.x;
      const dy = e.clientY - prevMouseRef.current.y;
      prevMouseRef.current = { x: e.clientX, y: e.clientY };

      orbitRef.current.rotY += dx * 0.007;
      orbitRef.current.rotX = Math.max(0.12, Math.min(1.15, orbitRef.current.rotX + dy * 0.007));
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
    };

    const onWheel = (e) => {
      e.preventDefault();
      orbitRef.current.zoom = Math.max(5.0, Math.min(10.5, orbitRef.current.zoom + e.deltaY * 0.005));
    };

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    let animationFrameId;
    let clock = new THREE.Clock();

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      const elapsedTime = clock.getElapsedTime();

      currentAngleRef.current += (targetAngleRef.current - currentAngleRef.current) * 0.15;
      const ang = currentAngleRef.current;

      if (rayGroupRef.current) {
        const rad = (ang * Math.PI) / 180;
        rayGroupRef.current.rotation.y = -rad + Math.PI;

        const pulseScale = activeRef.current ? 1 + Math.sin(elapsedTime * 6) * 0.18 : 0.3;
        sourcePoint.scale.set(pulseScale, pulseScale, pulseScale);

        waveRingsRef.current.forEach((w) => {
          const t = (elapsedTime * 0.75 + w.offset) % 1;
          const dist = 3.25 * (1 - t);
          w.mesh.position.z = dist;
          const s = 0.6 + t * 2.2;
          w.mesh.scale.set(s, s, s);
          w.mesh.material.opacity = activeRef.current ? (1 - t) * 0.5 : 0;
        });
      }

      if (mic1GlowRef.current) {
        const normL = Math.min(1, leftRmsRef.current / 35000);
        const sL = 1 + normL * 2.0;
        mic1GlowRef.current.scale.set(sL, sL, sL);
        mic1GlowRef.current.material.opacity = 0.08 + normL * 0.65;
      }

      if (mic2GlowRef.current) {
        const normR = Math.min(1, rightRmsRef.current / 35000);
        const sR = 1 + normR * 2.0;
        mic2GlowRef.current.scale.set(sR, sR, sR);
        mic2GlowRef.current.material.opacity = 0.08 + normR * 0.65;
      }

      const distCam = orbitRef.current.zoom;
      const rotX = orbitRef.current.rotX;
      const rotY = orbitRef.current.rotY;

      camera.position.x = distCam * Math.sin(rotY) * Math.cos(rotX);
      camera.position.y = distCam * Math.sin(rotX);
      camera.position.z = distCam * Math.cos(rotY) * Math.cos(rotX);
      camera.lookAt(0, 0.25, 0);

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '240px',
        position: 'relative',
        cursor: 'grab',
        touchAction: 'none'
      }}
    />
  );
}
