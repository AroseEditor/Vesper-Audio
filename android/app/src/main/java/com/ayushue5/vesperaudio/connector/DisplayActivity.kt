package com.ayushue5.vesperaudio.connector

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView

class DisplayActivity : Activity() {
    private lateinit var surfaceView: SurfaceView
    private lateinit var info: TextView
    private var receiver: VideoReceiver? = null
    private var shown: DisplayRequest? = null
    @Volatile private var surfaceReady = false
    private val listener = Runnable { refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        surfaceView = SurfaceView(this)
        root.addView(surfaceView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        info = TextView(this)
        info.setTextColor(0xFFF2F2F2.toInt())
        info.textSize = 18f
        info.gravity = Gravity.CENTER
        root.addView(info, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                surfaceReady = true
                refresh()
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

            override fun surfaceDestroyed(holder: SurfaceHolder) {
                surfaceReady = false
                stopReceiver()
            }
        })
        Hub.client(this).intent = "display"
        val prefs = Prefs(this)
        val target = prefs.target()
        if (target != null && !Hub.client(this).isRunning()) Hub.client(this).start(target, null)
    }

    override fun onStart() {
        super.onStart()
        Hub.listen(listener)
        hideBars()
        refresh()
    }

    override fun onStop() {
        Hub.unlisten(listener)
        stopReceiver()
        super.onStop()
    }

    override fun onDestroy() {
        if (Hub.client(this).intent == "display") Hub.client(this).intent = if (Hub.micWanted) "mic" else "idle"
        super.onDestroy()
    }

    private fun hideBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        }
    }

    private fun stopReceiver() {
        receiver?.stop()
        receiver = null
        shown = null
    }

    private fun refresh() {
        val request = Hub.display
        if (request == null) {
            stopReceiver()
            info.visibility = View.VISIBLE
            info.text = when (Hub.phase) {
                Hub.Phase.CONNECTED -> "Connected to ${Hub.pcName}\n\nOn the PC open Vesper Audio, go to Second Monitor\nand choose \"Use as second monitor\" for this phone."
                Hub.Phase.IDLE -> "Not connected to a PC.\nGo back and pair first."
                else -> "Connecting to ${Hub.pcName.ifEmpty { "your PC" }}..."
            }
            return
        }
        if (surfaceReady && shown !== request) {
            stopReceiver()
            val created = VideoReceiver(request, surfaceView.holder.surface)
            receiver = created
            shown = request
            created.start()
        }
        info.visibility = if (Hub.videoFps > 0) View.GONE else View.VISIBLE
        info.text = "Waiting for the first picture from ${Hub.pcName}..."
    }
}
