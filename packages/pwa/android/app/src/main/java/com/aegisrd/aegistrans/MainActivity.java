package com.aegisrd.aegistrans;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IapPlugin.class);
        registerPlugin(AegisFileStreamPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
