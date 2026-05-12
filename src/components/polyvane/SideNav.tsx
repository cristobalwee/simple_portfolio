import { useEffect, useState } from "react";

const SECTIONS = [
  { id: "portfolio", label: "Portfolio" },
  { id: "positions", label: "Positions" },
  { id: "trades", label: "Trades" },
  { id: "analysis", label: "Analysis" },
];

export function SideNav() {
  const [active, setActive] = useState<string>("portfolio");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length > 0) {
          setActive(visible[0].target.id);
        }
      },
      { rootMargin: "-30% 0px -50% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <nav className="pv-sidenav" aria-label="Dashboard sections">
      <a className="pv-sidenav-back" href="/">
        <span className="pv-sidenav-back-arrow">&#8617;</span>
        <span>Back</span>
      </a>
      <ul className="pv-sidenav-list">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className={`pv-sidenav-link${active === s.id ? " pv-sidenav-link--active" : ""}`}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
