"""Local-only model descriptors and immutable, content-identified artifacts."""

import hashlib
import json
import logging
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from .schemas import LABELS, MODEL_MANIFEST, ModelCatalog, ModelProfile, TumorLabel
from .settings import Settings

if TYPE_CHECKING:
    from .model import ModelEngine

logger = logging.getLogger(__name__)
REQUIRED_FILES = ("config.json", "preprocessor_config.json", "model.safetensors")
MAX_MODEL_BYTES = 512 * 1024 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
MAX_PARAMETERS = 250_000_000


class ModelConfigurationError(ValueError):
    pass


class ModelNotFoundError(LookupError):
    pass


class ModelConflictError(ValueError):
    pass


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path, limit: int = MAX_CONFIG_BYTES) -> dict:
    if path.is_symlink() or path.is_junction() or not path.is_file() or path.stat().st_size > limit:
        raise ModelConfigurationError(f"模型配置 {path.name} 缺失、不安全或超过大小限制。")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, RecursionError) as exc:
        raise ModelConfigurationError(f"模型配置 {path.name} 不是有效 JSON，或嵌套过深。") from exc
    if not isinstance(value, dict):
        raise ModelConfigurationError(f"模型配置 {path.name} 必须为 JSON 对象。")
    return value


def canonical_labels(config: dict, supplied: list[TumorLabel] | None) -> list[TumorLabel]:
    if supplied is not None:
        labels = list(supplied)
    else:
        mapping = config.get("id2label")
        if not isinstance(mapping, dict) or set(mapping) != {"0", "1", "2", "3"}:
            raise ModelConfigurationError("模型类别含义不明确，请按输出索引 0–3 明确指定四个类别。")
        known = {
            "glioma": "Glioma",
            "meningioma": "Meningioma",
            "pituitary": "Pituitary",
            "notumor": "No Tumor",
            "no tumor": "No Tumor",
            "no_tumor": "No Tumor",
        }
        labels = [known.get(str(mapping[str(index)]).strip().lower()) for index in range(4)]
    if len(labels) != 4 or set(labels) != set(LABELS):
        raise ModelConfigurationError(
            "类别映射须按模型输出顺序包含 "
            "No Tumor、Glioma、Meningioma、Pituitary 各一次；"
            "不能推测 LABEL_0 等数字类别。"
        )
    return labels


def validate_files(directory: Path, *, calculate_hashes: bool = True) -> dict[str, str]:
    if directory.is_symlink() or directory.is_junction() or not directory.is_dir():
        raise ModelConfigurationError("模型目录不存在或为不安全的链接。")
    entries = list(directory.iterdir())
    if len(entries) > 64:
        raise ModelConfigurationError("模型目录文件数量超过 64 个。")
    for entry in entries:
        if entry.is_symlink() or entry.is_junction() or not entry.is_file():
            raise ModelConfigurationError("模型目录不能包含链接或嵌套目录。")
    if not all((directory / name).is_file() for name in REQUIRED_FILES):
        raise ModelConfigurationError(
            "请上传 Hugging Face 标准视觉分类模型目录：config.json、"
            "preprocessor_config.json 和完整 model.safetensors。"
            "不支持分片、.pt/.pth/.bin/.onnx 或自定义 Python 模型。"
        )
    if any(
        entry.name.endswith(
            (".safetensors.index.json", ".py", ".pyc", ".pth", ".pt", ".bin", ".onnx")
        )
        for entry in entries
    ):
        raise ModelConfigurationError(
            "仅支持完整 model.safetensors；请先在可信环境转换模型，"
            "移除分片索引、可执行代码及 pickle 权重。"
        )
    total = sum(entry.stat().st_size for entry in entries)
    if total > MAX_MODEL_BYTES:
        raise ModelConfigurationError("模型文件总大小不能超过 512 MiB。")
    for name in REQUIRED_FILES[:2]:
        read_json(directory / name)
    return (
        {name: file_digest(directory / name) for name in REQUIRED_FILES} if calculate_hashes else {}
    )


def content_revision(hashes: dict[str, str]) -> str:
    return hashlib.sha256(
        json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class ModelRegistry:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = settings.data_dir / "model-library"
        self._lock = RLock()
        # The default exists logically; never write to the pinned builtin directory.
        self._builtin = ModelProfile(
            id="builtin",
            name="ViT 脑瘤分类模型",
            origin="builtin",
            model_id=MODEL_MANIFEST["model_id"],
            revision=MODEL_MANIFEST["revision"],
            architecture=MODEL_MANIFEST["architecture"],
            parameters=MODEL_MANIFEST["parameters"],
            input_size=MODEL_MANIFEST["input_size"],
            input_width=MODEL_MANIFEST["input_size"],
            input_height=MODEL_MANIFEST["input_size"],
            labels=MODEL_MANIFEST["output_labels"],
            size_bytes=MODEL_MANIFEST["weight_size"],
            created_at=None,
            heatmap_supported=True,
            heatmap_method="Grad-CAM",
        )

    @staticmethod
    def _safe_id(profile_id: str) -> str:
        if profile_id == "builtin":
            return profile_id
        try:
            if str(UUID(profile_id)) == profile_id:
                return profile_id
        except (ValueError, TypeError, AttributeError):
            pass
        raise ModelNotFoundError("模型编号无效。")

    def directory(self, profile_id: str) -> Path:
        profile_id = self._safe_id(profile_id)
        if profile_id == "builtin":
            return self.settings.model_dir
        path = self.root / profile_id
        if (
            self.root.is_symlink()
            or self.root.is_junction()
            or path.is_symlink()
            or path.is_junction()
        ):
            raise ModelConfigurationError("模型库路径不能为符号链接。")
        return path

    def active_id(self) -> str:
        with self._lock:
            path = self.root / "active.json"
            if not path.exists():
                return "builtin"
            try:
                value = read_json(path, 4096).get("active_id")
                return self._safe_id(value)
            except (ModelNotFoundError, ModelConfigurationError) as exc:
                raise ModelConfigurationError(
                    "已保存的模型选择损坏；请在模型管理中手动切换到内置模型恢复。"
                ) from exc

    def set_active(self, profile_id: str) -> None:
        with self._lock:
            self.get(profile_id)
            self._atomic_json(self.root / "active.json", {"active_id": profile_id})

    def _atomic_json(self, path: Path, value: dict) -> None:
        if self.root.is_symlink() or self.root.is_junction():
            raise ModelConfigurationError("模型库路径不能为符号链接。")
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid4()}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _record(self, profile_id: str) -> dict:
        path = self.directory(profile_id) / "registry.json"
        if not path.exists():
            raise ModelNotFoundError("模型不存在或已被删除。")
        record = read_json(path)
        try:
            profile = ModelProfile.model_validate(record.get("profile"))
            hashes = record.get("sha256")
            if (
                profile.id != profile_id
                or profile.origin != "local"
                or set(profile.labels) != set(LABELS)
                or len(profile.labels) != 4
                or not 0 < profile.parameters <= MAX_PARAMETERS
                or not 1 <= profile.input_width <= 1024
                or not 1 <= profile.input_height <= 1024
                or not 0 < profile.size_bytes <= MAX_MODEL_BYTES
                or not profile.name.strip()
                or len(profile.name) > 80
                or not isinstance(hashes, dict)
                or set(hashes) != set(REQUIRED_FILES)
                or not all(isinstance(value, str) and len(value) == 64 for value in hashes.values())
                or profile.revision != content_revision(hashes)
            ):
                raise ValueError("invalid descriptor")
        except (ValueError, TypeError) as exc:
            raise ModelConfigurationError("本地模型描述或内容版本损坏，请重新上传模型。") from exc
        return record

    def get(self, profile_id: str) -> ModelProfile:
        with self._lock:
            self._safe_id(profile_id)
            if profile_id == "builtin":
                return self._builtin.model_copy(deep=True)
            return ModelProfile.model_validate(self._record(profile_id)["profile"])

    def verify_integrity(self, profile_id: str) -> None:
        if profile_id == "builtin":
            return  # Engine enforces all pinned hashes and provenance before loading.
        with self._lock:
            record = self._record(profile_id)
            hashes = validate_files(self.directory(profile_id))
            if hashes != record["sha256"]:
                raise ModelConfigurationError("本地模型文件已改变或损坏，不能加载；请重新上传。")

    def catalog(self, active_id: str) -> ModelCatalog:
        with self._lock:
            items = [self._builtin.model_copy(update={"active": active_id == "builtin"}, deep=True)]
            if self.root.is_symlink() or self.root.is_junction():
                raise ModelConfigurationError("模型库路径不能为符号链接。")
            if self.root.exists():
                for entry in sorted(self.root.iterdir(), key=lambda item: item.name):
                    if not entry.is_dir() or entry.name.startswith("."):
                        continue
                    try:
                        profile = self.get(entry.name)
                        profile.active = profile.id == active_id
                        items.append(profile)
                    except (ModelNotFoundError, ModelConfigurationError):
                        logger.warning("忽略损坏的模型描述：%s", entry.name)
            return ModelCatalog(active_id=active_id, items=items)

    def register_directory(
        self, directory: Path, name: str, labels: list[TumorLabel] | None, engine: "ModelEngine"
    ) -> ModelProfile:
        name = name.strip()
        if not name or len(name) > 80:
            raise ModelConfigurationError("模型名称须为 1–80 个字符。")
        hashes = validate_files(directory)
        mapping = canonical_labels(read_json(directory / "config.json"), labels)
        profile_id = str(uuid4())
        provisional = ModelProfile(
            id=profile_id,
            name=name,
            origin="local",
            model_id=f"local/{profile_id}",
            revision=content_revision(hashes),
            architecture="",
            parameters=0,
            input_size=0,
            input_width=0,
            input_height=0,
            labels=mapping,
            size_bytes=sum((directory / file).stat().st_size for file in REQUIRED_FILES),
            created_at=datetime.now(UTC).isoformat(),
            heatmap_supported=False,
            heatmap_method=None,
        )
        # Validation owns only this candidate; it never touches the active classifier.
        info = engine.validate_profile(directory, provisional)
        profile = provisional.model_copy(
            update={
                "architecture": info.architecture,
                "parameters": info.parameters,
                "input_size": info.input_size,
                "input_width": info.input_width,
                "input_height": info.input_height,
                "heatmap_supported": info.heatmap_supported,
                "heatmap_method": info.heatmap_method,
            }
        )
        with self._lock:
            destination = self.directory(profile_id)
            self.root.mkdir(parents=True, exist_ok=True)
            temporary = self.root / f".register-{profile_id}"
            try:
                temporary.mkdir()
                for file in REQUIRED_FILES:
                    shutil.copyfile(directory / file, temporary / file)
                # Reject staging-file mutation between validation and persistence.
                if validate_files(temporary) != hashes:
                    raise ModelConfigurationError("上传文件在验证过程中发生变化，请重新上传。")
                self._atomic_json(
                    temporary / "registry.json",
                    {
                        "profile": profile.model_dump(mode="json"),
                        "sha256": hashes,
                    },
                )
                os.replace(temporary, destination)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        return profile.model_copy(deep=True)

    def remove(self, profile_id: str, active_id: str) -> None:
        with self._lock:
            self._safe_id(profile_id)
            if profile_id == "builtin" or profile_id == active_id or profile_id == self.active_id():
                raise ModelConflictError("内置模型和当前启用的模型不能删除，请先切换模型。")
            self.get(profile_id)
            shutil.rmtree(self.directory(profile_id))
