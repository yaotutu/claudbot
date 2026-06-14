import type { ReactNode } from "react";

export function SidebarButton({ icon, label, badge = 0, onClick }: { icon: ReactNode; label: string; badge?: number; onClick: () => void }) {
  return (
    <button className="mb-1 flex h-9 w-full items-center gap-2 rounded-full px-3 text-sm hover:bg-sidebar-accent" aria-label={label} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {badge > 0 ? <span className="ml-auto min-w-5 rounded-full bg-foreground px-1.5 py-0.5 text-center text-[11px] font-medium leading-none text-background">{badge > 99 ? "99+" : badge}</span> : null}
    </button>
  );
}
