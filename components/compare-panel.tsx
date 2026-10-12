"use client";

import Image from "next/image";
import { type CSSProperties, useRef, useState } from "react";
import { api } from "@/lib/api";
import { type Analysis, LABELS, type TumorLabel } from "@/lib/types";
import { Notice, numberFormatter } from "./ui";

export function ComparePanel({
  records,
  busy = false,
  onUpdated,
  onOpen,
  onClose,
}: {
  records: Analysis[];
  busy?: boolean;
  onUpdated: (record: Analysis) => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  async function review(record: Analysis, value: string) {
    if (lock.current || busy) return;
    lock.current = true;
    setSaving(record.id);
    setError(null);
    try {
      onUpdated(
        await api.update(record.id, { reviewed_label: value ? (value as TumorLabel) : null }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "复核保存失败，请重试。");
    } finally {
      lock.current = false;
      setSaving(null);
    }
  }

  return (
    <div className="library-compare">
      <div className="library-dialog-heading">
        <h2 id="library-compare-title">影像对比</h2>
        <button
          type="button"
          className="button button-secondary"
          onClick={onClose}
          disabled={saving !== null}
        >
          关闭
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div
        className="library-compare-grid"
        style={{ "--compare-columns": records.length } as CSSProperties}
      >
        {records.map((record) => (
          <article className="library-compare-card" key={record.id}>
            <div className="library-compare-image">
              <Image
                src={record.image_url}
                alt={record.filename}
                width={record.width}
                height={record.height}
                unoptimized
              />
            </div>
            <h3 title={record.filename}>{record.filename}</h3>
            <dl className="library-details">
              <div>
                <dt>原始 AI</dt>
                <dd style={{ color: LABELS[record.predicted_label].color }}>
                  {LABELS[record.predicted_label].name}
                </dd>
              </div>
              <div>
                <dt>置信度</dt>
                <dd>{numberFormatter.format(record.confidence * 100)}%</dd>
              </div>
              <div>
                <dt>人工复核</dt>
                <dd>{record.reviewed_label ? LABELS[record.reviewed_label].name : "待复核"}</dd>
              </div>
            </dl>
            <div className="library-score-list">
              {record.probabilities.map((item) => (
                <div className="library-score" key={item.label}>
                  <div>
                    <span>{LABELS[item.label].name}</span>
                    <strong>{numberFormatter.format(item.score * 100)}%</strong>
                  </div>
                  <div className="library-meter">
                    <span
                      style={{
                        width: `${item.score * 100}%`,
                        background: LABELS[item.label].color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <label className="library-field">
              <span>人工分类</span>
              <select
                value={record.reviewed_label ?? ""}
                disabled={busy || saving !== null}
                onChange={(event) => void review(record, event.target.value)}
              >
                <option value="">清除复核</option>
                {(Object.keys(LABELS) as TumorLabel[]).map((label) => (
                  <option key={label} value={label}>
                    {LABELS[label].name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || saving !== null}
              onClick={() => {
                onClose();
                onOpen(record.id);
              }}
            >
              {saving === record.id ? "正在保存…" : "打开影像"}
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
