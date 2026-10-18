/**
 * Climate stage: latitude temperature bands + altitude lapse, and moisture
 * advection with wind bands / orographic rain shadow.
 *
 * Moisture is advected one scanline at a time along the prevailing wind: air
 * picks up humidity over water, loses it as it climbs windward slopes
 * (orographic rainout, which is what produces lee-side deserts) and slowly
 * relaxes toward a latitude-dependent local equilibrium. A light diffusion
 * pass removes scanline banding. The model is deliberately cheap: one pass
 * plus one smoothing pass, no back-tracing.
 */
import { buildField, clamp, clamp01, fbm, hash2, sampleField } from "./rng";

export interface ClimateInput {
  size: number;
  height: Float32Array;
  ocean: Uint8Array;
  lake: Uint8Array;
  seaLevel: number;
  windAngle: number;
  windBands: boolean;
  moistureBias: number;
  temperatureOffset: number;
  /**
   * Optional climate sub-seed (stageSeeds.climate). When present, the
   * temperature/moisture noise fields use this seed instead of the historical
   * fixed noise constants; absent = legacy behaviour, bit-for-bit identical.
   */
  seed?: number;
}

export interface ClimateResult {
  temperature: Float32Array;
  moisture: Float32Array;
}

const DEG = Math.PI / 180;

/** Latitude-dependent baseline humidity (ITCZ wet, subtropics dry, westerlies wet). */
function latitudeHumidity(lat: number): number {
  const itcz = Math.exp(-(((lat - 0.0) / 0.17) ** 2)) * 0.42;
  const subtropics = Math.exp(-(((lat - 0.3) / 0.14) ** 2)) * 0.4;
  const westerlies = Math.exp(-(((lat - 0.56) / 0.17) ** 2)) * 0.34;
  return clamp01(0.3 + itcz + westerlies - subtropics);
}

/** Wind direction in screen space; 0deg = from the west (blowing toward +x). */
function windDirection(lat: number, bands: boolean, angleDeg: number): { dx: number; dy: number } {
  let angle = angleDeg;
  if (bands) {
    const degrees = lat * 90;
    const bandAngle = degrees < 30 ? 180 : degrees < 60 ? 0 : 180;
    angle = bandAngle + angleDeg;
  }
  const rad = angle * DEG;
  return { dx: Math.cos(rad), dy: Math.sin(rad) };
}

export function computeClimate(input: ClimateInput): ClimateResult {
  const size = input.size;
  const cells = size * size;
  const height = input.height;
  const ocean = input.ocean;
  const lake = input.lake;
  const seaLevel = clamp(input.seaLevel, 0.02, 0.95);
  const temperature = new Float32Array(cells);
  temperature.fill(NaN);
  const moisture = new Float32Array(cells);
  moisture.fill(NaN);

  const tempOffset = clamp(input.temperatureOffset, -0.35, 0.35);
  const seaSpan = Math.max(0.05, 1 - seaLevel);
  const invSize = 1 / size;

  // Deterministic low-frequency climate noise. The fixed constants are the
  // historical (pre-stage-seed) behaviour; an explicit climate seed re-rolls
  // only these noise fields.
  const noiseRes = Math.max(8, Math.min(size, 192));
  const tempNoiseSeed =
    input.seed === undefined ? 1301 : (hash2(input.seed, 0x7c, 0x5eed) | 0);
  const moistNoiseSeed =
    input.seed === undefined ? 1709 : (hash2(input.seed, 0x6d, 0x5eed) | 0);
  const tempNoise = buildField(noiseRes, (u, v) =>
    fbm(u * 3.1 + 4.7, v * 3.1 + 9.3, tempNoiseSeed, 3) - 0.5,
  );
  const moistNoise = buildField(noiseRes, (u, v) =>
    fbm(u * 2.7 + 15.1, v * 2.7 + 2.9, moistNoiseSeed, 3) - 0.5,
  );

  // ── Temperature ────────────────────────────────────────────────────────
  const rowHumidity = new Float32Array(size);
  const rowTempBase = new Float32Array(size);
  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) * invSize;
    const lat = Math.abs(v - 0.5) * 2;
    rowHumidity[y] = latitudeHumidity(lat);
    rowTempBase[y] = 0.5 + 0.5 * Math.cos(lat * Math.PI);
  }
  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) * invSize;
    const row = y * size;
    const base = rowTempBase[y];
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) * invSize;
      const h = height[row + x];
      const alt = clamp01((h - seaLevel) / seaSpan);
      // Oceans are thermally buffered; high land cools much faster.
      let t = base;
      if (!ocean[row + x]) t -= alt * 0.62;
      else t = t * 0.9 + 0.1;
      t += sampleField(tempNoise, noiseRes, u, v) * 0.12;
      temperature[row + x] = clamp01(t + tempOffset);
    }
  }

  // ── Moisture advection ─────────────────────────────────────────────────
  const angle = Number.isFinite(input.windAngle) ? input.windAngle : 0;
  const bias = clamp(input.moistureBias, -0.5, 0.5);
  const bands = input.windBands !== false;
  const transport = 0.997;
  const relax = 0.005;

  const useHorizontal = (() => {
    // Bands are always zonal; for a global wind use the dominant component.
    if (bands) return true;
    const dir = windDirection(0.5, false, angle);
    return Math.abs(dir.dx) >= Math.abs(dir.dy);
  })();

  if (useHorizontal) {
    for (let y = 0; y < size; y += 1) {
      const v = (y + 0.5) * invSize;
      const lat = Math.abs(v - 0.5) * 2;
      const dir = windDirection(lat, bands, angle);
      const forward = dir.dx >= 0;
      const equilibriumBase = rowHumidity[y];
      const row = y * size;
      let upM = 0.66;
      let upH = 0;
      for (let step = 0; step < size; step += 1) {
        const x = forward ? step : size - 1 - step;
        const i = row + x;
        const h = height[i];
        let m: number;
        if (ocean[i]) {
          m = clamp01(0.58 + 0.32 * temperature[i]);
        } else if (lake[i]) {
          m = clamp01(0.62 + 0.24 * temperature[i]);
        } else {
          const transported = upM * transport;
          const lift = h > upH ? h - upH : 0;
          const rainFraction = lift > 0 ? Math.min(0.75, lift * 7) : 0;
          const u = (x + 0.5) * invSize;
          const equilibrium = clamp01(
            equilibriumBase * 0.95 + sampleField(moistNoise, noiseRes, u, v) * 0.2,
          );
          m = transported * (1 - rainFraction);
          m += (equilibrium - m) * relax;
        }
        moisture[i] = m;
        upM = m;
        upH = h;
      }
    }
  } else {
    const dir = windDirection(0.5, false, angle);
    const forward = dir.dy >= 0;
    const columnBase = new Float32Array(size);
    for (let x = 0; x < size; x += 1) {
      const lat = Math.abs((x + 0.5) * invSize - 0.5) * 2;
      columnBase[x] = latitudeHumidity(lat);
    }
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) * invSize;
      let upM = 0.66;
      let upH = 0;
      for (let step = 0; step < size; step += 1) {
        const y = forward ? step : size - 1 - step;
        const v = (y + 0.5) * invSize;
        const i = y * size + x;
        const h = height[i];
        let m: number;
        if (ocean[i]) {
          m = clamp01(0.58 + 0.32 * temperature[i]);
        } else if (lake[i]) {
          m = clamp01(0.62 + 0.24 * temperature[i]);
        } else {
          const transported = upM * transport;
          const lift = h > upH ? h - upH : 0;
          const rainFraction = lift > 0 ? Math.min(0.75, lift * 7) : 0;
          const equilibrium = clamp01(
            columnBase[x] * 0.95 + sampleField(moistNoise, noiseRes, u, v) * 0.2,
          );
          m = transported * (1 - rainFraction);
          m += (equilibrium - m) * relax;
        }
        moisture[i] = m;
        upM = m;
        upH = h;
      }
    }
  }

  // Light cross-scanline diffusion to remove scanline banding; ocean cells are
  // reset to humid air in the same pass (keeps coasts green and readable).
  const blended = new Float32Array(cells);
  if (useHorizontal) {
    for (let x = 0; x < size; x += 1) {
      for (let y = 0; y < size; y += 1) {
        const i = y * size + x;
        if (ocean[i]) {
          blended[i] = clamp01(0.6 + 0.3 * temperature[i] + bias);
          continue;
        }
        const rowUp = y > 0 ? i - size : i;
        const rowDown = y < size - 1 ? i + size : i;
        blended[i] = clamp01((moisture[i] * 2 + moisture[rowUp] + moisture[rowDown]) * 0.25 + bias);
      }
    }
  } else {
    for (let y = 0; y < size; y += 1) {
      const row = y * size;
      for (let x = 0; x < size; x += 1) {
        const i = row + x;
        if (ocean[i]) {
          blended[i] = clamp01(0.6 + 0.3 * temperature[i] + bias);
          continue;
        }
        const left = x > 0 ? i - 1 : i;
        const right = x < size - 1 ? i + 1 : i;
        blended[i] = clamp01((moisture[i] * 2 + moisture[left] + moisture[right]) * 0.25 + bias);
      }
    }
  }
  for (let i = 0; i < cells; i += 1) {
    moisture[i] = blended[i];
    if (temperature[i] < 0) temperature[i] = 0;
    else if (temperature[i] > 1) temperature[i] = 1;
  }

  return { temperature, moisture };
}
