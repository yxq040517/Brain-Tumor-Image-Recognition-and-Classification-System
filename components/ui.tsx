import { AlertCircle, LoaderCircle, ScanLine } from "lucide-react";
import type { ReactNode } from "react";

export function Notice({
  children,
  tone = "warning",
}: {
  children: ReactNode;
  tone?: "warning" | "error" | "info";
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <AlertCircle size={18} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

export function Loading({ children = "正在读取本地数据…" }: { children?: ReactNode }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle size={22} className="spin" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({ title }: { title: string }) {
  return (
    <div className="empty-state">
      <div className="empty-art" aria-hidden="true">
        <span />
        <ScanLine size={32} />
        <span />
      </div>
      <h3>{title}</h3>
    </div>
  );
}

export const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
export const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
