from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter

from ...config import settings
from ...models import ClientConfig, RotationConfig, ViewConfig

router = APIRouter(tags=["meta"])


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/config", response_model=ClientConfig)
def client_config() -> ClientConfig:
    return ClientConfig(
        app_title=settings.title,
        app_description=settings.description,
        map_style_url=settings.map_style_url,
        custom_attribution=settings.custom_attribution,
        default_point_color=settings.default_point_color,
        initial_view=ViewConfig(**asdict(settings.view)),
        rotation=RotationConfig(**asdict(settings.rotation)),
    )
