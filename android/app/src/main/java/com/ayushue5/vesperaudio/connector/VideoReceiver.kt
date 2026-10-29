package com.ayushue5.vesperaudio.connector

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.SystemClock
import android.view.Surface
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.util.TreeMap

class VideoReceiver(private val request: DisplayRequest, private val surface: Surface) {
    private class Pending(val count: Int, val key: Boolean) {
        val parts = arrayOfNulls<ByteArray>(count)
        var got = 0
        val since = SystemClock.elapsedRealtime()
    }

    @Volatile private var running = false
    private var thread: Thread? = null

    fun start() {
        running = true
        val worker = Thread({ run() }, "vesper-video")
        worker.priority = Thread.MAX_PRIORITY
        thread = worker
        worker.start()
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
    }

    private fun run() {
        val sealer = Sealer(request.key, request.salt)
        val socket = DatagramSocket()
        socket.soTimeout = 20
        val destination = InetSocketAddress(request.host, request.port)
        var seq = 1
        fun send(kind: Int, plain: ByteArray) {
            val packet = sealer.seal(kind, 0, request.sid, seq++, 0, plain, plain.size)
            try {
                socket.send(DatagramPacket(packet, packet.size, destination))
            } catch (_: Exception) {
            }
        }
        var codec: MediaCodec? = null
        try {
            val format = MediaFormat.createVideoFormat("video/avc", request.width, request.height)
            if (Build.VERSION.SDK_INT >= 30) format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            format.setInteger(MediaFormat.KEY_PRIORITY, 0)
            val created = MediaCodec.createDecoderByType("video/avc")
            created.configure(format, surface, null, 0)
            created.start()
            codec = created
            val pending = HashMap<Int, Pending>()
            val ready = TreeMap<Int, Pair<ByteArray, Boolean>>()
            val buffer = ByteArray(2048)
            var next = -1
            var needKey = true
            var lastSeq = -1
            var lost = 0
            var maxSeq = 0
            var lastReport = 0L
            var stalledSince = 0L
            var frames = 0
            var fpsStart = SystemClock.elapsedRealtime()
            var pts = 0L
            val info = MediaCodec.BufferInfo()
            var gotAny = false
            while (running) {
                val now = SystemClock.elapsedRealtime()
                if (now - lastReport >= 100) {
                    lastReport = now
                    val nacks = ArrayList<Pair<Int, Int>>()
                    for ((id, p) in pending) {
                        if (now - p.since > 30) for (i in 0 until p.count) if (p.parts[i] == null && nacks.size < 32) nacks.add(Pair(id, i))
                    }
                    val plain = ByteBuffer.allocate(22 + nacks.size * 6)
                    plain.putInt(maxSeq).putInt(lost).putInt(0).putInt(0).putShort(0).putShort(if (needKey) 1 else 0).putShort(nacks.size.toShort())
                    for ((id, i) in nacks) plain.putInt(id).putShort(i.toShort())
                    send(Wire.KIND_FEEDBACK, plain.array())
                    if (!gotAny) send(Wire.KIND_PUNCH, ByteArray(0))
                    if (now - fpsStart >= 1000) {
                        Hub.videoFps = frames
                        frames = 0
                        fpsStart = now
                        Hub.changed()
                    }
                }
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val opened = sealer.open(buffer, packet.length)
                    if (opened != null && (opened.first[1].toInt() and 0xff) == Wire.KIND_VIDEO && opened.second.size > 8) {
                        val flags = opened.first[2].toInt()
                        val packetSeq = ByteBuffer.wrap(opened.first, 8, 4).int
                        if (lastSeq >= 0 && packetSeq - lastSeq > 1) lost += packetSeq - lastSeq - 1
                        if (packetSeq > lastSeq) lastSeq = packetSeq
                        maxSeq = lastSeq
                        gotAny = true
                        val body = ByteBuffer.wrap(opened.second)
                        val frame = body.int
                        val index = body.short.toInt() and 0xffff
                        val count = body.short.toInt() and 0xffff
                        if (count in 1..512 && index < count) {
                            val entry = pending.getOrPut(frame) { Pending(count, flags and 1 == 1) }
                            if (entry.parts[index] == null) {
                                entry.parts[index] = opened.second.copyOfRange(8, opened.second.size)
                                entry.got++
                            }
                            if (entry.got == entry.count) {
                                pending.remove(frame)
                                val joined = java.io.ByteArrayOutputStream()
                                for (part in entry.parts) joined.write(part!!)
                                ready[frame] = Pair(joined.toByteArray(), entry.key)
                            }
                        }
                    }
                } catch (_: SocketTimeoutException) {
                }
                if (next < 0) {
                    val firstKey = ready.entries.firstOrNull { it.value.second }
                    if (firstKey != null) {
                        next = firstKey.key
                        needKey = false
                        ready.headMap(next).clear()
                    }
                }
                while (next >= 0) {
                    val unit = ready.remove(next)
                    if (unit != null) {
                        stalledSince = 0
                        if (!needKey || unit.second) {
                            needKey = false
                            val index = created.dequeueInputBuffer(8000)
                            if (index >= 0) {
                                val input = created.getInputBuffer(index)!!
                                input.clear()
                                input.put(unit.first)
                                created.queueInputBuffer(index, 0, unit.first.size, pts, if (unit.second) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                                pts += 33333
                                frames++
                            }
                        }
                        next++
                    } else {
                        if (ready.isEmpty()) break
                        if (stalledSince == 0L) stalledSince = now
                        if (now - stalledSince > 250) {
                            val key = ready.entries.firstOrNull { it.value.second }
                            needKey = true
                            stalledSince = 0
                            if (key != null) {
                                next = key.key
                                ready.headMap(next).clear()
                                pending.keys.removeAll { it < next }
                            } else {
                                ready.clear()
                                pending.clear()
                                next = -1
                            }
                        }
                        break
                    }
                }
                var out = created.dequeueOutputBuffer(info, 0)
                while (out >= 0 || out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    if (out >= 0) created.releaseOutputBuffer(out, true)
                    out = created.dequeueOutputBuffer(info, 0)
                }
                if (pending.size > 64) pending.keys.minOrNull()?.let { pending.remove(it) }
            }
        } catch (_: InterruptedException) {
        } catch (e: Exception) {
            Hub.error = "The screen could not be shown: " + (e.message ?: e.javaClass.simpleName)
        } finally {
            try {
                codec?.stop()
            } catch (_: Exception) {
            }
            try {
                codec?.release()
            } catch (_: Exception) {
            }
            socket.close()
            Hub.videoFps = 0
            Hub.changed()
        }
    }
}
