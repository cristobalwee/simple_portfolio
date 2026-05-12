import { useMemo } from "react";
import {
  useEndpoint,
  tokenIdOf,
  type Position,
  type PositionsResponse,
} from "./hooks/usePolyvaneAPI";
import { usePolling } from "./hooks/usePolling";
import { usePolymarketPrices, type PriceMap } from "./hooks/usePolymarket";
import { Skeleton, EmptyState, ErrorState } from "./Panel";

export function OpenPositions() {
  const endpoint = useEndpoint<PositionsResponse>("/positions", {
    status: "open",
    limit: 200,
  });
  usePolling(endpoint.fetch, { intervalMs: 30_000 });

  const positions = endpoint.data?.positions ?? [];
  const tokenIds = useMemo(
    () =>
      positions
        .map((p) => tokenIdOf(p))
        .filter((t): t is string => typeof t === "string"),
    [positions],
  );
  const { prices } = usePolymarketPrices(tokenIds);

  return (
    <section className="pv-section" id="positions">
      <div className="pv-section-head">
        <h2 className="pv-section-title">Open positions</h2>
        {endpoint.data ? (
          <span className="pv-dim" style={{ fontSize: 12 }}>
            {endpoint.data.pagination.total} active
          </span>
        ) : null}
      </div>
      <Body
        loading={endpoint.loading && !endpoint.data}
        error={endpoint.error?.message ?? null}
        positions={positions}
        prices={prices}
      />
    </section>
  );
}

function Body({
  loading,
  error,
  positions,
  prices,
}: {
  loading: boolean;
  error: string | null;
  positions: Position[];
  prices: PriceMap;
}) {
  if (error) return <ErrorState message={error} />;
  if (loading) return <Skeleton height={120} />;
  if (positions.length === 0)
    return <EmptyState message="No open positions — bot is scanning" />;

  return (
    <div className="pv-positions-grid">
      {positions.map((p) => {
        const tokenId = tokenIdOf(p);
        const live = tokenId ? prices[tokenId] : undefined;
        return <PositionCard key={p.id} position={p} livePrice={live} />;
      })}
    </div>
  );
}

function PositionCard({
  position: p,
  livePrice,
}: {
  position: Position;
  livePrice: number | undefined;
}) {
  // P&L = (current - entry) * shares. Fall back to entry until Polymarket
  // responds so the card reads $0 instead of flashing a stale figure.
  const current = livePrice ?? p.entry_price;
  const unrealized = (current - p.entry_price) * p.shares;
  const positive = unrealized >= 0;
  const haveLive = livePrice !== undefined;
  const city = p.city ?? "—";
  const bucket = p.bucket ?? p.market_question ?? p.market_id;
  return (
    <article className="pv-position-card">
      <header className="pv-position-head">
        <div>
          <div className="pv-position-city">
            <span>{city}</span>
            <span className={`pv-side pv-side--${p.direction.toLowerCase()}`}>
              {p.direction}
            </span>
          </div>
          <div className="pv-position-bucket">{bucket}</div>
        </div>
        <div className={`pv-position-pnl ${positive ? "pv-pos" : "pv-neg"}`}>
          {positive ? "+" : ""}${unrealized.toFixed(2)}
        </div>
      </header>

      <div className="pv-position-meta">
        <Cell label="Entry" value={p.entry_price.toFixed(3)} />
        <Cell label="Now" value={haveLive ? current.toFixed(3) : "…"} />
        <Cell label="Size" value={`$${p.size_usd.toFixed(0)}`} />
        <Cell label="Edge" value={`${(p.edge_at_entry * 100).toFixed(1)}%`} />
        <Cell label="Held" value={timeAgo(p.opened_at)} />
      </div>
    </article>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="pv-position-meta-cell">
      <span className="pv-position-meta-label">{label}</span>
      <span className="pv-position-meta-value">{value}</span>
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
