package dev.nodic.app;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import dev.nodic.app.sync.NodicSyncPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NodicSyncPlugin.class);
        super.onCreate(savedInstanceState);
        handleDeepLinkIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLinkIntent(intent);
    }

    private void handleDeepLinkIntent(Intent intent) {
        if (intent == null) return;
        String route = intent.getStringExtra("route");
        if (route != null && !route.isEmpty()) {
            String channelId = intent.getStringExtra("channelId");
            String eventId = intent.getStringExtra("eventId");
            String taskId = intent.getStringExtra("taskId");
            NodicSyncPlugin.Companion.handleDeepLink(route, channelId, eventId, taskId);
        }
    }
}
