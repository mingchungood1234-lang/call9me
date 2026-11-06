#!/bin/sh
# Runs inside the builder image with the android/ folder mounted at /project.
# Env: TWA_HOST, APP_ID, VERSION_CODE, VERSION_NAME.
set -eu
cd /project

# First build: create the release signing key. Keep android/keystore/ backed up and private:
# every later version must be signed with this same key.
if [ ! -f keystore/keystore.properties ]; then
  echo "Creating a new signing key in android/keystore/ (back it up!)"
  mkdir -p keystore
  PASS=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
  keytool -genkeypair -noprompt -v \
    -keystore keystore/release.jks -storetype PKCS12 \
    -alias call9me -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=Call9me, O=Call9me" > /dev/null 2>&1
  printf 'storeFile=release.jks\nstorePassword=%s\nkeyAlias=call9me\nkeyPassword=%s\n' "$PASS" "$PASS" \
    > keystore/keystore.properties
fi

STORE_PASS=$(sed -n 's/^storePassword=//p' keystore/keystore.properties)
STORE_FILE=$(sed -n 's/^storeFile=//p' keystore/keystore.properties)
KEY_ALIAS=$(sed -n 's/^keyAlias=//p' keystore/keystore.properties)

gradle --no-daemon --console=plain -q assembleRelease \
  -PtwaHost="$TWA_HOST" \
  -PapplicationId="$APP_ID" \
  -PversionCode="$VERSION_CODE" \
  -PversionName="$VERSION_NAME"

# The signing certificate's SHA-256, for the site's /.well-known/assetlinks.json.
mkdir -p build/out
keytool -list -v -keystore "keystore/$STORE_FILE" -storepass "$STORE_PASS" -alias "$KEY_ALIAS" \
  | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' > build/out/sha256.txt
cp app/build/outputs/apk/release/app-release.apk build/out/call9me.apk
echo "Built build/out/call9me.apk"
