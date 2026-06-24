// SPDX-License-Identifier: AGPL-3.0-or-later
package app.licio.courier;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the native courier transport plugins BEFORE the bridge loads, so the TS
        // `registerPlugin('…')` proxies resolve.  Each radio channel is a separate plugin
        // sharing the same JS event surface (WS-R.15.4c Nearby + WS-R.15.4d Wi-Fi Direct /
        // Bluetooth / USB).
        registerPlugin(NearbyCourierPlugin.class);
        registerPlugin(WifiDirectCourierPlugin.class);
        registerPlugin(BluetoothCourierPlugin.class);
        registerPlugin(UsbCourierPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
