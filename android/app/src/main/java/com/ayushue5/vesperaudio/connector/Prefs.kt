package com.ayushue5.vesperaudio.connector

import android.content.Context
import android.os.Build
import java.util.UUID

data class Target(val ips: List<String>, val port: Int, val fp: ByteArray?, val name: String)

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("vesper", Context.MODE_PRIVATE)

    val deviceId: String
        get() {
            var value = sp.getString("deviceId", null)
            if (value == null) {
                value = UUID.randomUUID().toString()
                sp.edit().putString("deviceId", value).apply()
            }
            return value
        }

    val deviceName: String
        get() = Build.MODEL ?: "Android phone"

    fun hasPc(): Boolean = sp.getString("pcFp", null) != null && sp.getString("pcIps", "")!!.isNotEmpty()

    fun target(): Target? {
        if (!hasPc()) return null
        return Target(sp.getString("pcIps", "")!!.split(",").filter { it.isNotEmpty() }, sp.getInt("pcPort", 47100), Wire.fromHex(sp.getString("pcFp", "")!!), sp.getString("pcName", "") ?: "")
    }

    fun save(target: Target) {
        sp.edit()
            .putString("pcIps", target.ips.joinToString(","))
            .putInt("pcPort", target.port)
            .putString("pcFp", target.fp?.let { Wire.hex(it) })
            .putString("pcName", target.name)
            .apply()
    }

    fun forget() {
        sp.edit().remove("pcIps").remove("pcPort").remove("pcFp").remove("pcName").apply()
    }

    var wasActive: Boolean
        get() = sp.getBoolean("active", false)
        set(value) {
            sp.edit().putBoolean("active", value).apply()
        }
}
