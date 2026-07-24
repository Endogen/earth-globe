package com.earthmarkerstudio.tracker;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import com.google.android.gms.location.CurrentLocationRequest;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.time.Instant;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class TrackingService extends Service {
    static final String ACTION_START = "com.earthmarkerstudio.tracker.START";
    static final String ACTION_STOP = "com.earthmarkerstudio.tracker.STOP";

    private static final String CHANNEL_ID = "earth_tracker_connection";
    private static final int NOTIFICATION_ID = 7301;
    private static final long FRESH_LOCATION_TIMEOUT_MS = 35_000;
    private static final long MAX_CACHED_LOCATION_AGE_MS = 5 * 60_000;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean running;
    private FusedLocationProviderClient locationClient;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        locationClient = LocationServices.getFusedLocationProviderClient(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            TrackerPreferences.setServiceEnabled(this, false);
            TrackerPreferences.setServiceState(this, "stopped", "Tracking was stopped from the app or notification.");
            running = false;
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        TrackerPreferences.Registration registration = TrackerPreferences.registration(this);
        if (!registration.isComplete() || !TrackerPreferences.isServiceEnabled(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            promoteToForeground("Connecting to your private server…");
        } catch (RuntimeException exception) {
            TrackerPreferences.setServiceEnabled(this, false);
            TrackerPreferences.setServiceState(
                    this,
                    "error",
                    "Android blocked the location service. Open the app and review location permissions."
            );
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!running) {
            running = true;
            TrackerPreferences.setServiceState(this, "connecting", "Opening the reliable command connection…");
            worker.execute(this::runConnectionLoop);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        worker.shutdownNow();
        if (TrackerPreferences.isServiceEnabled(this)) {
            TrackerPreferences.setServiceState(this, "reconnecting", "Android is restarting the tracking service…");
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void runConnectionLoop() {
        int retrySeconds = 1;
        while (running && TrackerPreferences.isServiceEnabled(this)) {
            TrackerPreferences.Registration registration = TrackerPreferences.registration(this);
            if (!registration.isComplete()) {
                stopForInvalidCredential("This phone is no longer paired.");
                return;
            }

            try {
                sendPendingUpload(registration);
                if (!running) {
                    return;
                }
                TrackerApiClient.Response response = TrackerApiClient.get(
                        registration.serverUrl,
                        "/api/device/commands?wait_seconds=25",
                        registration.deviceToken,
                        40_000
                );
                if (response.statusCode == 401) {
                    stopForInvalidCredential("The server rejected this phone's device credential. Pair it again.");
                    return;
                }
                if (response.statusCode == 204) {
                    setState("connected", "Connected. Waiting for a location request.");
                    retrySeconds = 1;
                    continue;
                }
                if (!response.isSuccessful()) {
                    throw new IOException(TrackerApiClient.errorMessage(response));
                }

                JSONObject command = new JSONObject(response.body);
                if ("locate".equals(command.optString("type"))) {
                    handleLocationRequest(registration, command.getString("request_id"));
                }
                retrySeconds = 1;
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                return;
            } catch (IOException | JSONException | RuntimeException exception) {
                if (!running) {
                    return;
                }
                setState("reconnecting", "Connection interrupted. Retrying automatically in " + retrySeconds + " seconds.");
                if (!sleepSeconds(retrySeconds)) {
                    return;
                }
                retrySeconds = Math.min(30, retrySeconds * 2);
            }
        }
    }

    private void handleLocationRequest(TrackerPreferences.Registration registration, String requestId)
            throws InterruptedException, JSONException, IOException {
        setState("locating", "The website requested this phone's current location.");
        try {
            TrackerApiClient.Response locatingResponse = TrackerApiClient.post(
                    registration.serverUrl,
                    "/api/device/location-requests/" + requestId + "/locating",
                    registration.deviceToken,
                    "{}"
            );
            if (locatingResponse.statusCode == 401) {
                stopForInvalidCredential("The server rejected this phone's device credential. Pair it again.");
                return;
            }
        } catch (IOException ignored) {
            // Capturing the fix is still useful; the durable outbox will upload it after reconnection.
        }

        PowerManager powerManager = getSystemService(PowerManager.class);
        PowerManager.WakeLock wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                getPackageName() + ":location-request"
        );
        wakeLock.acquire(60_000);
        try {
            LocationFix fix = getLocationFix();
            if (fix == null) {
                queueFailure(requestId, "No location fix was available. Check Location Services and try again.");
            } else {
                queueLocation(requestId, fix);
            }
        } catch (SecurityException exception) {
            queueFailure(requestId, "Location permission is missing. Open Earth Tracker and configure location access.");
        } finally {
            if (wakeLock.isHeld()) {
                wakeLock.release();
            }
        }

        sendPendingUpload(registration);
        if (!running || !TrackerPreferences.isServiceEnabled(this)) {
            return;
        }
        setState("connected", "Location request completed. Waiting for the next request.");
    }

    private LocationFix getLocationFix() throws InterruptedException {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("Precise location permission is missing");
        }

        AtomicReference<Location> freshLocation = new AtomicReference<>();
        CountDownLatch freshLatch = new CountDownLatch(1);
        CancellationTokenSource cancellation = new CancellationTokenSource();
        CurrentLocationRequest request = new CurrentLocationRequest.Builder()
                .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
                .setDurationMillis(30_000)
                .setMaxUpdateAgeMillis(0)
                .build();
        locationClient.getCurrentLocation(request, cancellation.getToken())
                .addOnCompleteListener(task -> {
                    if (task.isSuccessful()) {
                        freshLocation.set(task.getResult());
                    }
                    freshLatch.countDown();
                });
        boolean finished = freshLatch.await(FRESH_LOCATION_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        if (!finished) {
            cancellation.cancel();
        }
        if (freshLocation.get() != null) {
            return new LocationFix(freshLocation.get(), "current");
        }

        AtomicReference<Location> cachedLocation = new AtomicReference<>();
        CountDownLatch cachedLatch = new CountDownLatch(1);
        locationClient.getLastLocation().addOnCompleteListener(task -> {
            if (task.isSuccessful()) {
                cachedLocation.set(task.getResult());
            }
            cachedLatch.countDown();
        });
        cachedLatch.await(5, TimeUnit.SECONDS);
        Location cached = cachedLocation.get();
        if (cached != null && Math.max(0, System.currentTimeMillis() - cached.getTime()) <= MAX_CACHED_LOCATION_AGE_MS) {
            return new LocationFix(cached, "cached");
        }
        return null;
    }

    private void queueLocation(String requestId, LocationFix fix) throws JSONException {
        Location location = fix.location;
        JSONObject payload = new JSONObject()
                .put("request_id", requestId)
                .put("latitude", location.getLatitude())
                .put("longitude", location.getLongitude())
                .put("accuracy", Math.max(0, location.getAccuracy()))
                .put("captured_at", Instant.ofEpochMilli(location.getTime()).toString())
                .put("source", fix.source)
                .put("is_mock", isMockLocation(location));
        payload.put("altitude", location.hasAltitude() ? location.getAltitude() : JSONObject.NULL);
        TrackerPreferences.savePendingUpload(this, "/api/device/location-results", payload.toString());
    }

    private void queueFailure(String requestId, String error) throws JSONException {
        JSONObject payload = new JSONObject()
                .put("request_id", requestId)
                .put("error", error.length() > 240 ? error.substring(0, 240) : error);
        TrackerPreferences.savePendingUpload(this, "/api/device/location-failures", payload.toString());
    }

    private void sendPendingUpload(TrackerPreferences.Registration registration) throws IOException {
        TrackerPreferences.PendingUpload upload = TrackerPreferences.pendingUpload(this);
        if (upload == null) {
            return;
        }
        TrackerApiClient.Response response = TrackerApiClient.post(
                registration.serverUrl,
                upload.endpoint,
                registration.deviceToken,
                upload.body
        );
        if (response.statusCode == 401) {
            stopForInvalidCredential("The server rejected this phone's device credential. Pair it again.");
            return;
        }
        if (response.isSuccessful() || response.statusCode == 404 || response.statusCode == 409) {
            TrackerPreferences.clearPendingUpload(this);
            return;
        }
        if (response.statusCode >= 400 && response.statusCode < 500
                && response.statusCode != 408 && response.statusCode != 429) {
            TrackerPreferences.clearPendingUpload(this);
            setState("error", "The server rejected a location result: " + TrackerApiClient.errorMessage(response));
            return;
        }
        throw new IOException(TrackerApiClient.errorMessage(response));
    }

    private void stopForInvalidCredential(String detail) {
        running = false;
        TrackerPreferences.setServiceEnabled(this, false);
        TrackerPreferences.setServiceState(this, "unauthorized", detail);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private boolean sleepSeconds(int seconds) {
        try {
            Thread.sleep(seconds * 1_000L);
            return true;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private void setState(String state, String detail) {
        TrackerPreferences.setServiceState(this, state, detail);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, createNotification(detail));
        }
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Device tracking connection",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shows when this phone is ready to answer your private location requests.");
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private void promoteToForeground(String detail) {
        Notification notification = createNotification(detail);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @SuppressWarnings("deprecation")
    private static boolean isMockLocation(Location location) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? location.isMock() : location.isFromMockProvider();
    }

    private Notification createNotification(String detail) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
                this,
                0,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Intent stopIntent = new Intent(this, TrackingService.class).setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
                this,
                1,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_tracker_status)
                .setContentTitle("Earth Tracker is ready")
                .setContentText(detail)
                .setStyle(new Notification.BigTextStyle().bigText(detail))
                .setContentIntent(openPendingIntent)
                .addAction(new Notification.Action.Builder(null, "Stop", stopPendingIntent).build())
                .setCategory(Notification.CATEGORY_SERVICE)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private static final class LocationFix {
        final Location location;
        final String source;

        LocationFix(Location location, String source) {
            this.location = location;
            this.source = source;
        }
    }
}
