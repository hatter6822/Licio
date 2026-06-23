// SPDX-License-Identifier: AGPL-3.0-or-later
package app.licio.courier;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the WS-R.15.4c Nearby Connections courier transport BEFORE the bridge
        // loads, so the TS `registerPlugin('NearbyCourier')` proxy resolves.
        registerPlugin(NearbyCourierPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
