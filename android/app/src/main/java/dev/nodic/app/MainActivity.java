package dev.nodic.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import dev.nodic.app.sync.NodicSyncPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NodicSyncPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
