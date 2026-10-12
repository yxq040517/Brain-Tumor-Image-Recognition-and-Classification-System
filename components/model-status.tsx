"use client";

import { Check, ChevronDown, FolderOpen, LoaderCircle, Trash2, Upload, X } from "lucide-react";
import { type InputHTMLAttributes, useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  LABELS,
  type ModelCatalog,
  type ModelInfo,
  type ModelProfile,
  type TumorLabel,
} from "@/lib/types";

export interface ModelStatusProps {
  model: ModelInfo | null;
  error?: string | null;
  disabled?: boolean;
  onChanged: (info: ModelInfo) => void;
}

const classLabels = Object.keys(LABELS) as TumorLabel[];
const directoryAttributes: InputHTMLAttributes<HTMLInputElement> & { webkitdirectory: string } = {
  webkitdirectory: "",
  multiple: true,
};
const countFormatter = new Intl.NumberFormat("zh-CN");
const sizeFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${sizeFormatter.format(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${sizeFormatter.format(bytes / 1024 ** 2)} MB`;
  return `${sizeFormatter.format(bytes / 1024 ** 3)} GB`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function ModelDetails({ model }: { model: ModelInfo | ModelProfile }) {
  return (
    <dl className="model-detail-grid">
      <dt>名称</dt>
      <dd>{model.name}</dd>
      <dt>架构</dt>
      <dd>{model.architecture || "—"}</dd>
      <dt>输入</dt>
      <dd>
        {model.input_width} × {model.input_height}
      </dd>
      {"device" in model && (
        <>
          <dt>设备</dt>
          <dd>{model.device || "—"}</dd>
        </>
      )}
      <dt>参数量</dt>
      <dd>{countFormatter.format(model.parameters)}</dd>
      <dt>来源</dt>
      <dd>{model.origin === "builtin" ? "系统内置" : "本地上传"}</dd>
      <dt>类别顺序</dt>
      <dd className="model-class-order">
        {model.labels.map((label, index) => (
          <span key={label}>
            {index}: {LABELS[label].name}
          </span>
        ))}
      </dd>
      <dt>版本</dt>
      <dd>{model.revision || "—"}</dd>
    </dl>
  );
}

export function ModelStatus({ model, error, disabled = false, onChanged }: ModelStatusProps) {
  const id = useId();
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const restoringFocus = useRef(false);
  const alive = useRef(false);
  const mutationLock = useRef(false);
  const catalogSequence = useRef(0);
  const disabledRef = useRef(disabled);
  const onChangedRef = useRef(onChanged);
  disabledRef.current = disabled;
  onChangedRef.current = onChanged;

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [manualOrder, setManualOrder] = useState(false);
  const [order, setOrder] = useState<(TumorLabel | "")[]>(["", "", "", ""]);
  const [activateUpload, setActivateUpload] = useState(false);
  const controlsDisabled = disabled || busy !== null;
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const statusText = !model
    ? error
      ? "服务未连接"
      : "正在连接服务"
    : model.state === "ready"
      ? "模型就绪"
      : model.state === "loading"
        ? "模型加载中"
        : model.state === "missing"
          ? "模型未安装"
          : "模型不可用";

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);

  function openDetails() {
    cancelClose();
    if (!dialogRef.current?.open) setDetailsOpen(true);
  }

  function scheduleClose() {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = undefined;
      if (alive.current) setDetailsOpen(false);
    }, 160);
  }

  const loadCatalog = useCallback(async () => {
    const sequence = ++catalogSequence.current;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const next = await api.models();
      if (alive.current && sequence === catalogSequence.current) setCatalog(next);
    } catch (caught) {
      if (alive.current && sequence === catalogSequence.current)
        setCatalogError(errorMessage(caught));
    } finally {
      if (alive.current && sequence === catalogSequence.current) setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++catalogSequence.current;
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!detailsOpen) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        cancelClose();
        setDetailsOpen(false);
      }
    }
    function dismissWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        cancelClose();
        if (
          rootRef.current?.contains(document.activeElement) &&
          document.activeElement !== badgeRef.current
        ) {
          restoringFocus.current = true;
          badgeRef.current?.focus();
          restoringFocus.current = false;
        }
        setDetailsOpen(false);
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithEscape);
    };
  }, [detailsOpen, cancelClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!managerOpen || !dialog) return;
    if (!dialog.open) dialog.showModal();
    void loadCatalog();
    return () => {
      ++catalogSequence.current;
      restoringFocus.current = true;
      if (dialog.open) dialog.close();
      badgeRef.current?.focus();
      restoringFocus.current = false;
    };
  }, [managerOpen, loadCatalog]);

  useEffect(() => {
    if (deleteId) confirmRef.current?.focus();
  }, [deleteId]);

  function openManager() {
    cancelClose();
    setDetailsOpen(false);
    setDeleteId(null);
    setManagerOpen(true);
  }

  function closeManager() {
    setDeleteId(null);
    setManagerOpen(false);
    setDetailsOpen(false);
  }

  async function mutate(message: string, action: () => Promise<void>) {
    if (mutationLock.current || disabledRef.current) return;
    mutationLock.current = true;
    ++catalogSequence.current;
    setCatalogLoading(false);
    setBusy(message);
    setOperationError(null);
    setSuccess(null);
    try {
      await action();
    } catch (caught) {
      if (alive.current) setOperationError(errorMessage(caught));
    } finally {
      mutationLock.current = false;
      if (alive.current) {
        setBusy(null);
        if (dialogRef.current?.open) void loadCatalog();
      }
    }
  }

  async function activate(profile: ModelProfile) {
    const next = await api.activateModel(profile.id);
    if (!alive.current) return;
    setCatalog(
      (current) =>
        current && {
          active_id: next.profile_id,
          items: current.items.map((item) => ({ ...item, active: item.id === next.profile_id })),
        },
    );
    setDeleteId(null);
    onChangedRef.current(next);
    setSuccess(`已启用：${next.name}`);
  }

  function selectFiles(selected: FileList | null) {
    if (controlsDisabled || !selected?.length) return;
    const next = Array.from(selected);
    setFiles(next);
    setOperationError(null);
    setSuccess(null);
    if (!name.trim()) {
      const inferred =
        next[0].webkitRelativePath.split("/")[0] || next[0].name.replace(/\.zip$/i, "");
      setName(inferred.slice(0, 80));
    }
  }

  async function upload() {
    if (mutationLock.current || disabledRef.current) return;
    if (!files.length) {
      setOperationError("请选择模型包 ZIP 或模型目录。");
      return;
    }
    if (!name.trim()) {
      setOperationError("请输入模型名称。");
      return;
    }
    if (
      manualOrder &&
      (order.some((label) => !label) || new Set(order).size !== classLabels.length)
    ) {
      setOperationError("请为输出 0–3 分别选择不同的类别。");
      return;
    }
    const uploadFiles = files;
    const uploadName = name.trim();
    const uploadLabels = manualOrder ? (order as TumorLabel[]) : undefined;
    const shouldActivate = activateUpload;
    await mutate("正在上传并验证…", async () => {
      const profile = await api.uploadModel(uploadFiles, uploadName, uploadLabels);
      if (!alive.current) return;
      setCatalog((current) => current && { ...current, items: [...current.items, profile] });
      setFiles([]);
      setName("");
      setManualOrder(false);
      setOrder(["", "", "", ""]);
      setActivateUpload(false);
      if (zipRef.current) zipRef.current.value = "";
      if (directoryRef.current) directoryRef.current.value = "";
      setSuccess(`已上传：${profile.name}`);
      if (shouldActivate && !disabledRef.current) {
        setBusy("正在启用…");
        try {
          await activate(profile);
        } catch (caught) {
          throw new Error(`模型已上传，启用失败：${errorMessage(caught)}`);
        }
      }
    });
  }

  return (
    <fieldset
      ref={rootRef}
      className="model-status-control"
      aria-label="模型状态与管理"
      onMouseEnter={openDetails}
      onMouseLeave={scheduleClose}
      onFocus={(event) => {
        if (!restoringFocus.current && !dialogRef.current?.contains(event.target)) openDetails();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose();
      }}
    >
      <button
        ref={badgeRef}
        type="button"
        className={`model-status model-status-trigger ${model?.state === "ready" ? "is-ready" : "not-ready"}`}
        aria-haspopup="dialog"
        aria-expanded={managerOpen}
        aria-controls={`${id}-manager`}
        aria-describedby={detailsOpen ? `${id}-details` : undefined}
        onClick={openManager}
      >
        <span className="status-dot" aria-hidden="true" />
        {statusText}
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {detailsOpen && !managerOpen && (
        <section id={`${id}-details`} className="model-status-popover" aria-label="当前模型详情">
          {model ? (
            <ModelDetails model={model} />
          ) : (
            <div className="model-detail-empty">{error || statusText}</div>
          )}
          {model?.error && <div className="model-detail-error">{model.error}</div>}
          <button type="button" className="button button-quiet" onClick={openManager}>
            管理模型
          </button>
        </section>
      )}

      <dialog
        id={`${id}-manager`}
        ref={dialogRef}
        className="model-manager-dialog"
        aria-labelledby={`${id}-title`}
        onCancel={(event) => {
          event.preventDefault();
          closeManager();
        }}
        onClose={() => {
          if (managerOpen) closeManager();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeManager();
          }
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            closeManager();
        }}
      >
        <header className="model-manager-heading">
          <h2 id={`${id}-title`}>管理模型</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭模型管理"
            onClick={closeManager}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <section
          className="model-manager-section"
          aria-labelledby={`${id}-list-title`}
          aria-busy={catalogLoading || busy !== null}
        >
          <div className="model-section-heading">
            <h3 id={`${id}-list-title`} ref={listTitleRef} tabIndex={-1}>
              本地模型
            </h3>
            <button
              type="button"
              className="button button-quiet"
              disabled={busy !== null || catalogLoading}
              onClick={() => void loadCatalog()}
            >
              刷新
            </button>
          </div>
          {catalogLoading && (
            <div className="model-manager-status" role="status">
              <LoaderCircle className="spin" size={16} aria-hidden="true" />
              正在读取模型…
            </div>
          )}
          {catalogError && (
            <div className="model-manager-error" role="alert">
              <span>{catalogError}</span>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy !== null || catalogLoading}
                onClick={() => void loadCatalog()}
              >
                重试
              </button>
            </div>
          )}
          <div className="model-catalog">
            {catalog?.items.map((profile) => {
              const active = profile.id === catalog.active_id;
              return (
                <article
                  key={profile.id}
                  className={`model-profile-card ${active ? "is-active" : ""}`}
                >
                  <div className="model-profile-heading">
                    <h4>{profile.name}</h4>
                    {active && (
                      <span className="model-active-tag">
                        <Check size={13} aria-hidden="true" />
                        当前使用
                      </span>
                    )}
                  </div>
                  <div className="model-profile-summary">
                    <span>{profile.origin === "builtin" ? "系统内置" : "本地上传"}</span>
                    <span>{profile.architecture}</span>
                    <span>
                      {profile.input_width} × {profile.input_height}
                    </span>
                    <span>{fileSize(profile.size_bytes)}</span>
                  </div>
                  <details className="model-profile-details">
                    <summary>模型详情</summary>
                    <ModelDetails model={profile} />
                  </details>
                  {!active && (
                    <div className="model-profile-actions">
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={controlsDisabled || catalogLoading}
                        aria-label={`启用 ${profile.name}`}
                        onClick={() => void mutate("正在启用…", () => activate(profile))}
                      >
                        启用
                      </button>
                      {profile.origin === "local" && (
                        <button
                          type="button"
                          className="button button-quiet model-delete-button"
                          disabled={controlsDisabled || catalogLoading}
                          aria-label={`删除 ${profile.name}`}
                          onClick={() => {
                            setOperationError(null);
                            setDeleteId(profile.id);
                          }}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                          删除
                        </button>
                      )}
                    </div>
                  )}
                  {deleteId === profile.id && !active && profile.origin === "local" && (
                    <fieldset
                      className="model-delete-confirm"
                      aria-label={`确认删除 ${profile.name}`}
                    >
                      <strong>删除「{profile.name}」？</strong>
                      <div className="model-profile-actions">
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={controlsDisabled}
                          onClick={() => {
                            setDeleteId(null);
                            listTitleRef.current?.focus();
                          }}
                        >
                          取消
                        </button>
                        <button
                          ref={confirmRef}
                          type="button"
                          className="button button-danger"
                          disabled={controlsDisabled}
                          onClick={() =>
                            void mutate("正在删除…", async () => {
                              await api.removeModel(profile.id);
                              if (!alive.current) return;
                              setCatalog(
                                (current) =>
                                  current && {
                                    ...current,
                                    items: current.items.filter((item) => item.id !== profile.id),
                                  },
                              );
                              setDeleteId(null);
                              setSuccess(`已删除：${profile.name}`);
                              if (dialogRef.current?.open) listTitleRef.current?.focus();
                            })
                          }
                        >
                          确认删除
                        </button>
                      </div>
                    </fieldset>
                  )}
                </article>
              );
            })}
            {catalog && !catalog.items.length && <div className="model-detail-empty">暂无模型</div>}
          </div>
        </section>

        <section className="model-manager-section" aria-labelledby={`${id}-upload-title`}>
          <h3 id={`${id}-upload-title`}>上传模型</h3>
          <form
            className="model-upload-form"
            onSubmit={(event) => {
              event.preventDefault();
              void upload();
            }}
          >
            <fieldset disabled={controlsDisabled}>
              <label className="model-form-field" htmlFor={`${id}-name`}>
                <span>模型名称</span>
                <input
                  id={`${id}-name`}
                  value={name}
                  maxLength={80}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <div className="model-file-controls">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => zipRef.current?.click()}
                >
                  <Upload size={16} aria-hidden="true" />
                  模型包 ZIP
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => directoryRef.current?.click()}
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  模型目录
                </button>
                <input
                  ref={zipRef}
                  type="file"
                  accept=".zip,application/zip"
                  aria-label="选择模型包 ZIP"
                  hidden
                  onChange={(event) => {
                    selectFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <input
                  ref={directoryRef}
                  type="file"
                  {...directoryAttributes}
                  aria-label="选择模型目录"
                  hidden
                  onChange={(event) => {
                    selectFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </div>
              {files.length > 0 && (
                <details className="model-selected-files">
                  <summary>
                    已选择 {countFormatter.format(files.length)} 个文件 · {fileSize(totalBytes)}
                  </summary>
                  <ul>
                    {files.map((file) => (
                      <li key={file.webkitRelativePath || file.name}>
                        <span>{file.webkitRelativePath || file.name}</span>
                        <span>{fileSize(file.size)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <label className="model-form-field" htmlFor={`${id}-order`}>
                <span>输出类别</span>
                <select
                  id={`${id}-order`}
                  value={manualOrder ? "manual" : "auto"}
                  onChange={(event) => {
                    setManualOrder(event.target.value === "manual");
                    setOperationError(null);
                  }}
                >
                  <option value="auto">自动识别</option>
                  <option value="manual">手动指定顺序</option>
                </select>
              </label>
              {manualOrder && (
                <div className="model-output-order">
                  {[0, 1, 2, 3].map((output) => (
                    <label
                      className="model-form-field"
                      key={`output-${output}`}
                      htmlFor={`${id}-class-${output}`}
                    >
                      <span>输出 {output}</span>
                      <select
                        id={`${id}-class-${output}`}
                        required
                        value={order[output]}
                        onChange={(event) =>
                          setOrder((current) =>
                            current.map((item, position) =>
                              position === output ? (event.target.value as TumorLabel) : item,
                            ),
                          )
                        }
                      >
                        <option value="">选择类别</option>
                        {classLabels.map((option) => (
                          <option
                            key={option}
                            value={option}
                            disabled={order.some(
                              (item, position) => position !== output && item === option,
                            )}
                          >
                            {LABELS[option].name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              <label className="model-activate-upload">
                <input
                  type="checkbox"
                  checked={activateUpload}
                  onChange={(event) => setActivateUpload(event.target.checked)}
                />
                <span>上传后启用</span>
              </label>
              <button
                type="submit"
                className="button button-primary model-upload-submit"
                disabled={!files.length}
              >
                <Upload size={16} aria-hidden="true" />
                上传模型
              </button>
            </fieldset>
          </form>
        </section>
        <div className="model-manager-feedback" aria-live="polite">
          {busy && (
            <div className="model-manager-status" role="status">
              <LoaderCircle className="spin" size={17} aria-hidden="true" />
              {busy}
            </div>
          )}
          {operationError && (
            <div className="model-manager-error" role="alert">
              <span>{operationError}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="清除操作错误"
                onClick={() => setOperationError(null)}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
          )}
          {success && !busy && (
            <div className="model-manager-success" role="status">
              <Check size={16} aria-hidden="true" />
              {success}
            </div>
          )}
        </div>
      </dialog>
    </fieldset>
  );
}
