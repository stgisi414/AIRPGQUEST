package com.stefangisi.airpgquest;

import android.os.Bundle;
import android.webkit.WebView; // Make sure this import is at the top
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Add this line right here
        WebView.setWebContentsDebuggingEnabled(true);
    }
}
