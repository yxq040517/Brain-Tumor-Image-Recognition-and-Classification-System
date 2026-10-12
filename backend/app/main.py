import asyncio
import json
import logging
import stat
import struct
import tempfile
import zipfile
import zlib
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image
from starlette.datastructures import Headers, MutableHeaders
from starlette.datastructures import UploadFile as StarletteUploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .database import AnalysisRecord, InvalidFilters, MissingRecords, Repository
from .images import decode_raster, read_upload, safe_filename
from .model import ModelConfigurationError, ModelEngine, ModelUnavailable
from .model_registry import ModelConflictError, ModelNotFoundError
from .reports import build_excel, build_pdf
from .schemas import (
    LABELS,
    Analysis,
    AnalysisPage,
    AnalysisPatch,
    BulkRequest,
    BulkResult,
    ExportSelection,
    GroupCount,
    Health,
    HeatmapResult,
    ListOptions,
    ModelCatalog,
    ModelInfo,
    ModelProfile,
    Stats,
    TumorLabel,
)
from .settings import MAX_UPLOAD_BYTES, Settings

logger = logging.getLogger(__name__)
ALLOWED_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://localhost:3000",
    "https://127.0.0.1:3000",
}
MAX_MODEL_UPLOAD_BYTES = 512 * 1024 * 1024
MAX_MODEL_EXPANDED_BYTES = 1024 * 1024 * 1024
MAX_MODEL_ENTRIES = 64
MAX_MODEL_CONFIG_BYTES = 1024 * 1024
MODEL_FILES = {"config.json", "preprocessor_config.json", "model.safetensors"}
READ_CHUNK = 1024 * 1024


class RequestSafetyMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if scope["method"] in {"POST", "PATCH", "DELETE"}:
            origin = headers.get("origin")
            if origin is not None and origin not in ALLOWED_ORIGINS:
                await JSONResponse(
                    {"detail": "拒绝跨站修改请求，请从本机系统页面操作。"},
                    status_code=403,
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
                )(scope, receive, send)
                return
        image_upload = scope["method"] == "POST" and scope["path"] == "/api/analyses"
        model_upload = scope["method"] == "POST" and scope["path"] == "/api/models/upload"
        upload = image_upload or model_upload
        body_limit = (
            MAX_MODEL_UPLOAD_BYTES + 1024 * 1024 if model_upload else MAX_UPLOAD_BYTES + 64 * 1024
        )
        limit_message = (
            "模型上传请求过大，文件总量不得超过 512 MiB。"
            if model_upload
            else "上传请求过大，影像文件不得超过 10 MiB。"
        )
        if upload and headers.get("content-length") is not None:
            try:
                content_length = int(headers["content-length"])
                if content_length < 0:
                    raise ValueError
            except ValueError:
                await JSONResponse({"detail": "请求长度格式无效。"}, status_code=400)(
                    scope, receive, send
                )
                return
            if content_length > body_limit:
                await JSONResponse(
                    {"detail": limit_message},
                    status_code=413,
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
                )(scope, receive, send)
                return
        received = 0

        async def bounded_receive() -> Message:
            nonlocal received
            message = await receive()
            if upload and message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > body_limit:
                    raise HTTPException(413, limit_message)
            return message

        async def secured_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = MutableHeaders(scope=message)
                response_headers["Cache-Control"] = "no-store"
                response_headers["X-Content-Type-Options"] = "nosniff"
            await send(message)

        await self.app(scope, bounded_receive, secured_send)


@asynccontextmanager
async def lifespan(application: FastAPI):
    settings = Settings()
    repository = await asyncio.to_thread(Repository, settings.data_dir)
    engine = ModelEngine(settings)
    application.state.repository = repository
    application.state.settings = settings
    application.state.model = engine
    # One active upload/normalization/inference job bounds decoded-image memory too.
    application.state.analysis_gate = asyncio.Semaphore(1)
    loading_task = asyncio.create_task(asyncio.to_thread(engine.load))
    try:
        yield
    finally:
        await loading_task
        await asyncio.to_thread(repository.close)


app = FastAPI(
    title="脑瘤影像识别分类系统 · 本地研究接口",
    description="仅用于研究与教育的二维脑部 MRI 切片分类，不用于临床诊断。",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(RequestSafetyMiddleware)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, _exception: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        {"detail": "请求字段、资源编号或筛选条件格式不正确，请检查提交内容及分页参数。"},
        status_code=422,
    )


@app.exception_handler(StarletteHTTPException)
async def http_error(_request: Request, exception: StarletteHTTPException) -> JSONResponse:
    detail = exception.detail
    if detail == "Not Found":
        detail = "请求的资源不存在。"
    elif detail == "Method Not Allowed":
        detail = "此接口不支持当前请求方法。"
    elif detail == "There was an error parsing the body":
        detail = "无法读取上传内容，请检查文件和请求格式。"
    return JSONResponse(
        {"detail": detail}, status_code=exception.status_code, headers=exception.headers
    )


@app.exception_handler(Exception)
async def unexpected_error(_request: Request, exception: Exception) -> JSONResponse:
    logger.error("研究接口处理失败", exc_info=exception)
    return JSONResponse(
        {"detail": "本地处理失败，请检查服务终端、数据目录权限及可用内存后重试。"},
        status_code=500,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.get("/api/model", response_model=ModelInfo)
def model_info(request: Request) -> ModelInfo:
    return request.app.state.model.info()


def model_entry_path(value: str) -> tuple[str, ...]:
    if not value or "\x00" in value or value.startswith(("/", "\\")):
        raise HTTPException(400, "模型文件路径不可为空、绝对路径或网络共享路径。")
    normalized = value.replace("\\", "/")
    parts = normalized.rstrip("/").split("/")
    if len(normalized) > 1024 or any(len(part) > 255 for part in parts):
        raise HTTPException(400, "模型文件路径过长。")
    for part in parts:
        if (
            part in {"", ".", ".."}
            or ":" in part
            or part.endswith((".", " "))
            or any(ord(character) < 32 for character in part)
            or any(character in '<>"|?*' for character in part)
            or part.split(".")[0].upper()
            in {
                "CON",
                "PRN",
                "AUX",
                "NUL",
                "COM1",
                "COM2",
                "COM3",
                "COM4",
                "COM5",
                "COM6",
                "COM7",
                "COM8",
                "COM9",
                "LPT1",
                "LPT2",
                "LPT3",
                "LPT4",
                "LPT5",
                "LPT6",
                "LPT7",
                "LPT8",
                "LPT9",
            }
        ):
            raise HTTPException(400, "模型文件包含不安全或无法在本机保存的路径。")
    return tuple(PurePosixPath(*parts).parts)


def normalized_model_entries(
    entries: list[tuple[tuple[str, ...], object]],
) -> list[tuple[str, object]]:
    paths = [path for path, _entry in entries]
    if paths and all(len(path) > 1 and path[0] == paths[0][0] for path in paths):
        entries = [(path[1:], entry) for path, entry in entries]
    names: set[str] = set()
    result = []
    for path, entry in entries:
        if len(path) != 1:
            raise HTTPException(415, "模型文件必须位于同一目录；ZIP 可包含一个共同根文件夹。")
        name = path[0]
        if name.casefold() in names:
            raise HTTPException(400, "模型包包含重复的文件名。")
        names.add(name.casefold())
        if name not in MODEL_FILES:
            raise HTTPException(
                415,
                "仅接受 Hugging Face 的 config.json、preprocessor_config.json 和完整 "
                "model.safetensors；不支持分片、pt/pth/bin/onnx、脚本或其他文件。",
            )
        result.append((name, entry))
    if {name for name, _entry in result} != MODEL_FILES:
        raise HTTPException(
            422, "模型目录必须包含 config.json、preprocessor_config.json 和完整 model.safetensors。"
        )
    return result


def copy_model_stream(
    source, destination: Path, limit: int, totals: list[int], total_limit: int
) -> None:
    size = 0
    with destination.open("xb") as target:
        while chunk := source.read(READ_CHUNK):
            size += len(chunk)
            totals[0] += len(chunk)
            if size > limit or totals[0] > total_limit:
                raise HTTPException(
                    413,
                    "模型文件超出大小限制（上传总量 512 MiB、解压总量 1 GiB、配置文件 1 MiB）。",
                )
            target.write(chunk)


def check_zip_directory(archive_path: Path) -> None:
    # Bound central-directory allocation before ZipFile constructs its entry objects.
    with archive_path.open("rb") as source:
        size = source.seek(0, 2)
        source.seek(max(0, size - 65557))
        tail = source.read(65557)
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or len(tail) - offset < 22:
        raise HTTPException(400, "模型 ZIP 缺少完整的目录尾记录。")
    (
        _signature,
        disk,
        directory_disk,
        disk_entries,
        total_entries,
        directory_size,
        directory_offset,
        comment_size,
    ) = struct.unpack_from("<4s4H2LH", tail, offset)
    if len(tail) - offset != 22 + comment_size:
        raise HTTPException(400, "模型 ZIP 被截断或包含无效的尾部数据。")
    if disk or directory_disk or disk_entries != total_entries:
        raise HTTPException(415, "不支持分卷模型 ZIP，请使用单个完整 ZIP。")
    if total_entries > MAX_MODEL_ENTRIES or directory_size > MAX_MODEL_ENTRIES * 4096:
        raise HTTPException(413, "模型 ZIP 条目不得超过 64，且目录信息不可过大。")
    if directory_offset + directory_size > size - len(tail) + offset:
        raise HTTPException(400, "模型 ZIP 的目录长度或位置无效。")


def register_model_upload(
    files: list[StarletteUploadFile],
    name: str,
    labels: list[TumorLabel] | None,
    engine: ModelEngine,
    staging_root: Path,
) -> ModelProfile:
    staging_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="upload-", dir=staging_root) as temporary:
        root = Path(temporary)
        candidate = root / "candidate"
        candidate.mkdir()
        paths = [(model_entry_path(file.filename or ""), file) for file in files]
        zip_upload = len(files) == 1 and paths[0][0][-1].lower().endswith(".zip")
        uploaded_bytes = [0]
        if zip_upload:
            archive_path = root / "archive.zip"
            files[0].file.seek(0)
            copy_model_stream(
                files[0].file,
                archive_path,
                MAX_MODEL_UPLOAD_BYTES,
                uploaded_bytes,
                MAX_MODEL_UPLOAD_BYTES,
            )
            try:
                check_zip_directory(archive_path)
                with zipfile.ZipFile(archive_path) as archive:
                    members = archive.infolist()
                    if len(members) > MAX_MODEL_ENTRIES:
                        raise HTTPException(413, "模型 ZIP 条目数量不得超过 64。")
                    entries = []
                    seen: set[str] = set()
                    expanded_size = 0
                    for member in members:
                        path = model_entry_path(member.orig_filename)
                        key = "/".join(path).casefold()
                        if key in seen:
                            raise HTTPException(400, "模型 ZIP 包含重复路径。")
                        seen.add(key)
                        mode = member.external_attr >> 16
                        kind = stat.S_IFMT(mode)
                        if (
                            kind not in {0, stat.S_IFREG, stat.S_IFDIR}
                            or member.external_attr & 0x400
                        ):
                            raise HTTPException(
                                400, "模型 ZIP 不得包含符号链接、特殊文件或重解析点。"
                            )
                        if member.flag_bits & 1 or member.compress_type not in {
                            zipfile.ZIP_STORED,
                            zipfile.ZIP_DEFLATED,
                        }:
                            raise HTTPException(
                                415, "模型 ZIP 必须未加密，且使用存储或 Deflate 压缩。"
                            )
                        expanded_size += member.file_size
                        if expanded_size > MAX_MODEL_EXPANDED_BYTES:
                            raise HTTPException(413, "模型 ZIP 解压总量不得超过 1 GiB。")
                        if member.is_dir():
                            if member.file_size or member.CRC or kind == stat.S_IFREG:
                                raise HTTPException(400, "模型 ZIP 的目录条目无效。")
                            with archive.open(member, "r") as source:
                                if source.read(1):
                                    raise HTTPException(400, "模型 ZIP 的目录不得包含数据。")
                            continue
                        if kind == stat.S_IFDIR:
                            raise HTTPException(400, "模型 ZIP 的文件条目无效。")
                        entries.append((path, member))
                    normalized = normalized_model_entries(entries)
                    expanded_bytes = [0]
                    for filename, member in normalized:
                        limit = (
                            MAX_MODEL_CONFIG_BYTES
                            if filename.endswith(".json")
                            else MAX_MODEL_EXPANDED_BYTES
                        )
                        if member.file_size > limit:
                            raise HTTPException(413, "模型配置文件或权重超出大小限制。")
                        with archive.open(member, "r") as source:
                            copy_model_stream(
                                source,
                                candidate / filename,
                                limit,
                                expanded_bytes,
                                MAX_MODEL_EXPANDED_BYTES,
                            )
                        if (candidate / filename).stat().st_size != member.file_size:
                            raise HTTPException(400, "模型 ZIP 的条目长度不完整。")
            except (
                zipfile.BadZipFile,
                zipfile.LargeZipFile,
                EOFError,
                RuntimeError,
                NotImplementedError,
                zlib.error,
                UnicodeError,
            ) as exc:
                raise HTTPException(
                    400, "模型 ZIP 损坏、CRC 校验失败或文件被截断，请重新打包上传。"
                ) from exc
        else:
            for filename, file in normalized_model_entries(paths):
                limit = (
                    MAX_MODEL_CONFIG_BYTES if filename.endswith(".json") else MAX_MODEL_UPLOAD_BYTES
                )
                file.file.seek(0)
                copy_model_stream(
                    file.file, candidate / filename, limit, uploaded_bytes, MAX_MODEL_UPLOAD_BYTES
                )
        return engine.registry.register_directory(candidate, name, labels, engine)


async def await_model_worker(job: asyncio.Task, action: str):
    try:
        return await asyncio.shield(job)
    except asyncio.CancelledError as cancellation:
        # A native model worker cannot be cancelled; retain gate and staging until it ends.
        while not job.done():
            try:
                await asyncio.shield(job)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if job.done() and not job.cancelled():
            try:
                job.result()
            except Exception:
                logger.exception("请求取消后，%s失败", action)
        raise cancellation


def checked_profile_id(profile_id: str) -> str:
    if profile_id == "builtin":
        return profile_id
    try:
        parsed = str(UUID(profile_id))
    except ValueError as exc:
        raise HTTPException(422, "模型编号必须为 builtin 或有效 UUID。") from exc
    if parsed != profile_id:
        raise HTTPException(422, "模型 UUID 必须使用规范格式。")
    return profile_id


@app.get("/api/models", response_model=ModelCatalog)
def model_catalog(request: Request) -> ModelCatalog:
    engine: ModelEngine = request.app.state.model
    try:
        active_id = engine.registry.active_id()
    except ModelConfigurationError:
        active_id = engine.info().profile_id
    return engine.registry.catalog(active_id)


class StagedModelParser(MultiPartParser):
    def __init__(self, request: Request, staging_dir: Path) -> None:
        super().__init__(
            request.headers,
            request.stream(),
            max_files=MAX_MODEL_ENTRIES,
            max_fields=3,
            max_part_size=MAX_MODEL_CONFIG_BYTES,
        )
        self.staging_dir = staging_dir
        self.complete = False

    def on_headers_finished(self) -> None:
        super().on_headers_finished()
        if self._current_part.file is not None:
            original = self._current_part.file.file
            staged = tempfile.SpooledTemporaryFile(
                max_size=self.spool_max_size, dir=self.staging_dir
            )
            self._current_part.file.file = staged
            self._files_to_close_on_error[-1] = staged
            original.close()

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        if (
            self._current_part.file is None
            and len(self._current_part.data) + end - start > self.max_part_size
        ):
            raise HTTPException(413, "模型上传的文本字段不得超过 1 MiB。")
        super().on_part_data(data, start, end)

    def on_end(self) -> None:
        self.complete = True


@asynccontextmanager
async def model_upload_form(request: Request):
    if (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        != "multipart/form-data"
    ):
        raise HTTPException(415, "模型上传必须使用 multipart/form-data。")
    staging_dir = request.app.state.settings.data_dir / "model-library" / "staging"
    await asyncio.to_thread(staging_dir.mkdir, parents=True, exist_ok=True)
    parser = StagedModelParser(request, staging_dir)
    form = None
    try:
        try:
            form = await parser.parse()
        except MultiPartException as exc:
            if parser._current_files > MAX_MODEL_ENTRIES:
                raise HTTPException(413, "模型上传文件数量不得超过 64。") from exc
            if parser._current_fields > 3:
                raise HTTPException(422, "模型上传包含过多表单字段。") from exc
            raise HTTPException(400, "模型上传表单损坏或缺少有效边界，请重新上传。") from exc
        if not parser.complete:
            raise HTTPException(400, "模型上传请求被截断，缺少完整的结束边界。")
        yield form
    finally:
        try:
            if form is not None:
                await form.close()
        finally:
            # Unfinished parts may not be in FormData; close every tracked spool.
            for file in parser._files_to_close_on_error:
                file.close()


@app.post("/api/models/upload", response_model=ModelProfile, status_code=201)
async def upload_model(request: Request) -> ModelProfile:
    async with model_upload_form(request) as form:
        fields = list(form.multi_items())
        if any(key not in {"files", "name", "labels_json"} for key, _value in fields):
            raise HTTPException(422, "模型上传仅支持 files、name 和 labels_json 字段。")
        files = form.getlist("files")
        if (
            not files
            or len(files) > MAX_MODEL_ENTRIES
            or any(not isinstance(file, StarletteUploadFile) for file in files)
        ):
            raise HTTPException(
                422, "请使用重复 files 字段上传一个 ZIP 或模型目录文件（最多 64 个）。"
            )
        names = form.getlist("name")
        if (
            len(names) != 1
            or not isinstance(names[0], str)
            or not 1 <= len(names[0]) <= 80
            or not names[0].strip()
        ):
            raise HTTPException(422, "模型名称必须为 1 至 80 个字符。")
        raw_labels = form.getlist("labels_json")
        if len(raw_labels) > 1 or (raw_labels and not isinstance(raw_labels[0], str)):
            raise HTTPException(422, "labels_json 必须为一个四分类标签 JSON 数组。")
        labels = None
        if raw_labels:
            try:
                labels = json.loads(raw_labels[0])
            except (ValueError, TypeError, RecursionError) as exc:
                raise HTTPException(422, "labels_json 不是有效 JSON。") from exc
            if (
                not isinstance(labels, list)
                or len(labels) != 4
                or any(not isinstance(label, str) for label in labels)
                or set(labels) != set(LABELS)
            ):
                raise HTTPException(
                    422,
                    "labels_json 须按模型输出顺序包含 "
                    "No Tumor、Glioma、Meningioma、Pituitary，各一次。",
                )
        try:
            job = asyncio.create_task(
                asyncio.to_thread(
                    register_model_upload,
                    files,
                    names[0].strip(),
                    labels,
                    request.app.state.model,
                    request.app.state.settings.data_dir / "model-library" / "staging",
                )
            )
            return await await_model_worker(job, "导入模型")
        except ModelConfigurationError as exc:
            raise HTTPException(422, str(exc)) from exc
        except ModelConflictError as exc:
            raise HTTPException(409, str(exc)) from exc
        except OSError as exc:
            logger.exception("模型暂存或登记失败")
            raise HTTPException(
                500, "模型保存失败，请检查数据目录权限和剩余磁盘空间；当前模型未改变。"
            ) from exc


@app.post("/api/models/{profile_id}/activate", response_model=ModelInfo)
async def activate_model(request: Request, profile_id: str) -> ModelInfo:
    checked_profile_id(profile_id)
    async with request.app.state.analysis_gate:
        try:
            job = asyncio.create_task(
                asyncio.to_thread(request.app.state.model.activate, profile_id)
            )
            return await await_model_worker(job, "切换模型")
        except ModelNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ModelConfigurationError as exc:
            raise HTTPException(422, str(exc)) from exc
        except ModelConflictError as exc:
            raise HTTPException(409, str(exc)) from exc
        except ModelUnavailable as exc:
            raise HTTPException(409, str(exc)) from exc


@app.delete("/api/models/{profile_id}", status_code=204, response_class=Response)
async def remove_model(request: Request, profile_id: str) -> Response:
    checked_profile_id(profile_id)
    async with request.app.state.analysis_gate:
        engine: ModelEngine = request.app.state.model
        try:
            job = asyncio.create_task(
                asyncio.to_thread(engine.registry.remove, profile_id, engine.info().profile_id)
            )
            await await_model_worker(job, "删除模型")
        except ModelNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ModelConflictError as exc:
            raise HTTPException(409, str(exc)) from exc
        except ModelConfigurationError as exc:
            raise HTTPException(422, str(exc)) from exc
    return Response(status_code=204)


@app.get("/api/health", response_model=Health)
def health(request: Request) -> Health:
    return Health(model=request.app.state.model.info())


@app.get("/api/stats", response_model=Stats)
def stats(request: Request, days: Annotated[int, Query()] = 7) -> Stats:
    if days not in (7, 30):
        raise HTTPException(422, "统计周期仅支持 7 天或 30 天。")
    return request.app.state.repository.stats(days)


@app.get("/api/groups", response_model=list[GroupCount])
def groups(request: Request) -> list[GroupCount]:
    return request.app.state.repository.groups()


@app.get("/api/analyses", response_model=AnalysisPage)
def list_analyses(request: Request, options: Annotated[ListOptions, Query()]) -> AnalysisPage:
    try:
        return request.app.state.repository.list(options)
    except InvalidFilters as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/analyses/bulk", response_model=BulkResult)
def bulk_analyses(request: Request, selection: BulkRequest) -> BulkResult:
    try:
        return request.app.state.repository.bulk(
            selection.action, [str(identifier) for identifier in selection.ids], selection.group
        )
    except MissingRecords as exc:
        raise HTTPException(404, str(exc)) from exc


def export_report(request: Request, selection: ExportSelection, format_name: str) -> Response:
    repository: Repository = request.app.state.repository
    try:
        with repository.lock:
            records = repository.export_records(selection, 200 if format_name == "pdf" else 10000)
            analyses = [record.as_analysis() for record in records]
            if format_name == "pdf":
                content = build_pdf(
                    analyses, {record.id: repository.image_file(record) for record in records}
                )
                media_type, extension = "application/pdf", "pdf"
            else:
                content = build_excel(analyses)
                media_type, extension = (
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "xlsx",
                )
    except MissingRecords as exc:
        raise HTTPException(404, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(
            409, "导出所需的影像文件不存在，请检查数据目录或删除损坏的记录后重试。"
        ) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except RuntimeError as exc:
        logger.exception("生成报告失败")
        raise HTTPException(500, f"无法生成报告：{exc}") from exc
    except (OverflowError, OSError) as exc:
        raise HTTPException(
            500, "报告生成失败，请检查日期范围、数据目录权限和剩余磁盘空间。"
        ) from exc
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="neurolens-{timestamp}.{extension}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.post("/api/exports/pdf")
def export_pdf(request: Request, selection: ExportSelection) -> Response:
    return export_report(request, selection, "pdf")


@app.post("/api/exports/excel")
def export_excel(request: Request, selection: ExportSelection) -> Response:
    return export_report(request, selection, "excel")


def analyze_upload(
    contents: bytes, filename: str, repository: Repository, engine: ModelEngine, group: str = ""
) -> Analysis:
    with decode_raster(contents) as image:
        probabilities, elapsed_ms, info = engine.predict(image)
        predicted = max(probabilities, key=lambda probability: probability.score)
        identifier = str(uuid4())
        image_name = f"{identifier}.png"
        image_path = repository.image_dir / image_name
        record = AnalysisRecord(
            id=identifier,
            filename=filename,
            width=image.width,
            height=image.height,
            created_at=datetime.now(UTC).replace(tzinfo=None),
            predicted_label=predicted.label,
            confidence=predicted.score,
            probabilities=[probability.model_dump() for probability in probabilities],
            inference_ms=elapsed_ms,
            model_id=info.model_id,
            model_revision=info.revision,
            model_metadata=info.model_dump(mode="json", exclude={"state", "error"}),
            image_path=image_name,
            group_name=group,
        )
        try:
            image.save(image_path, format="PNG")
            return repository.insert(record)
        except Exception:
            image_path.unlink(missing_ok=True)
            raise


@app.post("/api/analyses", response_model=Analysis, status_code=201)
async def create_analysis(
    request: Request,
    file: Annotated[UploadFile, File()],
    group: Annotated[str, Form(max_length=80)] = "",
) -> Analysis:
    try:
        engine: ModelEngine = request.app.state.model
        try:
            engine.require_ready()
        except ModelUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        async with request.app.state.analysis_gate:
            contents = await read_upload(file)
            job = asyncio.create_task(
                asyncio.to_thread(
                    analyze_upload,
                    contents,
                    safe_filename(file.filename),
                    request.app.state.repository,
                    engine,
                    group,
                )
            )
            try:
                return await await_model_worker(job, "本地分析")
            except ModelUnavailable as exc:
                raise HTTPException(503, str(exc)) from exc
    finally:
        await file.close()


def find_record(request: Request, identifier: UUID) -> AnalysisRecord:
    record = request.app.state.repository.get(str(identifier))
    if record is None:
        raise HTTPException(404, "未找到该分析记录，记录可能已被删除。")
    return record


@app.get("/api/analyses/{identifier}", response_model=Analysis)
def get_analysis(request: Request, identifier: UUID) -> Analysis:
    return find_record(request, identifier).as_analysis()


@app.patch("/api/analyses/{identifier}", response_model=Analysis)
def update_analysis(request: Request, identifier: UUID, patch: AnalysisPatch) -> Analysis:
    try:
        return request.app.state.repository.update(str(identifier), patch)
    except MissingRecords as exc:
        raise HTTPException(404, str(exc)) from exc


@app.delete("/api/analyses/{identifier}", status_code=204, response_class=Response)
def delete_analysis(request: Request, identifier: UUID) -> Response:
    if not request.app.state.repository.delete(str(identifier)):
        raise HTTPException(404, "未找到该分析记录，记录可能已被删除。")
    return Response(status_code=204)


@app.get("/api/analyses/{identifier}/image")
def analysis_image(request: Request, identifier: UUID) -> FileResponse:
    record = find_record(request, identifier)
    image_path = request.app.state.repository.image_file(record)
    if not image_path.is_file():
        raise HTTPException(404, "该记录的归一化影像文件不存在。")
    return FileResponse(
        image_path,
        media_type="image/png",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


def heatmap_model_info(record: AnalysisRecord, engine: ModelEngine) -> ModelInfo:
    try:
        engine.require_ready()
    except ModelUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    info = engine.info()
    metadata = record.saved_model_metadata()
    if (
        record.model_id != info.model_id
        or record.model_revision != info.revision
        or metadata.get("profile_id") != info.profile_id
        or metadata.get("labels") != info.labels
    ):
        raise HTTPException(
            409,
            "该记录使用的模型版本或标签映射与当前权重不一致，请使用当前模型重新分析后生成热力图。",
        )
    if not info.heatmap_supported or info.heatmap_method is None:
        raise HTTPException(409, "当前模型的预处理裁剪或架构不支持映射到原始影像的热力图。")
    return info


def generate_heatmap(
    repository: Repository, engine: ModelEngine, identifier: UUID
) -> HeatmapResult:
    with repository.lock:
        record = repository.get(str(identifier))
        if record is None:
            raise HTTPException(404, "未找到该分析记录，记录可能已被删除。")
        info = heatmap_model_info(record, engine)
        path = repository.heatmap_file(record)
        if not path.is_file():
            source = repository.image_file(record)
            if not source.is_file():
                raise HTTPException(404, "该记录的归一化影像文件不存在，无法生成热力图。")
            temporary = repository.heatmap_dir / f".heatmap-{identifier}-{uuid4().hex}.png"
            try:
                engine.require_ready()
                with Image.open(source) as image, image.convert("RGB") as rgb:
                    with engine.explain(rgb, record.predicted_label) as overlay:
                        if overlay.mode != "RGBA" or overlay.size != (record.width, record.height):
                            raise RuntimeError("模型返回的热力图尺寸或颜色格式无效。")
                        overlay.save(temporary, format="PNG")
                temporary.replace(path)
            except ModelUnavailable as exc:
                raise HTTPException(503, str(exc)) from exc
            except ModelConfigurationError as exc:
                raise HTTPException(409, str(exc)) from exc
            except (ValueError, RuntimeError, OSError) as exc:
                logger.exception("生成模型热力图失败")
                raise HTTPException(
                    500, "热力图生成失败，请检查模型权重、影像文件及服务终端中的错误。"
                ) from exc
            finally:
                temporary.unlink(missing_ok=True)
        return HeatmapResult(
            analysis_id=record.id,
            heatmap_url=f"/api/analyses/{record.id}/heatmap",
            predicted_label=record.predicted_label,
            width=record.width,
            height=record.height,
            model_revision=record.model_revision,
            method=info.heatmap_method,
        )


@app.post("/api/analyses/{identifier}/heatmap", response_model=HeatmapResult)
async def create_heatmap(request: Request, identifier: UUID) -> HeatmapResult:
    async with request.app.state.analysis_gate:
        job = asyncio.create_task(
            asyncio.to_thread(
                generate_heatmap, request.app.state.repository, request.app.state.model, identifier
            )
        )
        return await await_model_worker(job, "生成热力图")


@app.get("/api/analyses/{identifier}/heatmap")
def heatmap_image(request: Request, identifier: UUID) -> FileResponse:
    record = find_record(request, identifier)
    heatmap_model_info(record, request.app.state.model)
    path = request.app.state.repository.heatmap_file(record)
    if not path.is_file():
        raise HTTPException(404, "尚未生成该记录的热力图，请先请求生成。")
    return FileResponse(
        path,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/analyses/{identifier}/report.pdf")
def analysis_pdf(request: Request, identifier: UUID) -> Response:
    return export_report(request, ExportSelection(ids=[identifier]), "pdf")


@app.get("/api/analyses/{identifier}/report")
def analysis_report(request: Request, identifier: UUID) -> Response:
    analysis = find_record(request, identifier).as_analysis()
    report = {
        "schema_version": 1,
        "exported_at": datetime.now(UTC).isoformat(),
        "purpose": "本地研究与教育；禁止作为临床诊断、治疗决策或病理结论。",
        "analysis": analysis.model_dump(),
        "model": analysis.model_metadata,
        "limitations": [
            "模型分数为未校准的 softmax 分类分数，不是临床诊断概率。",
            "仅支持单张二维脑部 MRI 的 PNG/JPEG/WebP 切片，"
            "不支持 CT、DICOM 体数据、分割或通用影像诊断。",
            "系统不会验证图像是否真实属于脑部 MRI；非目标域输入仍可能得到高分且不可靠的分类。",
            "训练数据来源、患者级划分及数据泄漏排查信息不足，不能声称外部验证或临床质量。",
            "单张切片无法排除其他切片中的病变，也不能替代专业医生结合完整检查的判断。",
            "上传影像在本机处理，原始图像元数据被去除，"
            "仅保存归一化 RGB PNG 及分析记录；"
            "文件名由用户提供并不代表已完全去标识化。",
        ],
    }
    return Response(
        content=json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="neurolens-{identifier}.json"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
