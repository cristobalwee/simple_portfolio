import { useEffect, useMemo, useRef, useState } from "react";

// Polymarket CLOB exposes public endpoints (no auth) for outcome-token prices
// and price history. The bot reports each position's token_id; everything
// else (current price, unrealized P&L, portfolio time series) is derived from
// these calls.

const CLOB_URL =
  import.meta.env.PUBLIC_POLYMARKET_CLOB_URL?.replace(/\/$/, "") ??
  "https://clob.polymarket.com";

export type PolyInterval = "1h" | "6h" | "1d" | "1w" | "1m" | "max";

export interface PricePoint {
  t: number; // unix seconds
  p: number; // 0..1
}

export type PriceMap = Record<string, number | undefined>;
export type HistoryMap = Record<string, PricePoint[] | undefined>;

function isMockToken(tokenId: string): boolean {
  return tokenId.startsWith("mock-");
}

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polymarket ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchMidpoint(tokenId: string): Promise<number> {
  if (isMockToken(tokenId)) return mockMidpoint(tokenId);
  const data = await fetchJSON<{ mid: string }>(
    `${CLOB_URL}/midpoint?token_id=${encodeURIComponent(tokenId)}`,
  );
  return parseFloat(data.mid);
}

export async function fetchPriceHistory(
  tokenId: string,
  interval: PolyInterval,
  fidelityMinutes?: number,
): Promise<PricePoint[]> {
  if (isMockToken(tokenId)) return mockHistory(tokenId, interval, fidelityMinutes);
  const params = new URLSearchParams({ market: tokenId, interval });
  if (fidelityMinutes) params.set("fidelity", String(fidelityMinutes));
  const data = await fetchJSON<{ history: PricePoint[] }>(
    `${CLOB_URL}/prices-history?${params.toString()}`,
  );
  return data.history ?? [];
}

// ---------- Hooks ----------

interface PricesState {
  prices: PriceMap;
  loading: boolean;
  lastUpdated: number | null;
}

export function usePolymarketPrices(
  tokenIds: string[],
  pollMs: number = 20_000,
): PricesState {
  const [state, setState] = useState<PricesState>({
    prices: {},
    loading: true,
    lastUpdated: null,
  });
  // Stable key so the effect re-fires only when the set of ids actually changes.
  const key = useMemo(() => [...tokenIds].sort().join("|"), [tokenIds]);

  useEffect(() => {
    if (tokenIds.length === 0) {
      setState({ prices: {}, loading: false, lastUpdated: Date.now() });
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const entries = await Promise.all(
        tokenIds.map(async (id) => {
          try {
            const p = await fetchMidpoint(id);
            return [id, p] as const;
          } catch {
            return [id, undefined] as const;
          }
        }),
      );
      if (cancelled) return;
      const next: PriceMap = {};
      for (const [id, p] of entries) next[id] = p;
      setState({ prices: next, loading: false, lastUpdated: Date.now() });
      timeoutId = setTimeout(tick, pollMs);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);

  return state;
}

interface HistoriesState {
  histories: HistoryMap;
  loading: boolean;
  lastUpdated: number | null;
}

export function usePolymarketHistories(
  tokenIds: string[],
  interval: PolyInterval,
  fidelityMinutes?: number,
  pollMs: number = 60_000,
): HistoriesState {
  const [state, setState] = useState<HistoriesState>({
    histories: {},
    loading: true,
    lastUpdated: null,
  });
  const key = useMemo(() => [...tokenIds].sort().join("|"), [tokenIds]);

  useEffect(() => {
    if (tokenIds.length === 0) {
      setState({ histories: {}, loading: false, lastUpdated: Date.now() });
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const entries = await Promise.all(
        tokenIds.map(async (id) => {
          try {
            const h = await fetchPriceHistory(id, interval, fidelityMinutes);
            return [id, h] as const;
          } catch {
            return [id, undefined] as const;
          }
        }),
      );
      if (cancelled) return;
      const next: HistoryMap = {};
      for (const [id, h] of entries) next[id] = h;
      setState({ histories: next, loading: false, lastUpdated: Date.now() });
      timeoutId = setTimeout(tick, pollMs);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, interval, fidelityMinutes, pollMs]);

  return state;
}

// ---------- Mock Polymarket ----------

function tokenHash(tokenId: string): number {
  let h = 0;
  for (let i = 0; i < tokenId.length; i++) h = (h * 31 + tokenId.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Mock midpoint drifts slowly minute-to-minute so the dashboard feels live
// without spiking on every poll.
function mockMidpoint(tokenId: string): number {
  const r = seeded(tokenHash(tokenId) + Math.floor(Date.now() / 60_000));
  const base = 0.25 + (tokenHash(tokenId) % 1000) / 1000 * 0.5;
  const wobble = (r() - 0.5) * 0.04;
  return clamp(base + wobble, 0.02, 0.98);
}

const INTERVAL_SECS: Record<PolyInterval, number> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "1d": 86400,
  "1w": 7 * 86400,
  "1m": 30 * 86400,
  max: 90 * 86400,
};

function mockHistory(
  tokenId: string,
  interval: PolyInterval,
  fidelityMinutes?: number,
): PricePoint[] {
  const windowSec = INTERVAL_SECS[interval];
  const stepSec = (fidelityMinutes ?? defaultFidelity(interval)) * 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec - windowSec;
  const seed = tokenHash(tokenId);
  const r = seeded(seed);
  // Anchor on the mock's current midpoint and walk backwards so the last
  // point lines up with what /midpoint returns.
  const endP = mockMidpoint(tokenId);
  const points: PricePoint[] = [];
  let p = endP;
  const steps = Math.max(2, Math.floor(windowSec / stepSec));
  for (let i = steps; i >= 0; i--) {
    points.push({ t: start + i * stepSec, p: round(p, 4) });
    p = clamp(p + (r() - 0.5) * 0.02, 0.02, 0.98);
  }
  points.reverse();
  return points;
}

function defaultFidelity(interval: PolyInterval): number {
  switch (interval) {
    case "1h":
      return 1;
    case "6h":
      return 5;
    case "1d":
      return 10;
    case "1w":
      return 60;
    case "1m":
      return 240;
    case "max":
      return 720;
  }
}

export function intervalForWindowSecs(secs: number): {
  interval: PolyInterval;
  fidelityMinutes: number;
} {
  if (secs <= 24 * 3600) return { interval: "1d", fidelityMinutes: 10 };
  if (secs <= 7 * 86400) return { interval: "1w", fidelityMinutes: 60 };
  if (secs <= 30 * 86400) return { interval: "1m", fidelityMinutes: 240 };
  return { interval: "max", fidelityMinutes: 720 };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round(n: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}
