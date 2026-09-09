plugins {
    id("com.android.application")
}

android {
    namespace = "com.earthmarkerstudio.tracker"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.earthmarkerstudio.tracker"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "0.2.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("com.google.android.gms:play-services-location:21.4.0")
    testImplementation("junit:junit:4.13.2")
}
