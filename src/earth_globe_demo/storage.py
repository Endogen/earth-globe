from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from uuid import uuid4

from fastapi import HTTPException, status

from .models import Point, PointCreate, PointUpdate


class PointRepository:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = Lock()
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
        raw = json.loads(self._path.read_text(encoding="utf-8"))
        return [Point.model_validate(item) for item in raw]

    def _write_points_unlocked(self, points: list[Point]) -> None:
        self._write_points_file(points)

    def _write_points_file(self, points: list[Point]) -> None:
        payload = [point.model_dump(mode="json") for point in points]
        self._path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
