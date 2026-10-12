"use client";

import { ChevronLeft, ChevronRight, LayoutGrid, List, Search } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { api, downloadExport } from "@/lib/api";
import {
  type Analysis,
  type AnalysisPage,
  type ExportFormat,
  type GroupCount,
  LABELS,
  type ListOptions,
  type ReviewStatus,
  type TumorLabel,
} from "@/lib/types";
import { ComparePanel } from "./compare-panel";
import { dateFormatter, EmptyState, Loading, Notice, numberFormatter } from "./ui";

type FilterDraft = {
  query: string;
  label: string;
  group: string;
  review: string;
  start: string;
  end: string;
  min: string;
  max: string;
  sort: NonNullable<ListOptions["sort"]>;
};
const initialFilters: FilterDraft = {
  query: "",
  label: "",
  group: "all",
  review: "",
  start: "",
  end: "",
  min: "",
  max: "",
  sort: "newest",
};
const pageSize = 12;
const labels = Object.keys(LABELS) as TumorLabel[];

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus();
      else dialog.parentElement?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    };
  }, [open]);
  return ref;
}

export function HistoryPanel({
  revision,
  busy,
  onOpen,
  onDeleted,
  onUpdated,
}: {
  revision: number;
  busy: boolean;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
  onUpdated?: (record: Analysis) => void;
}) {
  const [records, setRecords] = useState<AnalysisPage | null>(null);
  const [groups, setGroups] = useState<GroupCount[]>([]);
  const [draft, setDraft] = useState<FilterDraft>(initialFilters);
  const [filters, setFilters] = useState<ListOptions>({ sort: "newest" });
  const [advanced, setAdvanced] = useState(false);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, Analysis>>(new Map());
  const [groupInput, setGroupInput] = useState("");
  const [operation, setOperation] = useState<string | null>(null);
  const operationLock = useRef(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [editTarget, setEditTarget] = useState<Analysis | null>(null);
  const [editDraft, setEditDraft] = useState({ group: "", notes: "", label: "" });
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareRecords, setCompareRecords] = useState<Analysis[]>([]);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const deleteRef = useModal(deleteIds.length > 0);
  const editRef = useModal(editTarget !== null);
  const compareRef = useModal(compareIds.length > 0);
  const disabled = busy || operation !== null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([api.list({ ...filters, page, page_size: pageSize }), api.groups()])
      .then(([data, nextGroups]) => {
        if (cancelled) return;
        setGroups(nextGroups);
        const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setRecords(data);
        setSelected((previous) => {
          const next = new Map(previous);
          for (const record of data.items) if (next.has(record.id)) next.set(record.id, record);
          return next;
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setLoadError(reason instanceof Error ? reason.message : "无法读取影像库。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, page, revision, refresh]);

  useEffect(() => {
    if (!compareIds.length) return;
    let cancelled = false;
    setCompareLoading(true);
    setCompareError(null);
    Promise.all(compareIds.map((id) => api.get(id)))
      .then((data) => {
        if (!cancelled) setCompareRecords(data);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setCompareError(reason instanceof Error ? reason.message : "无法读取对比影像。");
      })
      .finally(() => {
        if (!cancelled) setCompareLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [compareIds]);

  function setField(field: keyof FilterDraft, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }));
  }

  function applyFilters() {
    if (draft.start && draft.end && draft.start > draft.end) {
      setError("起始日期不能晚于结束日期。");
      return;
    }
    const min = draft.min === "" ? undefined : Number(draft.min);
    const max = draft.max === "" ? undefined : Number(draft.max);
    if (
      [min, max].some(
        (value) => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100),
      ) ||
      (min !== undefined && max !== undefined && min > max)
    ) {
      setError("置信度范围须为 0–100%，下限不能高于上限。");
      return;
    }
    setError(null);
    setPage(1);
    setFilters({
      query: draft.query.trim(),
      label: draft.label ? (draft.label as TumorLabel) : undefined,
      group:
        draft.group === "all"
          ? undefined
          : draft.group === "unassigned"
            ? ""
            : draft.group.slice(6),
      review_status: draft.review ? (draft.review as ReviewStatus) : undefined,
      start_date: draft.start || undefined,
      end_date: draft.end || undefined,
      confidence_min: min === undefined ? undefined : min / 100,
      confidence_max: max === undefined ? undefined : max / 100,
      sort: draft.sort,
    });
  }

  function updateRecord(record: Analysis) {
    setRecords((previous) =>
      previous
        ? {
            ...previous,
            items: previous.items.map((item) => (item.id === record.id ? record : item)),
          }
        : previous,
    );
    setSelected((previous) => {
      const next = new Map(previous);
      if (next.has(record.id)) next.set(record.id, record);
      return next;
    });
    setCompareRecords((previous) =>
      previous.map((item) => (item.id === record.id ? record : item)),
    );
    onUpdated?.(record);
  }

  async function perform(name: string, action: () => Promise<void>) {
    if (operationLock.current || busy) return;
    operationLock.current = true;
    setOperation(name);
    setError(null);
    try {
      await action();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      operationLock.current = false;
      setOperation(null);
    }
  }

  function toggle(record: Analysis) {
    if (!selected.has(record.id) && selected.size >= 200) {
      setError("最多选择 200 张影像。");
      return;
    }
    setSelected((previous) => {
      const next = new Map(previous);
      if (next.has(record.id)) next.delete(record.id);
      else next.set(record.id, record);
      return next;
    });
  }

  function selectVisible() {
    if (!records) return;
    const next = new Map(selected);
    if (records.items.every((record) => next.has(record.id)))
      for (const record of records.items) next.delete(record.id);
    else {
      const additions = records.items.filter((record) => !next.has(record.id));
      if (next.size + additions.length > 200) {
        setError("最多选择 200 张影像。");
        return;
      }
      for (const record of additions) next.set(record.id, record);
    }
    setSelected(next);
  }

  function openEdit(record: Analysis) {
    void perform("edit-load", async () => {
      const fresh = await api.get(record.id);
      setEditDraft({ group: fresh.group, notes: fresh.notes, label: fresh.reviewed_label ?? "" });
      setEditTarget(fresh);
    });
  }

  function exportRecords(format: ExportFormat) {
    void perform(`export-${format}`, () =>
      downloadExport(format, selected.size ? { ids: [...selected.keys()] } : { filters }),
    );
  }

  const pages = records ? Math.max(1, Math.ceil(records.total / records.page_size)) : 1;
  const allVisibleSelected = Boolean(
    records?.items.length && records.items.every((record) => selected.has(record.id)),
  );

  return (
    <section className="card library-panel">
      <div className="library-heading">
        <h2>影像库</h2>
        <fieldset className="library-view-switch" aria-label="影像显示方式">
          <button
            type="button"
            className="button button-secondary"
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            <LayoutGrid size={16} aria-hidden="true" />
            网格
          </button>
          <button
            type="button"
            className="button button-secondary"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <List size={16} aria-hidden="true" />
            列表
          </button>
        </fieldset>
      </div>
      <form
        className="library-filter-form"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <div className="library-filter-main">
          <label className="library-field library-search">
            <span>文件名</span>
            <div>
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                maxLength={180}
                value={draft.query}
                placeholder="搜索影像"
                onChange={(event) => setField("query", event.target.value)}
              />
            </div>
          </label>
          <label className="library-field">
            <span>分类</span>
            <select value={draft.label} onChange={(event) => setField("label", event.target.value)}>
              <option value="">全部分类</option>
              {labels.map((label) => (
                <option key={label} value={label}>
                  {LABELS[label].name}
                </option>
              ))}
            </select>
          </label>
          <label className="library-field">
            <span>分组</span>
            <select value={draft.group} onChange={(event) => setField("group", event.target.value)}>
              <option value="all">全部分组</option>
              <option value="unassigned">未分组</option>
              {groups.map((group) => (
                <option key={group.name} value={`group:${group.name}`}>
                  {group.name}（{group.count}）
                </option>
              ))}
            </select>
          </label>
          <div className="library-filter-buttons">
            <button className="button button-primary" type="submit" disabled={loading}>
              筛选
            </button>
            <button
              className="button button-secondary"
              type="button"
              aria-expanded={advanced}
              aria-controls="library-advanced"
              onClick={() => setAdvanced(!advanced)}
            >
              高级筛选
            </button>
            <button
              className="button button-quiet"
              type="button"
              onClick={() => {
                setDraft(initialFilters);
                setFilters({ sort: "newest" });
                setPage(1);
                setError(null);
              }}
            >
              重置
            </button>
          </div>
        </div>
        {advanced && (
          <div className="library-advanced" id="library-advanced">
            <label className="library-field">
              <span>起始日期</span>
              <input
                type="date"
                value={draft.start}
                onChange={(event) => setField("start", event.target.value)}
              />
            </label>
            <label className="library-field">
              <span>结束日期</span>
              <input
                type="date"
                value={draft.end}
                onChange={(event) => setField("end", event.target.value)}
              />
            </label>
            <label className="library-field">
              <span>复核状态</span>
              <select
                value={draft.review}
                onChange={(event) => setField("review", event.target.value)}
              >
                <option value="">全部状态</option>
                <option value="pending">待复核</option>
                <option value="reviewed">已复核</option>
              </select>
            </label>
            <label className="library-field">
              <span>置信度下限 %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={draft.min}
                onChange={(event) => setField("min", event.target.value)}
              />
            </label>
            <label className="library-field">
              <span>置信度上限 %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={draft.max}
                onChange={(event) => setField("max", event.target.value)}
              />
            </label>
            <label className="library-field">
              <span>排序</span>
              <select value={draft.sort} onChange={(event) => setField("sort", event.target.value)}>
                <option value="newest">最新优先</option>
                <option value="oldest">最早优先</option>
                <option value="confidence_desc">置信度从高到低</option>
                <option value="confidence_asc">置信度从低到高</option>
              </select>
            </label>
          </div>
        )}
      </form>
      <datalist id="library-group-names">
        {groups.map((group) => (
          <option value={group.name} key={group.name} />
        ))}
      </datalist>
      <div className="library-actions">
        <div className="library-selection">
          <strong>已选 {selected.size}</strong>
          <button
            type="button"
            className="button button-secondary"
            disabled={loading || !records?.items.length}
            onClick={selectVisible}
          >
            {allVisibleSelected ? "取消本页" : "选择本页"}
          </button>
          <button
            type="button"
            className="button button-quiet"
            disabled={!selected.size}
            onClick={() => setSelected(new Map())}
          >
            清空选择
          </button>
        </div>
        <div className="library-bulk-group">
          <input
            aria-label="批量分组名称"
            value={groupInput}
            list="library-group-names"
            maxLength={80}
            placeholder="分组名称"
            onChange={(event) => setGroupInput(event.target.value)}
          />
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled || !selected.size}
            onClick={() =>
              void perform("group", async () => {
                const result = await api.bulk("group", [...selected.keys()], groupInput.trim());
                result.updated.forEach(updateRecord);
                setRefresh((value) => value + 1);
              })
            }
          >
            {operation === "group" ? "正在保存…" : groupInput.trim() ? "设置分组" : "移出分组"}
          </button>
        </div>
        <div className="library-bulk-buttons">
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled || selected.size < 2 || selected.size > 4}
            onClick={() => {
              setCompareRecords([]);
              setCompareIds([...selected.keys()]);
            }}
          >
            对比
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled || (!selected.size && !records?.total)}
            onClick={() => exportRecords("pdf")}
          >
            {operation === "export-pdf" ? "导出中…" : "导出 PDF"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled || (!selected.size && !records?.total)}
            onClick={() => exportRecords("excel")}
          >
            {operation === "export-excel" ? "导出中…" : "导出 Excel"}
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={disabled || !selected.size}
            onClick={() => {
              setError(null);
              setDeleteIds([...selected.keys()]);
            }}
          >
            删除所选
          </button>
        </div>
      </div>
      {error && !editTarget && !deleteIds.length && <Notice tone="error">{error}</Notice>}
      {loadError ? (
        <div className="library-status">
          <Notice tone="error">{loadError}</Notice>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setRefresh((value) => value + 1)}
          >
            重新加载
          </button>
        </div>
      ) : loading ? (
        <Loading />
      ) : !records?.items.length ? (
        <EmptyState title="暂无影像" />
      ) : (
        <>
          <div className={`library-records library-records-${view}`}>
            {records.items.map((record) => (
              <article
                className={`library-record ${selected.has(record.id) ? "is-selected" : ""}`}
                key={record.id}
              >
                <div className="library-thumbnail">
                  <button
                    type="button"
                    aria-label={`打开 ${record.filename}`}
                    onClick={() => onOpen(record.id)}
                    disabled={busy}
                  >
                    <Image
                      src={record.image_url}
                      alt={record.filename}
                      width={record.width}
                      height={record.height}
                      unoptimized
                      sizes="(max-width: 600px) 100vw, 320px"
                    />
                  </button>
                  <label className="library-checkbox">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${record.filename}`}
                      checked={selected.has(record.id)}
                      onChange={() => toggle(record)}
                    />
                  </label>
                </div>
                <div className="library-record-info">
                  <h3 title={record.filename}>{record.filename}</h3>
                  <time dateTime={record.created_at}>
                    {dateFormatter.format(new Date(record.created_at))}
                  </time>
                  <dl className="library-details">
                    <div>
                      <dt>原始 AI</dt>
                      <dd>
                        <span
                          className="class-badge"
                          style={{ color: LABELS[record.predicted_label].color }}
                        >
                          {LABELS[record.predicted_label].name}
                        </span>
                        <strong>{numberFormatter.format(record.confidence * 100)}%</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>人工复核</dt>
                      <dd>
                        {record.reviewed_label ? LABELS[record.reviewed_label].name : "待复核"}
                      </dd>
                    </div>
                    <div>
                      <dt>分组</dt>
                      <dd title={record.group}>{record.group || "未分组"}</dd>
                    </div>
                  </dl>
                </div>
                <div className="library-record-actions">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => onOpen(record.id)}
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={disabled}
                    onClick={() => openEdit(record)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={disabled}
                    onClick={() => {
                      setError(null);
                      setDeleteIds([record.id]);
                    }}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
          <div className="library-pagination">
            <span>
              共 {numberFormatter.format(records.total)} 张 · 第 {records.page} / {pages} 页
            </span>
            <div>
              <button
                type="button"
                className="button button-secondary"
                aria-label="上一页"
                disabled={loading || page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft size={16} aria-hidden="true" />
                上一页
              </button>
              <button
                type="button"
                className="button button-secondary"
                aria-label="下一页"
                disabled={loading || page >= pages}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      )}
      <dialog
        ref={deleteRef}
        className="library-dialog library-delete-dialog"
        aria-labelledby="library-delete-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!disabled) setDeleteIds([]);
        }}
      >
        <h2 id="library-delete-title">删除 {deleteIds.length} 张影像？</h2>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="library-dialog-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled}
            onClick={() => setDeleteIds([])}
          >
            取消
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={disabled}
            onClick={() =>
              void perform("delete", async () => {
                const result = await api.bulk("delete", deleteIds);
                setSelected((previous) => {
                  const next = new Map(previous);
                  for (const id of result.deleted_ids) next.delete(id);
                  return next;
                });
                result.deleted_ids.forEach(onDeleted);
                setDeleteIds([]);
                setRefresh((value) => value + 1);
              })
            }
          >
            {operation === "delete" ? "正在删除…" : "确认删除"}
          </button>
        </div>
      </dialog>
      <dialog
        ref={editRef}
        className="library-dialog library-edit-dialog"
        aria-labelledby="library-edit-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!disabled) setEditTarget(null);
        }}
      >
        <div className="library-dialog-heading">
          <h2 id="library-edit-title">编辑影像</h2>
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled}
            onClick={() => setEditTarget(null)}
          >
            关闭
          </button>
        </div>
        {editTarget && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform("save", async () => {
                const record = await api.update(editTarget.id, {
                  group: editDraft.group.trim(),
                  notes: editDraft.notes,
                  reviewed_label: editDraft.label ? (editDraft.label as TumorLabel) : null,
                });
                updateRecord(record);
                setEditTarget(null);
                setRefresh((value) => value + 1);
              });
            }}
          >
            <h3 className="library-edit-filename">{editTarget.filename}</h3>
            <dl className="library-details">
              <div>
                <dt>原始 AI</dt>
                <dd>
                  {LABELS[editTarget.predicted_label].name} ·{" "}
                  {numberFormatter.format(editTarget.confidence * 100)}%
                </dd>
              </div>
              <div>
                <dt>人工复核</dt>
                <dd>
                  {editTarget.reviewed_label ? LABELS[editTarget.reviewed_label].name : "待复核"}
                </dd>
              </div>
            </dl>
            <label className="library-field">
              <span>分组</span>
              <input
                autoFocus
                value={editDraft.group}
                list="library-group-names"
                maxLength={80}
                onChange={(event) =>
                  setEditDraft((previous) => ({ ...previous, group: event.target.value }))
                }
              />
            </label>
            <label className="library-field">
              <span>备注</span>
              <textarea
                rows={4}
                maxLength={2000}
                value={editDraft.notes}
                onChange={(event) =>
                  setEditDraft((previous) => ({ ...previous, notes: event.target.value }))
                }
              />
            </label>
            <label className="library-field">
              <span>人工分类</span>
              <select
                value={editDraft.label}
                onChange={(event) =>
                  setEditDraft((previous) => ({ ...previous, label: event.target.value }))
                }
              >
                <option value="">待复核</option>
                {labels.map((label) => (
                  <option key={label} value={label}>
                    {LABELS[label].name}
                  </option>
                ))}
              </select>
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="library-dialog-actions">
              <button
                className="button button-quiet"
                type="button"
                disabled={disabled || !editDraft.label}
                onClick={() => setEditDraft((previous) => ({ ...previous, label: "" }))}
              >
                清除复核
              </button>
              <button
                className="button button-secondary"
                type="button"
                disabled={disabled}
                onClick={() => setEditTarget(null)}
              >
                取消
              </button>
              <button className="button button-primary" type="submit" disabled={disabled}>
                {operation === "save" ? "正在保存…" : "保存"}
              </button>
            </div>
          </form>
        )}
      </dialog>
      <dialog
        ref={compareRef}
        className="library-dialog library-compare-dialog"
        aria-labelledby="library-compare-title"
        onCancel={(event) => {
          event.preventDefault();
          setCompareIds([]);
        }}
      >
        {compareLoading || compareError ? (
          <>
            <div className="library-dialog-heading">
              <h2 id="library-compare-title">影像对比</h2>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setCompareIds([])}
              >
                关闭
              </button>
            </div>
            {compareLoading ? (
              <Loading />
            ) : (
              <div className="library-status">
                <Notice tone="error">{compareError}</Notice>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setCompareIds([...compareIds])}
                >
                  重试
                </button>
              </div>
            )}
          </>
        ) : (
          <ComparePanel
            records={compareRecords}
            busy={busy}
            onUpdated={(record) => {
              updateRecord(record);
              setRefresh((value) => value + 1);
            }}
            onOpen={onOpen}
            onClose={() => setCompareIds([])}
          />
        )}
      </dialog>
    </section>
  );
}
