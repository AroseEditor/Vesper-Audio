package com.ayushue5.vesperaudio.connector

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Process
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress

class MicSender(private val host: InetAddress, private val port: Int, private val sid: Int, key: ByteArray, salt: ByteArray) {
    private val sealer = Sealer(key, salt)
    @Volatile private var running = false
    @Volatile var muted = false
    private var thread: Thread? = null

    fun start() {
        running = true
        val worker = Thread({ run() }, "vesper-mic")
        worker.priority = Thread.MAX_PRIORITY
        thread = worker
        worker.start()
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
    }

    @SuppressLint("MissingPermission")
    private fun run() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val socket = DatagramSocket()
        val destination = InetSocketAddress(host, port)
        val punch = sealer.seal(Wire.KIND_PUNCH, 0, sid, 0, 0, ByteArray(0), 0)
        try {
            socket.send(DatagramPacket(punch, punch.size, destination))
        } catch (_: Exception) {
        }
        val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val record = AudioRecord(source(), RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, FRAME * 2 * 6))
        val frame = ShortArray(FRAME)
        val bytes = ByteArray(FRAME * 2)
        var seq = 0
        var live = false
        try {
            while (running) {
                if (muted) {
                    if (live) {
                        record.stop()
                        live = false
                    }
                    Thread.sleep(40)
                    continue
                }
                if (!live) {
                    record.startRecording()
                    live = true
                }
                var filled = 0
                while (filled < FRAME && running && !muted) {
                    val got = record.read(frame, filled, FRAME - filled)
                    if (got < 0) throw IllegalStateException("The microphone stopped.")
                    filled += got
                }
                if (filled < FRAME) continue
                for (i in 0 until FRAME) {
                    bytes[i * 2] = (frame[i].toInt() and 0xff).toByte()
                    bytes[i * 2 + 1] = ((frame[i].toInt() shr 8) and 0xff).toByte()
                }
                val packet = sealer.seal(Wire.KIND_AUDIO, 0, sid, seq, seq * FRAME, bytes, bytes.size)
                seq++
                socket.send(DatagramPacket(packet, packet.size, destination))
            }
        } catch (_: InterruptedException) {
        } catch (_: Exception) {
        } finally {
            try {
                if (live) record.stop()
            } catch (_: Exception) {
            }
            record.release()
            socket.close()
        }
    }

    private fun source(): Int = MediaRecorder.AudioSource.VOICE_RECOGNITION

    companion object {
        const val RATE = 48000
        const val FRAME = 480
    }
}
