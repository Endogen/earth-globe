package com.earthmarkerstudio.tracker;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;

final class TrackerPreferences {
    private static final String FILE_NAME = "earth_tracker";
    private static final String SERVER_URL = "server_url";
    private static final String DEVICE_ID = "device_id";
    private static final String DEVICE_TOKEN = "device_token";
    private static final String DEVICE_NAME = "device_name";
    private static final String SERVICE_ENABLED = "service_enabled";
    private static final String SERVICE_STATE = "service_state";
    private static final String SERVICE_DETAIL = "service_detail";
    private static final String PENDING_ENDPOINT = "pending_endpoint";
    private static final String PENDING_BODY = "pending_body";

    private TrackerPreferences() {
    }

    static SharedPreferences values(Context context) {
        return context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE);
    }

    static Registration registration(Context context) {
        SharedPreferences values = values(context);
        return new Registration(
                values.getString(SERVER_URL, ""),
                values.getString(DEVICE_ID, ""),
                values.getString(DEVICE_TOKEN, ""),
                values.getString(DEVICE_NAME, "")
        );
    }

    static void saveRegistration(
            Context context,
            String serverUrl,
            String deviceId,
            String deviceToken,
            String deviceName
    ) {
        values(context).edit()
                .putString(SERVER_URL, serverUrl)
                .putString(DEVICE_ID, deviceId)
                .putString(DEVICE_TOKEN, deviceToken)
                .putString(DEVICE_NAME, deviceName)
                .apply();
    }

    static void clearRegistration(Context context) {
        values(context).edit()
                .remove(SERVER_URL)
                .remove(DEVICE_ID)
                .remove(DEVICE_TOKEN)
                .remove(DEVICE_NAME)
                .remove(PENDING_ENDPOINT)
                .remove(PENDING_BODY)
                .putBoolean(SERVICE_ENABLED, false)
                .putString(SERVICE_STATE, "stopped")
                .putString(SERVICE_DETAIL, "This phone is not paired.")
                .apply();
    }

    static boolean isServiceEnabled(Context context) {
        return values(context).getBoolean(SERVICE_ENABLED, false);
    }

    static void setServiceEnabled(Context context, boolean enabled) {
        values(context).edit().putBoolean(SERVICE_ENABLED, enabled).apply();
    }

    static void setServiceState(Context context, String state, String detail) {
        values(context).edit()
                .putString(SERVICE_STATE, state)
                .putString(SERVICE_DETAIL, detail)
                .apply();
    }

    static String serviceState(Context context) {
        return values(context).getString(SERVICE_STATE, "stopped");
    }

    static String serviceDetail(Context context) {
        return values(context).getString(SERVICE_DETAIL, "Pair this phone to begin.");
    }

    @SuppressLint("ApplySharedPref")
    static void savePendingUpload(Context context, String endpoint, String body) {
        boolean persisted = values(context).edit()
                .putString(PENDING_ENDPOINT, endpoint)
                .putString(PENDING_BODY, body)
                .commit();
        if (!persisted) {
            throw new IllegalStateException("The pending location result could not be persisted.");
        }
    }

    static PendingUpload pendingUpload(Context context) {
        SharedPreferences values = values(context);
        String endpoint = values.getString(PENDING_ENDPOINT, "");
        String body = values.getString(PENDING_BODY, "");
        return endpoint.isEmpty() || body.isEmpty() ? null : new PendingUpload(endpoint, body);
    }

    @SuppressLint("ApplySharedPref")
    static void clearPendingUpload(Context context) {
        boolean persisted = values(context).edit().remove(PENDING_ENDPOINT).remove(PENDING_BODY).commit();
        if (!persisted) {
            throw new IllegalStateException("The pending location result could not be cleared.");
        }
    }

    static final class Registration {
        final String serverUrl;
        final String deviceId;
        final String deviceToken;
        final String deviceName;

        Registration(String serverUrl, String deviceId, String deviceToken, String deviceName) {
            this.serverUrl = serverUrl;
            this.deviceId = deviceId;
            this.deviceToken = deviceToken;
            this.deviceName = deviceName;
        }

        boolean isComplete() {
            return !serverUrl.isEmpty() && !deviceId.isEmpty() && !deviceToken.isEmpty();
        }
    }

    static final class PendingUpload {
        final String endpoint;
        final String body;

        PendingUpload(String endpoint, String body) {
            this.endpoint = endpoint;
            this.body = body;
        }
    }
}
