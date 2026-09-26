from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.routes.auth import router as auth_router
from .api.routes.meta import router as meta_router
from .api.routes.points import router as points_router
from .api.routes.tracking import router as tracking_router
from .config import (
    DOWNLOADS_DIR,
    INDEX_FILE,
    POINTS_FILE,
    STATIC_DIR,
    TRACKING_DATABASE_FILE,
    get_or_create_tracking_admin_token,
    settings,
)
from .storage import PointDataError, PointRepository
from .tracking import TrackingDataError, TrackingRepository


def create_app(
    *,
    point_repository: PointRepository | None = None,
    tracking_repository: TrackingRepository | None = None,
    tracking_admin_token: str | None = None,
    downloads_dir: Path = DOWNLOADS_DIR,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.point_repository = point_repository or PointRepository(POINTS_FILE)
        app.state.tracking_repository = tracking_repository or TrackingRepository(TRACKING_DATABASE_FILE)
        app.state.tracking_admin_token = tracking_admin_token or get_or_create_tracking_admin_token()
        app.state.downloads_dir = downloads_dir
        downloads_dir.mkdir(parents=True, exist_ok=True)
        yield

    app = FastAPI(title=settings.title, description=settings.description, version="0.5.0", lifespan=lifespan)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        if request.url.path.startswith("/api/") and request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            cross_origin = origin and origin != f"{request.url.scheme}://{request.url.netloc}"
            if cross_origin or request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse(status_code=403, content={"detail": "Cross-origin changes are not allowed."})
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path == "/":
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self' https://unpkg.com; "
                "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; "
                "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://tiles.openfreemap.org; "
                "connect-src 'self' https://tiles.openfreemap.org; worker-src 'self' blob:; "
                "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
            )
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        elif request.url.path == "/" or request.url.path.startswith("/assets/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(PointDataError)
    async def point_data_error_handler(_request: Request, exc: PointDataError) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    @app.exception_handler(TrackingDataError)
    async def tracking_data_error_handler(_request: Request, exc: TrackingDataError) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    app.include_router(auth_router, prefix="/api")
    app.include_router(meta_router, prefix="/api")
    app.include_router(points_router, prefix="/api")
    app.include_router(tracking_router, prefix="/api")
    app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")
    app.mount("/downloads", StaticFiles(directory=downloads_dir, check_dir=False), name="downloads")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(INDEX_FILE)

    return app


app = create_app()
