package com.ayushue5.vesperaudio.connector

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList

class DisplayRequest(val host: InetAddress, val port: Int, val sid: Int, val key: ByteArray, val salt: ByteArray, val width: Int, val height: Int)

object Hub {
    enum class Phase { IDLE, CONNECTING, CONNECTED, RECONNECTING }

    @Volatile var phase = Phase.IDLE
    @Volatile var pcName = ""
    @Volatile var error = ""
    @Volatile var sasCode = ""
    @Volatile var micLive = false
    @Volatile var muted = false
    @Volatile var rtt = -1L
    @Volatile var display: DisplayRequest? = null
    @Volatile var videoFps = 0
    @Volatile var micWanted = false

    private val ui = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<Runnable>()
    @Volatile private var link: LinkClient? = null

    fun client(context: Context): LinkClient {
        val existing = link
        if (existing != null) return existing
        synchronized(this) {
            val again = link
            if (again != null) return again
            val created = LinkClient(context.applicationContext)
            link = created
            return created
        }
    }

    fun listen(listener: Runnable) {
        listeners.add(listener)
    }

    fun unlisten(listener: Runnable) {
        listeners.remove(listener)
    }

    fun changed() {
        ui.post { listeners.forEach { it.run() } }
    }
}
