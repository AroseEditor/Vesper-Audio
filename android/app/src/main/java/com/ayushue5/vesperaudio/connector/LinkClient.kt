package com.ayushue5.vesperaudio.connector

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
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
    @Volatile private var wifiPrefixes: List<Pair<ByteArray, Int>> = emptyList()

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

    fun startPairing(target: Target, token: String, mac: String) {
        stop()
        running = true
        Hub.error = ""
        confirm.clear()
        val thread = Thread({ pairThenLoop(target, token, mac) }, "vesper-link")
        worker = thread
        thread.start()
    }

    private fun pairThenLoop(target: Target, token: String, mac: String) {
        Hub.phase = Hub.Phase.CONNECTING
        Hub.pcName = target.name
        Hub.step = "Pairing over Bluetooth..."
        Hub.changed()
        val result = BluetoothPairing(app).pair(mac, token, prefs.deviceId, prefs.deviceName)
        if (!running) return
        if (result.ok) {
            Hub.log("Bluetooth paired with " + result.name)
            Hub.step = "Paired over Bluetooth. Joining over Wi-Fi..."
            Hub.changed()
            loop(Target((result.ips + target.ips).distinct(), result.port, result.fp, result.name), null)
        } else {
            Hub.log("Bluetooth: " + result.message)
            Hub.step = "Bluetooth did not work (" + result.message + "). Trying Wi-Fi..."
            Hub.changed()
            loop(target, token)
        }
    }

    private fun bindWifi() {
        try {
            val manager = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            for (network in manager.allNetworks) {
                val capabilities = manager.getNetworkCapabilities(network) ?: continue
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    manager.bindProcessToNetwork(network)
                    wifiPrefixes = manager.getLinkProperties(network)?.linkAddresses?.mapNotNull {
                        val bytes = it.address.address
                        if (bytes.size == 4) Pair(bytes, it.prefixLength) else null
                    } ?: emptyList()
                    return
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun sameSubnet(ip: String): Boolean {
        val bytes = try {
            java.net.InetAddress.getByName(ip).address
        } catch (_: Exception) {
            return false
        }
        if (bytes.size != 4) return false
        return wifiPrefixes.any { (mine, bits) ->
            var left = bits
            var index = 0
            var same = true
            while (left > 0 && index < 4) {
                val mask = if (left >= 8) 0xFF else (0xFF shl (8 - left)) and 0xFF
                if ((bytes[index].toInt() and mask) != (mine[index].toInt() and mask)) {
                    same = false
                    break
                }
                left -= 8
                index++
            }
            same
        }
    }

    fun confirmCode(ok: Boolean) {
        confirm.offer(ok)
    }

    fun isRunning(): Boolean = running

    private fun describe(error: Exception): String = when (error) {
        is PairException -> error.message ?: "Pairing failed."
        is SocketTimeoutException, is ConnectException, is UnknownHostException -> "Could not reach the PC (" + (error.message ?: "no answer") + "). Check it is on the same Wi-Fi, that Vesper Audio is open, and press Allow in Windows Firewall on the PC."
        is CertificateException -> "This is not the PC you scanned. Scan the code again."
        is SSLHandshakeException -> "The secure connection to the PC failed (" + (error.message ?: "no details") + "). Scan the pairing code again."
        is SSLException -> "The secure connection to the PC failed (" + (error.message ?: "no details") + ")."
        else -> error.message ?: error.javaClass.simpleName
    }

    private fun loop(initial: Target, firstToken: String?) {
        var target = initial
        var token = firstToken
        var delay = 500L
        var attempts = 0
        bindWifi()
        Hub.log("Key check: " + Identity.check())
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
                Hub.log(Hub.error)
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
        val local = target.ips.filter { sameSubnet(it) }
        for (ip in if (local.isNotEmpty()) local else target.ips) {
            for (version in arrayOf("TLSv1.3", "TLSv1.2")) {
                var raw: Socket? = null
                try {
                    raw = Socket()
                    raw.connect(InetSocketAddress(ip, target.port), 3000)
                    raw.tcpNoDelay = true
                    raw.soTimeout = 5000
                    val ssl = context.socketFactory.createSocket(raw, ip, target.port, true) as SSLSocket
                    ssl.useClientMode = true
                    ssl.enabledProtocols = arrayOf(version)
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
                    val unreachable = e is ConnectException || e is SocketTimeoutException
                    if (lastError == null || !unreachable || lastError is ConnectException || lastError is SocketTimeoutException) lastError = e
                    Hub.log(ip + " " + version + ": " + e.javaClass.simpleName + " " + (e.message ?: "") + (e.cause?.let { " / " + it.javaClass.simpleName + " " + (it.message ?: "") } ?: ""))
                    try {
                        raw?.close()
                    } catch (_: Exception) {
                    }
                    if (e is ConnectException || e is SocketTimeoutException) break
                }
            }
            if (tls != null) break
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
        Hub.step = ""
        Hub.log("Connected to " + pcName)
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
