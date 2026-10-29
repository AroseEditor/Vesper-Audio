package com.ayushue5.vesperaudio.connector

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var discovery: Discovery
    private lateinit var status: TextView
    private lateinit var detail: TextView
    private lateinit var logView: TextView
    private var pendingPair: String? = null
    private lateinit var scan: Button
    private lateinit var mic: Button
    private lateinit var monitor: Button
    private lateinit var mute: Button
    private lateinit var micState: TextView
    private lateinit var disconnect: Button
    private lateinit var battery: Button
    private lateinit var nearbyTitle: TextView
    private lateinit var nearby: LinearLayout
    private lateinit var address: EditText
    private var codeDialog: AlertDialog? = null
    private val listener = Runnable { render() }

    private val accent = 0xFF2FE0B8.toInt()
    private val panel = 0xFF1D1D20.toInt()
    private val text = 0xFFF2F2F2.toInt()
    private val muted = 0xFF9A9A9F.toInt()

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun label(size: Float, color: Int, bold: Boolean = false): TextView {
        val view = TextView(this)
        view.textSize = size
        view.setTextColor(color)
        if (bold) view.setTypeface(view.typeface, android.graphics.Typeface.BOLD)
        return view
    }

    private fun button(title: String, primary: Boolean, click: () -> Unit): Button {
        val view = Button(this)
        view.text = title
        view.isAllCaps = false
        view.textSize = 16f
        view.setTextColor(if (primary) 0xFF121212.toInt() else text)
        val shape = GradientDrawable()
        shape.cornerRadius = dp(14).toFloat()
        shape.setColor(if (primary) accent else panel)
        if (!primary) shape.setStroke(dp(1), 0x33FFFFFF)
        view.background = shape
        view.setOnClickListener { click() }
        val params = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52))
        params.topMargin = dp(10)
        view.layoutParams = params
        return view
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        discovery = Discovery(this)
        val column = LinearLayout(this)
        column.orientation = LinearLayout.VERTICAL
        column.setPadding(dp(20), dp(28), dp(20), dp(28))
        val title = label(22f, text, true)
        title.text = "Vesper Audio Connector"
        column.addView(title)
        status = label(26f, text, true)
        status.setPadding(0, dp(22), 0, 0)
        column.addView(status)
        detail = label(14f, muted)
        detail.setPadding(0, dp(6), 0, dp(10))
        column.addView(detail)
        logView = label(11f, muted)
        logView.typeface = android.graphics.Typeface.MONOSPACE
        logView.setTextIsSelectable(true)
        column.addView(logView)
        scan = button("Scan the QR code on your PC", true) { startScan() }
        column.addView(scan)
        mic = button("Use as PC microphone", false) { toggleMic() }
        column.addView(mic)
        monitor = button("Use as second monitor", false) { openMonitor() }
        column.addView(monitor)
        micState = label(14f, muted)
        micState.setPadding(0, dp(8), 0, 0)
        column.addView(micState)
        mute = button("Mute microphone", false) { toggleMute() }
        column.addView(mute)
        disconnect = button("Disconnect from the PC", false) { disconnectNow() }
        column.addView(disconnect)
        battery = button("Keep running in the background", false) { askBattery() }
        column.addView(battery)
        nearbyTitle = label(16f, text, true)
        nearbyTitle.text = "PCs nearby"
        nearbyTitle.setPadding(0, dp(24), 0, dp(4))
        column.addView(nearbyTitle)
        nearby = LinearLayout(this)
        nearby.orientation = LinearLayout.VERTICAL
        column.addView(nearby)
        val manualTitle = label(16f, text, true)
        manualTitle.text = "Connect by address"
        manualTitle.setPadding(0, dp(24), 0, dp(4))
        column.addView(manualTitle)
        address = EditText(this)
        address.hint = "For example 192.168.1.20:47100"
        address.setHintTextColor(muted)
        address.setTextColor(text)
        address.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        address.setSingleLine()
        column.addView(address)
        column.addView(button("Connect and pair with a code", false) { connectByAddress() })
        val version = label(12f, muted)
        version.gravity = Gravity.CENTER
        version.setPadding(0, dp(24), 0, 0)
        version.text = "Version " + (packageManager.getPackageInfo(packageName, 0).versionName ?: "")
        column.addView(version)
        val scroll = ScrollView(this)
        scroll.addView(column)
        setContentView(scroll)
        handleIntent(intent)
        val target = prefs.target()
        if (target != null && !Hub.client(this).isRunning()) Hub.client(this).start(target, null)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        Hub.listen(listener)
        discovery.onChange = { runOnUiThread { render() } }
        discovery.start()
        render()
    }

    override fun onStop() {
        Hub.unlisten(listener)
        discovery.stop()
        super.onStop()
    }

    private fun handleIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "vesper") pair(data.toString())
    }

    private fun startScan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { code -> code.rawValue?.let { pair(it) } }
            .addOnFailureListener { Toast.makeText(this, "Could not scan. You can also type the PC address below.", Toast.LENGTH_LONG).show() }
    }

    private fun pair(raw: String, allowBluetooth: Boolean = true) {
        val uri = Uri.parse(raw)
        if (uri.scheme != "vesper" || uri.host != "pair") {
            Toast.makeText(this, "That is not a Vesper Audio pairing code.", Toast.LENGTH_LONG).show()
            return
        }
        val ips = (uri.getQueryParameter("a") ?: "").split(",").filter { it.isNotEmpty() }
        val port = uri.getQueryParameter("p")?.toIntOrNull()
        val fp = uri.getQueryParameter("f")?.let { runCatching { Wire.unb64(it) }.getOrNull() }
        val token = uri.getQueryParameter("t")
        if (ips.isEmpty() || port == null || fp == null || fp.size != 32 || token == null) {
            Toast.makeText(this, "The pairing code is incomplete. Show a new one on the PC.", Toast.LENGTH_LONG).show()
            return
        }
        val target = Target(ips, port, fp, uri.getQueryParameter("n") ?: "PC")
        val mac = uri.getQueryParameter("b")
        if (mac != null && mac.length == 12 && allowBluetooth) {
            if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                pendingPair = raw
                requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), 2)
                return
            }
            Hub.client(this).startPairing(target, token, mac)
        } else {
            Hub.client(this).start(target, token)
        }
    }

    private fun connectByAddress() {
        val parts = address.text.toString().trim().split(":")
        val host = parts[0]
        val port = parts.getOrNull(1)?.toIntOrNull() ?: 47100
        if (host.isEmpty()) {
            Toast.makeText(this, "Type the PC address first.", Toast.LENGTH_SHORT).show()
            return
        }
        Hub.client(this).start(Target(listOf(host), port, null, "PC"), null)
    }

    private fun toggleMic() {
        if (Hub.client(this).intent == "mic") {
            startService(Intent(this, LinkService::class.java).setAction(LinkService.ACTION_STOP))
            render()
            return
        }
        if (!prefs.hasPc() && !Hub.client(this).isRunning()) {
            Toast.makeText(this, "Pair with your PC first.", Toast.LENGTH_LONG).show()
            return
        }
        val need = ArrayList<String>()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.POST_NOTIFICATIONS)
        if (need.isNotEmpty()) {
            requestPermissions(need.toTypedArray(), 1)
            return
        }
        startMic()
    }

    private fun openMonitor() {
        if (!prefs.hasPc() && !Hub.client(this).isRunning()) {
            Toast.makeText(this, "Pair with your PC first.", Toast.LENGTH_LONG).show()
            return
        }
        startActivity(Intent(this, DisplayActivity::class.java))
    }

    private fun startMic() {
        startForegroundService(Intent(this, LinkService::class.java).setAction(LinkService.ACTION_START))
        render()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 2) {
            val raw = pendingPair
            pendingPair = null
            if (raw != null) pair(raw, grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startMic()
        else Toast.makeText(this, "The microphone permission is needed to use this phone as a microphone.", Toast.LENGTH_LONG).show()
    }

    private fun toggleMute() {
        Hub.muted = !Hub.muted
        Hub.changed()
    }

    private fun disconnectNow() {
        startService(Intent(this, LinkService::class.java).setAction(LinkService.ACTION_STOP))
        Hub.client(this).stop()
        render()
    }

    private fun askBattery() {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        try {
            startActivity(intent)
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun render() {
        val client = Hub.client(this)
        val saved = prefs.target()
        val pc = Hub.pcName.ifEmpty { saved?.name ?: "" }.ifEmpty { "your PC" }
        when {
            Hub.phase == Hub.Phase.CONNECTED -> {
                status.text = "Connected to $pc"
                status.setTextColor(accent)
            }
            Hub.phase == Hub.Phase.CONNECTING -> {
                status.text = "Connecting to $pc..."
                status.setTextColor(text)
            }
            Hub.phase == Hub.Phase.RECONNECTING -> {
                status.text = "Reconnecting to $pc..."
                status.setTextColor(0xFFF0B429.toInt())
            }
            saved != null -> {
                status.text = "Paired with $pc"
                status.setTextColor(text)
            }
            else -> {
                status.text = "Not connected to a PC"
                status.setTextColor(text)
            }
        }
        logView.text = Hub.logText()
        detail.text = when {
            Hub.error.isNotEmpty() -> Hub.error
            Hub.step.isNotEmpty() && Hub.phase != Hub.Phase.CONNECTED -> Hub.step
            Hub.phase == Hub.Phase.CONNECTED -> "This phone and the PC are linked over Wi-Fi."
            saved == null -> "Open Vesper Audio on your PC, go to Second Monitor and scan the code it shows."
            else -> "Open Vesper Audio on your PC and keep both on the same Wi-Fi."
        }
        val usingMic = client.intent == "mic"
        mic.text = if (usingMic) "Stop using as PC microphone" else "Use as PC microphone"
        mute.visibility = if (usingMic) View.VISIBLE else View.GONE
        mute.text = if (Hub.muted) "Unmute microphone" else "Mute microphone"
        micState.visibility = if (usingMic) View.VISIBLE else View.GONE
        micState.text = if (Hub.muted) "Microphone is muted" else if (Hub.micLive) "Microphone is on and sending to $pc" else "Microphone is on, waiting for the PC to start listening"
        disconnect.visibility = if (client.isRunning()) View.VISIBLE else View.GONE
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        battery.visibility = if (power.isIgnoringBatteryOptimizations(packageName)) View.GONE else View.VISIBLE
        nearby.removeAllViews()
        val found = Discovery.shared.values.toList()
        nearbyTitle.visibility = if (found.isEmpty()) View.GONE else View.VISIBLE
        for (item in found) {
            nearby.addView(button("${item.name} (pair with a code)", false) { Hub.client(this).start(Target(listOf(item.host), item.port, null, item.name), null) })
        }
        if (Hub.sasCode.isNotEmpty()) showCode(Hub.sasCode) else {
            codeDialog?.dismiss()
            codeDialog = null
        }
    }

    private fun showCode(code: String) {
        if (codeDialog?.isShowing == true) return
        codeDialog = AlertDialog.Builder(this)
            .setTitle("Pair with this PC?")
            .setMessage("The PC should show this code. Press Match only if they are the same.\n\n$code")
            .setCancelable(false)
            .setPositiveButton("They match") { _, _ -> Hub.client(this).confirmCode(true) }
            .setNegativeButton("Cancel") { _, _ -> Hub.client(this).confirmCode(false) }
            .show()
    }
}
