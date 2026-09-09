from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from tempfile import NamedTemporaryFile
from uuid import uuid4

from fastapi import HTTPException, status
from filelock import FileLock
from pydantic import ValidationError

from .models import Point, PointCreate, PointUpdate


class PointDataError(RuntimeError):
    """Raised when persisted point data cannot be read safely."""


class PointRepository:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = FileLock(str(path) + ".lock")
        self._cached_signature = None
        self._cached_points: list[Point] = []
        with self._lock:
            self._ensure_data_file()

    def list_points(self) -> list[Point]:
        with self._lock:
            return self._read_points_unlocked()

    def add_point(self, payload: PointCreate) -> Point:
        with self._lock:
            points = self._read_points_unlocked()
            point = Point(
                id=str(uuid4()),
                created_at=datetime.now(UTC),
                **payload.model_dump(),
            )
            points.append(point)
            self._write_points_unlocked(points)
            return point

    def update_point(self, point_id: str, payload: PointUpdate) -> Point:
        with self._lock:
            points = self._read_points_unlocked()
            updated_point: Point | None = None
            next_points: list[Point] = []

            for point in points:
                if point.id == point_id:
                    updated_point = Point(
                        id=point.id,
                        created_at=point.created_at,
                        **payload.model_dump(),
                    )
                    next_points.append(updated_point)
                    continue

                next_points.append(point)

            if updated_point is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Point not found")

            self._write_points_unlocked(next_points)
            return updated_point

    def delete_point(self, point_id: str) -> Point:
        with self._lock:
            points = self._read_points_unlocked()
            kept_points: list[Point] = []
            removed_point: Point | None = None

            for point in points:
                if point.id == point_id:
                    removed_point = point
                    continue
                kept_points.append(point)

            if removed_point is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Point not found")

            self._write_points_unlocked(kept_points)
            return removed_point

    def clear_points(self) -> int:
        with self._lock:
            removed_count = len(self._read_points_unlocked())
            self._write_points_unlocked([])
            return removed_count

    def _ensure_data_file(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if self._path.exists():
            return

        self._write_points_file([])

    def _read_points_unlocked(self) -> list[Point]:
        try:
            stat = self._path.stat()
            signature = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
            if signature == self._cached_signature:
                return list(self._cached_points)
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(raw, list):
                raise ValueError("The point store root must be a JSON array")
            points = [Point.model_validate(item) for item in raw]
            self._cached_signature = signature
            self._cached_points = points
            return list(points)
        except (OSError, UnicodeError, json.JSONDecodeError, ValidationError, ValueError) as exc:
            raise PointDataError("Saved point data is unreadable. Restore or replace data/points.json.") from exc

    def _write_points_unlocked(self, points: list[Point]) -> None:
        self._write_points_file(points)

    def _write_points_file(self, points: list[Point]) -> None:
        payload = [point.model_dump(mode="json") for point in points]
        temporary_path: Path | None = None

        try:
            with NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=self._path.parent,
                prefix=f".{self._path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                json.dump(payload, temporary_file, indent=2)
                temporary_file.write("\n")
                temporary_file.flush()
                os.fsync(temporary_file.fileno())

            os.replace(temporary_path, self._path)
        except OSError as exc:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
            raise PointDataError("Saved point data could not be written.") from exc
