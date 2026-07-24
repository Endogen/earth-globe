package com.earthmarkerstudio.tracker;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity implements SharedPreferences.OnSharedPreferenceChangeListener {
    private static final int LOCATION_PERMISSION_REQUEST = 41;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 42;

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();

    private EditText serverUrl;
    private EditText deviceName;
    private EditText pairingCode;
    private Button pairButton;
    private Button unpairButton;
    private Button locationPermissionButton;
    private Button batteryButton;
    private Button startButton;
    private Button stopButton;
    private TextView serviceState;
    private TextView serviceDetail;
    private TextView permissionSummary;
    private volatile boolean pairingInProgress;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        bindViews();
        bindActions();
        populateSavedRegistration();
        refreshUi();
    }

    @Override
    protected void onResume() {
        super.onResume();
        TrackerPreferences.values(this).registerOnSharedPreferenceChangeListener(this);
        refreshUi();
    }

    @Override
    protected void onPause() {
        TrackerPreferences.values(this).unregisterOnSharedPreferenceChangeListener(this);
        super.onPause();
    }

    @Override
    public void onSharedPreferenceChanged(SharedPreferences sharedPreferences, String key) {
        runOnUiThread(this::refreshUi);
    }

    @Override
    protected void onDestroy() {
        networkExecutor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        refreshUi();
        if (requestCode == LOCATION_PERMISSION_REQUEST && hasForegroundLocation() && !hasBackgroundLocation()) {
            explainBackgroundLocation();
        }
    }

    private void bindViews() {
        serverUrl = findViewById(R.id.server_url);
        deviceName = findViewById(R.id.device_name);
        pairingCode = findViewById(R.id.pairing_code);
        pairButton = findViewById(R.id.pair_button);
        unpairButton = findViewById(R.id.unpair_button);
        locationPermissionButton = findViewById(R.id.location_permission_button);
        batteryButton = findViewById(R.id.battery_button);
        startButton = findViewById(R.id.start_button);
        stopButton = findViewById(R.id.stop_button);
        serviceState = findViewById(R.id.service_state);
        serviceDetail = findViewById(R.id.service_detail);
        permissionSummary = findViewById(R.id.permission_summary);
    }

    private void bindActions() {
        pairButton.setOnClickListener(view -> pairDevice());
        unpairButton.setOnClickListener(view -> confirmUnpair());
        locationPermissionButton.setOnClickListener(view -> configureLocationPermissions());
        batteryButton.setOnClickListener(view -> requestReliableBatteryMode());
        startButton.setOnClickListener(view -> startTracking());
        stopButton.setOnClickListener(view -> stopTracking());
    }

    private void populateSavedRegistration() {
        TrackerPreferences.Registration registration = TrackerPreferences.registration(this);
        if (!registration.serverUrl.isEmpty()) {
            serverUrl.setText(registration.serverUrl);
        }
        if (!registration.deviceName.isEmpty()) {
            deviceName.setText(registration.deviceName);
        } else {
            deviceName.setText(getString(R.string.default_device_name, Build.MANUFACTURER, Build.MODEL));
        }
    }

    private void pairDevice() {
        String requestedServerUrl = serverUrl.getText().toString();
        String requestedName = deviceName.getText().toString().trim();
        String requestedCode = pairingCode.getText().toString().trim();
        if (requestedName.isEmpty() || requestedCode.isEmpty()) {
            setServiceMessage("● Setup incomplete", "Enter a device name and the one-time code from the website.", R.color.warning);
            return;
        }

        pairingInProgress = true;
        TrackerPreferences.setServiceState(this, "pairing", "Verifying the pairing code with your server…");
        refreshUi();
        setServiceMessage("● Connecting", "Verifying the pairing code with your server…", R.color.warning);
        networkExecutor.execute(() -> {
            try {
                String normalizedServerUrl = TrackerApiClient.normalizeServerUrl(requestedServerUrl);
                JSONObject payload = new JSONObject()
                        .put("pairing_code", requestedCode)
                        .put("device_name", requestedName)
                        .put("platform_version", "Android " + Build.VERSION.RELEASE)
                        .put("app_version", BuildConfig.VERSION_NAME);
                TrackerApiClient.Response response = TrackerApiClient.register(normalizedServerUrl, payload.toString());
                if (!response.isSuccessful()) {
                    throw new IOException(TrackerApiClient.errorMessage(response));
                }
                JSONObject credentials = new JSONObject(response.body);
                TrackerPreferences.saveRegistration(
                        this,
                        normalizedServerUrl,
                        credentials.getString("device_id"),
                        credentials.getString("device_token"),
                        requestedName
                );
                runOnUiThread(() -> {
                    pairingInProgress = false;
                    pairingCode.setText("");
                    TrackerPreferences.setServiceState(
                            this,
                            "stopped",
                            "Pairing succeeded. Complete the reliability permissions, then start tracking."
                    );
                    refreshUi();
                });
            } catch (IOException | JSONException exception) {
                runOnUiThread(() -> {
                    pairingInProgress = false;
                    TrackerPreferences.setServiceState(this, "pairing_error", exception.getMessage());
                    refreshUi();
                });
            }
        });
    }

    private void configureLocationPermissions() {
        if (!hasForegroundLocation()) {
            requestPermissions(
                    new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION},
                    LOCATION_PERMISSION_REQUEST
            );
            return;
        }
        if (!hasBackgroundLocation()) {
            explainBackgroundLocation();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
            return;
        }
        Toast.makeText(this, "Location and notification access are configured.", Toast.LENGTH_SHORT).show();
    }

    private void explainBackgroundLocation() {
        new AlertDialog.Builder(this)
                .setTitle("Allow location all the time")
                .setMessage(
                        "For requests to work after a reboot or service restart, open Permissions → Location and choose "
                                + "Allow all the time. The app requests GPS only after you press Request location on the website."
                )
                .setNegativeButton("Not now", null)
                .setPositiveButton("Open app settings", (dialog, which) -> openAppSettings())
                .show();
    }

    @SuppressLint("BatteryLife")
    private void requestReliableBatteryMode() {
        PowerManager powerManager = getSystemService(PowerManager.class);
        if (powerManager != null && powerManager.isIgnoringBatteryOptimizations(getPackageName())) {
            Toast.makeText(this, "Battery restrictions are already disabled for Earth Tracker.", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (RuntimeException exception) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private void startTracking() {
        TrackerPreferences.Registration registration = TrackerPreferences.registration(this);
        if (!registration.isComplete()) {
            setServiceMessage("● Not paired", "Pair this phone before starting the connection.", R.color.warning);
            return;
        }
        if (!hasForegroundLocation()) {
            configureLocationPermissions();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }

        TrackerPreferences.setServiceEnabled(this, true);
        TrackerPreferences.setServiceState(this, "connecting", "Opening the reliable command connection…");
        Intent serviceIntent = new Intent(this, TrackingService.class).setAction(TrackingService.ACTION_START);
        try {
            startForegroundService(serviceIntent);
        } catch (RuntimeException exception) {
            TrackerPreferences.setServiceEnabled(this, false);
            TrackerPreferences.setServiceState(
                    this,
                    "error",
                    exception.getMessage() == null ? "Android could not start the tracking service." : exception.getMessage()
            );
        }
        refreshUi();
    }

    private void stopTracking() {
        TrackerPreferences.setServiceEnabled(this, false);
        startService(new Intent(this, TrackingService.class).setAction(TrackingService.ACTION_STOP));
        TrackerPreferences.setServiceState(this, "stopped", "Tracking is stopped. The website cannot request this phone.");
        refreshUi();
    }

    private void confirmUnpair() {
        TrackerPreferences.Registration registration = TrackerPreferences.registration(this);
        new AlertDialog.Builder(this)
                .setTitle("Remove this pairing?")
                .setMessage("The phone will stop answering requests. Also use Unpair on the website to delete its stored location history.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Remove", (dialog, which) -> {
                    stopTracking();
                    TrackerPreferences.clearRegistration(this);
                    serverUrl.setText(registration.serverUrl);
                    pairingCode.setText("");
                    refreshUi();
                })
                .show();
    }

    private void refreshUi() {
        TrackerPreferences.Registration registration = TrackerPreferences.registration(this);
        boolean paired = registration.isComplete();
        boolean enabled = TrackerPreferences.isServiceEnabled(this);
        String state = TrackerPreferences.serviceState(this);

        serverUrl.setEnabled(!paired);
        deviceName.setEnabled(!paired);
        pairingCode.setEnabled(!paired);
        pairButton.setVisibility(paired ? View.GONE : View.VISIBLE);
        pairButton.setEnabled(!paired && !pairingInProgress);
        pairButton.setText(pairingInProgress ? "Pairing…" : "Pair device");
        unpairButton.setVisibility(paired ? View.VISIBLE : View.GONE);
        startButton.setEnabled(paired && !enabled && hasForegroundLocation());
        stopButton.setEnabled(paired && enabled);

        if (pairingInProgress) {
            setServiceMessage("● Connecting", TrackerPreferences.serviceDetail(this), R.color.warning);
        } else if (!paired && state.equals("pairing_error")) {
            setServiceMessage("● Pairing failed", TrackerPreferences.serviceDetail(this), R.color.danger);
        } else if (!paired) {
            setServiceMessage("● Not paired", "Enter the server address and pairing code from the website.", R.color.text_secondary);
        } else if (state.equals("connected")) {
            setServiceMessage("● Connected and ready", TrackerPreferences.serviceDetail(this), R.color.device_green);
        } else if (state.equals("locating")) {
            setServiceMessage("● Getting location", TrackerPreferences.serviceDetail(this), R.color.warning);
        } else if (state.equals("reconnecting") || state.equals("connecting")) {
            setServiceMessage("● Reconnecting", TrackerPreferences.serviceDetail(this), R.color.warning);
        } else if (state.equals("unauthorized") || state.equals("error")) {
            setServiceMessage("● Connection needs attention", TrackerPreferences.serviceDetail(this), R.color.danger);
        } else if (enabled) {
            setServiceMessage("● Starting", TrackerPreferences.serviceDetail(this), R.color.warning);
        } else {
            setServiceMessage("● Paired but stopped", "Start tracking to make this phone available on the website.", R.color.text_secondary);
        }

        updatePermissionSummary();
    }

    private void updatePermissionSummary() {
        List<String> ready = new ArrayList<>();
        List<String> missing = new ArrayList<>();
        if (hasForegroundLocation()) {
            ready.add("precise location");
        } else {
            missing.add("precise location");
        }
        if (hasBackgroundLocation()) {
            ready.add("background location");
        } else {
            missing.add("background location");
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            ready.add("notifications");
        } else {
            missing.add("notifications");
        }

        PowerManager powerManager = getSystemService(PowerManager.class);
        boolean batteryReady = powerManager != null && powerManager.isIgnoringBatteryOptimizations(getPackageName());
        if (batteryReady) {
            ready.add("unrestricted battery");
        } else {
            missing.add("unrestricted battery");
        }

        StringBuilder summary = new StringBuilder();
        if (!ready.isEmpty()) {
            summary.append("Ready: ").append(String.join(", ", ready)).append(".");
        }
        if (!missing.isEmpty()) {
            if (summary.length() > 0) {
                summary.append("\n");
            }
            summary.append("For maximum reliability, configure: ").append(String.join(", ", missing)).append(".");
        }
        permissionSummary.setText(summary.toString());
        locationPermissionButton.setText(
                hasForegroundLocation() && hasBackgroundLocation()
                        ? "Location access configured"
                        : "Configure location access"
        );
        batteryButton.setText(batteryReady ? "Background operation configured" : "Allow reliable background operation");
    }

    private boolean hasForegroundLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBackgroundLocation() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                || checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void openAppSettings() {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }

    private void setServiceMessage(String title, String detail, int colorResource) {
        serviceState.setText(title);
        serviceState.setTextColor(getColor(colorResource));
        serviceDetail.setText(detail == null || detail.isBlank() ? "No additional details." : detail);
    }
}
