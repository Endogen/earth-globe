package com.earthmarkerstudio.tracker;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

import java.io.IOException;

public final class TrackerApiClientTest {
    @Test
    public void normalizesHttpsBaseAddress() throws IOException {
        assertEquals(
                "https://tracker.example/private",
                TrackerApiClient.normalizeServerUrl("  https://tracker.example/private/  ")
        );
    }

    @Test
    public void permitsCleartextOnlyForPrivateNetworks() throws IOException {
        assertEquals(
                "http://192.168.1.20:8132",
                TrackerApiClient.normalizeServerUrl("http://192.168.1.20:8132/")
        );
        assertEquals("http://tracker.local", TrackerApiClient.normalizeServerUrl("http://tracker.local"));
        assertEquals("http://[::1]:8132", TrackerApiClient.normalizeServerUrl("http://[::1]:8132"));
        assertEquals("http://[fd00::1234]:8132", TrackerApiClient.normalizeServerUrl("http://[fd00::1234]:8132"));
        assertThrows(IOException.class, () -> TrackerApiClient.normalizeServerUrl("http://tracker.example"));
    }

    @Test
    public void rejectsAmbiguousOrCredentialBearingAddresses() {
        assertThrows(IOException.class, () -> TrackerApiClient.normalizeServerUrl("tracker.example"));
        assertThrows(IOException.class, () -> TrackerApiClient.normalizeServerUrl("http://fd-example.com"));
        assertThrows(IOException.class, () -> TrackerApiClient.normalizeServerUrl("https://user@tracker.example"));
        assertThrows(IOException.class, () -> TrackerApiClient.normalizeServerUrl("https://tracker.example?token=secret"));
        assertThrows(IOException.class, () -> TrackerApiClient.normalizeServerUrl("https://tracker.example/#section"));
    }
}
