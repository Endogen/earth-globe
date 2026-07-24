from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Query, Request, Response, status

from ...dependencies import authenticate_device, get_tracking_repository, require_tracking_admin
from ...models import (
    DeviceCredentials,
    DeviceLocation,
    DeviceRegistration,
    LocationCommand,
    LocationFailureCreate,
    LocationRequest,
    LocationResultCreate,
    PairingCode,
    PairingCodeCreate,
    TrackedDevice,
    TrackingStatus,
)
from ...tracking import TrackingRepository

router = APIRouter(tags=["device tracking"])


@router.get("/tracking/status", response_model=TrackingStatus)
def tracking_status(request: Request) -> TrackingStatus:
    return TrackingStatus(apk_available=(request.app.state.downloads_dir / "earth-tracker.apk").is_file())


@router.post(
    "/devices/pairing-codes",
    response_model=PairingCode,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_tracking_admin)],
)
def create_pairing_code(
    payload: PairingCodeCreate,
    repository: TrackingRepository = Depends(get_tracking_repository),
) -> PairingCode:
    return repository.create_pairing_code(payload.device_name)


@router.get(
    "/devices",
    response_model=list[TrackedDevice],
    dependencies=[Depends(require_tracking_admin)],
)
def list_devices(repository: TrackingRepository = Depends(get_tracking_repository)) -> list[TrackedDevice]:
    return repository.list_devices()


@router.delete(
    "/devices/{device_id}",
    response_model=TrackedDevice,
    dependencies=[Depends(require_tracking_admin)],
)
def delete_device(
    device_id: str,
    repository: TrackingRepository = Depends(get_tracking_repository),
) -> TrackedDevice:
    return repository.delete_device(device_id)


@router.post(
    "/devices/{device_id}/location-requests",
    response_model=LocationRequest,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_tracking_admin)],
)
def request_device_location(
    device_id: str,
    repository: TrackingRepository = Depends(get_tracking_repository),
) -> LocationRequest:
    return repository.create_location_request(device_id)


@router.post("/device/register", response_model=DeviceCredentials, status_code=status.HTTP_201_CREATED)
def register_device(
    payload: DeviceRegistration,
    repository: TrackingRepository = Depends(get_tracking_repository),
) -> DeviceCredentials:
    return repository.register_device(payload)


@router.get("/device/commands", response_model=LocationCommand | None)
async def wait_for_device_command(
    response: Response,
    wait_seconds: int = Query(default=25, ge=0, le=30),
    device_id: str = Depends(authenticate_device),
    repository: TrackingRepository = Depends(get_tracking_repository),
) -> LocationCommand | None:
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while True:
        command = await asyncio.to_thread(repository.claim_location_request, device_id)
        if command is not None:
            return command
        if asyncio.get_running_loop().time() >= deadline:
            response.status_code = status.HTTP_204_NO_CONTENT
            return None
        await asyncio.sleep(0.5)


@router.post("/device/location-requests/{request_id}/locating", response_model=LocationRequest)
def mark_device_locating(
    request_id: str,
    device_id: str = Depends(authenticate_device),
    repository: TrackingRepository = Depends(get_tracking_repository),
) -> LocationRequest:
    return repository.mark_locating(device_id, request_id)


@router.post("/device/location-results", response_model=DeviceLocation, status_code=status.HTTP_201_CREATED)
def submit_device_location(
    payload: LocationResultCreate,
    device_id: str = Depends(authenticate_device),
    repository: TrackingRepository = Depends(get_tracking_repository),
) -> DeviceLocation:
    return repository.save_location(device_id, payload)


@router.post("/device/location-failures", response_model=LocationRequest)
def submit_device_location_failure(
    payload: LocationFailureCreate,
    device_id: str = Depends(authenticate_device),
    repository: TrackingRepository = Depends(get_tracking_repository),
) -> LocationRequest:
    return repository.fail_location_request(device_id, payload)
