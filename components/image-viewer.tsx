"use client";

import {
  Check,
  Focus,
  Fullscreen,
  LoaderCircle,
  Maximize,
  Minimize,
  MousePointer2,
  RotateCcw,
  RotateCw,
  Save,
  ScanLine,
  Square,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Image from "next/image";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Analysis, ImageAnnotation } from "@/lib/types";

export interface ImageViewerProps {
  source: string | null;
  filename: string | null;
  analysis?: Analysis | null;
  onSaveAnnotations?: (annotations: ImageAnnotation[]) => Promise<void>;
  heatmapUrl?: string | null;
  heatmapBusy?: boolean;
  onHeatmap?: () => Promise<void>;
}

type Point = { x: number; y: number };
type View = { zoom: number; rotation: number; x: number; y: number };
type Draft = { annotations: ImageAnnotation[]; dirty: boolean; saving: boolean };
type DraftCache = {
  entries: Map<string, Draft>;
  listeners: Map<string, Set<(draft: Draft) => void>>;
};
type Gesture =
  | { type: "pan"; pointerId: number; start: Point; view: View }
  | { type: "draw"; pointerId: number; start: Point; end: Point };
const INITIAL_VIEW: View = { zoom: 1, rotation: 0, x: 0, y: 0 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const copyAnnotations = (annotations: ImageAnnotation[]) =>
  annotations.map((item) => ({ ...item }));

// A source switch gets its own geometry and async lifecycle, but keeps unsaved annotation drafts.
export function ImageViewer(props: ImageViewerProps) {
  const [cache] = useState<DraftCache>(() => ({ entries: new Map(), listeners: new Map() }));
  const identity = props.analysis?.id ?? props.source ?? "empty";
  return (
    <ViewerSession
      key={`${identity}:${props.source ?? ""}`}
      {...props}
      identity={identity}
      cache={cache}
    />
  );
}

function ViewerSession({
  source,
  filename,
  analysis,
  onSaveAnnotations,
  heatmapUrl,
  heatmapBusy = false,
  onHeatmap,
  identity,
  cache,
}: ImageViewerProps & { identity: string; cache: DraftCache }) {
  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const firstPaneRef = useRef<HTMLElement>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const gesture = useRef<Gesture | null>(null);
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<"original" | "adjusted" | "compare">("original");
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [heatmapOpacity, setHeatmapOpacity] = useState(65);
  const [heatmapFailed, setHeatmapFailed] = useState(false);
  const [heatmapRequest, setHeatmapRequest] = useState(false);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [preview, setPreview] = useState<ImageAnnotation | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [color, setColor] = useState("#a78bfa");
  const [draft, setDraft] = useState<Draft>(
    () =>
      cache.entries.get(identity) ?? {
        annotations: copyAnnotations(analysis?.annotations ?? []),
        dirty: false,
        saving: false,
      },
  );
  const draftRef = useRef(draft);
  const annotationSignature = JSON.stringify(analysis?.annotations ?? []);
  const available = !!source && !failed && natural.width > 0;
  const waiting = heatmapBusy || heatmapRequest;
  const annotationBusy = draft.saving || waiting;
  const canAnnotate = !!analysis && !!onSaveAnnotations && available && !annotationBusy;
  const selectedAnnotation = draft.annotations.find((item) => item.id === selected);
  const turned = view.rotation % 180 !== 0;
  const fit =
    natural.width && size.width
      ? Math.max(
          0.0001,
          Math.min(
            Math.max(1, size.width - 28) / (turned ? natural.height : natural.width),
            Math.max(1, size.height - 28) / (turned ? natural.width : natural.height),
          ),
        )
      : 1;

  const updateDraft = useCallback(
    (next: Draft) => {
      cache.entries.set(identity, next);
      for (const listener of cache.listeners.get(identity) ?? []) listener(next);
    },
    [cache, identity],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const listener = (next: Draft) => {
      draftRef.current = next;
      setDraft(next);
    };
    const listeners = cache.listeners.get(identity) ?? new Set<(draft: Draft) => void>();
    cache.listeners.set(identity, listeners);
    listeners.add(listener);
    const current = cache.entries.get(identity);
    if (current) listener(current);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) cache.listeners.delete(identity);
    };
  }, [cache, identity]);

  useEffect(() => {
    const current = draftRef.current;
    if (!current.dirty && !current.saving) {
      updateDraft({
        annotations: copyAnnotations(JSON.parse(annotationSignature) as ImageAnnotation[]),
        dirty: false,
        saving: false,
      });
    }
  }, [annotationSignature, updateDraft]);

  useEffect(() => {
    if (!annotationOpen) {
      gesture.current = null;
      setDrawing(false);
      setPreview(null);
    }
  }, [annotationOpen]);

  useEffect(() => {
    const pane = firstPaneRef.current;
    if (!pane) return;
    const resize = () => {
      const rect = pane.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [mode, source, failed]);

  useEffect(() => {
    setHeatmapFailed(false);
  }, [heatmapUrl]);

  useEffect(() => {
    const root = rootRef.current;
    const changed = () => {
      const active = document.fullscreenElement === root;
      setFullscreen(active);
      if (active) root?.focus();
      else focusReturn.current?.focus();
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      if (root && document.fullscreenElement === root)
        void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !available) return;
    const wheel = (event: WheelEvent) => {
      const pane = (event.target as HTMLElement).closest<HTMLElement>(".imaging-pane");
      if (!pane) return;
      event.preventDefault();
      if (gesture.current) return;
      const bounds = pane.getBoundingClientRect();
      const anchor = {
        x: event.clientX - bounds.left - bounds.width / 2,
        y: event.clientY - bounds.top - bounds.height / 2,
      };
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      setView((current) => {
        const zoom = clamp(current.zoom * Math.exp(-delta * 0.0015), 0.25, 8);
        const ratio = zoom / current.zoom;
        return {
          ...current,
          zoom,
          x: anchor.x - (anchor.x - current.x) * ratio,
          y: anchor.y - (anchor.y - current.y) * ratio,
        };
      });
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, [available]);

  function changeAnnotations(annotations: ImageAnnotation[]) {
    if (!canAnnotate || annotations.length > 100) return;
    updateDraft({ annotations, dirty: true, saving: false });
    setError(null);
  }

  function imagePoint(
    clientX: number,
    clientY: number,
    pane: HTMLElement,
    bounded: boolean,
  ): Point | null {
    const bounds = pane.getBoundingClientRect();
    const dx = clientX - bounds.left - bounds.width / 2 - view.x;
    const dy = clientY - bounds.top - bounds.height / 2 - view.y;
    const angle = (view.rotation * Math.PI) / 180;
    const x =
      (dx * Math.cos(angle) + dy * Math.sin(angle)) / (fit * view.zoom * natural.width) + 0.5;
    const y =
      (-dx * Math.sin(angle) + dy * Math.cos(angle)) / (fit * view.zoom * natural.height) + 0.5;
    if (!bounded && (x < 0 || y < 0 || x > 1 || y > 1)) return null;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  }

  function rectFromPoints(start: Point, end: Point): ImageAnnotation {
    return {
      id: "preview",
      type: "rect",
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      text: "",
      color,
    };
  }

  function pointerDown(event: PointerEvent<HTMLElement>) {
    if (!available || event.button !== 0 || gesture.current) return;
    event.currentTarget.focus();
    const annotationId = (event.target as Element)
      .closest("[data-annotation-id]")
      ?.getAttribute("data-annotation-id");
    if (!drawing && annotationId) {
      setSelected(annotationId);
      setAnnotationOpen(true);
      return;
    }
    if (drawing) {
      if (!canAnnotate || draft.annotations.length >= 100) return;
      const point = imagePoint(event.clientX, event.clientY, event.currentTarget, false);
      if (!point) return;
      gesture.current = { type: "draw", pointerId: event.pointerId, start: point, end: point };
      setPreview(rectFromPoints(point, point));
    } else {
      gesture.current = {
        type: "pan",
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        view,
      };
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.type === "pan") {
      setView({
        ...active.view,
        x: active.view.x + event.clientX - active.start.x,
        y: active.view.y + event.clientY - active.start.y,
      });
    } else {
      const point = imagePoint(event.clientX, event.clientY, event.currentTarget, true);
      if (point) {
        active.end = point;
        setPreview(rectFromPoints(active.start, point));
      }
    }
  }

  function finishGesture(event: PointerEvent<HTMLElement>, cancelled = false) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setPreview(null);
    if (
      active.type !== "draw" ||
      cancelled ||
      !canAnnotate ||
      draftRef.current.annotations.length >= 100
    )
      return;
    const point = imagePoint(event.clientX, event.clientY, event.currentTarget, true) ?? active.end;
    const rectangle = rectFromPoints(active.start, point);
    if (
      rectangle.width * natural.width * fit * view.zoom < 3 ||
      rectangle.height * natural.height * fit * view.zoom < 3
    )
      return;
    const annotation = { ...rectangle, id: crypto.randomUUID() };
    changeAnnotations([...draftRef.current.annotations, annotation]);
    setSelected(annotation.id);
    setDrawing(false);
  }

  function addCenteredAnnotation() {
    if (!canAnnotate || draftRef.current.annotations.length >= 100) return;
    const annotation: ImageAnnotation = {
      id: crypto.randomUUID(),
      type: "rect",
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
      text: "",
      color,
    };
    changeAnnotations([...draftRef.current.annotations, annotation]);
    setSelected(annotation.id);
    setDrawing(false);
  }

  async function saveAnnotations() {
    if (
      !onSaveAnnotations ||
      !analysis ||
      !draftRef.current.dirty ||
      draftRef.current.saving ||
      waiting
    )
      return;
    const snapshot = copyAnnotations(draftRef.current.annotations);
    updateDraft({ annotations: snapshot, dirty: true, saving: true });
    try {
      await onSaveAnnotations(snapshot);
      const next = { annotations: snapshot, dirty: false, saving: false };
      updateDraft(next);
      if (mounted.current) setError(null);
    } catch (reason) {
      const next = { annotations: snapshot, dirty: true, saving: false };
      updateDraft(next);
      if (mounted.current) setError(reason instanceof Error ? reason.message : "标注保存失败");
    }
  }

  async function toggleFullscreen() {
    const root = rootRef.current;
    if (!root) return;
    setError(null);
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else {
        if (!root.requestFullscreen) throw new Error("当前浏览器不支持全屏");
        focusReturn.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        await root.requestFullscreen();
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "无法进入全屏");
    }
  }

  async function requestHeatmap() {
    if (!onHeatmap || !analysis || waiting) return;
    setError(null);
    setHeatmapRequest(true);
    try {
      await onHeatmap();
      if (mounted.current) {
        setShowHeatmap(true);
        setHeatmapFailed(false);
        setMode("adjusted");
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "关注区域生成失败");
    } finally {
      if (mounted.current) setHeatmapRequest(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (fullscreen && event.key === "Tab") {
      const focusable = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), [tabindex='0']",
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === rootRef.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === rootRef.current)
      ) {
        event.preventDefault();
        first?.focus();
      }
    }
    if (event.key === "Escape") {
      gesture.current = null;
      setPreview(null);
      setDrawing(false);
      if (fullscreen) {
        event.preventDefault();
        void toggleFullscreen();
      }
    }
    if (!(event.target instanceof HTMLElement) || !event.target.classList.contains("imaging-pane"))
      return;
    if (event.key === "Enter" && drawing) {
      event.preventDefault();
      addCenteredAnnotation();
    }
    if (!available) return;
    const step = event.shiftKey ? 60 : 20;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      setView((current) => ({
        ...current,
        x: current.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
        y: current.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
      }));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setView((current) => ({ ...current, zoom: clamp(current.zoom * 1.25, 0.25, 8) }));
    } else if (event.key === "-") {
      event.preventDefault();
      setView((current) => ({ ...current, zoom: clamp(current.zoom / 1.25, 0.25, 8) }));
    }
  }

  const planeStyle: CSSProperties = {
    width: natural.width * fit,
    height: natural.height * fit,
    transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) rotate(${view.rotation}deg) scale(${view.zoom})`,
  };
  const imageFilter = `brightness(${brightness}%) contrast(${contrast}%)`;

  function renderPane(adjusted: boolean, index: number) {
    return (
      <section
        key={index}
        ref={index === 0 ? firstPaneRef : undefined}
        className={`imaging-pane ${drawing && canAnnotate ? "is-drawing" : ""}`}
        tabIndex={source && !failed ? 0 : -1}
        aria-label={adjusted ? "调整后的影像" : "原始影像"}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={(event) => finishGesture(event, true)}
        onLostPointerCapture={() => {
          gesture.current = null;
          setPreview(null);
        }}
      >
        {source && !failed ? (
          <>
            <div className="imaging-plane" style={planeStyle}>
              <Image
                className="imaging-image"
                width={natural.width || analysis?.width || 224}
                height={natural.height || analysis?.height || 224}
                unoptimized
                src={source}
                alt={filename ?? "影像切片"}
                draggable={false}
                style={{ filter: adjusted ? imageFilter : "none" }}
                onLoad={(event) =>
                  setNatural({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                onError={() => setFailed(true)}
              />
              {adjusted && showHeatmap && heatmapUrl && !heatmapFailed && (
                <Image
                  className="imaging-heatmap"
                  width={natural.width}
                  height={natural.height}
                  unoptimized
                  src={heatmapUrl}
                  alt="模型关注区域"
                  draggable={false}
                  style={{ opacity: heatmapOpacity / 100 }}
                  onError={() => {
                    setHeatmapFailed(true);
                    setError("关注区域影像无法显示");
                  }}
                />
              )}
              {natural.width > 0 && (
                <svg
                  className="imaging-annotations"
                  viewBox={`0 0 ${natural.width} ${natural.height}`}
                  aria-label="影像标注"
                >
                  {[...draft.annotations, ...(preview ? [preview] : [])].map((item) => (
                    <g
                      key={item.id}
                      data-annotation-id={item.id === "preview" ? undefined : item.id}
                    >
                      <rect
                        x={item.x * natural.width}
                        y={item.y * natural.height}
                        width={item.width * natural.width}
                        height={item.height * natural.height}
                        fill={selected === item.id ? `${item.color}20` : "transparent"}
                        stroke={item.color}
                        strokeWidth={selected === item.id ? 2.5 : 1.5}
                        vectorEffect="non-scaling-stroke"
                        strokeDasharray={item.id === "preview" ? "5 3" : undefined}
                      />
                      {item.text && (
                        <text
                          x={item.x * natural.width + 3 / fit}
                          y={
                            item.y * natural.height +
                            Math.min(18 / fit, item.height * natural.height * 0.8)
                          }
                          fill={item.color}
                          stroke="#080c16"
                          strokeWidth={2 / fit}
                          paintOrder="stroke"
                          fontSize={12 / fit}
                        >
                          {item.text}
                        </text>
                      )}
                    </g>
                  ))}
                </svg>
              )}
            </div>
            {!available && (
              <div className="imaging-empty">
                <LoaderCircle size={28} className="imaging-spin" aria-label="加载影像" />
              </div>
            )}
            {mode === "compare" && (
              <span className="imaging-pane-label">{adjusted ? "调整" : "原图"}</span>
            )}
            {drawing && canAnnotate && <span className="imaging-draw-label">绘制矩形</span>}
          </>
        ) : (
          <div className="imaging-empty" role={failed ? "alert" : undefined}>
            <ScanLine size={42} strokeWidth={1.3} />
            <h3>{failed ? "无法显示影像" : "请上传影像"}</h3>
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      ref={rootRef}
      className={`card viewer-card imaging-viewer ${fullscreen ? "is-fullscreen" : ""}`}
      aria-label="影像预览"
      tabIndex={-1}
      onKeyDown={keyDown}
    >
      <div className="imaging-heading">
        <h2 className="section-title">
          <ScanLine size={18} />
          影像预览
        </h2>
        <fieldset className="imaging-modes" aria-label="影像显示模式">
          {(
            [
              ["original", "原图"],
              ["adjusted", "调整"],
              ["compare", "对照"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={!source || failed}
              onClick={() => {
                setMode(value);
                gesture.current = null;
                setPreview(null);
              }}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="imaging-tools" role="toolbar" aria-label="影像工具栏">
        <div className="imaging-tool-group">
          <button
            type="button"
            className="icon-button"
            title="缩小"
            aria-label="缩小影像"
            disabled={!available || view.zoom <= 0.25}
            onClick={() =>
              setView((current) => ({ ...current, zoom: clamp(current.zoom / 1.25, 0.25, 8) }))
            }
          >
            <ZoomOut size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="放大"
            aria-label="放大影像"
            disabled={!available || view.zoom >= 8}
            onClick={() =>
              setView((current) => ({ ...current, zoom: clamp(current.zoom * 1.25, 0.25, 8) }))
            }
          >
            <ZoomIn size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="旋转 90°"
            aria-label="顺时针旋转显示九十度"
            disabled={!available}
            onClick={() => {
              gesture.current = null;
              setPreview(null);
              setView((current) => ({
                ...current,
                rotation: (current.rotation + 90) % 360,
                x: 0,
                y: 0,
              }));
            }}
          >
            <RotateCw size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="适应画布"
            aria-label="适应画布"
            disabled={!available}
            onClick={() => setView((current) => ({ ...current, zoom: 1, x: 0, y: 0 }))}
          >
            <Maximize size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="重置显示"
            aria-label="重置影像显示"
            disabled={!available}
            onClick={() => {
              setView(INITIAL_VIEW);
              setBrightness(100);
              setContrast(100);
            }}
          >
            <RotateCcw size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={fullscreen ? "退出全屏" : "全屏"}
            aria-label={fullscreen ? "退出全屏" : "全屏查看影像"}
            disabled={!source && !fullscreen}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <Minimize size={17} /> : <Fullscreen size={17} />}
          </button>
        </div>
        <div className="imaging-tool-group">
          {onHeatmap && (
            <button
              type="button"
              className="button button-secondary imaging-compact"
              disabled={!analysis || !available || waiting || draft.saving}
              onClick={() => void requestHeatmap()}
            >
              {waiting ? <LoaderCircle size={15} className="imaging-spin" /> : <Focus size={15} />}
              关注区域
            </button>
          )}
          {analysis && onSaveAnnotations && (
            <button
              type="button"
              className={`button button-secondary imaging-compact ${annotationOpen ? "is-active" : ""}`}
              aria-expanded={annotationOpen}
              onClick={() => setAnnotationOpen((current) => !current)}
            >
              <Square size={15} />
              标注
            </button>
          )}
        </div>
      </div>
      {mode !== "original" && source && !failed && (
        <div className="imaging-adjustments">
          <label>
            亮度{" "}
            <input
              type="range"
              min="25"
              max="250"
              value={brightness}
              aria-label="亮度"
              onChange={(event) => setBrightness(Number(event.target.value))}
            />
            <output>{brightness}%</output>
          </label>
          <label>
            对比度{" "}
            <input
              type="range"
              min="25"
              max="250"
              value={contrast}
              aria-label="对比度"
              onChange={(event) => setContrast(Number(event.target.value))}
            />
            <output>{contrast}%</output>
          </label>
        </div>
      )}
      {heatmapUrl && mode !== "original" && (
        <div className="imaging-heatmap-controls">
          <button
            type="button"
            className={`button button-quiet imaging-compact ${showHeatmap ? "is-active" : ""}`}
            aria-pressed={showHeatmap}
            onClick={() => setShowHeatmap((current) => !current)}
          >
            <Focus size={15} />
            关注区域
          </button>
          <label>
            透明度{" "}
            <input
              type="range"
              min="0"
              max="100"
              value={heatmapOpacity}
              disabled={!showHeatmap || heatmapFailed}
              aria-label="关注区域透明度"
              onChange={(event) => setHeatmapOpacity(Number(event.target.value))}
            />
            <output>{heatmapOpacity}%</output>
          </label>
        </div>
      )}
      <div ref={stageRef} className={`imaging-stage ${mode === "compare" ? "is-compare" : ""}`}>
        {mode === "compare"
          ? [renderPane(false, 0), renderPane(true, 1)]
          : renderPane(mode === "adjusted", 0)}
        {available && <span className="imaging-zoom">{Math.round(view.zoom * 100)}%</span>}
      </div>
      <div className="imaging-footer">
        <span title={filename ?? undefined}>{filename ?? "未选择文件"}</span>
        {available && (
          <span>
            {natural.width} × {natural.height}
          </span>
        )}
      </div>
      {annotationOpen && analysis && onSaveAnnotations && (
        <section className="imaging-annotation-editor" aria-label="标注编辑器">
          <div className="imaging-annotation-toolbar">
            <button
              type="button"
              className={`button button-secondary imaging-compact ${drawing ? "is-active" : ""}`}
              aria-pressed={drawing}
              disabled={!canAnnotate || draft.annotations.length >= 100}
              title="拖动绘制矩形；画布上按 Enter 添加居中矩形"
              onClick={() => {
                setDrawing((current) => !current);
                firstPaneRef.current?.focus();
              }}
            >
              {drawing ? <MousePointer2 size={15} /> : <Square size={15} />}
              {drawing ? "取消绘制" : "新增标注"}
            </button>
            <button
              type="button"
              className="icon-button danger-icon"
              aria-label="清空全部标注"
              title="清空全部标注"
              disabled={!canAnnotate || !draft.annotations.length}
              onClick={() => {
                changeAnnotations([]);
                setSelected(null);
                setDrawing(false);
              }}
            >
              <Trash2 size={16} />
            </button>
            <span className="imaging-annotation-count">
              {draft.annotations.length}/100{draft.dirty ? " · 未保存" : ""}
            </span>
            <button
              type="button"
              className="button button-primary imaging-compact imaging-save"
              disabled={!canAnnotate || !draft.dirty}
              onClick={() => void saveAnnotations()}
            >
              {draft.saving ? (
                <LoaderCircle className="imaging-spin" size={15} />
              ) : draft.dirty ? (
                <Save size={15} />
              ) : (
                <Check size={15} />
              )}
              {draft.saving ? "保存中" : "保存标注"}
            </button>
          </div>
          {!!draft.annotations.length && (
            <fieldset className="imaging-annotation-list" aria-label="选择标注">
              {draft.annotations.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selected === item.id}
                  className={selected === item.id ? "is-active" : ""}
                  onClick={() => {
                    setSelected(item.id);
                    setDrawing(false);
                  }}
                >
                  <span style={{ backgroundColor: item.color }} />
                  {item.text || `标注 ${index + 1}`}
                </button>
              ))}
            </fieldset>
          )}
          {selectedAnnotation && (
            <div className="imaging-annotation-fields">
              <label className="imaging-label-input">
                标签
                <input
                  type="text"
                  value={selectedAnnotation.text}
                  maxLength={100}
                  disabled={!canAnnotate}
                  aria-label="标注标签"
                  onChange={(event) =>
                    changeAnnotations(
                      draft.annotations.map((item) =>
                        item.id === selected ? { ...item, text: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <label className="imaging-color-input">
                颜色
                <input
                  type="color"
                  value={selectedAnnotation.color}
                  disabled={!canAnnotate}
                  aria-label="标注颜色"
                  onChange={(event) => {
                    setColor(event.target.value);
                    changeAnnotations(
                      draft.annotations.map((item) =>
                        item.id === selected ? { ...item, color: event.target.value } : item,
                      ),
                    );
                  }}
                />
              </label>
              <button
                type="button"
                className="icon-button danger-icon"
                title="删除所选标注"
                aria-label="删除所选标注"
                disabled={!canAnnotate}
                onClick={() => {
                  changeAnnotations(draft.annotations.filter((item) => item.id !== selected));
                  setSelected(null);
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          )}
        </section>
      )}
      {error && (
        <div className="notice imaging-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
