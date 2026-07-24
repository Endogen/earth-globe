from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PointBase(BaseModel):
    label: str = Field(min_length=1, max_length=48)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    color: str = Field(default="#ff8d57", pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("label", mode="before")
    @classmethod
    def strip_label(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class PointCreate(PointBase):
    pass


class PointUpdate(PointBase):
    pass


class Point(PointBase):
    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1)
    created_at: datetime


class ClearPointsResult(BaseModel):
    removed_count: int = Field(ge=0)


class ViewConfig(BaseModel):
    longitude: float
    latitude: float
    zoom: float
    bearing: float
    pitch: float
    min_zoom: float
    max_zoom: float


class RotationConfig(BaseModel):
    enabled: bool
    degrees_per_second: float
    max_zoom: float


class ClientConfig(BaseModel):
    app_title: str
    app_description: str
    map_style_url: str
    custom_attribution: str
    default_point_color: str
    initial_view: ViewConfig
    rotation: RotationConfig


class PairingCodeCreate(BaseModel):
    device_name: str = Field(min_length=1, max_length=64)

    @field_validator("device_name", mode="before")
    @classmethod
    def strip_device_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class PairingCode(BaseModel):
    code: str
    device_name: str
    expires_at: datetime


class DeviceRegistration(BaseModel):
    pairing_code: str = Field(min_length=8, max_length=16)
    device_name: str = Field(min_length=1, max_length=64)
    platform_version: str = Field(default="Unknown", max_length=32)
    app_version: str = Field(default="Unknown", max_length=32)

    @field_validator("pairing_code", mode="before")
    @classmethod
    def normalize_pairing_code(cls, value: object) -> object:
        return value.strip().upper() if isinstance(value, str) else value

    @field_validator("device_name", "platform_version", "app_version", mode="before")
    @classmethod
    def strip_registration_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class DeviceCredentials(BaseModel):
    device_id: str
    device_token: str


class DeviceLocation(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: float = Field(ge=0, le=100_000)
    altitude: float | None = None
    captured_at: datetime
    received_at: datetime
    source: Literal["current", "cached"]
    is_mock: bool = False


class LocationRequest(BaseModel):
    id: str
    device_id: str
    status: Literal["pending", "delivered", "locating", "succeeded", "failed", "timed_out"]
    created_at: datetime
    delivered_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None


class TrackedDevice(BaseModel):
    id: str
    name: str
    platform_version: str
    app_version: str
    created_at: datetime
    last_seen_at: datetime | None = None
    latest_location: DeviceLocation | None = None
    active_request: LocationRequest | None = None


class LocationCommand(BaseModel):
    type: Literal["locate"] = "locate"
    request_id: str
    requested_at: datetime


class LocationResultCreate(BaseModel):
    request_id: str = Field(min_length=1)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: float = Field(ge=0, le=100_000)
    altitude: float | None = None
    captured_at: datetime
    source: Literal["current", "cached"] = "current"
    is_mock: bool = False


class LocationFailureCreate(BaseModel):
    request_id: str = Field(min_length=1)
    error: str = Field(min_length=1, max_length=240)


class TrackingStatus(BaseModel):
    enabled: bool = True
    apk_available: bool = False
