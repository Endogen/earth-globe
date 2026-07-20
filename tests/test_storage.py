from __future__ import annotations

import json

import pytest

from earth_globe_demo.models import PointCreate
from earth_globe_demo.storage import PointDataError, PointRepository


def test_repository_writes_valid_json_atomically(tmp_path) -> None:
    path = tmp_path / "points.json"
    repository = PointRepository(path)
    repository.add_point(PointCreate(label="Test", latitude=12.5, longitude=-8.25, color="#ff8d57"))

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload[0]["label"] == "Test"
    assert path.read_text(encoding="utf-8").endswith("\n")
    assert list(tmp_path.glob(".points.json.*.tmp")) == []


def test_repository_reports_corrupt_data(tmp_path) -> None:
    path = tmp_path / "points.json"
    path.write_text("not-json", encoding="utf-8")
    repository = PointRepository(path)

    with pytest.raises(PointDataError, match="unreadable"):
        repository.list_points()


def test_repository_rejects_non_list_root(tmp_path) -> None:
    path = tmp_path / "points.json"
    path.write_text('{"points": []}', encoding="utf-8")
    repository = PointRepository(path)

    with pytest.raises(PointDataError, match="unreadable"):
        repository.list_points()
