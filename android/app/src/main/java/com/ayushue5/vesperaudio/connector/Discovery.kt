package com.ayushue5.vesperaudio.connector

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import java.util.concurrent.ConcurrentHashMap

data class Found(val name: String, val host: String, val port: Int, val fp: String)

class Discovery(context: Context) {
    private val app = context.applicationContext
    private val manager = app.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var multicast: WifiManager.MulticastLock? = null
    private var listener: NsdManager.DiscoveryListener? = null
    private val queue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    @Volatile var onChange: () -> Unit = {}

    fun start() {
        if (listener != null) return
        val wifi = app.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicast = wifi.createMulticastLock("vesper-discovery").also {
            it.setReferenceCounted(false)
            it.acquire()
        }
        val created = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}

            override fun onServiceFound(service: NsdServiceInfo) {
                synchronized(queue) {
                    queue.addLast(service)
                }
                next()
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                shared.remove(service.serviceName)
                onChange()
            }

            override fun onDiscoveryStopped(serviceType: String) {}

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                listener = null
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        }
        listener = created
        try {
            manager.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, created)
        } catch (_: Exception) {
            listener = null
        }
    }

    fun stop() {
        val active = listener
        listener = null
        if (active != null) {
            try {
                manager.stopServiceDiscovery(active)
            } catch (_: Exception) {
            }
        }
        multicast?.let {
            if (it.isHeld) it.release()
        }
        multicast = null
        shared.clear()
    }

    @Suppress("DEPRECATION")
    private fun next() {
        val service = synchronized(queue) {
            if (resolving || queue.isEmpty()) return
            resolving = true
            queue.removeFirst()
        }
        manager.resolveService(service, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                done()
            }

            override fun onServiceResolved(info: NsdServiceInfo) {
                val host = info.host?.hostAddress
                val fp = info.attributes["fp"]?.let { String(it) } ?: ""
                val shown = info.attributes["name"]?.let { String(it) } ?: info.serviceName
                if (host != null && fp.isNotEmpty()) {
                    shared[info.serviceName] = Found(shown, host, info.port, fp)
                    onChange()
                }
                done()
            }
        })
    }

    private fun done() {
        synchronized(queue) {
            resolving = false
        }
        next()
    }

    companion object {
        const val TYPE = "_vesper-link._tcp"
        val shared = ConcurrentHashMap<String, Found>()

        fun lookup(fp: String): Found? = shared.values.firstOrNull { it.fp == fp }
    }
}
