from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class PointBase(BaseModel):
    label: str = Field(min_length=1, max_length=48)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    color: str = Field(default="#ff8d57", pattern=r"^#[0-9a-fA-F]{6}$")


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
