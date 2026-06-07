import { useMemo } from "react";
import {
  useEndpoint,
  type APIError,
  type BotStatus,
  type ConnectionState,
} from "./hooks/usePolyvaneAPI";
import { usePolling } from "./hooks/usePolling";
import { SideNav } from "./SideNav";
import { StatusBar } from "./StatusBar";
import { PortfolioValue } from "./PortfolioValue";
import { OpenPositions } from "./OpenPositions";
import { TradeJournal } from "./TradeJournal";
import { TradeAnalysis } from "./TradeAnalysis";

const STALE_MS = 90_000;

function deriveConnection(
  error: APIError | null,
  lastUpdated: number | null,
): ConnectionState {
  if (error && !lastUpdated) return "disconnected";
  if (error) return "degraded";
  if (lastUpdated && Date.now() - lastUpdated > STALE_MS) return "degraded";
  return "connected";
}

export function Dashboard() {
  const status = useEndpoint<BotStatus>("/status");
  usePolling(status.fetch, { intervalMs: 15_000 });

  const connection = useMemo(
    () => deriveConnection(status.error, status.lastUpdated),
    [status.error, status.lastUpdated],
  );

  return (
    <div className="pv-shell">
      <SideNav />

      <div className="pv-content">
        <StatusBar
          status={status.data}
          connection={connection}
          loading={status.loading && !status.data}
        />
        <PortfolioValue />
        <section className="pv-section pv-about" id="about">
          <h2 className="pv-section-title">About</h2>
          <p>
            PolyVane is a paper-trading bot that hunts mispricings in weather
            prediction markets. It pulls NWS and ECMWF forecasts for a handful
            of US cities, scores each daily temperature contract against an
            ensemble model, and opens YES/NO positions whenever the market's
            implied probability drifts far enough from its own. It started as a
            weekend script to test whether high-resolution forecasts could
            outrun consensus on next-day highs — once the first month of paper
            P&amp;L cleared, it grew into the full pipeline you see here, with
            per-trade edge tracking, Kelly-scaled sizing, and circuit breakers
            wired in.
          </p>
        </section>
        <OpenPositions />
        <TradeJournal />
        {/* <TradeAnalysis /> */}
      </div>
    </div>
  );
}

export default Dashboard;
