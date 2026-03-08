from __future__ import annotations

from fastapi import APIRouter, Depends, status

from ...dependencies import get_point_repository
from ...models import ClearPointsResult, Point, PointCreate, PointUpdate
from ...storage import PointRepository

router = APIRouter(prefix="/points", tags=["points"])


@router.get("", response_model=list[Point])
def list_points(repository: PointRepository = Depends(get_point_repository)) -> list[Point]:
    return repository.list_points()


@router.delete("", response_model=ClearPointsResult)
def clear_points(repository: PointRepository = Depends(get_point_repository)) -> ClearPointsResult:
    return ClearPointsResult(removed_count=repository.clear_points())


@router.post("", response_model=Point, status_code=status.HTTP_201_CREATED)
def create_point(
    payload: PointCreate,
    repository: PointRepository = Depends(get_point_repository),
) -> Point:
    return repository.add_point(payload)


@router.put("/{point_id}", response_model=Point)
def update_point(
    point_id: str,
    payload: PointUpdate,
    repository: PointRepository = Depends(get_point_repository),
) -> Point:
    return repository.update_point(point_id, payload)


@router.delete("/{point_id}", response_model=Point)
def delete_point(
    point_id: str,
    repository: PointRepository = Depends(get_point_repository),
) -> Point:
    return repository.delete_point(point_id)
