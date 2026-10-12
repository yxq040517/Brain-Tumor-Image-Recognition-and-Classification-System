"use client";

import { CalendarDays, CheckCheck, Clock3, Files, ListChecks } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { LABELS, type Stats, type TrendPoint } from "@/lib/types";
import { Loading, Notice, numberFormatter } from "./ui";

function completeTrend(points: TrendPoint[], days: 7 | 30): TrendPoint[] {
  const entries = new Map(points.map((point) => [point.date, point]));
  const latest = points.reduce((date, point) => (point.date > date ? point.date : date), "");
  const end = latest ? new Date(`${latest}T12:00:00`) : new Date();
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setDate(date.getDate() - days + index + 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return entries.get(key) ?? { date: key, count: 0, mean_inference_ms: null };
  });
}

function TrendChart({ points, latency = false }: { points: TrendPoint[]; latency?: boolean }) {
  const width = 640;
  const height = 210;
  const left = 58;
  const right = 16;
  const top = 18;
  const bottom = 40;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const values = points.map((point) => (latency ? point.mean_inference_ms : point.count));
  const max = Math.max(1, ...values.filter((value): value is number => value !== null));
  const step = chartWidth / points.length;
  const x = (index: number) => left + step * (index + 0.5);
  const y = (value: number) => top + chartHeight * (1 - value / max);
  const paths: string[] = [];
  let path = "";
  if (latency) {
    values.forEach((value, index) => {
      if (value === null) {
        if (path) paths.push(path);
        path = "";
      } else path += `${path ? " L" : "M"}${x(index)},${y(value)}`;
    });
    if (path) paths.push(path);
  }
  const title = latency ? "每日平均推理耗时" : "每日分析数量";
  const dateIndices =
    points.length === 7 ? points.map((_, index) => index) : [0, 7, 14, 21, points.length - 1];
  return (
    <svg className="library-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <title>{title}</title>
      {[0, 0.5, 1].map((fraction) => (
        <g key={fraction}>
          <line
            x1={left}
            x2={width - right}
            y1={y(max * fraction)}
            y2={y(max * fraction)}
            className="library-chart-grid"
          />
          <text x={left - 10} y={y(max * fraction) + 4} textAnchor="end">
            {numberFormatter.format(max * fraction)}
          </text>
        </g>
      ))}
      {latency &&
        paths.map((segment) => (
          <path key={segment} d={segment} fill="none" className="library-chart-line" />
        ))}
      {points.map((point, index) => {
        const value = values[index];
        const description = `${point.date}：${value === null ? "无推理数据" : `${numberFormatter.format(value)}${latency ? " ms" : " 张"}`}`;
        return (
          <g key={point.date} tabIndex={0} aria-label={description}>
            <title>{description}</title>
            {latency ? (
              value !== null && (
                <circle cx={x(index)} cy={y(value)} r={4} className="library-chart-dot" />
              )
            ) : (
              <rect
                x={x(index) - step * 0.32}
                y={y(point.count)}
                width={step * 0.64}
                height={(chartHeight * point.count) / max}
                rx={3}
                className="library-chart-bar"
              />
            )}
            <rect
              x={left + step * index}
              y={top}
              width={step}
              height={chartHeight}
              fill="transparent"
            />
          </g>
        );
      })}
      {dateIndices.map((index) => (
        <text key={points[index].date} x={x(index)} y={height - 14} textAnchor="middle">
          {points[index].date.slice(5).replace("-", "/")}
        </text>
      ))}
      <text x={left} y={height - 1}>
        {latency ? "ms" : "张"}
      </text>
    </svg>
  );
}

export function OverviewPanel({ revision }: { revision: number }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [days, setDays] = useState<7 | 30>(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .stats(days)
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取数据概览。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision, refresh, days]);

  const trend = stats ? completeTrend(stats.trend, days) : [];
  const distributionTotal = stats?.distribution.reduce((total, item) => total + item.count, 0) ?? 0;
  const maxLatency = Math.max(1, ...(stats?.latency.map((bucket) => bucket.count) ?? []));

  return (
    <div className="library-overview">
      <div className="library-heading">
        <h2>数据概览</h2>
        <fieldset className="library-view-switch" aria-label="统计时间范围">
          {([7, 30] as const).map((value) => (
            <button
              type="button"
              className="button button-secondary"
              key={value}
              aria-pressed={days === value}
              onClick={() => setDays(value)}
            >
              {value} 天
            </button>
          ))}
        </fieldset>
      </div>
      {error ? (
        <section className="card library-status">
          <Notice tone="error">{error}</Notice>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setRefresh((value) => value + 1)}
          >
            重新加载
          </button>
        </section>
      ) : loading || !stats ? (
        <section className="card">
          <Loading />
        </section>
      ) : (
        <>
          <div className="library-stat-grid">
            {[
              { name: "累计分析", value: stats.total, unit: "张", icon: Files },
              { name: "今日分析", value: stats.today, unit: "张", icon: CalendarDays },
              { name: "待复核", value: stats.pending, unit: "张", icon: ListChecks },
              { name: "已复核", value: stats.reviewed, unit: "张", icon: CheckCheck },
              { name: "平均推理耗时", value: stats.mean_inference_ms, unit: "ms", icon: Clock3 },
            ].map((metric) => (
              <div className="card library-stat-card" key={metric.name}>
                <metric.icon size={21} aria-hidden="true" />
                <span>{metric.name}</span>
                <strong>
                  {metric.value === null ? "—" : numberFormatter.format(metric.value)}
                  <span>{metric.unit}</span>
                </strong>
              </div>
            ))}
          </div>
          <div className="library-chart-grid-layout">
            <section className="card library-chart-card">
              <h3>每日分析数量</h3>
              <TrendChart points={trend} />
            </section>
            <section className="card library-chart-card">
              <h3>平均耗时趋势</h3>
              <TrendChart points={trend} latency />
            </section>
            <section className="card library-chart-card">
              <h3>分类分布</h3>
              <div className="library-distribution">
                {stats.distribution.map((item) => {
                  const percent = distributionTotal ? (item.count / distributionTotal) * 100 : 0;
                  return (
                    <div
                      key={item.label}
                      title={`${LABELS[item.label].name}：${item.count} 张（${percent.toFixed(1)}%）`}
                    >
                      <div className="library-distribution-heading">
                        <span>
                          <i style={{ background: LABELS[item.label].color }} />
                          {LABELS[item.label].name}
                        </span>
                        <strong>
                          {numberFormatter.format(item.count)} 张 · {percent.toFixed(1)}%
                        </strong>
                      </div>
                      <div
                        className="library-meter"
                        role="img"
                        aria-label={`${LABELS[item.label].name} ${item.count} 张`}
                      >
                        <span
                          style={{ width: `${percent}%`, background: LABELS[item.label].color }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="card library-chart-card">
              <h3>推理耗时分布</h3>
              <div className="library-histogram">
                {stats.latency.map((bucket) => (
                  <div
                    className="library-histogram-row"
                    key={bucket.name}
                    title={`${bucket.name}：${bucket.count} 张`}
                  >
                    <span>{bucket.name}</span>
                    <div
                      className="library-meter"
                      role="img"
                      aria-label={`${bucket.name} ${bucket.count} 张`}
                    >
                      <span style={{ width: `${(bucket.count / maxLatency) * 100}%` }} />
                    </div>
                    <strong>{numberFormatter.format(bucket.count)}</strong>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
