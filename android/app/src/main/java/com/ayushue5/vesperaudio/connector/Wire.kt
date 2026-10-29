package com.ayushue5.vesperaudio.connector

import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object Wire {
    const val KIND_AUDIO = 1
    const val KIND_VIDEO = 2
    const val KIND_FEEDBACK = 3
    const val KIND_PUNCH = 4
    const val HEADER = 16
    const val MAX_FRAME = 65536

    fun b64(data: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(data)

    fun unb64(text: String): ByteArray = Base64.getUrlDecoder().decode(text)

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    fun hex(data: ByteArray): String = data.joinToString("") { "%02x".format(it) }

    fun fromHex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    fun sasCode(clientFp: ByteArray, serverFp: ByteArray, clientNonce: ByteArray, serverNonce: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(clientFp)
        digest.update(serverFp)
        digest.update(clientNonce)
        digest.update(serverNonce)
        val d = digest.digest()
        val value = (((d[0].toLong() and 0xff) shl 24) or ((d[1].toLong() and 0xff) shl 16) or ((d[2].toLong() and 0xff) shl 8) or (d[3].toLong() and 0xff)) % 1_000_000L
        return "%06d".format(value)
    }

    fun frame(message: JSONObject): ByteArray {
        val body = message.toString().toByteArray(Charsets.UTF_8)
        if (body.size > MAX_FRAME) throw IOException("frame too large")
        val out = ByteBuffer.allocate(4 + body.size)
        out.putInt(body.size)
        out.put(body)
        return out.array()
    }

    fun write(stream: OutputStream, lock: Any, message: JSONObject) {
        val bytes = frame(message)
        synchronized(lock) {
            stream.write(bytes)
            stream.flush()
        }
    }

    fun header(kind: Int, flags: Int, sid: Int, seq: Int, ts: Int): ByteArray {
        val buffer = ByteBuffer.allocate(HEADER)
        buffer.put(1)
        buffer.put(kind.toByte())
        buffer.put(flags.toByte())
        buffer.put(0)
        buffer.putInt(sid)
        buffer.putInt(seq)
        buffer.putInt(ts)
        return buffer.array()
    }
}

class Sealer(key: ByteArray, private val salt: ByteArray) {
    private val keySpec = SecretKeySpec(key, "AES")

    fun nonce(kind: Int, seq: Int): ByteArray {
        val nonce = ByteArray(12)
        System.arraycopy(salt, 0, nonce, 0, 4)
        nonce[4] = kind.toByte()
        ByteBuffer.wrap(nonce, 8, 4).putInt(seq)
        return nonce
    }

    fun seal(kind: Int, flags: Int, sid: Int, seq: Int, ts: Int, plain: ByteArray, length: Int): ByteArray {
        val header = Wire.header(kind, flags, sid, seq, ts)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, GCMParameterSpec(128, nonce(kind, seq)))
        cipher.updateAAD(header)
        val body = cipher.doFinal(plain, 0, length)
        val packet = ByteArray(header.size + body.size)
        System.arraycopy(header, 0, packet, 0, header.size)
        System.arraycopy(body, 0, packet, header.size, body.size)
        return packet
    }

    fun open(packet: ByteArray, length: Int): Pair<ByteArray, ByteArray>? {
        if (length < Wire.HEADER + 16 || packet[0].toInt() != 1) return null
        val header = packet.copyOfRange(0, Wire.HEADER)
        val kind = header[1].toInt() and 0xff
        val seq = ByteBuffer.wrap(header, 8, 4).int
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, keySpec, GCMParameterSpec(128, nonce(kind, seq)))
            cipher.updateAAD(header)
            Pair(header, cipher.doFinal(packet, Wire.HEADER, length - Wire.HEADER))
        } catch (e: Exception) {
            null
        }
    }
}

class Frames {
    private var buffer = ByteArray(0)

    private fun take(): JSONObject? {
        if (buffer.size < 4) return null
        val length = ByteBuffer.wrap(buffer, 0, 4).int
        if (length < 0 || length > Wire.MAX_FRAME) throw IOException("bad frame")
        if (buffer.size < 4 + length) return null
        val text = String(buffer, 4, length, Charsets.UTF_8)
        buffer = buffer.copyOfRange(4 + length, buffer.size)
        return JSONObject(text)
    }

    fun poll(input: InputStream): JSONObject? {
        val ready = take()
        if (ready != null) return ready
        val chunk = ByteArray(4096)
        val count = try {
            input.read(chunk)
        } catch (e: SocketTimeoutException) {
            return null
        }
        if (count < 0) throw IOException("closed")
        buffer += chunk.copyOf(count)
        return take()
    }
}
