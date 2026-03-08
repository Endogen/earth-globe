from __future__ import annotations

from fastapi import Request

from .storage import PointRepository


def get_point_repository(request: Request) -> PointRepository:
    return request.app.state.point_repository
