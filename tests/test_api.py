from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from stat import S_IMODE

import pytest
from fastapi.testclient import TestClient

from earth_globe_demo import tracking
from earth_globe_demo.main import create_app
from earth_globe_demo.models import DeviceRegistration, LocationResultCreate
from earth_globe_demo.storage import PointRepository
from earth_globe_demo.tracking import REQUEST_TIMEOUT, TrackingRepository


ADMIN_TOKEN = "test-admin-token-with-more-than-24-characters"


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    app = create_app(
        point_repository=PointRepository(tmp_path / "points.json"),
        tracking_repository=TrackingRepository(tmp_path / "tracking.sqlite3"),
        tracking_admin_token=ADMIN_TOKEN,
        downloads_dir=tmp_path / "downloads",
    )
    with TestClient(app) as test_client:
        yield test_client


def test_application_dependencies_are_initialized_in_lifespan(tmp_path) -> None:
    app = create_app(
        point_repository=PointRepository(tmp_path / "points.json"),
        tracking_repository=TrackingRepository(tmp_path / "tracking.sqlite3"),
        tracking_admin_token=ADMIN_TOKEN,
        downloads_dir=tmp_path / "downloads",
    )

    assert not hasattr(app.state, "tracking_admin_token")
    with TestClient(app) as test_client:
        assert test_client.get("/api/health").status_code == 200
        assert app.state.tracking_admin_token == ADMIN_TOKEN


def test_tracking_database_is_owner_only(tmp_path) -> None:
    database_path = tmp_path / "tracking.sqlite3"
    TrackingRepository(database_path)

    assert S_IMODE(database_path.stat().st_mode) == 0o600


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


def test_device_pairing_and_reliable_location_request_flow(client: TestClient) -> None:
    admin_headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    assert client.get("/api/devices").status_code == 401
    assert client.get("/api/devices", headers={"Authorization": "Bearer wrong"}).status_code == 401

    pairing_response = client.post(
        "/api/devices/pairing-codes",
        headers=admin_headers,
        json={"device_name": "Personal phone"},
    )
    assert pairing_response.status_code == 201
    pairing_code = pairing_response.json()["code"]

    registration_response = client.post(
        "/api/device/register",
        json={
            "pairing_code": pairing_code.lower().replace("-", " "),
            "device_name": "  Pixel 9  ",
            "platform_version": "Android 16",
            "app_version": "0.1.0",
        },
    )
    assert registration_response.status_code == 201
    credentials = registration_response.json()
    device_headers = {"Authorization": f"Bearer {credentials['device_token']}"}

    assert (
        client.post(
            "/api/device/register",
            json={
                "pairing_code": pairing_code,
                "device_name": "Duplicate",
                "platform_version": "Android 16",
                "app_version": "0.1.0",
            },
        ).status_code
        == 400
    )

    devices = client.get("/api/devices", headers=admin_headers).json()
    assert len(devices) == 1
    assert devices[0]["name"] == "Pixel 9"
    assert devices[0]["latest_location"] is None

    request_response = client.post(
        f"/api/devices/{credentials['device_id']}/location-requests",
        headers=admin_headers,
    )
    assert request_response.status_code == 202
    location_request = request_response.json()
    assert location_request["status"] == "pending"

    duplicate_request = client.post(
        f"/api/devices/{credentials['device_id']}/location-requests",
        headers=admin_headers,
    ).json()
    assert duplicate_request["id"] == location_request["id"]

    command_response = client.get("/api/device/commands?wait_seconds=0", headers=device_headers)
    assert command_response.status_code == 200
    assert command_response.json()["request_id"] == location_request["id"]

    locating_response = client.post(
        f"/api/device/location-requests/{location_request['id']}/locating",
        headers=device_headers,
    )
    assert locating_response.json()["status"] == "locating"

    location_payload = {
        "request_id": location_request["id"],
        "latitude": 52.52,
        "longitude": 13.405,
        "accuracy": 6.5,
        "captured_at": "2026-07-21T10:30:00Z",
        "source": "current",
        "is_mock": False,
    }
    result_response = client.post("/api/device/location-results", headers=device_headers, json=location_payload)
    assert result_response.status_code == 201
    assert result_response.json()["accuracy"] == 6.5

    repeated_result = client.post("/api/device/location-results", headers=device_headers, json=location_payload)
    assert repeated_result.status_code == 201
    assert repeated_result.json() == result_response.json()

    device = client.get("/api/devices", headers=admin_headers).json()[0]
    assert device["active_request"] is None
    assert device["latest_location"]["latitude"] == 52.52
    assert device["latest_location"]["captured_at"] == "2026-07-21T10:30:00Z"

    assert client.get("/api/device/commands?wait_seconds=0", headers=device_headers).status_code == 204


def test_deleting_device_revokes_its_credential(client: TestClient) -> None:
    admin_headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    pairing = client.post(
        "/api/devices/pairing-codes",
        headers=admin_headers,
        json={"device_name": "Temporary phone"},
    ).json()
    credentials = client.post(
        "/api/device/register",
        json={
            "pairing_code": pairing["code"],
            "device_name": "Temporary phone",
            "platform_version": "Android 15",
            "app_version": "0.1.0",
        },
    ).json()

    delete_response = client.delete(f"/api/devices/{credentials['device_id']}", headers=admin_headers)
    assert delete_response.status_code == 200
    assert client.get("/api/devices", headers=admin_headers).json() == []
    assert (
        client.get(
            "/api/device/commands?wait_seconds=0",
            headers={"Authorization": f"Bearer {credentials['device_token']}"},
        ).status_code
        == 401
    )


def test_captured_location_is_accepted_after_request_timeout(tmp_path, monkeypatch) -> None:
    now = datetime(2026, 7, 21, 10, 0, tzinfo=UTC)
    clock = {"now": now}
    monkeypatch.setattr(tracking, "_utc_now", lambda: clock["now"])

    repository = TrackingRepository(tmp_path / "tracking.sqlite3")
    pairing = repository.create_pairing_code("Delayed phone")
    credentials = repository.register_device(
        DeviceRegistration(
            pairing_code=pairing.code,
            device_name="Delayed phone",
            platform_version="Android 16",
            app_version="0.1.0",
        )
    )
    request = repository.create_location_request(credentials.device_id)
    clock["now"] = now + REQUEST_TIMEOUT + timedelta(seconds=1)

    assert repository.get_device(credentials.device_id).active_request is None
    location = repository.save_location(
        credentials.device_id,
        LocationResultCreate(
            request_id=request.id,
            latitude=52.52,
            longitude=13.405,
            accuracy=5,
            captured_at=now + timedelta(seconds=20),
        ),
    )

    assert location.latitude == 52.52
    assert repository.get_device(credentials.device_id).latest_location == location
