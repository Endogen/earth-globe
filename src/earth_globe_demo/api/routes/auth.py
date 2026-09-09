from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ...dependencies import require_tracking_admin

router = APIRouter(prefix="/auth", tags=["workspace access"])
COOKIE_NAME = "earth_session"


class SessionCreate(BaseModel):
    control_key: str = Field(min_length=1, max_length=512)


@router.post("/session", status_code=204)
def create_session(payload: SessionCreate, request: Request, response: Response) -> None:
    repository = request.app.state.tracking_repository
    repository.check_auth_attempt("login:" + (request.client.host if request.client else "unknown"))
    if not hmac.compare_digest(payload.control_key.strip().encode(), request.app.state.tracking_admin_token.encode()):
        raise HTTPException(401, "Invalid control key", headers={"WWW-Authenticate": "Bearer"})
    previous = request.cookies.get(COOKIE_NAME)
    if previous:
        repository.revoke_admin_session(previous)
    token = repository.create_admin_session(request.app.state.tracking_admin_token)
    response.set_cookie(
        COOKIE_NAME, token, max_age=8 * 60 * 60, httponly=True,
        secure=request.url.scheme == "https", samesite="strict", path="/api",
    )


@router.get("/session", dependencies=[Depends(require_tracking_admin)])
def get_session() -> dict[str, bool]:
    return {"authenticated": True}


@router.delete("/session", status_code=204)
def delete_session(request: Request, response: Response) -> None:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        request.app.state.tracking_repository.revoke_admin_session(token)
    response.delete_cookie(COOKIE_NAME, path="/api", httponly=True, samesite="strict")
