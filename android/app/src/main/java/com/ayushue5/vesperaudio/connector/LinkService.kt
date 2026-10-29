package com.ayushue5.vesperaudio.connector

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager

class LinkService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private val listener = Runnable { refresh() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Connector status", NotificationManager.IMPORTANCE_LOW))
        Hub.listen(listener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopWork()
                return START_NOT_STICKY
            }
            ACTION_MUTE -> {
                Hub.muted = !Hub.muted
                Hub.changed()
                refresh()
                return START_STICKY
            }
            else -> {
                if (!startWork()) {
                    stopSelf()
                    return START_NOT_STICKY
                }
            }
        }
        return START_STICKY
    }

    private fun startWork(): Boolean {
        try {
            startForeground(NOTIFICATION, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } catch (e: Exception) {
            return false
        }
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (wake == null) {
            wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vesper:link").also {
                it.setReferenceCounted(false)
                it.acquire()
            }
        }
        if (wifi == null) {
            val manager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifi = manager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "vesper:link").also {
                it.setReferenceCounted(false)
                it.acquire()
            }
        }
        val prefs = Prefs(this)
        prefs.wasActive = true
        Hub.micWanted = true
        val client = Hub.client(this)
        client.intent = "mic"
        if (!client.isRunning()) {
            val target = prefs.target()
            if (target != null) client.start(target, null)
        }
        Hub.changed()
        return true
    }

    private fun stopWork() {
        Prefs(this).wasActive = false
        Hub.micWanted = false
        Hub.client(this).intent = "idle"
        release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        Hub.changed()
    }

    private fun release() {
        wake?.let {
            if (it.isHeld) it.release()
        }
        wake = null
        wifi?.let {
            if (it.isHeld) it.release()
        }
        wifi = null
    }

    private fun refresh() {
        if (Hub.client(this).intent != "mic") return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION, build())
    }

    private fun action(label: String, name: String, code: Int): Notification.Action {
        val pending = PendingIntent.getService(this, code, Intent(this, LinkService::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_launcher_foreground), label, pending).build()
    }

    private fun build(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val title = when (Hub.phase) {
            Hub.Phase.CONNECTED -> "Connected to ${Hub.pcName}"
            Hub.Phase.CONNECTING, Hub.Phase.RECONNECTING -> "Reconnecting to ${Hub.pcName}"
            Hub.Phase.IDLE -> "Not connected"
        }
        val line = if (Hub.muted) "Microphone is muted" else "Microphone is on"
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(line)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(action(if (Hub.muted) "Unmute" else "Mute", ACTION_MUTE, 1))
            .addAction(action("Stop", ACTION_STOP, 2))
            .build()
    }

    override fun onDestroy() {
        Hub.unlisten(listener)
        release()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "com.ayushue5.vesperaudio.connector.START"
        const val ACTION_STOP = "com.ayushue5.vesperaudio.connector.STOP"
        const val ACTION_MUTE = "com.ayushue5.vesperaudio.connector.MUTE"
        private const val CHANNEL = "link"
        private const val NOTIFICATION = 7
    }
}
