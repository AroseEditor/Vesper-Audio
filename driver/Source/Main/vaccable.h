#pragma once

#include <ntddk.h>

#define VAC_RING_BYTES   262144
#define VAC_FRAME_BYTES  4
#define VAC_BYTES_PER_MS (48 * VAC_FRAME_BYTES)
#define VAC_PRIME_BYTES  (VAC_BYTES_PER_MS * 20)
#define VAC_MAX_BYTES    (VAC_BYTES_PER_MS * 120)
#define VAC_IDLE_100NS   5000000LL

typedef struct _VAC_RING
{
    KSPIN_LOCK Lock;
    ULONG      Head;
    ULONG      Fill;
    BOOLEAN    Primed;
    ULONGLONG  LastRead;
    UCHAR      Data[VAC_RING_BYTES];
} VAC_RING;

extern VAC_RING g_VacRing;

inline VOID VacRingWrite(_In_reads_bytes_(Length) const UCHAR* Source, _In_ ULONG Length)
{
    KIRQL irql;
    KeAcquireSpinLock(&g_VacRing.Lock, &irql);

    if ((LONGLONG)(KeQueryInterruptTime() - g_VacRing.LastRead) > VAC_IDLE_100NS)
    {
        g_VacRing.Head = 0;
        g_VacRing.Fill = 0;
        g_VacRing.Primed = FALSE;
        KeReleaseSpinLock(&g_VacRing.Lock, irql);
        return;
    }

    if (Length > VAC_RING_BYTES)
    {
        Source += Length - VAC_RING_BYTES;
        Length = VAC_RING_BYTES;
    }

    if (g_VacRing.Fill + Length > VAC_RING_BYTES)
    {
        ULONG drop = g_VacRing.Fill + Length - VAC_RING_BYTES;
        g_VacRing.Head = (g_VacRing.Head + drop) % VAC_RING_BYTES;
        g_VacRing.Fill -= drop;
    }

    ULONG tail = (g_VacRing.Head + g_VacRing.Fill) % VAC_RING_BYTES;
    ULONG first = min(Length, (ULONG)VAC_RING_BYTES - tail);
    RtlCopyMemory(g_VacRing.Data + tail, Source, first);
    if (Length > first)
    {
        RtlCopyMemory(g_VacRing.Data, Source + first, Length - first);
    }
    g_VacRing.Fill += Length;

    if (g_VacRing.Fill > VAC_MAX_BYTES)
    {
        ULONG drop = g_VacRing.Fill - VAC_PRIME_BYTES;
        g_VacRing.Head = (g_VacRing.Head + drop) % VAC_RING_BYTES;
        g_VacRing.Fill -= drop;
    }

    KeReleaseSpinLock(&g_VacRing.Lock, irql);
}

inline VOID VacRingRead(_Out_writes_bytes_(Length) UCHAR* Destination, _In_ ULONG Length)
{
    KIRQL irql;
    KeAcquireSpinLock(&g_VacRing.Lock, &irql);

    g_VacRing.LastRead = KeQueryInterruptTime();

    if (!g_VacRing.Primed && g_VacRing.Fill >= VAC_PRIME_BYTES)
    {
        g_VacRing.Primed = TRUE;
    }

    if (!g_VacRing.Primed)
    {
        RtlZeroMemory(Destination, Length);
        KeReleaseSpinLock(&g_VacRing.Lock, irql);
        return;
    }

    ULONG take = min(Length, g_VacRing.Fill);
    ULONG first = min(take, (ULONG)VAC_RING_BYTES - g_VacRing.Head);
    RtlCopyMemory(Destination, g_VacRing.Data + g_VacRing.Head, first);
    if (take > first)
    {
        RtlCopyMemory(Destination + first, g_VacRing.Data, take - first);
    }
    g_VacRing.Head = (g_VacRing.Head + take) % VAC_RING_BYTES;
    g_VacRing.Fill -= take;

    if (take < Length)
    {
        RtlZeroMemory(Destination + take, Length - take);
        g_VacRing.Primed = FALSE;
    }

    KeReleaseSpinLock(&g_VacRing.Lock, irql);
}
