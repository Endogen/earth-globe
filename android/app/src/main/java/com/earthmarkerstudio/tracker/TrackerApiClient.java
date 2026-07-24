package com.earthmarkerstudio.tracker;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

final class TrackerApiClient {
    private static final int CONNECT_TIMEOUT_MS = 15_000;

    private TrackerApiClient() {
    }

    static Response get(String serverUrl, String endpoint, String deviceToken, int readTimeoutMs) throws IOException {
        return request(serverUrl, endpoint, "GET", deviceToken, null, readTimeoutMs);
    }

    static Response post(String serverUrl, String endpoint, String deviceToken, String body) throws IOException {
        return request(serverUrl, endpoint, "POST", deviceToken, body, 30_000);
    }

    static Response register(String serverUrl, String body) throws IOException {
        return request(serverUrl, "/api/device/register", "POST", null, body, 30_000);
    }

    static String normalizeServerUrl(String input) throws IOException {
        String normalized = input.trim();
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        try {
            URI uri = new URI(normalized);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (host == null || scheme == null || !(scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http"))) {
                throw new IOException("Enter a complete http:// or https:// server address.");
            }
            if (uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) {
                throw new IOException("The server address cannot contain credentials, a query, or a fragment.");
            }
            if (scheme.equalsIgnoreCase("http") && !isPrivateHost(host)) {
                throw new IOException("Public servers must use HTTPS. Plain HTTP is allowed only on a private local network.");
            }
            return normalized;
        } catch (URISyntaxException exception) {
            throw new IOException("The server address is not valid.", exception);
        }
    }

    static String errorMessage(Response response) {
        if (response.body == null || response.body.isBlank()) {
            return "Server returned status " + response.statusCode + ".";
        }
        try {
            String detail = new JSONObject(response.body).optString("detail", "");
            return detail.isBlank() ? response.body : detail;
        } catch (JSONException ignored) {
            return response.body;
        }
    }

    private static Response request(
            String serverUrl,
            String endpoint,
            String method,
            String deviceToken,
            String body,
            int readTimeoutMs
    ) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(serverUrl + endpoint).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(readTimeoutMs);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "EarthTrackerAndroid/" + BuildConfig.VERSION_NAME);
            if (deviceToken != null && !deviceToken.isBlank()) {
                connection.setRequestProperty("Authorization", "Bearer " + deviceToken);
            }
            if (body != null) {
                byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(payload.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload);
                }
            }

            int statusCode = connection.getResponseCode();
            InputStream stream = statusCode >= 400 ? connection.getErrorStream() : connection.getInputStream();
            return new Response(statusCode, readBody(stream));
        } finally {
            connection.disconnect();
        }
    }

    private static String readBody(InputStream stream) throws IOException {
        if (stream == null) {
            return "";
        }
        StringBuilder body = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                body.append(line);
            }
        }
        return body.toString();
    }

    private static boolean isPrivateHost(String host) {
        String lower = host.toLowerCase(Locale.ROOT);
        if (lower.startsWith("[") && lower.endsWith("]")) {
            lower = lower.substring(1, lower.length() - 1);
        }
        if (lower.equals("localhost")
                || lower.equals("::1")
                || lower.endsWith(".local")
                || lower.startsWith("10.")
                || lower.startsWith("192.168.")
                || isPrivateIpv6(lower)) {
            return true;
        }
        if (!lower.startsWith("172.")) {
            return false;
        }
        String[] parts = lower.split("\\.");
        if (parts.length < 2) {
            return false;
        }
        try {
            int secondOctet = Integer.parseInt(parts[1]);
            return secondOctet >= 16 && secondOctet <= 31;
        } catch (NumberFormatException ignored) {
            return false;
        }
    }

    private static boolean isPrivateIpv6(String host) {
        return host.indexOf(':') >= 0
                && (host.equals("::1")
                || host.startsWith("fc")
                || host.startsWith("fd")
                || (host.length() > 2 && host.startsWith("fe") && "89ab".indexOf(host.charAt(2)) >= 0));
    }

    static final class Response {
        final int statusCode;
        final String body;

        Response(int statusCode, String body) {
            this.statusCode = statusCode;
            this.body = body;
        }

        boolean isSuccessful() {
            return statusCode >= 200 && statusCode < 300;
        }
    }
}
