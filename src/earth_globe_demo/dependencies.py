from __future__ import annotations

import hmac

from fastapi import Depends, Header, HTTPException, Request, status

from .storage import PointRepository
from .tracking import TrackingRepository


def get_point_repository(request: Request) -> PointRepository:
    return request.app.state.point_repository


def get_tracking_repository(request: Request) -> TrackingRepository:
    return request.app.state.tracking_repository


def _bearer_token(authorization: str | None) -> str:
    scheme, separator, token = (authorization or "").partition(" ")
    if not separator or scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer credential required")
    return token.strip()


def require_tracking_admin(
    request: Request,
    authorization: str | None = Header(default=None),
) -> None:
    supplied_token = _bearer_token(authorization)
    if not hmac.compare_digest(supplied_token, request.app.state.tracking_admin_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid control key")


def authenticate_device(
    authorization: str | None = Header(default=None),
    repository: TrackingRepository = Depends(get_tracking_repository),
) -> str:
    return repository.authenticate_device(_bearer_token(authorization))
