from __future__ import annotations

import logging
import sqlite3
from contextlib import closing
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from threading import RLock
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    Integer,
    String,
    create_engine,
    event,
    func,
    select,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .schemas import (
    LABELS,
    MODEL_ID,
    MODEL_MANIFEST,
    MODEL_OUTPUT_LABELS,
    MODEL_REVISION,
    Analysis,
    AnalysisPage,
    AnalysisPatch,
    BulkResult,
    ExportSelection,
    GroupCount,
    LabelCount,
    LatencyBucket,
    ListOptions,
    Stats,
    TrendPoint,
)

logger = logging.getLogger(__name__)


class MissingRecords(LookupError):
    pass


class InvalidFilters(ValueError):
    pass


class Base(DeclarativeBase):
    pass


class AnalysisRecord(Base):
    __tablename__ = "analyses"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    filename: Mapped[str] = mapped_column(String(180))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    predicted_label: Mapped[str] = mapped_column(String(16), index=True)
    confidence: Mapped[float] = mapped_column(Float)
    probabilities: Mapped[list[dict]] = mapped_column(JSON)
    inference_ms: Mapped[float] = mapped_column(Float)
    model_id: Mapped[str] = mapped_column(String(128))
    model_revision: Mapped[str] = mapped_column(String(40))
    image_path: Mapped[str] = mapped_column(String(40))
    group_name: Mapped[str] = mapped_column(String(80), default="", server_default="")
    notes: Mapped[str] = mapped_column(String(2000), default="", server_default="")
    reviewed_label: Mapped[str | None] = mapped_column(String(16), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    annotations: Mapped[list[dict]] = mapped_column(JSON, default=list, server_default="[]")
    model_metadata: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")

    def as_analysis(self) -> Analysis:
        return Analysis(
            id=self.id,
            filename=self.filename,
            width=self.width,
            height=self.height,
            created_at=self.created_at.replace(tzinfo=UTC).isoformat(),
            predicted_label=self.predicted_label,
            confidence=self.confidence,
            probabilities=self.probabilities,
            inference_ms=self.inference_ms,
            model_id=self.model_id,
            model_revision=self.model_revision,
            image_url=f"/api/analyses/{self.id}/image",
            group=self.group_name or "",
            notes=self.notes or "",
            reviewed_label=self.reviewed_label,
            reviewed_at=self.reviewed_at.replace(tzinfo=UTC).isoformat()
            if self.reviewed_at
            else None,
            review_status="reviewed" if self.reviewed_label is not None else "pending",
            annotations=self.annotations or [],
            model_metadata=self.saved_model_metadata(),
        )

    def saved_model_metadata(self) -> dict:
        if self.model_metadata:
            return dict(self.model_metadata)
        identity = {"model_id": self.model_id, "revision": self.model_revision}
        if self.model_id != MODEL_ID or self.model_revision != MODEL_REVISION:
            return {**identity, "name": self.model_id, "provenance": "legacy-unknown"}
        # Derive only the pinned builtin identity; do not rewrite historical records.
        return {
            **identity,
            "profile_id": "builtin",
            "name": "ViT 脑瘤分类模型",
            "origin": "builtin",
            "architecture": MODEL_MANIFEST["architecture"],
            "parameters": MODEL_MANIFEST["parameters"],
            "license": MODEL_MANIFEST["license"],
            "source_url": MODEL_MANIFEST["source_url"],
            "reported_accuracy": MODEL_MANIFEST["reported_accuracy"],
            "labels": list(MODEL_OUTPUT_LABELS),
            "input_size": MODEL_MANIFEST["input_size"],
            "input_width": MODEL_MANIFEST["input_size"],
            "input_height": MODEL_MANIFEST["input_size"],
            "size_bytes": MODEL_MANIFEST["weight_size"],
            "heatmap_supported": True,
            "heatmap_method": "Grad-CAM",
            "provenance": "pinned-builtin-legacy",
        }


def local_midnight(day: date) -> datetime:
    return datetime.combine(day, time.min).astimezone(UTC).replace(tzinfo=None)


class Repository:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.image_dir = data_dir / "images"
        self.heatmap_dir = data_dir / "heatmaps"
        self.image_dir.mkdir(exist_ok=True)
        self.heatmap_dir.mkdir(exist_ok=True)
        database_path = data_dir / "analyses.sqlite3"
        self._migrate(database_path)
        self.engine = create_engine(
            f"sqlite:///{database_path.as_posix()}",
            connect_args={"check_same_thread": False, "timeout": 30},
        )

        @event.listens_for(self.engine, "connect")
        def configure_sqlite(connection, _record) -> None:
            cursor = connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.close()

        self.sessions = sessionmaker(self.engine, expire_on_commit=False)
        Base.metadata.create_all(self.engine)
        self._recover_tombstones()

    @staticmethod
    def _migrate(database_path: Path) -> None:
        if not database_path.exists():
            return
        additions = {
            "group_name": "VARCHAR(80) NOT NULL DEFAULT ''",
            "notes": "VARCHAR(2000) NOT NULL DEFAULT ''",
            "reviewed_label": "VARCHAR(16)",
            "reviewed_at": "DATETIME",
            "annotations": "JSON NOT NULL DEFAULT '[]'",
            "model_metadata": "JSON NOT NULL DEFAULT '{}'",
        }
        try:
            with closing(sqlite3.connect(database_path, timeout=30)) as source:
                columns = {row[1] for row in source.execute("PRAGMA table_info(analyses)")}
                if not columns or all(name in columns for name in additions):
                    return
                backup_dir = database_path.parent / "backups"
                backup_dir.mkdir(exist_ok=True)
                timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
                backup_path = (
                    backup_dir / f"analyses-before-migration-{timestamp}-{uuid4().hex[:8]}.sqlite3"
                )
                # SQLite's backup API includes committed WAL content in one consistent snapshot.
                with closing(sqlite3.connect(backup_path)) as backup:
                    source.backup(backup)
                source.execute("BEGIN IMMEDIATE")
                columns = {row[1] for row in source.execute("PRAGMA table_info(analyses)")}
                for name, declaration in additions.items():
                    if name not in columns:
                        source.execute(f'ALTER TABLE analyses ADD COLUMN "{name}" {declaration}')
                source.commit()
        except (OSError, sqlite3.Error) as exc:
            raise RuntimeError(
                "数据库备份或升级失败，请检查数据目录权限、剩余磁盘空间及其他占用数据库的进程。原始记录未被重建。"
            ) from exc

    def _recover_tombstones(self) -> None:
        for directory in (self.image_dir, self.heatmap_dir):
            for tombstone in directory.glob(".deleted-*.png"):
                try:
                    identifier = str(
                        UUID(tombstone.name.removeprefix(".deleted-").removesuffix(".png"))
                    )
                except ValueError:
                    continue
                with self.sessions.begin() as session:
                    session.execute(text("BEGIN IMMEDIATE"))
                    if session.get(AnalysisRecord, identifier) is None:
                        tombstone.unlink(missing_ok=True)
                    else:
                        original = directory / f"{identifier}.png"
                        if original.exists():
                            tombstone.unlink(missing_ok=True)
                        else:
                            tombstone.replace(original)

    def insert(self, record: AnalysisRecord) -> Analysis:
        with self.lock, self.sessions.begin() as session:
            session.add(record)
            session.flush()
            analysis = record.as_analysis()
        return analysis

    def get(self, identifier: str) -> AnalysisRecord | None:
        with self.sessions() as session:
            return session.get(AnalysisRecord, identifier)

    @staticmethod
    def conditions(options: ListOptions) -> list:
        conditions = []
        effective_label = func.coalesce(
            AnalysisRecord.reviewed_label, AnalysisRecord.predicted_label
        )
        if options.label is not None:
            conditions.append(effective_label == options.label)
        if options.query:
            conditions.append(AnalysisRecord.filename.contains(options.query, autoescape=True))
        if options.group is not None:
            conditions.append(AnalysisRecord.group_name == options.group)
        if options.review_status == "reviewed":
            conditions.append(AnalysisRecord.reviewed_label.is_not(None))
        elif options.review_status == "pending":
            conditions.append(AnalysisRecord.reviewed_label.is_(None))
        try:
            if options.start_date is not None:
                conditions.append(AnalysisRecord.created_at >= local_midnight(options.start_date))
            if options.end_date is not None:
                conditions.append(
                    AnalysisRecord.created_at < local_midnight(options.end_date + timedelta(days=1))
                )
        except (ValueError, OverflowError, OSError) as exc:
            raise InvalidFilters(
                "筛选日期超出本机支持的范围，请使用有效的 YYYY-MM-DD 日期。"
            ) from exc
        if options.confidence_min is not None:
            conditions.append(AnalysisRecord.confidence >= options.confidence_min)
        if options.confidence_max is not None:
            conditions.append(AnalysisRecord.confidence <= options.confidence_max)
        return conditions

    @staticmethod
    def ordering(options: ListOptions) -> tuple:
        if options.sort == "oldest":
            return (AnalysisRecord.created_at.asc(), AnalysisRecord.id.asc())
        if options.sort == "confidence_desc":
            return (
                AnalysisRecord.confidence.desc(),
                AnalysisRecord.created_at.desc(),
                AnalysisRecord.id.desc(),
            )
        if options.sort == "confidence_asc":
            return (
                AnalysisRecord.confidence.asc(),
                AnalysisRecord.created_at.desc(),
                AnalysisRecord.id.desc(),
            )
        return (AnalysisRecord.created_at.desc(), AnalysisRecord.id.desc())

    def list(self, options: ListOptions) -> AnalysisPage:
        conditions = self.conditions(options)
        with self.sessions() as session:
            session.execute(text("BEGIN"))
            total = (
                session.scalar(select(func.count()).select_from(AnalysisRecord).where(*conditions))
                or 0
            )
            records = session.scalars(
                select(AnalysisRecord)
                .where(*conditions)
                .order_by(*self.ordering(options))
                .offset((options.page - 1) * options.page_size)
                .limit(options.page_size)
            ).all()
            return AnalysisPage(
                items=[record.as_analysis() for record in records],
                total=total,
                page=options.page,
                page_size=options.page_size,
            )

    def groups(self) -> list[GroupCount]:
        with self.sessions() as session:
            rows = session.execute(
                select(AnalysisRecord.group_name, func.count())
                .where(AnalysisRecord.group_name != "")
                .group_by(AnalysisRecord.group_name)
                .order_by(AnalysisRecord.group_name.asc())
            ).all()
            return [GroupCount(name=name, count=count) for name, count in rows]

    def update(self, identifier: str, patch: AnalysisPatch) -> Analysis:
        with self.lock, self.sessions.begin() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            record = session.get(AnalysisRecord, identifier)
            if record is None:
                raise MissingRecords("未找到该分析记录，记录可能已被删除。")
            fields = patch.model_fields_set
            if "group" in fields:
                record.group_name = patch.group
            if "notes" in fields:
                record.notes = patch.notes
            if "annotations" in fields:
                record.annotations = [annotation.model_dump() for annotation in patch.annotations]
            if "reviewed_label" in fields:
                record.reviewed_label = patch.reviewed_label
                record.reviewed_at = (
                    datetime.now(UTC).replace(tzinfo=None)
                    if patch.reviewed_label is not None
                    else None
                )
            session.flush()
            return record.as_analysis()

    @staticmethod
    def _selected(session, identifiers: list[str]) -> list[AnalysisRecord]:
        records = session.scalars(
            select(AnalysisRecord).where(AnalysisRecord.id.in_(identifiers))
        ).all()
        by_id = {record.id: record for record in records}
        if any(identifier not in by_id for identifier in identifiers):
            raise MissingRecords("部分分析记录已不存在，请刷新列表后重试；本次操作未修改任何记录。")
        return [by_id[identifier] for identifier in identifiers]

    def export_records(self, selection: ExportSelection, limit: int) -> list[AnalysisRecord]:
        with self.sessions() as session:
            session.execute(text("BEGIN"))
            if selection.ids is not None:
                return self._selected(session, [str(identifier) for identifier in selection.ids])
            options = selection.filters or ListOptions()
            conditions = self.conditions(options)
            total = (
                session.scalar(select(func.count()).select_from(AnalysisRecord).where(*conditions))
                or 0
            )
            if total > limit:
                raise ValueError(
                    f"符合条件的记录有 {total} 条，超过本次导出上限 {limit} 条，请缩小筛选范围。"
                )
            records = session.scalars(
                select(AnalysisRecord)
                .where(*conditions)
                .order_by(*self.ordering(options))
                .limit(limit + 1)
            ).all()
            if len(records) > limit:
                raise ValueError(f"符合条件的记录超过导出上限 {limit} 条，请缩小筛选范围。")
            if not records:
                raise ValueError("没有符合条件的分析记录可供导出。")
            return list(records)

    def stats(self, days: int = 7) -> Stats:
        today = date.today()
        today_start = local_midnight(today)
        end = local_midnight(today + timedelta(days=1))
        window_start = local_midnight(today - timedelta(days=days - 1))
        with self.sessions() as session:
            session.execute(text("BEGIN"))
            total, average = session.execute(
                select(func.count(), func.avg(AnalysisRecord.inference_ms))
            ).one()
            today_count = (
                session.scalar(
                    select(func.count())
                    .select_from(AnalysisRecord)
                    .where(
                        AnalysisRecord.created_at >= today_start, AnalysisRecord.created_at < end
                    )
                )
                or 0
            )
            reviewed = (
                session.scalar(
                    select(func.count())
                    .select_from(AnalysisRecord)
                    .where(AnalysisRecord.reviewed_label.is_not(None))
                )
                or 0
            )
            counts = dict(
                session.execute(
                    select(AnalysisRecord.predicted_label, func.count()).group_by(
                        AnalysisRecord.predicted_label
                    )
                ).all()
            )
            rows = session.execute(
                select(AnalysisRecord.created_at, AnalysisRecord.inference_ms).where(
                    AnalysisRecord.created_at >= window_start, AnalysisRecord.created_at < end
                )
            ).all()
        daily: dict[date, list[float | int]] = {}
        latency_counts = [0, 0, 0, 0]
        for created_at, elapsed in rows:
            local_day = created_at.replace(tzinfo=UTC).astimezone().date()
            aggregate = daily.setdefault(local_day, [0, 0.0])
            aggregate[0] += 1
            aggregate[1] += elapsed
            bucket = 0 if elapsed < 1000 else 1 if elapsed < 3000 else 2 if elapsed < 5000 else 3
            latency_counts[bucket] += 1
        trend = []
        for offset in range(days):
            day = today - timedelta(days=days - 1 - offset)
            count, elapsed_sum = daily.get(day, [0, 0.0])
            trend.append(
                TrendPoint(
                    date=day.isoformat(),
                    count=count,
                    mean_inference_ms=elapsed_sum / count if count else None,
                )
            )
        return Stats(
            total=total,
            today=today_count,
            mean_inference_ms=average,
            distribution=[LabelCount(label=label, count=counts.get(label, 0)) for label in LABELS],
            reviewed=reviewed,
            pending=total - reviewed,
            trend=trend,
            latency=[
                LatencyBucket(name=name, count=count)
                for name, count in zip(
                    ("< 1 秒", "1–3 秒", "3–5 秒", "≥ 5 秒"), latency_counts, strict=True
                )
            ],
        )

    def image_file(self, record: AnalysisRecord) -> Path:
        expected_name = f"{UUID(record.id)}.png"
        if record.image_path != expected_name:
            raise ValueError("影像记录中的存储标识无效。")
        path = self.image_dir / expected_name
        if path.is_symlink():
            raise ValueError("影像存储文件不可为符号链接。")
        return path

    def heatmap_file(self, record: AnalysisRecord) -> Path:
        path = self.heatmap_dir / f"{UUID(record.id)}.png"
        if path.is_symlink():
            raise ValueError("热力图存储文件不可为符号链接。")
        return path

    def bulk(self, action: str, identifiers: list[str], group: str | None = None) -> BulkResult:
        moved: list[tuple[Path, Path]] = []
        with self.lock:
            try:
                with self.sessions.begin() as session:
                    session.execute(text("BEGIN IMMEDIATE"))
                    records = self._selected(session, identifiers)
                    if action == "group":
                        for record in records:
                            record.group_name = group
                        session.flush()
                        return BulkResult(updated=[record.as_analysis() for record in records])
                    for record in records:
                        for original in (self.image_file(record), self.heatmap_file(record)):
                            if original.exists():
                                tombstone = original.parent / f".deleted-{record.id}.png"
                                if tombstone.exists():
                                    raise OSError(
                                        "发现未恢复的删除文件，请重启服务完成恢复后重试。"
                                    )
                                original.replace(tombstone)
                                moved.append((original, tombstone))
                        session.delete(record)
                    session.flush()
            except Exception:
                for original, tombstone in reversed(moved):
                    try:
                        tombstone.replace(original)
                    except OSError:
                        logger.exception(
                            "数据库已回滚，但文件恢复失败；请修复目录权限并重启服务：%s", tombstone
                        )
                raise
            for _original, tombstone in moved:
                try:
                    tombstone.unlink(missing_ok=True)
                except OSError:
                    # The committed record is gone; startup safely completes physical removal.
                    logger.exception(
                        "删除已提交，但文件清理失败；重启服务将继续清理：%s", tombstone
                    )
            return BulkResult(deleted_ids=identifiers)

    def delete(self, identifier: str) -> bool:
        try:
            self.bulk("delete", [identifier])
        except MissingRecords:
            return False
        return True

    def close(self) -> None:
        self.engine.dispose()
