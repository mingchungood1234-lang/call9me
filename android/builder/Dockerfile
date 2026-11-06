# Build environment for the Android app (JDK 17 + Android SDK + Gradle), so building the APK
# needs only Docker. Used by `npm run android:build` (scripts/build-android.js).
FROM eclipse-temurin:17-jdk

ENV ANDROID_HOME=/opt/android-sdk \
    GRADLE_VERSION=8.14.3
ENV PATH=/opt/gradle-${GRADLE_VERSION}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${PATH}

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip \
 && mkdir -p ${ANDROID_HOME}/cmdline-tools \
 && unzip -q /tmp/tools.zip -d ${ANDROID_HOME}/cmdline-tools \
 && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
 && rm /tmp/tools.zip \
 && yes | sdkmanager --licenses > /dev/null \
 && sdkmanager "platforms;android-36" "build-tools;35.0.0" "platform-tools" > /dev/null

RUN curl -fsSL -o /tmp/gradle.zip https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip \
 && unzip -q /tmp/gradle.zip -d /opt \
 && rm /tmp/gradle.zip

WORKDIR /project
