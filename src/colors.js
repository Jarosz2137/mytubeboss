// Pulls 3 vibrant colors out of a cover for the living background.
import { useEffect, useState } from 'react';
import { imageObjectUrl } from './yt.js';

const cache = new Map();

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max / 255];
}

async function extract(url) {
  const small = url.replace(/=w\d+-h\d+[^&?#]*$/, '=w96-h96').replace(/=s\d+[^&?#]*$/, '=s96');
  const src = await imageObjectUrl(small);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const N = 32;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data;
    const buckets = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      const [h, sat, val] = rgbToHsv(r, g, b);
      const key = sat < 0.18 ? 'gray' : Math.round(h / 30) % 12;
      const w = sat < 0.18 ? 0.25 : 0.4 + sat * val;
      const bk = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0 };
      bk.r += r * w; bk.g += g * w; bk.b += b * w; bk.w += w;
      buckets.set(key, bk);
    }
    const cols = [...buckets.values()]
      .sort((a, b) => b.w - a.w)
      .slice(0, 3)
      .map((bk) => [bk.r / bk.w, bk.g / bk.w, bk.b / bk.w].map(Math.round));
    while (cols.length < 3) cols.push(cols[0] || [255, 45, 85]);
    return cols.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
  } finally {
    URL.revokeObjectURL(src);
  }
}

export function coverColors(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) { const hit=cache.get(url); cache.delete(url); cache.set(url,hit); return hit; }
  const job=extract(url).catch(()=>null);
  cache.set(url,job);
  while(cache.size>128) cache.delete(cache.keys().next().value);
  return job;
}

export function useCoverColors(url) {
  const [cols, setCols] = useState(null);
  useEffect(() => {
    let alive = true;
    coverColors(url).then((c) => alive && setCols(c));
    return () => { alive = false; };
  }, [url]);
  return cols;
}
