"use client";

import {
  ArrowDownToLine,
  Check,
  Clock3,
  FileSpreadsheet,
  LoaderCircle,
  Save,
  Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, downloadExport } from "@/lib/api";
import { type Analysis, type ExportFormat, LABELS, type TumorLabel } from "@/lib/types";
import { dateFormatter, EmptyState, Loading, Notice, numberFormatter } from "./ui";

type Props = { analysis: Analysis | null; busy: boolean; onUpdated?: (record: Analysis) => void };

export function ResultPanel({ analysis, busy, onUpdated }: Props) {
  const [review, setReview] = useState<TumorLabel | "">("");
  const [group, setGroup] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setReview(analysis?.reviewed_label ?? "");
    setGroup(analysis?.group ?? "");
    setNotes(analysis?.notes ?? "");
    setError(null);
  }, [analysis?.id, analysis?.reviewed_label, analysis?.group, analysis?.notes]);

  useEffect(() => {
    setSaved(false);
  }, [analysis?.id]);

  async function save() {
    if (!analysis || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.update(analysis.id, {
        reviewed_label: review || null,
        group: group.trim(),
        notes,
      });
      onUpdated?.(updated);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function exportRecord(format: ExportFormat) {
    if (!analysis || exporting) return;
    setExporting(format);
    setError(null);
    try {
      await downloadExport(format, { ids: [analysis.id] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出失败");
    } finally {
      setExporting(null);
    }
  }

  return (
    <section className="card result-card" aria-label="模型分类结果">
      <div className="card-heading">
        <h2>分类结果</h2>
        {analysis && (
          <span className={`review-state ${analysis.review_status}`}>
            <span />
            {analysis.review_status === "reviewed" ? "已复核" : "待复核"}
          </span>
        )}
      </div>
      {busy ? (
        <div className="result-placeholder">
          <Loading>正在分析…</Loading>
        </div>
      ) : !analysis ? (
        <EmptyState title="暂无分析结果" />
      ) : (
        <>
          <div className="prediction-summary">
            <div className="prediction-main">
              <h3 style={{ color: LABELS[analysis.predicted_label].color }}>
                {LABELS[analysis.predicted_label].name}
              </h3>
              <span className="prediction-score">
                {(analysis.confidence * 100).toFixed(2)}
                <small>%</small>
              </span>
            </div>
            {analysis.reviewed_label && (
              <div className="review-result">
                <Check size={15} />
                <span>复核结果</span>
                <strong style={{ color: LABELS[analysis.reviewed_label].color }}>
                  {LABELS[analysis.reviewed_label].name}
                </strong>
              </div>
            )}
          </div>
          <div className="score-heading">
            <h3>四类模型评分</h3>
          </div>
          <div className="score-list">
            {(Object.keys(LABELS) as TumorLabel[]).map((label) => {
              const score = analysis.probabilities.find((item) => item.label === label)?.score;
              return (
                <div className="score-item" key={label}>
                  <div className="score-row">
                    <span>
                      <i style={{ background: LABELS[label].color }} />
                      {LABELS[label].name}
                    </span>
                    <strong>{score === undefined ? "—" : `${(score * 100).toFixed(2)}%`}</strong>
                  </div>
                  <div className="score-track">
                    <div
                      style={{
                        width: `${Math.max(0, Math.min(100, (score ?? 0) * 100))}%`,
                        background: LABELS[label].color,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="review-editor">
            <div className="review-editor-heading">
              <h3>结果复核</h3>
              {saved && (
                <span className="saved-state">
                  <Check size={14} />
                  已保存
                </span>
              )}
            </div>
            <div className="review-fields">
              <label>
                人工分类
                <select
                  aria-label="人工分类"
                  value={review}
                  disabled={saving}
                  onChange={(event) => {
                    setReview(event.target.value as TumorLabel | "");
                    setSaved(false);
                  }}
                >
                  <option value="">待复核</option>
                  {(Object.keys(LABELS) as TumorLabel[]).map((label) => (
                    <option key={label} value={label}>
                      {LABELS[label].name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                分组
                <input
                  aria-label="记录分组"
                  value={group}
                  maxLength={80}
                  disabled={saving}
                  onChange={(event) => {
                    setGroup(event.target.value);
                    setSaved(false);
                  }}
                  placeholder="未分组"
                />
              </label>
            </div>
            <label className="notes-field">
              备注
              <textarea
                aria-label="记录备注"
                value={notes}
                maxLength={2000}
                rows={3}
                disabled={saving}
                onChange={(event) => {
                  setNotes(event.target.value);
                  setSaved(false);
                }}
                placeholder="填写备注"
              />
            </label>
            <div className="review-editor-actions">
              <button
                type="button"
                className="button button-quiet"
                disabled={saving || !review}
                onClick={() => {
                  setReview("");
                  setSaved(false);
                }}
              >
                <Undo2 size={14} />
                清除复核
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={saving}
                onClick={save}
              >
                {saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存
              </button>
            </div>
          </div>
          <dl className="result-metadata">
            <div>
              <dt>
                <Clock3 size={14} />
                推理耗时
              </dt>
              <dd>{numberFormatter.format(analysis.inference_ms)} ms</dd>
            </div>
            <div>
              <dt>原始尺寸</dt>
              <dd>
                {analysis.width} × {analysis.height} px
              </dd>
            </div>
            <div className="metadata-wide">
              <dt>文件名称</dt>
              <dd title={analysis.filename}>{analysis.filename}</dd>
            </div>
            <div className="metadata-wide">
              <dt>分析时间</dt>
              <dd>{dateFormatter.format(new Date(analysis.created_at))}</dd>
            </div>
            {analysis.reviewed_at && (
              <div className="metadata-wide">
                <dt>复核时间</dt>
                <dd>{dateFormatter.format(new Date(analysis.reviewed_at))}</dd>
              </div>
            )}
          </dl>
          {error && (
            <div className="result-error">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
          <div className="report-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={Boolean(exporting)}
              onClick={() => exportRecord("pdf")}
            >
              {exporting === "pdf" ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <ArrowDownToLine size={15} />
              )}
              PDF 报告
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={Boolean(exporting)}
              onClick={() => exportRecord("excel")}
            >
              {exporting === "excel" ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <FileSpreadsheet size={15} />
              )}
              Excel
            </button>
            <a
              className="button button-quiet"
              href={`/api/analyses/${encodeURIComponent(analysis.id)}/report`}
              download
            >
              JSON
            </a>
          </div>
        </>
      )}
    </section>
  );
}
