import { Fragment, useMemo, useState } from "react";
import {
  useEndpoint,
  type Trade,
  type TradesResponse,
  type Outcome,
} from "./hooks/usePolyvaneAPI";
import { usePolling } from "./hooks/usePolling";
import { Skeleton, EmptyState, ErrorState } from "./Panel";

const PAGE = 25;

type SortKey =
  | "timestamp"
  | "city"
  | "bucket"
  | "direction"
  | "entry_price"
  | "outcome"
  | "pnl"
  | "edge_at_entry"
  | "forecast_temp";
type SortDir = "asc" | "desc";

export function TradeJournal() {
  const [page, setPage] = useState(0);
  const endpoint = useEndpoint<TradesResponse>("/trades", {
    limit: PAGE,
    offset: page * PAGE,
  });
  usePolling(endpoint.fetch, { intervalMs: 60_000 });

  const [cityFilter, setCityFilter] = useState<string>("all");
  const [outcomeFilter, setOutcomeFilter] = useState<Outcome | "all">("all");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("timestamp");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<number | null>(null);

  const items = endpoint.data?.trades ?? [];
  const total = endpoint.data?.pagination.total ?? 0;

  const cities = useMemo(
    () =>
      Array.from(
        new Set(items.map((t) => t.city).filter((c): c is string => !!c)),
      ).sort(),
    [items],
  );

  const filtered = useMemo(() => {
    let rows = items;
    if (cityFilter !== "all") rows = rows.filter((t) => t.city === cityFilter);
    if (outcomeFilter !== "all")
      rows = rows.filter((t) => t.outcome === outcomeFilter);
    if (from) {
      const fromMs = new Date(from).getTime();
      rows = rows.filter((t) => new Date(t.timestamp).getTime() >= fromMs);
    }
    if (to) {
      const toMs = new Date(to).getTime() + 86_400_000;
      rows = rows.filter((t) => new Date(t.timestamp).getTime() < toMs);
    }
    rows = [...rows].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (typeof va === "number" && typeof vb === "number") {
        return sortDir === "asc" ? va - vb : vb - va;
      }
      return sortDir === "asc"
        ? String(va ?? "").localeCompare(String(vb ?? ""))
        : String(vb ?? "").localeCompare(String(va ?? ""));
    });
    return rows;
  }, [items, cityFilter, outcomeFilter, from, to, sortKey, sortDir]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const exportCSV = () => {
    const headers = [
      "timestamp",
      "city",
      "market_id",
      "bucket",
      "direction",
      "entry_price",
      "outcome",
      "pnl",
      "edge_at_entry",
      "forecast_temp",
      "agreement_score",
      "volume_tier",
    ];
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const valueFor = (t: Trade, h: string): unknown => {
      switch (h) {
        case "forecast_temp":
          return t.metadata?.forecast_temp;
        case "agreement_score":
          return t.metadata?.agreement_score;
        case "volume_tier":
          return t.metadata?.volume_tier;
        default:
          return (t as unknown as Record<string, unknown>)[h];
      }
    };
    const rows = filtered
      .map((t) => headers.map((h) => escape(valueFor(t, h))).join(","))
      .join("\n");
    const csv = headers.join(",") + "\n" + rows;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polyvane-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <section className="pv-section" id="trades">
      <div className="pv-section-head">
        <h2 className="pv-section-title">Trade journal</h2>
        <div className="pv-section-actions">
          <span className="pv-dim" style={{ fontSize: 12 }}>
            {total} total
          </span>
          <button className="pv-btn" onClick={exportCSV} disabled={filtered.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      <div className="pv-filter-row">
        <Select
          label="City"
          value={cityFilter}
          onChange={setCityFilter}
          options={[
            { label: "All cities", value: "all" },
            ...cities.map((c) => ({ label: c, value: c })),
          ]}
        />
        <Select<Outcome | "all">
          label="Outcome"
          value={outcomeFilter}
          onChange={setOutcomeFilter}
          options={[
            { label: "All", value: "all" },
            { label: "Won", value: "won" },
            { label: "Lost", value: "lost" },
            { label: "Pending", value: "pending" },
          ]}
        />
        <DateInput label="From" value={from} onChange={setFrom} />
        <DateInput label="To" value={to} onChange={setTo} />
      </div>

      {endpoint.error ? (
        <ErrorState message={endpoint.error.message} />
      ) : endpoint.loading && !endpoint.data ? (
        <Skeleton height={280} />
      ) : filtered.length === 0 ? (
        <EmptyState message="No trades match these filters" />
      ) : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th className="pv-th" style={{ width: 24 }} />
                <Th k="timestamp" label="When" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <Th k="city" label="City" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <Th k="bucket" label="Bucket" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <Th k="direction" label="Side" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <Th k="entry_price" label="Entry" align="right" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <Th k="outcome" label="Outcome" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <Th k="pnl" label="P&L" align="right" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <Th k="edge_at_entry" label="Edge" align="right" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
                <Th k="forecast_temp" label="Fcst °F" align="right" sortKey={sortKey} sortDir={sortDir} onClick={onSort} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const open = expanded === t.id;
                const pnl = t.pnl ?? null;
                const fcst = t.metadata?.forecast_temp;
                return (
                  <Fragment key={t.id}>
                    <tr>
                      <td className="pv-expand-cell">
                        <button
                          className="pv-expand-btn"
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : t.id)}
                        >
                          {open ? "−" : "+"}
                        </button>
                      </td>
                      <td className="pv-dim pv-mono">
                        {new Date(t.timestamp).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td>{t.city ?? "—"}</td>
                      <td className="pv-mono">{t.bucket ?? "—"}</td>
                      <td>
                        <span className={`pv-side pv-side--${t.direction.toLowerCase()}`}>
                          {t.direction}
                        </span>
                      </td>
                      <td className="pv-num">{t.entry_price.toFixed(3)}</td>
                      <td>
                        <span className={`pv-outcome pv-outcome--${t.outcome}`}>
                          {t.outcome}
                        </span>
                      </td>
                      <td className={`pv-num ${pnl == null ? "pv-dim" : pnl >= 0 ? "pv-pos" : "pv-neg"}`}>
                        {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
                      </td>
                      <td className="pv-num">{(t.edge_at_entry * 100).toFixed(1)}%</td>
                      <td className="pv-num pv-dim">
                        {typeof fcst === "number" ? fcst.toFixed(1) : "—"}
                      </td>
                    </tr>
                    {open ? (
                      <tr className="pv-meta-row">
                        <td colSpan={10}>
                          <div className="pv-meta-grid">
                            <MetaCell label="Market">{t.market_id}</MetaCell>
                            <MetaCell label="Question">
                              {t.market_question ?? "—"}
                            </MetaCell>
                            <MetaCell label="Agreement">
                              {typeof t.metadata?.agreement_score === "number"
                                ? t.metadata.agreement_score.toFixed(2)
                                : "—"}
                            </MetaCell>
                            <MetaCell label="Volume tier">
                              {(t.metadata?.volume_tier as string | undefined) ?? "—"}
                            </MetaCell>
                            <MetaCell label="Rationale">
                              {(t.metadata?.intent_reason as string | undefined) ?? "—"}
                            </MetaCell>
                            <MetaCell label="Size / shares">
                              ${t.size_usd.toFixed(2)} / {t.shares.toFixed(2)}
                            </MetaCell>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="pv-pagination">
        <button
          className="pv-pg-btn"
          disabled={page === 0}
          onClick={() => setPage(Math.max(0, page - 1))}
        >
          ← Prev
        </button>
        <span className="pv-pg-label">
          Page {page + 1} of {totalPages}
        </span>
        <button
          className="pv-pg-btn"
          disabled={page >= totalPages - 1}
          onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
        >
          Next →
        </button>
      </div>
    </section>
  );
}

function sortValue(t: Trade, k: SortKey): number | string | null | undefined {
  switch (k) {
    case "forecast_temp":
      return typeof t.metadata?.forecast_temp === "number"
        ? t.metadata.forecast_temp
        : null;
    case "pnl":
      return t.pnl ?? null;
    default:
      return (t as unknown as Record<string, number | string | null>)[k];
  }
}

function Th({
  k,
  label,
  align,
  sortKey,
  sortDir,
  onClick,
}: {
  k: SortKey;
  label: string;
  align?: "right";
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <th
      className={`pv-th${align === "right" ? " pv-th--right" : ""}${active ? " pv-th--active" : ""}`}
      onClick={() => onClick(k)}
    >
      {label}
      {active ? <span className="pv-sort-arrow">{sortDir === "asc" ? "↑" : "↓"}</span> : null}
    </th>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { label: string; value: T }[];
}) {
  return (
    <label className="pv-input">
      <span className="pv-input-label">{label}</span>
      <select
        className="pv-select"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="pv-input">
      <span className="pv-input-label">{label}</span>
      <input
        type="date"
        className="pv-date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function MetaCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pv-meta-cell">
      <div className="pv-meta-label">{label}</div>
      <div className="pv-meta-value">{children}</div>
    </div>
  );
}
