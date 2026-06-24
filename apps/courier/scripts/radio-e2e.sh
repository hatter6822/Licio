#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# WS-R.15.4f — the two-device courier radio E2E (OFFLINE_SPEC §22.5, §32.3).
#
# THIS IS THE OPTIONAL **LAYER 3** OF THE COURIER TEST PYRAMID — real-radio hardware
# confidence, NOT required for CI or day-to-day development:
#   * L1 (logic):  `pnpm --filter courier test:unit` — the PURE framing / chunking /
#                  reassembly / serialize-on-ack send state machine (`CourierFramingTest`),
#                  plain JVM, NO Android / radio / root.
#   * L2 (glue):   the same command — Robolectric (shadowed Android) over the plugin↔API
#                  contract (`BluetoothCourierGattTest`), JVM, NO device / radio / root.
#   * L3 (radio):  THIS script — the actual bytes crossing emulated/real radios.  Requires an
#                  emulator (KVM) and, for the Wi-Fi Direct leg, real radios.  Opt-in.
# Because L1+L2 cover the courier's logic with no privileged setup, a contributor never needs
# root (or even an emulator) for normal development; this layer adds hardware confidence only.
#
# Boots TWO headless Android emulators that share the netsim virtual radio bus
# (emulated BLE/Bluetooth via RootCanal + virtio-wifi), installs the courier APK +
# the instrumentation test, and runs the Nearby Connections exchange across them:
# one device advertises + receives, the other discovers + connects + sends — proving a
# payload crosses the emulated radios with NO internet, over the SAME GMS Nearby
# Connections API the production `NearbyCourierPlugin` wraps.
#
# REQUIREMENTS (this is hardware-gated, but runs on any capable host):
#   * KVM hardware acceleration (/dev/kvm readable+writable).
#   * A HOST GPU with a working Vulkan driver (we run `-gpu host`): the bundled
#     SwiftShader software renderer SIGSEGVs qemu during SurfaceFlinger bring-up on
#     some CPUs, so host-GPU rendering is REQUIRED for a clean boot.  Verified on an
#     AMD Radeon (RADV) host.  Emulators are headless (`-no-window`).
#   * Android SDK: an `emulator` (>= 33 for netsim Bluetooth), platform-tools, and a
#     GOOGLE-APIS system image (carries GMS, which Nearby Connections needs).
#   * JDK 21 (the courier Gradle build) + a built debug APK + androidTest APK
#     (`pnpm --filter courier build` then `:app:assembleDebugAndroidTest`).
#
# Env: ANDROID_HOME / ANDROID_SDK_ROOT, JAVA_HOME (JDK 21).  Override AVD/port/image
# via the variables below.
set -euo pipefail

: "${ANDROID_HOME:=$HOME/Android/sdk}"
export ANDROID_HOME ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
EMU="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
IMAGE="${RADIO_E2E_IMAGE:-system-images;android-34;google_apis;x86_64}"
AVD_A="${RADIO_E2E_AVD_A:-licio-a}"
AVD_B="${RADIO_E2E_AVD_B:-licio-b}"
PORT_A="${RADIO_E2E_PORT_A:-5554}"
PORT_B="${RADIO_E2E_PORT_B:-5556}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HERE/android/app/build/outputs/apk/debug/app-debug.apk"
TEST="$HERE/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
RUNNER="app.licio.courier.test/androidx.test.runner.AndroidJUnitRunner"
PERMS="android.permission.ACCESS_FINE_LOCATION android.permission.ACCESS_COARSE_LOCATION android.permission.BLUETOOTH_SCAN android.permission.BLUETOOTH_CONNECT android.permission.BLUETOOTH_ADVERTISE android.permission.NEARBY_WIFI_DEVICES"
PIDS=()

die() { echo "radio-e2e: $*" >&2; exit 1; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "KVM not accessible (/dev/kvm) — accelerated emulators required"
[ -x "$EMU" ] || die "emulator not found at $EMU (sdkmanager 'emulator')"
[ -f "$APP" ] || die "missing $APP — run 'pnpm --filter courier build' first"
[ -f "$TEST" ] || die "missing $TEST — run './gradlew :app:assembleDebugAndroidTest' in android/"

# Preflight each AVD: it must EXIST and its configured system image must be INSTALLED.
# (boot() reuses pre-created AVDs — this never calls avdmanager — so a stale AVD that points
# at an uninstalled image would otherwise fail with a cryptic "Unknown AVD" / boot hang.  Any
# GMS-carrying image works — `google_apis` OR `google_apis_playstore`, since Nearby Connections
# needs GMS.)
avd_ok() { # $1=avd name
  local cfg="$HOME/.android/avd/$1.avd/config.ini"
  [ -f "$cfg" ] || die "AVD '$1' not found ($cfg).  Create it (cmdline-tools): avdmanager create avd -n '$1' -k '$IMAGE' -d pixel_6"
  local sysdir; sysdir="$(sed -n 's/^image.sysdir.1[[:space:]]*=[[:space:]]*//p' "$cfg" | tr -d '[:space:]')"
  [ -n "$sysdir" ] && [ -f "$ANDROID_HOME/$sysdir/system.img" ] \
    || die "AVD '$1' points at a system image that is NOT installed ($sysdir).  Install it (sdkmanager '$IMAGE') or repoint $cfg 'image.sysdir.1' at an installed GMS image (google_apis or google_apis_playstore)."
}
avd_ok "$AVD_A"
avd_ok "$AVD_B"

cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

boot() { # $1=avd $2=port
  rm -f "$HOME/.android/avd/$1.avd/"*.lock 2>/dev/null || true
  "$EMU" -avd "$1" -port "$2" -no-window -no-audio -no-boot-anim -gpu host -no-snapshot -accel on -no-metrics >/dev/null 2>&1 &
  PIDS+=("$!")
  "$ADB" -s "emulator-$2" wait-for-device
  local n=0
  until [ "$("$ADB" -s "emulator-$2" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    n=$((n + 1)); [ "$n" -ge 60 ] && die "emulator-$2 did not finish booting"; sleep 5
  done
  echo "radio-e2e: emulator-$2 booted"
}

prep() { # $1=serial
  "$ADB" -s "$1" install -r -g "$APP" >/dev/null
  "$ADB" -s "$1" install -r -g "$TEST" >/dev/null
  "$ADB" -s "$1" shell cmd bluetooth_manager enable >/dev/null 2>&1 || true
  for p in $PERMS; do "$ADB" -s "$1" shell pm grant app.licio.courier "$p" >/dev/null 2>&1 || true; done
}

"$ADB" start-server >/dev/null 2>&1 || true
boot "$AVD_A" "$PORT_A"
boot "$AVD_B" "$PORT_B"
prep "emulator-$PORT_A"
prep "emulator-$PORT_B"

# Device A's Bluetooth address — the `secure` setting holds the real MAC, which the RFCOMM
# client dials directly (no headless pairing/discovery handshake, which has no automatable UI).
ADDR_A="$("$ADB" -s "emulator-$PORT_A" shell settings get secure bluetooth_address 2>/dev/null | tr -d '\r')"

# The two-device scenario matrix: "testClass|methodA|methodB|extraArgsA|extraArgsB".  methodA
# runs on A (PORT_A), methodB on B (PORT_B), CONCURRENTLY; both must report "OK (1 test)".  Each
# scenario re-establishes its radio link, so a short settle between scenarios lets it release.
#
# Coverage over the netsim radio bus (BLE/Bluetooth via RootCanal):
#   * Nearby Connections (P2P_CLUSTER, BYTES): basic / chunked-512KiB+integrity / duplex / disconnect
#   * Bluetooth LE GATT (advertise + GATT server + chunked writes, no pairing)
#   * Bluetooth Classic RFCOMM (insecure, direct-dial-by-address, 64 KiB length-prefixed frame)
# Wi-Fi Direct is PHYSICAL-RADIO-ONLY (netsim virtio-wifi forms no P2P group; the test itself
# SKIPS unless `-e includeWifiDirect 1` is passed) — run it with RADIO_E2E_INCLUDE_WIFI_DIRECT=1
# on real radios; it is excluded from the default netsim matrix.
SCENARIOS=(
  "NearbyConnectionsRadioTest|advertiseAndReceive|discoverAndSend||"
  "NearbyConnectionsRadioTest|advertiseReceiveChunked|discoverSendChunked||"
  "NearbyConnectionsRadioTest|serveBidirectionalA|serveBidirectionalB||"
  "NearbyConnectionsRadioTest|advertiseAwaitDisconnect|discoverConnectThenDisconnect||"
  "BleGattRadioTest|gattServerReceive|gattClientSend||"
  "BluetoothRfcommRadioTest|rfcommServerReceive|rfcommClientSend||-e peerAddress ${ADDR_A}"
)
if [ "${RADIO_E2E_INCLUDE_WIFI_DIRECT:-0}" = "1" ]; then
  SCENARIOS+=("WifiDirectRadioTest|wifiDirectReceive|wifiDirectSend|-e includeWifiDirect 1|-e includeWifiDirect 1")
fi

run_scenario() { # $1=class $2=methodA $3=methodB $4=extraArgsA $5=extraArgsB
  local cls="app.licio.courier.$1" ma="$2" mb="$3" extraA="$4" extraB="$5"
  local oa ob; oa="$(mktemp)"; ob="$(mktemp)"
  # shellcheck disable=SC2086 — extraA/extraB are intentional word-splits of "-e key value".
  "$ADB" -s "emulator-$PORT_A" shell am instrument -w $extraA -e class "$cls#$ma" "$RUNNER" >"$oa" 2>&1 &
  local pa=$!
  # shellcheck disable=SC2086
  "$ADB" -s "emulator-$PORT_B" shell am instrument -w $extraB -e class "$cls#$mb" "$RUNNER" >"$ob" 2>&1 &
  local pb=$!
  wait "$pa"; wait "$pb"
  if grep -q 'OK (1 test)' "$oa" && grep -q 'OK (1 test)' "$ob"; then
    echo "radio-e2e: PASS  $1 [$ma | $mb]"
    return 0
  fi
  echo "radio-e2e: FAIL  $1 [$ma | $mb]"
  echo "----- A ($ma) -----"; cat "$oa"
  echo "----- B ($mb) -----"; cat "$ob"
  return 1
}

echo "radio-e2e: running ${#SCENARIOS[@]} courier radio scenarios across both emulators..."
fails=0
for entry in "${SCENARIOS[@]}"; do
  IFS='|' read -r s_cls s_ma s_mb s_extraA s_extraB <<<"$entry"
  run_scenario "$s_cls" "$s_ma" "$s_mb" "$s_extraA" "$s_extraB" || fails=$((fails + 1))
  sleep 4 # let the radios release before the next scenario
done

if [ "$fails" -eq 0 ]; then
  echo "radio-e2e: PASS — all ${#SCENARIOS[@]} courier radio scenarios crossed the emulated radios"
  exit 0
fi
echo "radio-e2e: FAIL — $fails of ${#SCENARIOS[@]} scenarios failed"
exit 1
