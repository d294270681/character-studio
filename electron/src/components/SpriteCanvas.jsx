import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../lib/studio.js';

export default function SpriteCanvas({ sheetPath, metadata, mode = 'anim', playing = true, className = '' }) {
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const frameRef = useRef(0);
  const rafRef = useRef(0);
  const [imageVersion, setImageVersion] = useState(0);

  const columns = metadata?.grid?.[0] || 1;
  const rows = metadata?.grid?.[1] || 1;
  const cellW = metadata?.cell_size?.[0] || 128;
  const cellH = metadata?.cell_size?.[1] || 192;
  const frameCount = metadata?.selected_frames?.length || columns * rows;
  const fps = Math.max(1, Number(metadata?.animation_fps) || 12);
  const transparent = metadata?.transparent !== false;

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent) return undefined;
    const width = mode === 'sheet' ? cellW * columns : cellW;
    const height = mode === 'sheet' ? cellH * rows : cellH;
    const fit = () => {
      const factor = Math.min(parent.clientWidth / width, parent.clientHeight / height);
      canvas.style.width = `${Math.max(1, width * factor)}px`;
      canvas.style.height = `${Math.max(1, height * factor)}px`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(parent);
    fit();
    return () => observer.disconnect();
  }, [mode, columns, rows, cellW, cellH]);

  useEffect(() => {
    imageRef.current = null;
    frameRef.current = 0;
    if (!sheetPath) return undefined;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => { imageRef.current = image; setImageVersion(version => version + 1); };
    image.src = mediaUrl(sheetPath);
    return () => { image.onload = null; };
  }, [sheetPath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    const canvasStyle = getComputedStyle(canvas);
    const checkerLight = canvasStyle.getPropertyValue('--checker-light').trim() || '#232b28';
    const checkerDark = canvasStyle.getPropertyValue('--checker-dark').trim() || '#1b211f';

    const drawChecker = (width, height, step) => {
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          context.fillStyle = ((x / step) + (y / step)) % 2 === 0 ? checkerLight : checkerDark;
          context.fillRect(x, y, step, step);
        }
      }
    };

    const paint = () => {
      const image = imageRef.current;
      context.imageSmoothingEnabled = false;
      if (!image) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        drawChecker(canvas.width, canvas.height, Math.max(8, Math.round(canvas.width / 24)));
        return;
      }
      if (mode === 'sheet') {
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (transparent) drawChecker(canvas.width, canvas.height, Math.max(8, Math.round(canvas.width / 40)));
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return;
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (transparent) drawChecker(canvas.width, canvas.height, Math.max(6, Math.round(canvas.width / 20)));
      const index = frameRef.current % frameCount;
      const sx = (index % columns) * cellW;
      const sy = Math.floor(index / columns) * cellH;
      context.drawImage(image, sx, sy, cellW, cellH, 0, 0, canvas.width, canvas.height);
    };

    if (mode === 'sheet') {
      canvas.width = cellW * columns;
      canvas.height = cellH * rows;
      paint();
      return undefined;
    }

    canvas.width = cellW;
    canvas.height = cellH;
    if (!playing) { paint(); return undefined; }

    let previous = performance.now();
    const step = now => {
      const elapsed = now - previous;
      if (elapsed >= 1000 / fps) {
        previous = now - (elapsed % (1000 / fps));
        frameRef.current = (frameRef.current + 1) % frameCount;
      }
      paint();
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [sheetPath, mode, playing, columns, rows, cellW, cellH, frameCount, fps, transparent, imageVersion]);

  return <canvas ref={canvasRef} className={`sprite-canvas ${className}`.trim()}
    style={{ imageRendering: Number(metadata?.pixel_grid ?? metadata?.pixel_size ?? 2) === 1 ? 'auto' : 'pixelated' }} />;
}
