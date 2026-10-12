import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from PIL import Image

from app.database import AnalysisRecord, MissingRecords, Repository
from app.schemas import MODEL_ID, MODEL_REVISION, AnalysisPatch, ListOptions


def prediction():
    return [
        {"label": "No Tumor", "score": 0.1},
        {"label": "Glioma", "score": 0.7},
        {"label": "Meningioma", "score": 0.1},
        {"label": "Pituitary", "score": 0.1},
    ]


def test_legacy_migration_preserves_records_and_consistent_backup(tmp_path: Path):
    identifier = str(uuid4())
    database = tmp_path / "analyses.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE analyses (id TEXT PRIMARY KEY, filename TEXT, "
            "width INTEGER, height INTEGER, created_at DATETIME, predicted_label TEXT, "
            "confidence FLOAT, probabilities JSON, inference_ms FLOAT, model_id TEXT, "
            "model_revision TEXT, image_path TEXT)"
        )
        connection.execute("PRAGMA journal_mode=WAL")
        values = (
            identifier,
            "旧影像.jpg",
            64,
            64,
            "2026-01-01 12:34:56",
            "Glioma",
            0.7,
            json.dumps(prediction()),
            123.5,
            MODEL_ID,
            MODEL_REVISION,
            f"{identifier}.png",
        )
        connection.execute("INSERT INTO analyses VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", values)
        connection.commit()
        original = connection.execute("SELECT * FROM analyses").fetchall()
    repo = Repository(tmp_path)
    try:
        migrated = repo.get(identifier).as_analysis()
        assert migrated.filename == "旧影像.jpg" and migrated.predicted_label == "Glioma"
        assert migrated.probabilities[1].score == 0.7 and migrated.model_revision == MODEL_REVISION
        assert (
            migrated.group == ""
            and migrated.notes == ""
            and migrated.reviewed_label is None
            and migrated.annotations == []
        )
        backups = list((tmp_path / "backups").glob("*.sqlite3"))
        assert len(backups) == 1
        with sqlite3.connect(backups[0]) as snapshot:
            assert snapshot.execute("SELECT * FROM analyses").fetchall() == original
    finally:
        repo.close()
    reopened = Repository(tmp_path)
    try:
        assert reopened.get(identifier).as_analysis() == migrated
        assert list((tmp_path / "backups").glob("*.sqlite3")) == backups
    finally:
        reopened.close()


def test_review_preserves_ai_and_missing_bulk_does_not_partially_delete(tmp_path: Path):
    repo = Repository(tmp_path)
    identifier = str(uuid4())
    try:
        original = repo.insert(
            AnalysisRecord(
                id=identifier,
                filename="image.jpg",
                width=64,
                height=64,
                created_at=datetime.now(UTC).replace(tzinfo=None),
                predicted_label="Glioma",
                confidence=0.7,
                probabilities=prediction(),
                inference_ms=123.5,
                model_id=MODEL_ID,
                model_revision=MODEL_REVISION,
                image_path=f"{identifier}.png",
            )
        )
        image_file = tmp_path / "images" / f"{identifier}.png"
        Image.new("RGB", (64, 64), "white").save(image_file)
        original_bytes = image_file.read_bytes()
        revised = repo.update(
            identifier, AnalysisPatch(reviewed_label="Meningioma", group="A", notes="人工复核")
        )
        assert (
            revised.predicted_label == original.predicted_label
            and revised.probabilities == original.probabilities
            and revised.confidence == original.confidence
        )
        assert revised.reviewed_label == "Meningioma" and revised.reviewed_at
        assert (
            repo.list(ListOptions(label="Meningioma", review_status="reviewed")).items[0].id
            == identifier
        )
        cleared = repo.update(identifier, AnalysisPatch(reviewed_label=None))
        assert (
            cleared.review_status == "pending"
            and cleared.reviewed_at is None
            and cleared.notes == "人工复核"
        )
        with pytest.raises(MissingRecords):
            repo.bulk("delete", [identifier, str(uuid4())])
        assert repo.get(identifier).as_analysis() == cleared
        assert image_file.read_bytes() == original_bytes
    finally:
        repo.close()
