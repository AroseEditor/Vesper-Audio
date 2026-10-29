plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val runNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
val connectorVersion = System.getenv("CONNECTOR_VERSION") ?: "2.0.2"

android {
    namespace = "com.ayushue5.vesperaudio.connector"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.ayushue5.vesperaudio.connector"
        minSdk = 29
        targetSdk = 36
        versionCode = 200000 + runNumber
        versionName = connectorVersion
    }

    signingConfigs {
        create("release") {
            val keystore = System.getenv("ANDROID_KEYSTORE_FILE")
            if (keystore != null && file(keystore).exists()) {
                storeFile = file(keystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val keystore = System.getenv("ANDROID_KEYSTORE_FILE")
            signingConfig = if (keystore != null && file(keystore).exists()) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
}
