# Vesper Link protocol, version 1

Used between Vesper Audio (PC) and the Vesper Audio Connector (Android). All integers are big-endian.

## Discovery

- The PC advertises the DNS-SD service `_vesper-link._tcp` on the local network. TXT records: `v=1`, `id=<pc id>`, `name=<pc name>`, `fp=<first 16 hex chars of the server certificate SHA-256>`.
- The phone can also be given the endpoint by QR code or typed manually as `ip:port`.
- The default control port is 47100. If it is taken, a random free port is used and the real port is always advertised and placed in the QR code.

## Control channel

TCP, TLS 1.3, mutual authentication, ALPN `vesper/1`.

- The PC certificate is a self-signed ECDSA P-256 certificate created on first run. Its fingerprint is the SHA-256 of the DER bytes.
- The phone certificate is a self-signed ECDSA P-256 certificate created in the Android Keystore. Its fingerprint is the SHA-256 of the DER bytes.
- The PC accepts any client certificate at the TLS layer and decides at the application layer. A connection from an unknown client may only send `hello` and `pair`.

Framing: `u32` length (at most 65536), then a UTF-8 JSON object with a string field `t`.

### Messages from the phone

| `t` | Fields |
| --- | --- |
| `hello` | `v` (1), `id` (stable random id), `name`, `model`, `api`, `caps` (array of `mic`, `display`), `w`, `h`, `rate` (screen size and refresh rate) |
| `pair` | `token` (base64url, from the QR code) or `nonce` (16 random bytes, base64url, for the short-code path) |
| `pair.confirm` | `ok` (bool), sent after the user compares the 6-digit codes |
| `intent` | `mode`: `mic`, `display` or `idle` |
| `mute` | `on` (bool). The user muted or unmuted the microphone in the Connector app. While muted the phone sends no audio packets. A phone is unmuted by default and stays unmuted until the user mutes it |
| `ping` | `ts` (phone milliseconds) |
| `stats` | `rtt`, `battery`, `charging` |
| `bye` | none |

### Messages from the PC

| `t` | Fields |
| --- | --- |
| `welcome` | `v`, `name` (PC name, shown on the phone as "Connected to <name>"), `known` (bool, the client certificate is already paired), `nonce` (16 random bytes, base64url) |
| `pair.result` | `ok` (bool), `reason` |
| `pair.sas` | `code` (6 digits), sent so the phone can display the same code |
| `session.start` | `sid` (u32), `kind` (`mic` or `display`), `udp` (PC UDP port), `key` (16 bytes, base64url), `salt` (4 bytes, base64url), `rate` (48000), `ch` (1), `frameMs` (5 or 10), `codec` (`pcm16`), `redundancy` (0 or 1). For `display` also `video`: `codec` (`h264`), `w`, `h`, `fps`, `kbps`, `idrMs` |
| `session.stop` | `sid` |
| `pong` | `ts` (echo), `pc` (PC milliseconds) |
| `error` | `message` |

### Pairing

QR code text:

`vesper://pair?v=1&a=<ip,ip>&p=<port>&f=<base64url sha256 of the PC certificate>&t=<base64url 16-byte token>&n=<PC name>`

1. The phone dials every address in `a` in parallel and pins the first PC certificate whose SHA-256 equals `f`.
2. The phone sends `hello`, then `pair` with `token`.
3. The PC accepts a token only once and only within 120 seconds of the QR code being shown. On success it stores the phone certificate fingerprint and replies `pair.result` with `ok` true.

Short-code path (mDNS or manual address, no QR code):

1. The phone sends `hello`, then `pair` with `nonce`.
2. The PC replies `pair.sas` with `code` = the first 6 decimal digits of the big-endian integer formed by the first 4 bytes of `SHA-256(clientFp || serverFp || clientNonce || serverNonce)` modulo 1000000, zero padded. `clientFp` and `serverFp` are the 32-byte certificate hashes. The nonces are the raw 16 bytes.
3. The PC shows the code and asks the user to confirm. The phone computes the same code and shows it. The user compares the two screens.
4. The PC sends `pair.result` after the user confirms. The phone sends `pair.confirm` when the user taps Match. Pairing succeeds only when both sides confirmed.

A known phone (certificate fingerprint already stored) is welcomed with `known` true and needs no pairing. Forgetting a phone on the PC deletes its fingerprint.

Heartbeat: the phone sends `ping` every second. The PC ends a session when no `ping` was seen for 3 seconds.

## UDP media

All media packets share one 16-byte header, used as AES-128-GCM additional data:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | `ver` = 1 |
| 1 | 1 | `kind`: 1 audio (phone to PC), 2 video (PC to phone), 3 feedback (phone to PC), 4 punch (phone to PC) |
| 2 | 1 | `flags`: bit0 keyframe, bit1 last fragment, bit2 retransmit |
| 3 | 1 | reserved, 0 |
| 4 | 4 | `sid` |
| 8 | 4 | `seq` (per kind, starts at 0) |
| 12 | 4 | `ts` (audio: first sample counter; video: capture time in microseconds, low 32 bits) |

Followed by the ciphertext and a 16-byte GCM tag. Key: the 16 bytes from `session.start`. Nonce (12 bytes): `salt(4) || kind(1) || 0 0 0 || seq(4)`.

The phone opens its own UDP socket and sends a `punch` packet (empty plaintext) to the PC UDP port; the PC learns the phone address from the packet source and answers there. The punch packet is repeated every second until the first packet arrives from the PC, and for audio sessions it is simply followed by audio packets.

Audio payload (plaintext): `frameMs` of 48 kHz mono signed 16-bit little-endian samples (480 samples for 10 ms). With `redundancy` 1 the plaintext is the current frame followed by the previous frame.

Video payload (plaintext): `frameId u32, fragIdx u16, fragCnt u16`, then a slice of the Annex-B H.264 access unit (SPS and PPS before every keyframe). Slices are at most 1100 bytes.

Feedback payload (plaintext): `recvSeqMax u32, lost u32, jitterUs u32, decodeUs u32, queue u16, flags u16`, then `nackCount u16` and `nackCount` pairs of `frameId u32, fragIdx u16`. Flags bit0 requests a keyframe.
