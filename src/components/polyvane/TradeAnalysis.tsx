import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  useEndpoint,
  type Trade,
  type TradesResponse,
} from "./hooks/usePolyvaneAPI";
import { usePolling } from "./hooks/usePolling";
import { Skeleton, EmptyState, ErrorState } from "./Panel";

const POSITIVE = "#5fb87c";
const NEGATIVE = "#e0625e";

type GroupKey = "city" | "bucket" | "volume_tier";

const GROUPS: { label: string; value: GroupKey }[] = [
  { label: "City", value: "city" },
  { label: "Bucket", value: "bucket" },
  { label: "Volume tier", value: "volume_tier" },
];

const GROUP_HEADER: Record<GroupKey, string> = {
  city: "City",
  bucket: "Bucket",
  volume_tier: "Volume tier",
};

interface GroupRow {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  open: number;
  win_rate: number;
  avg_edge: number;
  total_pnl: number;
}

export function TradeAnalysis() {
  const [groupBy, setGroupBy] = useState<GroupKey>("city");
  const endpoint = useEndpoint<TradesResponse>("/trades", {
    limit: 500,
    offset: 0,
  });
  usePolling(endpoint.fetch, { intervalMs: 60_000 });

  return (
    <section className="pv-section" id="analysis">
      <div className="pv-section-head">
        <h2 className="pv-section-title">Trade analysis</h2>
        <div className="pv-tabs" role="tablist">
          {GROUPS.map((g) => (
            <button
              key={g.value}
              role="tab"
              aria-selected={groupBy === g.value}
              className={`pv-tab${groupBy === g.value ? " pv-tab--active" : ""}`}
              onClick={() => setGroupBy(g.value)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <Body state={endpoint} groupBy={groupBy} />
    </section>
  );
}

function Body({
  state,
  groupBy,
}: {
  state: ReturnType<typeof useEndpoint<TradesResponse>>;
  groupBy: GroupKey;
}) {
  const rows = useMemo(
    () => aggregate(state.data?.trades ?? [], groupBy),
    [state.data, groupBy],
  );

  if (state.error) return <ErrorState message={state.error.message} />;
  if (state.loading && !state.data) return <Skeleton height={280} />;
  if (rows.length === 0) return <EmptyState message="No trades to analyze yet" />;

  const sorted = [...rows].sort((a, b) => b.total_pnl - a.total_pnl);

  return (
    <>
      <ResponsiveContainer width="100%" height={Math.max(180, sorted.length * 32)}>
        <BarChart
          data={sorted}
          layout="vertical"
          margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
        >
          <XAxis
            type="number"
            stroke="#666"
            tick={{ fontSize: 11, fill: "#888" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v}`}
          />
          <YAxis
            type="category"
            dataKey="key"
            stroke="#666"
            tick={{ fontSize: 12, fill: "#bbb" }}
            axisLine={false}
            tickLine={false}
            width={80}
          />
          <Tooltip
            cursor={{ fill: "#222" }}
            contentStyle={{
              backgroundColor: "#292929",
              border: "none",
              borderRadius: 6,
              fontSize: 12,
              color: "#e0e0e0",
            }}
            formatter={(v: number) => [`$${v.toFixed(2)}`, "P&L"]}
          />
          <Bar dataKey="total_pnl" radius={[0, 2, 2, 0]}>
            {sorted.map((r, i) => (
              <Cell key={i} fill={r.total_pnl >= 0 ? POSITIVE : NEGATIVE} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <div className="pv-table-wrap" style={{ marginTop: 16 }}>
        <table className="pv-table">
          <thead>
            <tr>
              <th className="pv-th">{GROUP_HEADER[groupBy]}</th>
              <th className="pv-th pv-th--right">Trades</th>
              <th className="pv-th pv-th--right">W / L</th>
              <th className="pv-th pv-th--right">Win rate</th>
              <th className="pv-th pv-th--right">Avg edge</th>
              <th className="pv-th pv-th--right">P&L</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const lowWR = r.win_rate < 0.5;
              return (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td className="pv-num">{r.trades}</td>
                  <td className="pv-num pv-dim">
                    {r.wins} / {r.losses}
                  </td>
                  <td className={`pv-num ${lowWR ? "pv-warn" : ""}`}>
                    {(r.win_rate * 100).toFixed(1)}%
                  </td>
                  <td className="pv-num">{(r.avg_edge * 100).toFixed(1)}%</td>
                  <td className={`pv-num ${r.total_pnl >= 0 ? "pv-pos" : "pv-neg"}`}>
                    {r.total_pnl >= 0 ? "+" : ""}${r.total_pnl.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function groupValue(t: Trade, groupBy: GroupKey): string {
  if (groupBy === "volume_tier") {
    const v = t.metadata?.volume_tier;
    return typeof v === "string" ? v : "—";
  }
  return t[groupBy] ?? "—";
}

function aggregate(trades: Trade[], groupBy: GroupKey): GroupRow[] {
  const map = new Map<string, GroupRow & { _edgeSum: number }>();
  for (const t of trades) {
    const key = groupValue(t, groupBy);
    let row = map.get(key);
    if (!row) {
      row = {
        key,
        trades: 0,
        wins: 0,
        losses: 0,
        open: 0,
        win_rate: 0,
        avg_edge: 0,
        total_pnl: 0,
        _edgeSum: 0,
      };
      map.set(key, row);
    }
    row.trades += 1;
    row.total_pnl += t.pnl ?? 0;
    row._edgeSum += t.edge_at_entry;
    if (t.outcome === "won") row.wins += 1;
    else if (t.outcome === "lost") row.losses += 1;
    else row.open += 1;
  }
  return Array.from(map.values()).map((r) => {
    const decided = r.wins + r.losses;
    return {
      key: r.key,
      trades: r.trades,
      wins: r.wins,
      losses: r.losses,
      open: r.open,
      win_rate: decided > 0 ? r.wins / decided : 0,
      avg_edge: r.trades > 0 ? r._edgeSum / r.trades : 0,
      total_pnl: round2(r.total_pnl),
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
