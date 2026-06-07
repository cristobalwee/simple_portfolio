import type { BotStatus, ConnectionState } from "./hooks/usePolyvaneAPI";

interface StatusBarProps {
  status: BotStatus | null;
  connection: ConnectionState;
  loading: boolean;
}

export function StatusBar({ status, connection }: StatusBarProps) {
  return (
    <header className="pv-statusbar">
      <div className="pv-brand">
        <span className="pv-brand-name">PolyVane</span>
      </div>

      <div className="pv-conn">
        <span className={`pv-dot pv-dot--${connection}`} aria-hidden="true" />
        <span className="pv-conn-label">
          {connection === "connected" && "Connected"}
          {connection === "degraded" && "Degraded"}
          {connection === "disconnected" && "Disconnected"}
        </span>
      </div>
    </header>
  );
}
