package com.ayushue5.vesperaudio.connector

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer

class WireTest {
    private fun vectors(): JSONObject {
        var dir: File? = File("").absoluteFile
        while (dir != null && !File(dir, "proto/vectors.json").exists()) dir = dir.parentFile
        return JSONObject(File(dir, "proto/vectors.json").readText())
    }

    private fun bytes(text: String): ByteArray = Wire.fromHex(text)

    @Test
    fun shortCodesMatchTheRustCore() {
        val list = vectors().getJSONArray("sas")
        for (i in 0 until list.length()) {
            val v = list.getJSONObject(i)
            val code = Wire.sasCode(bytes(v.getString("clientFp")), bytes(v.getString("serverFp")), bytes(v.getString("clientNonce")), bytes(v.getString("serverNonce")))
            assertEquals(v.getString("code"), code)
        }
    }

    @Test
    fun sealedPacketsAreIdenticalToTheRustCore() {
        val list = vectors().getJSONArray("seal")
        for (i in 0 until list.length()) {
            val v = list.getJSONObject(i)
            val sealer = Sealer(bytes(v.getString("key")), bytes(v.getString("salt")))
            val plain = bytes(v.getString("plain"))
            val packet = sealer.seal(v.getInt("kind"), v.getInt("flags"), v.getInt("sid"), v.getInt("seq"), v.getInt("ts"), plain, plain.size)
            assertEquals(v.getString("packet"), Wire.hex(packet))
        }
    }

    @Test
    fun packetsFromTheRustCoreOpen() {
        val list = vectors().getJSONArray("seal")
        for (i in 0 until list.length()) {
            val v = list.getJSONObject(i)
            val sealer = Sealer(bytes(v.getString("key")), bytes(v.getString("salt")))
            val packet = bytes(v.getString("packet"))
            val opened = sealer.open(packet, packet.size)
            assertNotNull(opened)
            assertArrayEquals(bytes(v.getString("plain")), opened!!.second)
            assertEquals(v.getInt("seq"), ByteBuffer.wrap(opened.first, 8, 4).int)
        }
    }

    @Test
    fun base64IsUrlSafeWithoutPadding() {
        val data = byteArrayOf(-5, -1, -2, 0, 1)
        val text = Wire.b64(data)
        assertEquals(false, text.contains("=") || text.contains("+") || text.contains("/"))
        assertArrayEquals(data, Wire.unb64(text))
    }
}
