from __future__ import annotations

import hashlib
import secrets
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Lock
from uuid import uuid4

from fastapi import HTTPException, status

from .models import (
    DeviceCredentials,
    DeviceLocation,
    DeviceRegistration,
    LocationCommand,
    LocationFailureCreate,
    LocationRequest,
    LocationResultCreate,
    PairingCode,
    TrackedDevice,
)

PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
ACTIVE_REQUEST_STATUSES = ("pending", "delivered", "locating")
REQUEST_TIMEOUT = timedelta(minutes=10)
REDELIVERY_INTERVAL = timedelta(seconds=12)


class TrackingDataError(RuntimeError):
    """Raised when the tracking database cannot be read or updated safely."""


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _as_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def _hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_pairing_code(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())


def _parse_timestamp(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


class TrackingRepository:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def create_pairing_code(self, device_name: str, valid_for: timedelta = timedelta(minutes=10)) -> PairingCode:
        raw_code = "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(8))
        display_code = f"{raw_code[:4]}-{raw_code[4:]}"
        now = _utc_now()
        expires_at = now + valid_for
        with self._locked_connection() as connection:
            connection.execute(
                """
                INSERT INTO pairing_codes (code_hash, device_name, created_at, expires_at)
                VALUES (?, ?, ?, ?)
                """,
                (_hash_secret(raw_code), device_name, _as_timestamp(now), _as_timestamp(expires_at)),
            )
            connection.execute(
                "DELETE FROM pairing_codes WHERE expires_at < ?", (_as_timestamp(now - timedelta(days=1)),)
            )
        return PairingCode(code=display_code, device_name=device_name, expires_at=expires_at)

    def register_device(self, payload: DeviceRegistration) -> DeviceCredentials:
        normalized_code = _normalize_pairing_code(payload.pairing_code)
        now = _utc_now()
        device_id = str(uuid4())
        device_token = secrets.token_urlsafe(32)

        with self._locked_connection() as connection:
            pairing = connection.execute(
                """
                SELECT code_hash, expires_at, used_at
                FROM pairing_codes
                WHERE code_hash = ?
                """,
                (_hash_secret(normalized_code),),
            ).fetchone()
            if pairing is None or pairing["used_at"] is not None or _parse_timestamp(pairing["expires_at"]) <= now:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST, detail="Pairing code is invalid or expired"
                )

            connection.execute(
                """
                INSERT INTO devices (
                    id, name, token_hash, platform_version, app_version, created_at, last_seen_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    device_id,
                    payload.device_name,
                    _hash_secret(device_token),
                    payload.platform_version,
                    payload.app_version,
                    _as_timestamp(now),
                    _as_timestamp(now),
                ),
            )
            connection.execute(
                "UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?",
                (_as_timestamp(now), pairing["code_hash"]),
            )

        return DeviceCredentials(device_id=device_id, device_token=device_token)

    def authenticate_device(self, device_token: str) -> str:
        now = _utc_now()
        with self._locked_connection() as connection:
            device = connection.execute(
                "SELECT id FROM devices WHERE token_hash = ?",
                (_hash_secret(device_token),),
            ).fetchone()
            if device is None:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid device credential")
            connection.execute(
                "UPDATE devices SET last_seen_at = ? WHERE id = ?",
                (_as_timestamp(now), device["id"]),
            )
            return str(device["id"])

    def list_devices(self) -> list[TrackedDevice]:
        with self._locked_connection() as connection:
            self._expire_requests(connection)
            rows = connection.execute("SELECT * FROM devices ORDER BY created_at DESC").fetchall()
            return [self._build_device(connection, row) for row in rows]

    def get_device(self, device_id: str) -> TrackedDevice:
        with self._locked_connection() as connection:
            self._expire_requests(connection)
            return self._build_device(connection, self._require_device(connection, device_id))

    def delete_device(self, device_id: str) -> TrackedDevice:
        with self._locked_connection() as connection:
            row = self._require_device(connection, device_id)
            device = self._build_device(connection, row)
            connection.execute("DELETE FROM devices WHERE id = ?", (device_id,))
            return device

    def create_location_request(self, device_id: str) -> LocationRequest:
        now = _utc_now()
        with self._locked_connection() as connection:
            self._require_device(connection, device_id)
            self._expire_requests(connection, now)
            active = connection.execute(
                """
                SELECT * FROM location_requests
                WHERE device_id = ? AND status IN (?, ?, ?)
                ORDER BY created_at DESC LIMIT 1
                """,
                (device_id, *ACTIVE_REQUEST_STATUSES),
            ).fetchone()
            if active is not None:
                return self._build_request(active)

            request_id = str(uuid4())
            connection.execute(
                """
                INSERT INTO location_requests (id, device_id, status, created_at, delivery_attempts)
                VALUES (?, ?, 'pending', ?, 0)
                """,
                (request_id, device_id, _as_timestamp(now)),
            )
            created = connection.execute("SELECT * FROM location_requests WHERE id = ?", (request_id,)).fetchone()
            return self._build_request(created)

    def claim_location_request(self, device_id: str) -> LocationCommand | None:
        now = _utc_now()
        with self._locked_connection() as connection:
            self._expire_requests(connection, now)
            row = connection.execute(
                """
                SELECT * FROM location_requests
                WHERE device_id = ?
                  AND status IN (?, ?, ?)
                  AND (last_delivery_at IS NULL OR last_delivery_at <= ?)
                ORDER BY created_at ASC LIMIT 1
                """,
                (device_id, *ACTIVE_REQUEST_STATUSES, _as_timestamp(now - REDELIVERY_INTERVAL)),
            ).fetchone()
            if row is None:
                return None

            connection.execute(
                """
                UPDATE location_requests
                SET status = 'delivered',
                    delivered_at = COALESCE(delivered_at, ?),
                    last_delivery_at = ?,
                    delivery_attempts = delivery_attempts + 1
                WHERE id = ?
                """,
                (_as_timestamp(now), _as_timestamp(now), row["id"]),
            )
            return LocationCommand(request_id=row["id"], requested_at=_parse_timestamp(row["created_at"]))

    def mark_locating(self, device_id: str, request_id: str) -> LocationRequest:
        now = _utc_now()
        with self._locked_connection() as connection:
            row = self._require_request(connection, device_id, request_id)
            if row["status"] not in ACTIVE_REQUEST_STATUSES:
                return self._build_request(row)
            connection.execute(
                "UPDATE location_requests SET status = 'locating', last_delivery_at = ? WHERE id = ?",
                (_as_timestamp(now), request_id),
            )
            return self._build_request(
                connection.execute("SELECT * FROM location_requests WHERE id = ?", (request_id,)).fetchone()
            )

    def save_location(self, device_id: str, payload: LocationResultCreate) -> DeviceLocation:
        now = _utc_now()
        with self._locked_connection() as connection:
            request = self._require_request(connection, device_id, payload.request_id)
            existing = connection.execute(
                "SELECT * FROM location_samples WHERE request_id = ?",
                (payload.request_id,),
            ).fetchone()
            if existing is not None:
                return self._build_location(existing)
            if request["status"] == "failed":
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Location request is no longer active")

            connection.execute(
                """
                INSERT INTO location_samples (
                    id, request_id, device_id, latitude, longitude, accuracy, altitude,
                    captured_at, received_at, source, is_mock
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid4()),
                    payload.request_id,
                    device_id,
                    payload.latitude,
                    payload.longitude,
                    payload.accuracy,
                    payload.altitude,
                    _as_timestamp(payload.captured_at),
                    _as_timestamp(now),
                    payload.source,
                    int(payload.is_mock),
                ),
            )
            connection.execute(
                """
                UPDATE location_requests
                SET status = 'succeeded', completed_at = ?, error = NULL
                WHERE id = ?
                """,
                (_as_timestamp(now), payload.request_id),
            )
            return self._build_location(
                connection.execute(
                    "SELECT * FROM location_samples WHERE request_id = ?",
                    (payload.request_id,),
                ).fetchone()
            )

    def fail_location_request(self, device_id: str, payload: LocationFailureCreate) -> LocationRequest:
        now = _utc_now()
        with self._locked_connection() as connection:
            row = self._require_request(connection, device_id, payload.request_id)
            if row["status"] == "succeeded":
                return self._build_request(row)
            connection.execute(
                """
                UPDATE location_requests
                SET status = 'failed', completed_at = ?, error = ?
                WHERE id = ?
                """,
                (_as_timestamp(now), payload.error, payload.request_id),
            )
            return self._build_request(
                connection.execute("SELECT * FROM location_requests WHERE id = ?", (payload.request_id,)).fetchone()
            )

    def _initialize(self) -> None:
        try:
            with self._connect() as connection:
                connection.executescript(
                    """
                    PRAGMA journal_mode = WAL;
                    PRAGMA foreign_keys = ON;

                    CREATE TABLE IF NOT EXISTS pairing_codes (
                        code_hash TEXT PRIMARY KEY,
                        device_name TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        expires_at TEXT NOT NULL,
                        used_at TEXT
                    );

                    CREATE TABLE IF NOT EXISTS devices (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        token_hash TEXT NOT NULL UNIQUE,
                        platform_version TEXT NOT NULL,
                        app_version TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        last_seen_at TEXT
                    );

                    CREATE TABLE IF NOT EXISTS location_requests (
                        id TEXT PRIMARY KEY,
                        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                        status TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        delivered_at TEXT,
                        last_delivery_at TEXT,
                        delivery_attempts INTEGER NOT NULL DEFAULT 0,
                        completed_at TEXT,
                        error TEXT
                    );

                    CREATE TABLE IF NOT EXISTS location_samples (
                        id TEXT PRIMARY KEY,
                        request_id TEXT NOT NULL UNIQUE REFERENCES location_requests(id) ON DELETE CASCADE,
                        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                        latitude REAL NOT NULL,
                        longitude REAL NOT NULL,
                        accuracy REAL NOT NULL,
                        altitude REAL,
                        captured_at TEXT NOT NULL,
                        received_at TEXT NOT NULL,
                        source TEXT NOT NULL,
                        is_mock INTEGER NOT NULL DEFAULT 0
                    );

                    CREATE INDEX IF NOT EXISTS idx_location_requests_device_status
                    ON location_requests(device_id, status, created_at);

                    CREATE INDEX IF NOT EXISTS idx_location_samples_device_received
                    ON location_samples(device_id, received_at DESC);
                    """
                )
            self._path.chmod(0o600)
        except (OSError, sqlite3.Error) as exc:
            raise TrackingDataError("The device tracking database could not be initialized.") from exc

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def _locked_connection(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                with self._connect() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    yield connection
            except HTTPException:
                raise
            except sqlite3.Error as exc:
                raise TrackingDataError("The device tracking database could not be updated.") from exc

    def _expire_requests(self, connection: sqlite3.Connection, now: datetime | None = None) -> None:
        current_time = now or _utc_now()
        connection.execute(
            """
            UPDATE location_requests
            SET status = 'timed_out', completed_at = ?, error = 'The device did not answer within ten minutes.'
            WHERE status IN (?, ?, ?) AND created_at <= ?
            """,
            (
                _as_timestamp(current_time),
                *ACTIVE_REQUEST_STATUSES,
                _as_timestamp(current_time - REQUEST_TIMEOUT),
            ),
        )

    @staticmethod
    def _require_device(connection: sqlite3.Connection, device_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
        return row

    @staticmethod
    def _require_request(connection: sqlite3.Connection, device_id: str, request_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM location_requests WHERE id = ? AND device_id = ?",
            (request_id, device_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Location request not found")
        return row

    def _build_device(self, connection: sqlite3.Connection, row: sqlite3.Row) -> TrackedDevice:
        location_row = connection.execute(
            "SELECT * FROM location_samples WHERE device_id = ? ORDER BY received_at DESC LIMIT 1",
            (row["id"],),
        ).fetchone()
        request_row = connection.execute(
            """
            SELECT * FROM location_requests
            WHERE device_id = ? AND status IN (?, ?, ?)
            ORDER BY created_at DESC LIMIT 1
            """,
            (row["id"], *ACTIVE_REQUEST_STATUSES),
        ).fetchone()
        return TrackedDevice(
            id=row["id"],
            name=row["name"],
            platform_version=row["platform_version"],
            app_version=row["app_version"],
            created_at=_parse_timestamp(row["created_at"]),
            last_seen_at=_parse_timestamp(row["last_seen_at"]),
            latest_location=self._build_location(location_row) if location_row is not None else None,
            active_request=self._build_request(request_row) if request_row is not None else None,
        )

    @staticmethod
    def _build_request(row: sqlite3.Row) -> LocationRequest:
        return LocationRequest(
            id=row["id"],
            device_id=row["device_id"],
            status=row["status"],
            created_at=_parse_timestamp(row["created_at"]),
            delivered_at=_parse_timestamp(row["delivered_at"]),
            completed_at=_parse_timestamp(row["completed_at"]),
            error=row["error"],
        )

    @staticmethod
    def _build_location(row: sqlite3.Row) -> DeviceLocation:
        return DeviceLocation(
            latitude=row["latitude"],
            longitude=row["longitude"],
            accuracy=row["accuracy"],
            altitude=row["altitude"],
            captured_at=_parse_timestamp(row["captured_at"]),
            received_at=_parse_timestamp(row["received_at"]),
            source=row["source"],
            is_mock=bool(row["is_mock"]),
        )
