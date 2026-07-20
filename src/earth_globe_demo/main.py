from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.routes.meta import router as meta_router
from .api.routes.points import router as points_router
from .config import INDEX_FILE, STATIC_DIR, POINTS_FILE, settings
from .storage import PointDataError, PointRepository


def create_app() -> FastAPI:
    app = FastAPI(title=settings.title, description=settings.description, version="0.2.0")
    app.state.point_repository = PointRepository(POINTS_FILE)

    @app.exception_handler(PointDataError)
    async def point_data_error_handler(_request: Request, exc: PointDataError) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    app.include_router(meta_router, prefix="/api")
    app.include_router(points_router, prefix="/api")
    app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(INDEX_FILE)

    return app


app = create_app()
