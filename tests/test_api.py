from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from stat import S_IMODE

import pytest
from fastapi import HTTPException
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
    assert client.post("/api/auth/session", json={"control_key": ADMIN_TOKEN}).status_code == 204
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
    assert client.post("/api/auth/session", json={"control_key": ADMIN_TOKEN}).status_code == 204
    response = client.post("/api/points", json=payload)
    assert response.status_code == 422
    assert client.get("/api/points").json() == []


def test_missing_point_returns_not_found(client: TestClient) -> None:
    assert client.post("/api/auth/session", json={"control_key": ADMIN_TOKEN}).status_code == 204
    payload = {"label": "Missing", "latitude": 0, "longitude": 0, "color": "#ff8d57"}
    assert client.put("/api/points/does-not-exist", json=payload).status_code == 404
    assert client.delete("/api/points/does-not-exist").status_code == 404


def test_clear_points_reports_removed_count(client: TestClient) -> None:
    assert client.post("/api/auth/session", json={"control_key": ADMIN_TOKEN}).status_code == 204
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


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/points"), ("POST", "/api/points"), ("DELETE", "/api/points"),
    ("PUT", "/api/points/id"), ("DELETE", "/api/points/id"),
])
def test_points_require_authentication(client: TestClient, method: str, path: str) -> None:
    response = client.request(method, path)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.headers["cache-control"] == "no-store"


def test_session_cookie_expiry_rotation_and_revocation(client: TestClient, monkeypatch) -> None:
    now = datetime.now(UTC)
    monkeypatch.setattr(tracking, "_utc_now", lambda: now)
    response = client.post("/api/auth/session", json={"control_key": ADMIN_TOKEN})
    assert response.status_code == 204
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Max-Age=28800" in cookie
    token = client.cookies.get("earth_session")
    assert ADMIN_TOKEN not in cookie
    assert client.get("/api/points").status_code == 200
    assert client.get("/api/devices").status_code == 200
    repository = client.app.state.tracking_repository
    assert repository.valid_admin_session(token, ADMIN_TOKEN)
    assert not repository.valid_admin_session(token, "a-new-control-key")
    monkeypatch.setattr(tracking, "_utc_now", lambda: now + timedelta(hours=9))
    assert client.get("/api/points").status_code == 401
    monkeypatch.setattr(tracking, "_utc_now", lambda: now)
    assert client.delete("/api/auth/session").status_code == 204
    assert not repository.valid_admin_session(token, ADMIN_TOKEN)
    assert client.get("/api/points").status_code == 401


def test_cross_origin_writes_rejected_and_bearer_clients_work(client: TestClient) -> None:
    assert client.post("/api/auth/session", json={"control_key": ADMIN_TOKEN},
                       headers={"Origin": "https://untrusted.example"}).status_code == 403
    assert client.post("/api/auth/session", json={"control_key": ADMIN_TOKEN},
                       headers={"Origin": "http://testserver"}).status_code == 204
    assert client.delete("/api/points", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    client.cookies.clear()
    assert client.get("/api/points", headers={"Authorization": f"Bearer {ADMIN_TOKEN}"}).status_code == 200


def test_login_and_pairing_rate_limits_expire(client: TestClient, monkeypatch) -> None:
    now = datetime.now(UTC)
    monkeypatch.setattr(tracking, "_utc_now", lambda: now)
    for _ in range(10):
        assert client.post("/api/auth/session", json={"control_key": "wrong"}).status_code == 401
    response = client.post("/api/auth/session", json={"control_key": ADMIN_TOKEN})
    assert response.status_code == 429 and response.headers["retry-after"] == "60"
    for _ in range(10):
        assert client.post("/api/device/register", json={"pairing_code": "ABCDEFGH", "device_name": "Test"}).status_code == 400
    assert client.post("/api/device/register", json={"pairing_code": "ABCDEFGH", "device_name": "Test"}).status_code == 429
    monkeypatch.setattr(tracking, "_utc_now", lambda: now + timedelta(seconds=61))
    assert client.post("/api/auth/session", json={"control_key": ADMIN_TOKEN}).status_code == 204


def test_security_headers_and_https_cookie(client: TestClient) -> None:
    response = client.get("/")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    response = client.post("https://testserver/api/auth/session", json={"control_key": ADMIN_TOKEN})
    assert "Secure" in response.headers["set-cookie"]


def test_tracking_connections_are_closed(tmp_path, monkeypatch) -> None:
    import sqlite3

    repository = TrackingRepository(tmp_path / "tracking.sqlite3")
    connections = []
    connect = repository._connect

    def record_connection():
        connection = connect()
        connections.append(connection)
        return connection

    monkeypatch.setattr(repository, "_connect", record_connection)
    repository.list_devices()
    with pytest.raises(HTTPException):
        repository.authenticate_device("invalid")
    for connection in connections:
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            connection.execute("SELECT 1")


def test_delayed_upload_does_not_replace_a_newer_device_fix(tmp_path, monkeypatch) -> None:
    repository = TrackingRepository(tmp_path / "tracking.sqlite3")
    now = datetime.now(UTC)
    monkeypatch.setattr(tracking, "_utc_now", lambda: now)
    code = repository.create_pairing_code("Phone")
    credentials = repository.register_device(DeviceRegistration(pairing_code=code.code, device_name="Phone"))
    first = repository.create_location_request(credentials.device_id)
    later = now + REQUEST_TIMEOUT + timedelta(seconds=1)
    monkeypatch.setattr(tracking, "_utc_now", lambda: later)
    second = repository.create_location_request(credentials.device_id)
    repository.save_location(credentials.device_id, LocationResultCreate(
        request_id=second.id, latitude=20, longitude=30, accuracy=5, captured_at=later,
    ))
    monkeypatch.setattr(tracking, "_utc_now", lambda: later + timedelta(seconds=5))
    repository.save_location(credentials.device_id, LocationResultCreate(
        request_id=first.id, latitude=10, longitude=10, accuracy=5, captured_at=now,
    ))
    device = repository.get_device(credentials.device_id)
    assert device.latest_location.latitude == 20
    assert device.latest_request.id == second.id


def test_timed_out_requests_remain_visible_to_the_operator(tmp_path, monkeypatch) -> None:
    repository = TrackingRepository(tmp_path / "tracking.sqlite3")
    now = datetime.now(UTC)
    monkeypatch.setattr(tracking, "_utc_now", lambda: now)
    pairing = repository.create_pairing_code("Phone")
    credentials = repository.register_device(DeviceRegistration(pairing_code=pairing.code, device_name="Phone"))
    repository.create_location_request(credentials.device_id)
    monkeypatch.setattr(tracking, "_utc_now", lambda: now + REQUEST_TIMEOUT + timedelta(seconds=1))
    device = repository.list_devices()[0]
    assert device.active_request is None
    assert device.latest_request.status == "timed_out"
    assert device.latest_request.error
