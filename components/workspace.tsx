"use client";

import {
  Activity,
  ArrowRight,
  Brain,
  ChartColumn,
  Check,
  ChevronRight,
  CirclePause,
  FileImage,
  FileSpreadsheet,
  FolderClock,
  Layers3,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, downloadExport } from "@/lib/api";
import { type Analysis, type ImageAnnotation, LABELS, type ModelInfo } from "@/lib/types";
import { HistoryPanel } from "./history-panel";
import { ImageViewer } from "./image-viewer";
import { ModelStatus } from "./model-status";
import { OverviewPanel } from "./overview-panel";
import { ResultPanel } from "./result-panel";
import { Notice } from "./ui";

type Section = "analysis" | "history" | "overview";
type QueueStatus = "pending" | "analyzing" | "done" | "error";
type QueueItem = {
  id: string;
  file: File;
  status: QueueStatus;
  result: Analysis | null;
  error: string | null;
};
const sections = [
  { id: "analysis" as const, name: "影像分析", icon: ScanLine },
  { id: "history" as const, name: "影像库", icon: FolderClock },
  { id: "overview" as const, name: "数据概览", icon: ChartColumn },
];
const statusNames: Record<QueueStatus, string> = {
  pending: "待分析",
  analyzing: "分析中",
  done: "已完成",
  error: "失败",
};

function validateFile(file: File): string | null {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    return "仅支持 PNG、JPEG、WebP";
  if (!file.size || file.size > 10 * 1024 * 1024) return "文件不能为空或超过 10 MiB";
  return null;
}

export function Workspace() {
  const [section, setSection] = useState<Section>("analysis");
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelRefresh, setModelRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [running, setRunning] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [opening, setOpening] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [group, setGroup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [revision, setRevision] = useState(0);
  const [heatmapUrl, setHeatmapUrl] = useState<string | null>(null);
  const [heatmapBusy, setHeatmapBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const activeRef = useRef<string | null>(null);
  const analysisRef = useRef<Analysis | null>(null);
  const previewRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const pauseRef = useRef(false);
  const heatmapsRef = useRef(new Map<string, string>());
  const selected = sections.find((item) => item.id === section) ?? sections[0];
  const ready = model?.state === "ready" && !modelError;
  const active = queue.find((item) => item.id === activeId);
  const completed = queue.filter((item) => item.status === "done").length;
  const failed = queue.filter((item) => item.status === "error").length;
  const pending = queue.filter((item) => item.status === "pending").length;

  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    api
      .model()
      .then((value) => {
        if (!cancelled) {
          setModel(value);
          setModelError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setModelError(reason instanceof Error ? reason.message : "无法连接服务");
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modelRefresh]);
  useEffect(() => {
    if (model?.state !== "loading" || modelError) return;
    const timer = window.setTimeout(() => setModelRefresh((value) => value + 1), 3000);
    return () => window.clearTimeout(timer);
  }, [model, modelError]);
  useEffect(
    () => () => {
      pauseRef.current = true;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  function publishQueue(items: QueueItem[]) {
    queueRef.current = items;
    setQueue(items);
  }
  function setRecord(value: Analysis | null) {
    analysisRef.current = value;
    setAnalysis(value);
    setHeatmapUrl(value ? (heatmapsRef.current.get(value.id) ?? null) : null);
  }
  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  }
  function chooseItem(item: QueueItem) {
    activeRef.current = item.id;
    setActiveId(item.id);
    clearPreview();
    if (!validateFile(item.file)) {
      const url = URL.createObjectURL(item.file);
      previewRef.current = url;
      setPreview(url);
    }
    setRecord(item.result);
    setError(null);
  }
  function addFiles(files: FileList | File[]) {
    if (runningRef.current) return;
    const incoming = Array.from(files);
    if (!incoming.length) return;
    if (incoming.length + queueRef.current.length > 50) {
      setError("一次最多保留 50 张影像，请清空列表或减少文件数量。");
      return;
    }
    const additions = incoming.map((file): QueueItem => {
      const message = validateFile(file);
      return {
        id: crypto.randomUUID(),
        file,
        status: message ? "error" : "pending",
        result: null,
        error: message,
      };
    });
    publishQueue([...queueRef.current, ...additions]);
    if (!activeRef.current || !queueRef.current.some((item) => item.id === activeRef.current))
      chooseItem(additions[0]);
    setError(null);
  }
  function removeItem(id: string) {
    if (runningRef.current) return;
    const remaining = queueRef.current.filter((item) => item.id !== id);
    publishQueue(remaining);
    if (activeRef.current === id) {
      if (remaining.length) chooseItem(remaining[0]);
      else {
        activeRef.current = null;
        setActiveId(null);
        clearPreview();
        setRecord(null);
      }
    }
  }
  function clearQueue() {
    if (runningRef.current) return;
    publishQueue([]);
    activeRef.current = null;
    setActiveId(null);
    clearPreview();
    setRecord(null);
    setError(null);
  }
  function retryFailed() {
    if (runningRef.current) return;
    publishQueue(
      queueRef.current.map((item) =>
        item.status === "error" && !validateFile(item.file)
          ? { ...item, status: "pending", error: null }
          : item,
      ),
    );
  }

  async function startBatch() {
    if (!ready || runningRef.current || !queueRef.current.some((item) => item.status === "pending"))
      return;
    runningRef.current = true;
    pauseRef.current = false;
    setRunning(true);
    setPauseRequested(false);
    setError(null);
    const batchGroup = group.trim();
    try {
      while (!pauseRef.current) {
        const item = queueRef.current.find((entry) => entry.status === "pending");
        if (!item) break;
        publishQueue(
          queueRef.current.map((entry) =>
            entry.id === item.id ? { ...entry, status: "analyzing", error: null } : entry,
          ),
        );
        try {
          const result = await api.analyze(item.file, batchGroup);
          publishQueue(
            queueRef.current.map((entry) =>
              entry.id === item.id ? { ...entry, status: "done", result, error: null } : entry,
            ),
          );
          if (activeRef.current === item.id) setRecord(result);
          setRevision((value) => value + 1);
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : "分析失败";
          publishQueue(
            queueRef.current.map((entry) =>
              entry.id === item.id ? { ...entry, status: "error", error: message } : entry,
            ),
          );
        }
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      setPauseRequested(false);
      setModelRefresh((value) => value + 1);
    }
  }

  function updateRecord(updated: Analysis) {
    if (analysisRef.current?.id === updated.id) setRecord(updated);
    publishQueue(
      queueRef.current.map((item) =>
        item.result?.id === updated.id ? { ...item, result: updated } : item,
      ),
    );
    setRevision((value) => value + 1);
  }
  async function openRecord(id: string) {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      const value = await api.get(id);
      clearPreview();
      activeRef.current = null;
      setActiveId(null);
      setRecord(value);
      setSection("analysis");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "打开失败");
    } finally {
      setOpening(false);
    }
  }
  async function saveAnnotations(annotations: ImageAnnotation[]) {
    const current = analysis;
    if (!current) throw new Error("请先完成分析");
    const updated = await api.update(current.id, { annotations });
    updateRecord(updated);
  }
  async function createHeatmap() {
    const current = analysisRef.current;
    if (!current || heatmapBusy) return;
    setHeatmapBusy(true);
    setError(null);
    try {
      const result = await api.heatmap(current.id);
      heatmapsRef.current.set(current.id, result.heatmap_url);
      if (analysisRef.current?.id === current.id) setHeatmapUrl(result.heatmap_url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成失败");
      throw reason;
    } finally {
      setHeatmapBusy(false);
    }
  }
  async function exportBatch(format: "pdf" | "excel") {
    const ids = queueRef.current.flatMap((item) => (item.result ? [item.result.id] : []));
    if (!ids.length || exporting) return;
    setExporting(true);
    setError(null);
    try {
      await downloadExport(format, { ids });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  const source = analysis?.image_url ?? preview;
  const filename = analysis?.filename ?? active?.file.name ?? null;

  return (
    <div className="workspace">
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="NeuroLens 首页">
          <span className="brand-mark">
            <Brain size={27} strokeWidth={1.6} />
          </span>
          <strong>
            NeuroLens<span className="brand-dot">.</span>
          </strong>
        </a>
        <nav className="main-nav" aria-label="工作台导航">
          {sections.map((item) => (
            <button
              type="button"
              className={`nav-item ${section === item.id ? "active" : ""}`}
              key={item.id}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              <item.icon size={20} />
              <span>{item.name}</span>
              {section === item.id && <ChevronRight size={15} className="nav-chevron" />}
            </button>
          ))}
        </nav>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Layers3 size={16} />
            <span>脑瘤影像识别</span>
            <ChevronRight size={13} />
            <strong>{selected.name}</strong>
          </div>
          <ModelStatus
            model={model}
            error={modelError}
            disabled={running || opening || heatmapBusy}
            onChanged={(updated) => {
              setModel(updated);
              setModelError(null);
              heatmapsRef.current.clear();
              setHeatmapUrl(null);
              setRevision((value) => value + 1);
            }}
          />
        </header>
        <main id="main-content" className="main-content">
          <div className="page-heading">
            <h1>{selected.name}</h1>
            <button
              className="button button-secondary refresh-button"
              type="button"
              disabled={refreshing}
              onClick={() => {
                setModelRefresh((value) => value + 1);
                setRevision((value) => value + 1);
              }}
            >
              <RefreshCw size={15} className={refreshing ? "spin" : undefined} />
              {refreshing ? "正在连接…" : "刷新"}
            </button>
          </div>
          {(modelError || (model && model.state !== "ready")) && (
            <div className="service-notice">
              <Notice tone={modelError || model?.state === "error" ? "error" : "info"}>
                {modelError ?? model?.error ?? "模型正在加载…"}
              </Notice>
            </div>
          )}
          {error && (
            <div className="operation-error">
              <Notice tone="error">{error}</Notice>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭错误提示"
                onClick={() => setError(null)}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {section === "analysis" && (
            <>
              <section className="card batch-card" aria-label="影像导入">
                <div className="batch-heading">
                  <div className="section-title">
                    <UploadCloud size={20} />
                    <h2>导入影像</h2>
                  </div>
                  <div className="batch-counts">
                    <span>
                      待分析 <strong>{pending}</strong>
                    </span>
                    <span>
                      完成 <strong>{completed}</strong>
                    </span>
                    <span>
                      失败 <strong>{failed}</strong>
                    </span>
                  </div>
                </div>
                <fieldset
                  className={`batch-dropzone ${dragging ? "is-dragging" : ""}`}
                  aria-label="影像上传区域"
                  disabled={running}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!running) setDragging(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      setDragging(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    addFiles(event.dataTransfer.files);
                  }}
                >
                  <span className="upload-art">
                    <FileImage size={25} />
                  </span>
                  <h3>拖入图片或批量选择</h3>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={running}
                    onClick={() => fileInput.current?.click()}
                  >
                    选择影像
                    <ArrowRight size={16} />
                  </button>
                  <input
                    ref={fileInput}
                    id="mri-file"
                    className="sr-only"
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/webp"
                    aria-label="选择 MRI 影像文件"
                    disabled={running}
                    onChange={(event) => {
                      if (event.target.files) addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </fieldset>
                <div className="batch-controls">
                  <label className="batch-group">
                    分组
                    <input
                      value={group}
                      maxLength={80}
                      disabled={running}
                      onChange={(event) => setGroup(event.target.value)}
                      placeholder="未分组"
                      aria-label="批次分组"
                    />
                  </label>
                  <div className="batch-actions">
                    {failed > 0 && (
                      <button
                        className="button button-quiet"
                        type="button"
                        disabled={running}
                        onClick={retryFailed}
                      >
                        <RotateCcw size={15} />
                        重试失败
                      </button>
                    )}
                    <button
                      className="button button-quiet"
                      type="button"
                      disabled={running || !queue.length}
                      onClick={clearQueue}
                    >
                      <Trash2 size={15} />
                      清空
                    </button>
                    {running ? (
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={pauseRequested}
                        onClick={() => {
                          pauseRef.current = true;
                          setPauseRequested(true);
                        }}
                      >
                        <CirclePause size={16} />
                        {pauseRequested ? "暂停中…" : "暂停"}
                      </button>
                    ) : (
                      <button
                        className="button button-primary"
                        type="button"
                        disabled={!ready || !pending}
                        onClick={startBatch}
                      >
                        {queue.length > 1 ? <Play size={16} /> : <Activity size={16} />}
                        {queue.length > 1 ? "开始批量" : "开始分析"}
                      </button>
                    )}
                  </div>
                </div>
                {queue.length > 0 && (
                  <div className="batch-queue">
                    <div className="batch-queue-head">
                      <h3>
                        任务列表 <span>{queue.length}</span>
                      </h3>
                      <div className="batch-export">
                        <button
                          type="button"
                          className="button button-quiet"
                          disabled={!completed || exporting}
                          onClick={() => exportBatch("pdf")}
                        >
                          PDF
                        </button>
                        <button
                          type="button"
                          className="button button-quiet"
                          disabled={!completed || exporting}
                          onClick={() => exportBatch("excel")}
                        >
                          <FileSpreadsheet size={14} />
                          Excel
                        </button>
                      </div>
                    </div>
                    <div
                      className="batch-progress"
                      role="progressbar"
                      aria-label="批次完成进度"
                      aria-valuemin={0}
                      aria-valuemax={queue.length}
                      aria-valuenow={completed + failed}
                    >
                      <span style={{ width: `${((completed + failed) / queue.length) * 100}%` }} />
                    </div>
                    <div className="queue-items">
                      {queue.map((item) => (
                        <div
                          className={`queue-item ${activeId === item.id ? "selected" : ""}`}
                          key={item.id}
                        >
                          <button
                            type="button"
                            className="queue-select"
                            onClick={() => chooseItem(item)}
                            aria-label={`查看 ${item.file.name}`}
                          >
                            <span className={`queue-state-icon ${item.status}`}>
                              {item.status === "analyzing" ? (
                                <LoaderCircle size={16} className="spin" />
                              ) : item.status === "done" ? (
                                <Check size={16} />
                              ) : item.status === "error" ? (
                                <X size={16} />
                              ) : (
                                <FileImage size={16} />
                              )}
                            </span>
                            <span className="queue-filename" title={item.error ?? item.file.name}>
                              {item.file.name}
                              {item.error && <span className="queue-error">{item.error}</span>}
                            </span>
                            <span className={`queue-status ${item.status}`}>
                              {statusNames[item.status]}
                            </span>
                            {item.result && (
                              <span
                                className="queue-class"
                                style={{ color: LABELS[item.result.predicted_label].color }}
                              >
                                {LABELS[item.result.predicted_label].name}
                              </span>
                            )}
                          </button>
                          <button
                            className="icon-button"
                            type="button"
                            disabled={running}
                            aria-label={`移除 ${item.file.name}`}
                            onClick={() => removeItem(item.id)}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
              <div className="analysis-grid enhanced-analysis">
                <ImageViewer
                  source={source}
                  filename={filename}
                  analysis={analysis}
                  onSaveAnnotations={saveAnnotations}
                  heatmapUrl={heatmapUrl}
                  heatmapBusy={heatmapBusy}
                  onHeatmap={model?.heatmap_supported ? createHeatmap : undefined}
                />
                <ResultPanel
                  analysis={analysis}
                  busy={opening || active?.status === "analyzing"}
                  onUpdated={updateRecord}
                />
              </div>
            </>
          )}
          {section === "history" && (
            <HistoryPanel
              revision={revision}
              busy={opening}
              onOpen={openRecord}
              onUpdated={updateRecord}
              onDeleted={(id) => {
                setRevision((value) => value + 1);
                if (analysisRef.current?.id === id) {
                  setRecord(null);
                  clearPreview();
                  activeRef.current = null;
                  setActiveId(null);
                }
                publishQueue(queueRef.current.filter((item) => item.result?.id !== id));
                heatmapsRef.current.delete(id);
              }}
            />
          )}
          {section === "overview" && <OverviewPanel revision={revision} />}
        </main>
      </div>
    </div>
  );
}
