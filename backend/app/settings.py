import os
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NEUROLENS_",
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = BACKEND_DIR / "data"
    model_dir: Path = BACKEND_DIR / "models" / "brain-tumor-classifier"
    device: Literal["cpu", "cuda"] = "cpu"
    torch_threads: int = Field(default=min(4, os.cpu_count() or 1), ge=1, le=16)

    @field_validator("data_dir", "model_dir", mode="before")
    @classmethod
    def resolve_directory(cls, value: str | Path) -> Path:
        path = Path(value).expanduser()
        return (path if path.is_absolute() else BACKEND_DIR / path).resolve()
