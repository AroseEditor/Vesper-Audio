package com.ayushue5.vesperaudio.connector

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import javax.security.auth.x500.X500Principal

object Identity {
    private const val ALIAS = "vesper-connector"
    private const val DAY = 86400000L

    private fun store(): KeyStore {
        val keyStore = KeyStore.getInstance("AndroidKeyStore")
        keyStore.load(null)
        return keyStore
    }

    private fun ensure() {
        val keyStore = store()
        if (keyStore.containsAlias(ALIAS)) return
        val now = System.currentTimeMillis()
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setCertificateSubject(X500Principal("CN=Vesper Audio Connector"))
            .setCertificateSerialNumber(BigInteger.valueOf(now))
            .setCertificateNotBefore(Date(now - DAY))
            .setCertificateNotAfter(Date(now + 3650L * DAY))
            .build()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(spec)
        generator.generateKeyPair()
    }

    fun fingerprint(): ByteArray {
        ensure()
        return Wire.sha256(store().getCertificate(ALIAS).encoded)
    }

    fun sslContext(pin: ByteArray?, onServer: (ByteArray) -> Unit): SSLContext {
        ensure()
        val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        managers.init(store(), null)
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
                throw CertificateException("client mode only")
            }

            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val fp = Wire.sha256(chain[0].encoded)
                onServer(fp)
                if (pin != null && !pin.contentEquals(fp)) throw CertificateException("The PC does not match the code you scanned")
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS")
        context.init(managers.keyManagers, arrayOf(trust), SecureRandom())
        return context
    }
}
