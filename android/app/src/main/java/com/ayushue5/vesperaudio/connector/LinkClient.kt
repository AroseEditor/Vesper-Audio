package com.ayushue5.vesperaudio.connector

import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLSocket

class PairException(message: String) : IOException(message)

class LinkClient(private val app: Context) {
    private val prefs = Prefs(app)
    @Volatile private var running = false
    @Volatile private var worker: Thread? = null
    @Volatile private var socket: SSLSocket? = null
    @Volatile private var mic: MicSender? = null
    private val confirm = LinkedBlockingQueue<Boolean>()

    @Volatile var intent = "idle"

    fun start(target: Target, token: String?) {
        stop()
        running = true
        Hub.error = ""
        confirm.clear()
        val thread = Thread({ loop(target, token) }, "vesper-link")
        worker = thread
        thread.start()
    }

    fun stop() {
        running = false
        mic?.stop()
        mic = null
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        worker?.interrupt()
        worker = null
        Hub.micLive = false
        Hub.phase = Hub.Phase.IDLE
        Hub.sasCode = ""
        Hub.changed()
    }

    fun confirmCode(ok: Boolean) {
        confirm.offer(ok)
    }

    fun isRunning(): Boolean = running

    private fun describe(error: Exception): String = when (error) {
        is PairException -> error.message ?: "Pairing failed."
        is SocketTimeoutException, is ConnectException, is UnknownHostException -> "Could not reach the PC. Check that it is on the same Wi-Fi and that Vesper Audio is open."
        is CertificateException -> "This is not the PC you scanned. Scan the code again."
        is SSLHandshakeException -> "The secure connection to the PC failed. Scan the pairing code again."
        is SSLException -> "The secure connection to the PC failed."
        else -> error.message ?: error.javaClass.simpleName
    }

    private fun loop(initial: Target, firstToken: String?) {
        var target = initial
        var token = firstToken
        var delay = 500L
        var attempts = 0
        while (running) {
            Hub.phase = if (attempts == 0) Hub.Phase.CONNECTING else Hub.Phase.RECONNECTING
            Hub.pcName = target.name
            Hub.changed()
            try {
                val saved = session(target, token)
                if (saved != null) target = saved
                token = null
                delay = 500L
            } catch (e: InterruptedException) {
                return
            } catch (e: Exception) {
                if (!running) return
                Hub.error = describe(e)
                if (e is PairException) {
                    running = false
                    Hub.phase = Hub.Phase.IDLE
                    Hub.micLive = false
                    Hub.changed()
                    return
                }
            }
            attempts++
            if (!running) return
            Hub.micLive = false
            Hub.phase = Hub.Phase.RECONNECTING
            Hub.changed()
            try {
                Thread.sleep(delay)
            } catch (e: InterruptedException) {
                return
            }
            delay = minOf(delay * 2, 10000L)
            target = refresh(target)
        }
    }

    private fun refresh(target: Target): Target {
        val fp = target.fp ?: return target
        val found = Discovery.lookup(Wire.hex(fp).substring(0, 16)) ?: return target
        val ips = (listOf(found.host) + target.ips).distinct()
        return Target(ips, found.port, target.fp, target.name)
    }

    private fun waitFrame(frames: Frames, input: InputStream, millis: Long): JSONObject {
        val until = SystemClock.elapsedRealtime() + millis
        while (running) {
            val frame = frames.poll(input)
            if (frame != null) return frame
            if (SystemClock.elapsedRealtime() > until) throw IOException("The PC did not answer.")
        }
        throw InterruptedException()
    }

    private fun battery(): Int {
        val manager = app.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    private fun session(target: Target, token: String?): Target? {
        var serverFp: ByteArray? = null
        val context = Identity.sslContext(target.fp) { serverFp = it }
        var lastError: Exception? = null
        var tls: SSLSocket? = null
        for (ip in target.ips) {
            try {
                val raw = Socket()
                raw.connect(InetSocketAddress(ip, target.port), 3000)
                raw.tcpNoDelay = true
                raw.soTimeout = 5000
                val ssl = context.socketFactory.createSocket(raw, ip, target.port, true) as SSLSocket
                ssl.useClientMode = true
                ssl.enabledProtocols = arrayOf("TLSv1.3")
                try {
                    val params = ssl.sslParameters
                    params.applicationProtocols = arrayOf("vesper/1")
                    ssl.sslParameters = params
                } catch (_: Throwable) {
                }
                ssl.startHandshake()
                tls = ssl
                break
            } catch (e: Exception) {
                lastError = e
            }
        }
        val ssl = tls ?: throw (lastError ?: IOException("No address to try."))
        socket = ssl
        ssl.soTimeout = 100
        val pcFp = serverFp ?: Wire.sha256((ssl.session.peerCertificates[0] as X509Certificate).encoded)
        val input = ssl.inputStream
        val output = ssl.outputStream
        val lock = Any()
        val frames = Frames()
        fun send(message: JSONObject) = Wire.write(output, lock, message)

        val metrics = app.resources.displayMetrics
        send(
            JSONObject().put("t", "hello").put("v", 1).put("id", prefs.deviceId).put("name", prefs.deviceName)
                .put("model", Build.MANUFACTURER + " " + Build.MODEL).put("api", Build.VERSION.SDK_INT)
                .put("caps", JSONArray().put("mic").put("display")).put("w", metrics.widthPixels).put("h", metrics.heightPixels).put("rate", 60)
        )
        val welcome = waitFrame(frames, input, 10000)
        if (welcome.optString("t") != "welcome") throw IOException("Unexpected answer from the PC.")
        val known = welcome.optBoolean("known")
        val pcName = welcome.optString("name", target.name)
        val serverNonce = Wire.unb64(welcome.optString("nonce"))
        if (!known) {
            if (token != null) {
                send(JSONObject().put("t", "pair").put("token", token))
            } else {
                val nonce = ByteArray(16)
                SecureRandom().nextBytes(nonce)
                send(JSONObject().put("t", "pair").put("nonce", Wire.b64(nonce)))
                val sas = waitFrame(frames, input, 10000)
                val code = sas.optString("code")
                val mine = Wire.sasCode(Identity.fingerprint(), pcFp, nonce, serverNonce)
                if (sas.optString("t") != "pair.sas" || code != mine) throw PairException("The codes did not match, so pairing was stopped.")
                Hub.sasCode = code
                Hub.changed()
                val accepted = confirm.poll(120, TimeUnit.SECONDS) ?: false
                Hub.sasCode = ""
                Hub.changed()
                send(JSONObject().put("t", "pair.confirm").put("ok", accepted))
                if (!accepted) throw PairException("Pairing was cancelled.")
            }
            val result = waitFrame(frames, input, 130000)
            if (!result.optBoolean("ok")) throw PairException(result.optString("reason", "The PC refused to pair."))
        }
        val saved = Target(target.ips, target.port, pcFp, pcName)
        prefs.save(saved)
        Hub.pcName = pcName
        Hub.error = ""
        Hub.phase = Hub.Phase.CONNECTED
        Hub.changed()

        var sentIntent = ""
        var sentMuted = false
        var lastPing = 0L
        var lastStats = 0L
        var lastPong = SystemClock.elapsedRealtime()
        try {
            while (running) {
                val now = SystemClock.elapsedRealtime()
                if (intent != sentIntent) {
                    send(JSONObject().put("t", "intent").put("mode", intent))
                    sentIntent = intent
                }
                if (Hub.muted != sentMuted) {
                    mic?.muted = Hub.muted
                    send(JSONObject().put("t", "mute").put("on", Hub.muted))
                    sentMuted = Hub.muted
                    Hub.changed()
                }
                if (now - lastPing >= 1000) {
                    lastPing = now
                    send(JSONObject().put("t", "ping").put("ts", now))
                }
                if (now - lastStats >= 5000) {
                    lastStats = now
                    send(JSONObject().put("t", "stats").put("rtt", Hub.rtt).put("battery", battery()))
                }
                while (true) {
                    val message = frames.poll(input) ?: break
                    when (message.optString("t")) {
                        "pong" -> {
                            lastPong = SystemClock.elapsedRealtime()
                            Hub.rtt = lastPong - message.optLong("ts", lastPong)
                        }
                        "session.start" -> startSession(message, ssl)
                        "session.stop" -> {
                            mic?.stop()
                            mic = null
                            Hub.micLive = false
                            Hub.display = null
                            Hub.changed()
                        }
                        "error" -> {
                            Hub.error = message.optString("message")
                            Hub.changed()
                        }
                    }
                }
                if (SystemClock.elapsedRealtime() - lastPong > 6000) throw IOException("The PC stopped answering.")
            }
        } finally {
            mic?.stop()
            mic = null
            Hub.micLive = false
            Hub.display = null
            try {
                ssl.close()
            } catch (_: Exception) {
            }
        }
        return saved
    }

    private fun startSession(message: JSONObject, ssl: SSLSocket) {
        if (message.optString("kind") == "display") {
            val video = message.optJSONObject("video")
            Hub.display = DisplayRequest(
                ssl.inetAddress,
                message.optInt("udp"),
                message.optLong("sid").toInt(),
                Wire.unb64(message.optString("key")),
                Wire.unb64(message.optString("salt")),
                video?.optInt("w", 1280) ?: 1280,
                video?.optInt("h", 720) ?: 720
            )
            Hub.changed()
            return
        }
        if (message.optString("kind") != "mic") return
        mic?.stop()
        val sender = MicSender(
            ssl.inetAddress,
            message.optInt("udp"),
            message.optLong("sid").toInt(),
            Wire.unb64(message.optString("key")),
            Wire.unb64(message.optString("salt"))
        )
        sender.muted = Hub.muted
        mic = sender
        sender.start()
        Hub.micLive = true
        Hub.changed()
    }
}
