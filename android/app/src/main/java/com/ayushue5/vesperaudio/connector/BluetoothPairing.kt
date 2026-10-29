package com.ayushue5.vesperaudio.connector

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.DataInputStream
import java.io.IOException
import java.util.UUID

class BtResult(val ok: Boolean, val message: String, val ips: List<String> = emptyList(), val port: Int = 0, val fp: ByteArray? = null, val name: String = "")

class BluetoothPairing(private val context: Context) {
    @SuppressLint("MissingPermission")
    fun pair(mac: String, token: String, id: String, name: String): BtResult {
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter ?: return BtResult(false, "this phone has no Bluetooth")
        if (!adapter.isEnabled) return BtResult(false, "Bluetooth is off, turn it on")
        var socket: BluetoothSocket? = null
        var watchdog: Thread? = null
        try {
            val device = adapter.getRemoteDevice(mac.chunked(2).joinToString(":"))
            adapter.cancelDiscovery()
            val created = device.createInsecureRfcommSocketToServiceRecord(UUID.fromString(SERVICE))
            socket = created
            watchdog = Thread {
                try {
                    Thread.sleep(25000)
                    created.close()
                } catch (_: InterruptedException) {
                } catch (_: Exception) {
                }
            }
            watchdog.start()
            created.connect()
            val hello = JSONObject().put("t", "bt.hello").put("v", 1).put("token", token).put("id", id).put("name", name)
                .put("model", Build.MANUFACTURER + " " + Build.MODEL).put("fp", Wire.hex(Identity.fingerprint()))
            created.outputStream.write(Wire.frame(hello))
            created.outputStream.flush()
            val input = DataInputStream(created.inputStream)
            val length = input.readInt()
            if (length < 1 || length > Wire.MAX_FRAME) return BtResult(false, "the PC sent an invalid answer")
            val body = ByteArray(length)
            input.readFully(body)
            val reply = JSONObject(String(body, Charsets.UTF_8))
            if (!reply.optBoolean("ok")) return BtResult(false, reply.optString("reason", "the PC refused to pair"))
            val list = reply.optJSONArray("ips")
            val ips = ArrayList<String>()
            if (list != null) for (i in 0 until list.length()) ips.add(list.getString(i))
            return BtResult(true, "", ips, reply.optInt("port", 47100), Wire.fromHex(reply.getString("fp")), reply.optString("name"))
        } catch (e: SecurityException) {
            return BtResult(false, "the Nearby devices permission was not allowed")
        } catch (e: IOException) {
            return BtResult(false, "could not reach the PC over Bluetooth (${e.message ?: "no answer"})")
        } catch (e: Exception) {
            return BtResult(false, e.message ?: e.javaClass.simpleName)
        } finally {
            watchdog?.interrupt()
            try {
                socket?.close()
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        const val SERVICE = "7ae1b6a0-5f6d-4a8e-9c3a-5e5a56455350"
    }
}
