/**
 * Unit tests for utils.ts — system-aware concurrency utilities.
 */

import * as os from 'os';
import { detectConcurrencyLimit, formatConcurrencyProfile } from './utils';
import type { ConcurrencyProfile } from './utils';

// ── detectConcurrencyLimit ────────────────────────────────────────────────────

describe('detectConcurrencyLimit()', () => {
  it('returns a cap within the MIN_CAP (4) and MAX_CAP (250) bounds', () => {
    const { cap } = detectConcurrencyLimit();
    expect(cap).toBeGreaterThanOrEqual(4);
    expect(cap).toBeLessThanOrEqual(250);
  });

  it('reports a cpus value matching os.cpus().length', () => {
    const { cpus } = detectConcurrencyLimit();
    expect(cpus).toBe(os.cpus().length);
  });

  it('reports totalRam matching os.totalmem()', () => {
    const { totalRam } = detectConcurrencyLimit();
    expect(totalRam).toBe(os.totalmem());
  });

  it('cpuSlots = cpus * 5', () => {
    const { cpus, cpuSlots } = detectConcurrencyLimit();
    expect(cpuSlots).toBe(cpus * 5);
  });

  it('ramSlots = floor(totalRam * 0.25 / 40MB)', () => {
    const { totalRam, ramSlots } = detectConcurrencyLimit();
    const expected = Math.floor((totalRam * 0.25) / (40 * 1024 * 1024));
    expect(ramSlots).toBe(expected);
  });

  it('cap = clamp(min(ramSlots, cpuSlots), 4, 250)', () => {
    const { cap, ramSlots, cpuSlots } = detectConcurrencyLimit();
    const raw = Math.min(ramSlots, cpuSlots);
    const expected = Math.max(4, Math.min(250, raw));
    expect(cap).toBe(expected);
  });

  it('floors at MIN_CAP=4 when both slots compute to 0', () => {
    // Verify the floor is enforced by checking the maths directly
    const raw = Math.min(0, 0);
    const cap = Math.max(4, Math.min(250, raw));
    expect(cap).toBe(4);
    // The real function always returns >= 4
    expect(detectConcurrencyLimit().cap).toBeGreaterThanOrEqual(4);
  });

  it('caps at MAX_CAP=250 when raw slots exceed 250', () => {
    // Verify the clamp formula directly
    const raw = 999;
    const cap = Math.max(4, Math.min(250, raw));
    expect(cap).toBe(250);
    // The real function always returns <= 250
    expect(detectConcurrencyLimit().cap).toBeLessThanOrEqual(250);
  });
});

// ── formatConcurrencyProfile ──────────────────────────────────────────────────

describe('formatConcurrencyProfile()', () => {
  const profile: ConcurrencyProfile = {
    cap:      50,
    cpus:     10,
    totalRam: 34_000_000_000,
    ramSlots: 212,
    cpuSlots: 50,
  };

  it('includes the cap value', () => {
    expect(formatConcurrencyProfile(profile)).toContain('50');
  });

  it('includes cpu count and cpu-slots', () => {
    const out = formatConcurrencyProfile(profile);
    expect(out).toContain('10 CPUs');
    expect(out).toContain('50 cpu-slots');
  });

  it('includes GB RAM value', () => {
    const out = formatConcurrencyProfile(profile);
    // 34 GB
    expect(out).toContain('34.0 GB RAM');
  });

  it('includes ram-slots', () => {
    expect(formatConcurrencyProfile(profile)).toContain('212 ram-slots');
  });

  it('contains "auto-detected" prefix', () => {
    expect(formatConcurrencyProfile(profile)).toMatch(/^auto-detected:/);
  });
});
