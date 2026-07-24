package com.earthmarkerstudio.tracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null
                || !(Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction()))) {
            return;
        }
        if (!TrackerPreferences.isServiceEnabled(context) || !TrackerPreferences.registration(context).isComplete()) {
            return;
        }
        Intent serviceIntent = new Intent(context, TrackingService.class).setAction(TrackingService.ACTION_START);
        try {
            context.startForegroundService(serviceIntent);
        } catch (RuntimeException exception) {
            TrackerPreferences.setServiceState(
                    context,
                    "error",
                    "Android could not restart tracking after reboot. Open Earth Tracker and press Start."
            );
        }
    }
}
