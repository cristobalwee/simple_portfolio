export function Skeleton({ height = 80 }: { height?: number }) {
  return <div className="pv-skeleton" style={{ height }} />;
}

export function EmptyState({ message }: { message: string }) {
  return <div className="pv-empty">{message}</div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="pv-error">{message}</div>;
}
