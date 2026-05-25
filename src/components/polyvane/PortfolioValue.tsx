import { useMemo, useState } from "react";
import { Liveline } from "liveline";
import {
  useEndpoint,
  tokenIdOf,
  type PositionsResponse,
  type Window,
} from "./hooks/usePolyvaneAPI";
import { usePolling } from "./hooks/usePolling";
import {
  intervalForWindowSecs,
  usePolymarketHistories,
  usePolymarketPrices,
  type PricePoint,
} from "./hooks/usePolymarket";
import { Skeleton, ErrorState } from "./Panel";

const WINDOWS: { label: string; value: Window; secs: number }[] = [
  { label: "24h", value: "24h", secs: 24 * 3600 },
  { label: "7d", value: "7d", secs: 7 * 86400 },
  { label: "30d", value: "30d", secs: 30 * 86400 },
  { label: "All", value: "all", secs: 90 * 86400 },
];

type Strategy = "all" | "lazy" | "weather";

const STRATEGIES: { label: string; value: Strategy }[] = [
  { label: "All", value: "all" },
  { label: "Lazy", value: "lazy" },
  { label: "Weather", value: "weather" },
];

const POSITIVE = "#5fb87c";
const NEGATIVE = "#e0625e";
const SAMPLES = 80;

const WINDOW_LABEL: Record<Window, string> = {
  "24h": "Past 24h",
  "7d": "Past 7 days",
  "30d": "Past 30 days",
  all: "All time",
};

export function PortfolioValue() {
  const [window, setWindow] = useState<Window>("7d");
  const [strategy, setStrategy] = useState<Strategy>("all");
  const windowSecs = WINDOWS.find((w) => w.value === window)?.secs ?? 7 * 86400;

  // Bare-minimum from the bot API: what was traded, at what price, in what
  // size. Everything downstream is derived from Polymarket.
  const open = useEndpoint<PositionsResponse>("/positions", {
    status: "open",
    limit: 200,
  });
  const resolved = useEndpoint<PositionsResponse>("/positions", {
    status: "resolved",
    limit: 500,
  });
  usePolling(open.fetch, { intervalMs: 30_000 });
  usePolling(resolved.fetch, { intervalMs: 120_000 });

  const openPositions = open.data?.positions ?? [];
  const resolvedPositions = resolved.data?.positions ?? [];

  // Strategy filter — applied client-side so we avoid redundant API round-trips.
  const filteredOpen = useMemo(
    () => (strategy === "all" ? openPositions : openPositions.filter((p) => p.strategy === strategy)),
    [openPositions, strategy],
  );
  const filteredResolved = useMemo(
    () =>
      strategy === "all" ? resolvedPositions : resolvedPositions.filter((p) => p.strategy === strategy),
    [resolvedPositions, strategy],
  );

  const tokenIds = useMemo(
    () =>
      filteredOpen
        .map((p) => tokenIdOf(p))
        .filter((t): t is string => typeof t === "string"),
    [filteredOpen],
  );
  const { interval, fidelityMinutes } = intervalForWindowSecs(windowSecs);
  const { histories } = usePolymarketHistories(tokenIds, interval, fidelityMinutes);
  const { prices: livePrices, lastUpdated: liveAt } = usePolymarketPrices(tokenIds);

  const {
    points,
    currentValue,
    pnlChange,
    pnlBasis,
    deployedNow,
    lineColor,
    positive,
  } = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - windowSecs;
    const step = windowSecs / SAMPLES;

    // Two parallel series:
    //   value(t)  = mark-to-market of open positions + realized P&L bank
    //               — Robinhood "Total" line. Baseline is the deployed capital
    //               so the chart never drops to $0 for pre-window positions.
    //   pnl(t)    = Σ unrealized on positions open at t + Σ realized on
    //               positions closed by t. Capital deployment is a no-op for
    //               this series; only price movement and realizations move it.
    const series: { time: number; value: number }[] = [];
    const pnlSeries: number[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const t = Math.floor(startSec + i * step);
      let holdings = 0;
      let unrealized = 0;

      // Currently-open positions.
      for (const p of filteredOpen) {
        const openedSec = isoToSec(p.opened_at);
        const tokenId = tokenIdOf(p);
        if (openedSec !== null && t >= openedSec) {
          const price = tokenId ? priceAt(histories[tokenId], t) : null;
          const ref = price ?? p.entry_price;
          holdings += ref * p.shares;
          unrealized += (ref - p.entry_price) * p.shares;
        } else {
          // Position not yet open at t — hold cost basis as the baseline so the
          // chart starts at deployed capital rather than $0.
          holdings += p.size_usd;
        }
      }

      // Resolved positions: track their holdings while they were active so
      // wins/losses appear as a step at resolution rather than a jump from $0.
      for (const c of filteredResolved) {
        const openedSec = isoToSec(c.opened_at);
        const closedSec = isoToSec(c.resolved_at ?? null);
        if (openedSec === null) continue;
        if (t >= openedSec && (closedSec === null || t < closedSec)) {
          // Active during this sample: mark at entry price (history unavailable
          // for resolved tokens; entry gives a stable baseline pre-resolution).
          holdings += c.entry_price * c.shares;
          // unrealized stays 0 — price movement shows up at the resolution step.
        }
      }

      let realized = 0;
      for (const c of filteredResolved) {
        const closedSec = isoToSec(c.resolved_at ?? null);
        const pnl = c.pnl ?? null;
        if (closedSec !== null && pnl !== null && t >= closedSec) realized += pnl;
      }
      series.push({ time: t, value: round(holdings + realized, 2) });
      pnlSeries.push(unrealized + realized);
    }

    // Snap the trailing point to "now" using live CLOB midpoints — this is
    // what keeps the Liveline tip pulsing as Polymarket prices tick.
    let liveHoldings = 0;
    let liveUnrealized = 0;
    for (const p of filteredOpen) {
      const tokenId = tokenIdOf(p);
      const live = tokenId ? livePrices[tokenId] : undefined;
      const fallback = tokenId ? priceAt(histories[tokenId], nowSec) : null;
      const ref = live ?? fallback ?? p.entry_price;
      liveHoldings += ref * p.shares;
      liveUnrealized += (ref - p.entry_price) * p.shares;
    }
    const liveRealized = filteredResolved.reduce(
      (acc, c) => acc + (c.pnl ?? 0),
      0,
    );
    const liveValue = round(liveHoldings + liveRealized, 2);
    const livePnl = liveUnrealized + liveRealized;
    if (series.length > 0) {
      series[series.length - 1] = { time: nowSec, value: liveValue };
      pnlSeries[pnlSeries.length - 1] = livePnl;
    }

    const cur = series[series.length - 1]?.value ?? 0;
    const startPnl = pnlSeries[0] ?? 0;
    const change = livePnl - startPnl;
    // Percentage denominator: cost basis at window start, falling back to
    // current deployed capital — gives "% return on the capital actually at
    // work over the window."
    const deployed = filteredOpen.reduce((acc, p) => acc + p.size_usd, 0);
    const startValue = series[0]?.value ?? 0;
    const basis = Math.max(startValue - startPnl, deployed);
    const isUp = change >= 0;
    return {
      points: series,
      currentValue: cur,
      pnlChange: change,
      pnlBasis: basis,
      deployedNow: deployed,
      lineColor: isUp ? POSITIVE : NEGATIVE,
      positive: isUp,
    };
    // liveAt threads the polled midpoint refresh through the memo so the
    // trailing live point re-renders on every Polymarket tick.
  }, [filteredOpen, filteredResolved, histories, livePrices, liveAt, windowSecs]);

  const change = pnlChange;
  const changePct = pnlBasis > 0 ? (change / pnlBasis) * 100 : 0;

  const error = open.error ?? resolved.error;
  if (error) {
    return (
      <section className="pv-section">
        <ErrorState message={`Couldn't load portfolio: ${error.message}`} />
      </section>
    );
  }

  const loading = open.loading && !open.data;

  return (
    <section className="pv-section" id="portfolio">
      <div className="pv-portfolio-heading">
        <div className="pv-portfolio-headline">
          <h2 className="pv-section-title">Portfolio value</h2>
          {loading ? (
            <Skeleton height={48} />
          ) : (
            <span className="pv-portfolio-value">{formatUSD(currentValue)}</span>
          )}
          {!loading ? (
            <div className="pv-portfolio-change">
              <span className={positive ? "pv-pos" : "pv-neg"}>
                {positive ? "+" : "−"}
                {formatUSD(Math.abs(change))} ({positive ? "+" : "−"}
                {Math.abs(changePct).toFixed(2)}%)
              </span>
              <span className="pv-portfolio-change-window">{WINDOW_LABEL[window]}</span>
              <span className="pv-portfolio-change-window">
                · {formatUSD(deployedNow)} deployed
              </span>
            </div>
          ) : null}
        </div>
        <div className="pv-portfolio-tabs">
          <div className="pv-tabs" role="tablist" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                role="tab"
                aria-selected={window === w.value}
                className={`pv-tab${window === w.value ? " pv-tab--active" : ""}`}
                onClick={() => setWindow(w.value)}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="pv-tabs pv-tabs--strategy" role="tablist" aria-label="Strategy">
        {STRATEGIES.map((s) => (
          <button
            key={s.value}
            role="tab"
            aria-selected={strategy === s.value}
            className={`pv-tab pv-tab--strategy${strategy === s.value ? " pv-tab--active" : ""}`}
            onClick={() => setStrategy(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="pv-portfolio-chart">
        <Liveline
          data={points}
          value={currentValue}
          theme="dark"
          color={lineColor}
          window={windowSecs}
          grid={true}
          badge={false}
          showValue={false}
          momentum={false}
          fill={true}
          lineWidth={1.5}
          emptyText="No portfolio data yet"
          formatValue={(v) => formatUSD(v)}
          style={{ width: "100%", height: 220 }}
        />
      </div>
    </section>
  );
}

function priceAt(history: PricePoint[] | undefined, t: number): number | null {
  if (!history || history.length === 0) return null;
  if (t < history[0].t) return null;
  if (t >= history[history.length - 1].t) return history[history.length - 1].p;
  // history is ascending by t; binary search for the most recent point <= t.
  let lo = 0;
  let hi = history.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (history[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return history[lo].p;
}

function isoToSec(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function formatUSD(v: number): string {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function round(n: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}
