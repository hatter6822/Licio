#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# WS-R.15.4f — the two-device courier radio E2E (OFFLINE_SPEC §22.5, §32.3).
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
CLASS="app.licio.courier.NearbyConnectionsRadioTest"
PERMS="android.permission.ACCESS_FINE_LOCATION android.permission.ACCESS_COARSE_LOCATION android.permission.BLUETOOTH_SCAN android.permission.BLUETOOTH_CONNECT android.permission.BLUETOOTH_ADVERTISE android.permission.NEARBY_WIFI_DEVICES"
PIDS=()

die() { echo "radio-e2e: $*" >&2; exit 1; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "KVM not accessible (/dev/kvm) — accelerated emulators required"
[ -x "$EMU" ] || die "emulator not found at $EMU (sdkmanager 'emulator')"
[ -f "$APP" ] || die "missing $APP — run 'pnpm --filter courier build' first"
[ -f "$TEST" ] || die "missing $TEST — run './gradlew :app:assembleDebugAndroidTest' in android/"

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

echo "radio-e2e: running the Nearby Connections exchange across both emulators..."
outA="$(mktemp)"; outB="$(mktemp)"
"$ADB" -s "emulator-$PORT_A" shell am instrument -w -e class "$CLASS#advertiseAndReceive" "$RUNNER" >"$outA" 2>&1 &
pa=$!
"$ADB" -s "emulator-$PORT_B" shell am instrument -w -e class "$CLASS#discoverAndSend" "$RUNNER" >"$outB" 2>&1 &
pb=$!
wait "$pa"; wait "$pb"
echo "----- advertiser (emulator-$PORT_A) -----"; cat "$outA"
echo "----- discoverer (emulator-$PORT_B) -----"; cat "$outB"
if grep -q 'OK (1 test)' "$outA" && grep -q 'OK (1 test)' "$outB"; then
  echo "radio-e2e: PASS — payload crossed the emulated radios on both devices"; exit 0
fi
echo "radio-e2e: FAIL"; exit 1
