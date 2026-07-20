from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from earth_globe_demo.main import create_app
from earth_globe_demo.storage import PointRepository


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    app = create_app()
    app.state.point_repository = PointRepository(tmp_path / "points.json")
    with TestClient(app) as test_client:
        yield test_client


def test_health_and_config(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}

    response = client.get("/api/config")
    assert response.status_code == 200
    assert response.json()["app_title"] == "Earth Marker Studio"


def test_point_crud_normalizes_labels(client: TestClient) -> None:
    create_response = client.post(
        "/api/points",
        json={"label": "  Berlin Hub  ", "latitude": 52.52, "longitude": 13.405, "color": "#67d3ff"},
    )
    assert create_response.status_code == 201
    point = create_response.json()
    assert point["label"] == "Berlin Hub"

    list_response = client.get("/api/points")
    assert list_response.json() == [point]

    update_response = client.put(
        f"/api/points/{point['id']}",
        json={"label": "Berlin Office", "latitude": 52.51, "longitude": 13.4, "color": "#ff8d57"},
    )
    assert update_response.status_code == 200
    assert update_response.json()["created_at"] == point["created_at"]

    delete_response = client.delete(f"/api/points/{point['id']}")
    assert delete_response.status_code == 200
    assert client.get("/api/points").json() == []


@pytest.mark.parametrize(
    "payload",
    [
        {"label": "   ", "latitude": 0, "longitude": 0, "color": "#ff8d57"},
        {"label": "Invalid latitude", "latitude": 91, "longitude": 0, "color": "#ff8d57"},
        {"label": "Invalid color", "latitude": 0, "longitude": 0, "color": "orange"},
    ],
)
def test_invalid_points_are_rejected(client: TestClient, payload: dict[str, object]) -> None:
    response = client.post("/api/points", json=payload)
    assert response.status_code == 422
    assert client.get("/api/points").json() == []


def test_missing_point_returns_not_found(client: TestClient) -> None:
    payload = {"label": "Missing", "latitude": 0, "longitude": 0, "color": "#ff8d57"}
    assert client.put("/api/points/does-not-exist", json=payload).status_code == 404
    assert client.delete("/api/points/does-not-exist").status_code == 404


def test_clear_points_reports_removed_count(client: TestClient) -> None:
    payload = {"label": "Point", "latitude": 0, "longitude": 0, "color": "#ff8d57"}
    client.post("/api/points", json=payload)
    client.post("/api/points", json={**payload, "label": "Point 2"})

    response = client.delete("/api/points")
    assert response.status_code == 200
    assert response.json() == {"removed_count": 2}
