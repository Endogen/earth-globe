from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

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

    app = FastAPI(title=settings.title, description=settings.description, version="0.3.0", lifespan=lifespan)

    @app.exception_handler(PointDataError)
    async def point_data_error_handler(_request: Request, exc: PointDataError) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    @app.exception_handler(TrackingDataError)
    async def tracking_data_error_handler(_request: Request, exc: TrackingDataError) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": str(exc)})

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
