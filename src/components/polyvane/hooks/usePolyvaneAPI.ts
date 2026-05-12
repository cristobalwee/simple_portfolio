import { useCallback, useRef, useState } from "react";

// Types mirror the PolyVane FastAPI OpenAPI schema. The bot reports entry
// conditions and metadata; current price, unrealized P&L, and portfolio time
// series are derived client-side from live Polymarket data.

export type BotMode = "paper" | "live";
export type Direction = "YES" | "NO";
export type Outcome = "won" | "lost" | "pending";
export type ConnectionState = "connected" | "degraded" | "disconnected";

export interface StrategyStatus {
  enabled: boolean;
  cities_active?: number | null;
  cities_skipped?: number | null;
  last_signal_at?: string | null;
}

export interface RiskStatus {
  open_positions: number;
  max_concurrent: number;
  daily_pnl: number;
  daily_loss_limit: number;
  circuit_breaker_active: boolean;
}

export interface WalletStatus {
  pUSD_balance?: number | null;
  address?: string | null;
}

export interface BotStatus {
  mode: BotMode;
  uptime_seconds?: number | null;
  last_scan_at?: string | null;
  last_scan_duration_sec?: number | null;
  strategies: Record<string, StrategyStatus>;
  wallet: WalletStatus;
  risk: RiskStatus;
  version: string;
  exchange: string;
}

// The CLOB outcome-token id (needed for live Polymarket pricing) is delivered
// inside metadata, not as a top-level Position field.
export interface PositionMetadata {
  token_id?: string;
  forecast_temp?: number;
  forecast_unit?: string;
  agreement_score?: number;
  volume_tier?: string;
  intent_reason?: string;
  station?: string;
  metric?: string;
  target_date?: string;
  [key: string]: unknown;
}

export interface Position {
  id: number;
  market_id: string;
  market_question?: string | null;
  city?: string | null;
  bucket?: string | null;
  direction: Direction;
  entry_price: number;
  current_price?: number | null;
  exit_price?: number | null;
  size_usd: number;
  shares: number;
  edge_at_entry: number;
  opened_at: string;
  resolved_at?: string | null;
  outcome: Outcome;
  pnl?: number | null;
  strategy: string;
  metadata: PositionMetadata;
}

export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface PositionsResponse {
  positions: Position[];
  pagination: PaginationMeta;
}

export interface Trade {
  id: number;
  timestamp: string;
  strategy: string;
  market_id: string;
  market_question?: string | null;
  direction: Direction;
  entry_price: number;
  size_usd: number;
  shares: number;
  edge_at_entry: number;
  outcome: Outcome;
  pnl?: number | null;
  city?: string | null;
  bucket?: string | null;
  metadata: PositionMetadata;
}

export interface TradesResponse {
  trades: Trade[];
  pagination: PaginationMeta;
}

export type Window = "24h" | "7d" | "30d" | "all";

export interface APIError {
  status: number;
  message: string;
  kind: "auth" | "rate_limit" | "network" | "server" | "unknown";
}

// Pull the CLOB outcome-token id (the thing Polymarket prices off of) out of
// position/trade metadata. Returns undefined if the bot didn't record one —
// in that case the position can't be live-priced.
export function tokenIdOf(p: { metadata: PositionMetadata }): string | undefined {
  return p.metadata?.token_id;
}

const RAW_API_URL = import.meta.env.PUBLIC_POLYVANE_API_URL ?? "";
const API_KEY = import.meta.env.PUBLIC_POLYVANE_API_KEY ?? "";

// Accept either `http://host:port` or `http://host:port/api/v1` in the env —
// strip both trailing slashes and a trailing /api/v1, then re-append it
// ourselves so every call routes to the right place.
function normalizeBase(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}
const API_BASE = normalizeBase(RAW_API_URL);
export const USE_MOCK = !RAW_API_URL || !API_KEY;

async function apiFetch<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  if (USE_MOCK) {
    return mockResponse<T>(path, query);
  }
  const url = new URL(`${API_BASE}/api/v1${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "X-API-Key": API_KEY, Accept: "application/json" },
    });
  } catch {
    throw { status: 0, message: "Network error", kind: "network" } as APIError;
  }
  if (res.status === 401) {
    throw { status: 401, message: "Invalid API key", kind: "auth" } as APIError;
  }
  if (res.status === 429) {
    throw { status: 429, message: "Rate limited", kind: "rate_limit" } as APIError;
  }
  if (!res.ok) {
    throw {
      status: res.status,
      message: `Request failed (${res.status})`,
      kind: res.status >= 500 ? "server" : "unknown",
    } as APIError;
  }
  return (await res.json()) as T;
}

export interface PollableState<T> {
  data: T | null;
  loading: boolean;
  error: APIError | null;
  lastUpdated: number | null;
  fetch: () => Promise<void>;
}

export function useEndpoint<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): PollableState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<APIError | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inFlight = useRef(false);
  const queryKey = JSON.stringify(query ?? {});

  const doFetch = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await apiFetch<T>(path, query);
      setData(result);
      setError(null);
      setLastUpdated(Date.now());
    } catch (e) {
      setError(e as APIError);
      throw e;
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryKey]);

  return { data, loading, error, lastUpdated, fetch: doFetch };
}

// ---------- Mock data ----------
// Used only when no PolyVane API URL/key is configured. Token ids are prefixed
// with `mock-` so the Polymarket adapter routes them to its mock midpoint and
// history generators.

const CITIES = ["NYC", "Phoenix", "Miami", "Los Angeles", "Chicago", "Seattle", "Boston"];
const BUCKETS = ["40-41°F", "50-55°F", "60-65°F", "65-70°F", "70-75°F", "75-80°F", "≥85°F"];

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function mockResponse<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const rand = seededRandom(hashPath(path + JSON.stringify(query ?? {})));
  if (path === "/status") return Promise.resolve(mockStatus() as unknown as T);
  if (path === "/positions") {
    const status = (query?.status as string) ?? "open";
    return Promise.resolve(mockPositions(rand, status, query) as unknown as T);
  }
  if (path === "/trades")
    return Promise.resolve(mockTrades(rand, query) as unknown as T);
  return Promise.reject({
    status: 404,
    message: `Mock not implemented for ${path}`,
    kind: "unknown",
  } as APIError);
}

function hashPath(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

function mockStatus(): BotStatus {
  return {
    mode: "paper",
    uptime_seconds: 3 * 86400 + 14 * 3600 + 22 * 60,
    last_scan_at: new Date(Date.now() - 12_000).toISOString(),
    last_scan_duration_sec: 0.42,
    strategies: {
      weather: { enabled: true, cities_active: 39, last_signal_at: new Date().toISOString() },
      lazy: { enabled: true, cities_active: null, last_signal_at: null },
      arbitrage: { enabled: false },
      whale: { enabled: false },
    },
    wallet: { pUSD_balance: null, address: null },
    risk: {
      open_positions: 4,
      max_concurrent: 10,
      daily_pnl: 18.42,
      daily_loss_limit: -50,
      circuit_breaker_active: false,
    },
    version: "1.0.0-mock",
    exchange: "polymarket_clob_v2",
  };
}

function mockPositions(
  rand: () => number,
  status: string,
  query?: Record<string, string | number | undefined>,
): PositionsResponse {
  const limit = Number(query?.limit ?? 50);
  const offset = Number(query?.offset ?? 0);
  const isOpen = status === "open";
  const totalAll = 87;
  const totalOpen = 4;
  const total = status === "open" ? totalOpen : status === "resolved" ? totalAll - totalOpen : totalAll;
  const count = Math.min(limit, Math.max(0, total - offset));
  const positions = Array.from({ length: count }).map<Position>((_, i) => {
    const idx = offset + i;
    const entry = round(0.05 + rand() * 0.6, 3);
    const size = 10 + Math.floor(rand() * 40);
    const direction: Direction = rand() > 0.5 ? "YES" : "NO";
    const marketId = `mkt-${idx}`;
    const shares = size / Math.max(entry, 0.001);
    const won = rand() > 0.45;
    const outcome: Outcome = isOpen ? "pending" : won ? "won" : "lost";
    const opened = new Date(Date.now() - (idx + 1) * 6 * 3600_000);
    const resolved = isOpen ? null : new Date(opened.getTime() + 18 * 3600_000);
    const realized = isOpen
      ? null
      : won
        ? (1 - entry) * shares
        : -entry * shares;
    return {
      id: 1000 + idx,
      market_id: marketId,
      market_question: `Mock market ${idx}`,
      city: CITIES[idx % CITIES.length],
      bucket: BUCKETS[idx % BUCKETS.length],
      direction,
      entry_price: entry,
      current_price: null,
      exit_price: isOpen ? null : round(won ? 1 : 0, 3),
      size_usd: size,
      shares: round(shares, 4),
      edge_at_entry: round(0.04 + rand() * 0.12, 3),
      opened_at: opened.toISOString(),
      resolved_at: resolved ? resolved.toISOString() : null,
      outcome,
      pnl: realized !== null ? round(realized, 2) : null,
      strategy: "weather",
      metadata: {
        token_id: `mock-${marketId}-${direction}`,
        forecast_temp: 60 + Math.floor(rand() * 30),
        forecast_unit: "fahrenheit",
        agreement_score: round(0.4 + rand() * 0.5, 2),
        volume_tier: ["low", "med", "high"][Math.floor(rand() * 3)],
        intent_reason: "kelly * 0.4, capped at $75",
      },
    };
  });
  return {
    positions,
    pagination: { total, limit, offset, has_more: offset + count < total },
  };
}

function mockTrades(
  rand: () => number,
  query?: Record<string, string | number | undefined>,
): TradesResponse {
  const limit = Number(query?.limit ?? 50);
  const offset = Number(query?.offset ?? 0);
  const total = 142;
  const count = Math.min(limit, Math.max(0, total - offset));
  const trades = Array.from({ length: count }).map<Trade>((_, i) => {
    const idx = offset + i;
    const won = rand() > 0.45;
    const entry = round(0.05 + rand() * 0.6, 3);
    const size = 10 + Math.floor(rand() * 40);
    const shares = size / Math.max(entry, 0.001);
    const direction: Direction = rand() > 0.5 ? "YES" : "NO";
    const marketId = `mkt-${idx % 12}`;
    const outcome: Outcome = idx < 4 ? "pending" : won ? "won" : "lost";
    const pnl =
      outcome === "pending"
        ? null
        : won
          ? round((1 - entry) * shares, 2)
          : round(-entry * shares, 2);
    return {
      id: 2000 + idx,
      timestamp: new Date(Date.now() - idx * 3 * 3600_000).toISOString(),
      strategy: "weather",
      market_id: marketId,
      market_question: `Mock market ${idx}`,
      direction,
      entry_price: entry,
      size_usd: size,
      shares: round(shares, 4),
      edge_at_entry: round(0.04 + rand() * 0.1, 3),
      outcome,
      pnl,
      city: CITIES[idx % CITIES.length],
      bucket: BUCKETS[idx % BUCKETS.length],
      metadata: {
        token_id: `mock-${marketId}-${direction}`,
        forecast_temp: 60 + Math.floor(rand() * 30),
        forecast_unit: "fahrenheit",
        agreement_score: round(0.4 + rand() * 0.5, 2),
        volume_tier: ["low", "med", "high"][Math.floor(rand() * 3)],
        intent_reason: "kelly * 0.4, capped at $75",
      },
    };
  });
  return {
    trades,
    pagination: { total, limit, offset, has_more: offset + count < total },
  };
}

function round(n: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}
