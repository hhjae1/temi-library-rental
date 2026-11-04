plugins {
    id("com.android.application")
}

android {
    namespace = "kr.ac.kw.temirental"
    compileSdk = 34

    defaultConfig {
        applicationId = "kr.ac.kw.temirental"
        minSdk = 23 // TEMI는 Android 6.0 (SDK 23)
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        // 처음 실행할 때 접속할 서버. TEMI 화면 왼쪽 위 상태 줄을 길게 누르면 바꿀 수 있다.
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"ws://172.20.10.2:3000/ws/robot\"")
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("com.robotemi:sdk:1.138.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // QR 인식. Android 7.0 미만에서는 zxing core 3.3.0을 써야 한다 (zxing-android-embedded 안내)
    implementation("com.journeyapps:zxing-android-embedded:4.3.0") { isTransitive = false }
    implementation("com.google.zxing:core:3.3.0")
}
