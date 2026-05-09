import type { AppSnapshot, Force, Palette, ProvinceCollection } from '@/types';

/** SVG canvas size in pixels. */
const SVG_WIDTH = 2000;
const SVG_HEIGHT = 1000;
const APP_TAG = 'theatrum';

/**
 * Project (lon, lat) → SVG (x, y) using the Mercator projection.
 * Latitudes are clamped to ±85° (the Mercator usable range).
 */
function projectMercator(lon: number, lat: number): [number, number] {
  const clampedLat = Math.max(-85, Math.min(85, lat));
  const x = ((lon + 180) / 360) * SVG_WIDTH;
  const sinLat = Math.sin((clampedLat * Math.PI) / 180);
  const yMerc = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  const y = yMerc * SVG_HEIGHT;
  return [x, y];
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ringToPath(ring: number[][]): string {
  const parts: string[] = [];
  for (let i = 0; i < ring.length; i++) {
    const pt = ring[i];
    if (!pt || pt.length < 2) continue;
    const [lon, lat] = pt as [number, number];
    const [x, y] = projectMercator(lon, lat);
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

function geometryToPath(geometry: ProvinceCollection['features'][0]['geometry']): string {
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.map(ringToPath).join(' ');
  }
  if (geometry.type === 'MultiPolygon') {
    const out: string[] = [];
    for (const poly of geometry.coordinates) {
      for (const ring of poly) out.push(ringToPath(ring));
    }
    return out.join(' ');
  }
  return '';
}

interface ExportSvgInputs {
  provinces: ProvinceCollection;
  palette: Palette;
  forces: Force[];
  snapshot: AppSnapshot;
  /** Country labels: { name, lon, lat, fontSize } */
  countryLabels: Array<{ name: string; lon: number; lat: number; fontSize: number }>;
  fillOpacity: number;
}

export function exportToSvg(inputs: ExportSvgInputs): string {
  const { provinces, palette, forces, snapshot, countryLabels, fillOpacity } = inputs;

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" width="${SVG_WIDTH}" height="${SVG_HEIGHT}">`,
  );

  // Embedded snapshot — re-importable by detecting data-app="theatrum"
  lines.push(`<metadata data-app="${APP_TAG}">`);
  lines.push(`<![CDATA[${JSON.stringify(snapshot)}]]>`);
  lines.push(`</metadata>`);

  // Black ocean background
  lines.push(`<rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#0a1929"/>`);

  // Provinces — one path per feature, fill from palette
  lines.push(`<g id="provinces">`);
  for (const feat of provinces.features) {
    const owner = feat.properties.owner;
    const fill = palette[owner] ?? '#888888';
    const path = geometryToPath(feat.geometry);
    if (!path) continue;
    lines.push(
      `<path d="${path}" fill="${fill}" fill-opacity="${fillOpacity}" ` +
        `stroke="#222" stroke-width="0.4" stroke-opacity="0.85"/>`,
    );
  }
  lines.push(`</g>`);

  // Country labels — classical engraved serif (Cinzel) with parchment fill.
  // Letter-spacing widens the imperial / map-engraving feel.
  lines.push(
    `<g id="country-labels" font-family="'Cinzel', 'Trajan Pro', Georgia, serif" ` +
      `font-weight="700" fill="#f3e7c8" letter-spacing="1">`,
  );
  for (const label of countryLabels) {
    const [x, y] = projectMercator(label.lon, label.lat);
    const fs = label.fontSize.toFixed(1);
    lines.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs}" ` +
        `text-anchor="middle" stroke="black" stroke-width="2" paint-order="stroke">` +
        `${escapeXml(label.name.toUpperCase())}</text>`,
    );
  }
  lines.push(`</g>`);

  // Force counters — simplified rectangles with branch glyph
  lines.push(`<g id="forces">`);
  for (const force of forces) {
    const [cx, cy] = projectMercator(force.lon, force.lat);
    const fill = palette[force.nation] ?? '#888';
    const x = cx - 25;
    const y = cy - 16;
    lines.push(
      `<g><rect x="${x}" y="${y}" width="50" height="32" fill="${fill}" stroke="black" stroke-width="2"/>`,
    );
    if (force.branch === 'army') {
      // X cross
      lines.push(
        `<line x1="${x}" y1="${y}" x2="${x + 50}" y2="${y + 32}" stroke="black" stroke-width="2"/>` +
          `<line x1="${x + 50}" y1="${y}" x2="${x}" y2="${y + 32}" stroke="black" stroke-width="2"/>`,
      );
    } else {
      // Anchor glyph (Unicode)
      lines.push(
        `<text x="${cx}" y="${cy + 7}" font-size="20" fill="black" text-anchor="middle">⚓</text>`,
      );
    }
    // Nation above — condensed military sans (Oswald)
    lines.push(
      `<text x="${cx}" y="${y - 4}" font-size="9" fill="white" stroke="black" stroke-width="2" ` +
        `paint-order="stroke" text-anchor="middle" font-weight="700" letter-spacing="0.6" ` +
        `font-family="'Oswald', 'Arial Narrow', 'Helvetica Neue', sans-serif">` +
        `${escapeXml(force.nation.toUpperCase())}</text>`,
    );
    // Name below — same family, slightly lighter
    lines.push(
      `<text x="${cx}" y="${y + 32 + 12}" font-size="10" fill="white" stroke="black" stroke-width="2" ` +
        `paint-order="stroke" text-anchor="middle" font-weight="500" letter-spacing="0.3" ` +
        `font-family="'Oswald', 'Arial Narrow', 'Helvetica Neue', sans-serif">` +
        `${escapeXml(force.name)}</text>`,
    );
    lines.push(`</g>`);
  }
  lines.push(`</g>`);

  lines.push(`</svg>`);
  return lines.join('\n');
}

/**
 * Try to extract an embedded AppSnapshot from an SVG string.
 * Returns null if no `<metadata data-app="theatrum">` is found
 * or if its CDATA isn't parseable JSON.
 */
export function importSnapshotFromSvg(svgText: string): AppSnapshot | null {
  const re = new RegExp(
    `<metadata\\s+data-app="${APP_TAG}"[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</metadata>`,
  );
  const m = svgText.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as AppSnapshot;
  } catch {
    return null;
  }
}
