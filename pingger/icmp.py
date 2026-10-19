"""Probes ICMP via iphlpapi do Windows (IcmpSendEcho / Icmp6SendEcho2).

Não exige privilégios de administrador. Cada chamada envia um eco com TTL
definido e devolve (endereço_respondente, rtt_ms, status).
"""
import ctypes
import ctypes.wintypes as wt
import ipaddress
import socket
import time

iphlpapi = ctypes.WinDLL("iphlpapi", use_last_error=True)

IP_SUCCESS = 0
IP_DEST_NET_UNREACHABLE = 11002
IP_DEST_HOST_UNREACHABLE = 11003
IP_DEST_PORT_UNREACHABLE = 11005
IP_REQ_TIMED_OUT = 11010
IP_TTL_EXPIRED_TRANSIT = 11013
IP_TTL_EXPIRED_REASSEM = 11014

# Status que significam "um roteador respondeu" (hop intermediário).
TRANSIT = {IP_TTL_EXPIRED_TRANSIT, IP_TTL_EXPIRED_REASSEM}
UNREACHABLE = {IP_DEST_NET_UNREACHABLE, IP_DEST_HOST_UNREACHABLE, IP_DEST_PORT_UNREACHABLE}


class IP_OPTION_INFORMATION(ctypes.Structure):
    _fields_ = [("Ttl", ctypes.c_ubyte), ("Tos", ctypes.c_ubyte), ("Flags", ctypes.c_ubyte),
                ("OptionsSize", ctypes.c_ubyte), ("OptionsData", ctypes.c_void_p)]


class ICMP_ECHO_REPLY(ctypes.Structure):
    _fields_ = [("Address", ctypes.c_uint32), ("Status", ctypes.c_ulong), ("RoundTripTime", ctypes.c_ulong),
                ("DataSize", ctypes.c_ushort), ("Reserved", ctypes.c_ushort), ("Data", ctypes.c_void_p),
                ("Options", IP_OPTION_INFORMATION)]


class SOCKADDR_IN6(ctypes.Structure):
    _fields_ = [("sin6_family", ctypes.c_short), ("sin6_port", ctypes.c_ushort), ("sin6_flowinfo", ctypes.c_ulong),
                ("sin6_addr", ctypes.c_ubyte * 16), ("sin6_scope_id", ctypes.c_ulong)]


class IPV6_ADDRESS_EX(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("sin6_port", ctypes.c_ushort), ("sin6_flowinfo", ctypes.c_ulong),
                ("sin6_addr", ctypes.c_ushort * 8), ("sin6_scope_id", ctypes.c_ulong)]


class ICMPV6_ECHO_REPLY(ctypes.Structure):
    _fields_ = [("Address", IPV6_ADDRESS_EX), ("Status", ctypes.c_ulong), ("RoundTripTime", ctypes.c_uint)]


iphlpapi.IcmpCreateFile.restype = wt.HANDLE
iphlpapi.Icmp6CreateFile.restype = wt.HANDLE
iphlpapi.IcmpCloseHandle.argtypes = [wt.HANDLE]
iphlpapi.IcmpSendEcho.argtypes = [wt.HANDLE, ctypes.c_uint32, ctypes.c_void_p, wt.WORD,
                                  ctypes.POINTER(IP_OPTION_INFORMATION), ctypes.c_void_p, wt.DWORD, wt.DWORD]
iphlpapi.IcmpSendEcho.restype = wt.DWORD
iphlpapi.Icmp6SendEcho2.argtypes = [wt.HANDLE, wt.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                    ctypes.POINTER(SOCKADDR_IN6), ctypes.POINTER(SOCKADDR_IN6),
                                    ctypes.c_void_p, wt.WORD, ctypes.POINTER(IP_OPTION_INFORMATION),
                                    ctypes.c_void_p, wt.DWORD, wt.DWORD]
iphlpapi.Icmp6SendEcho2.restype = wt.DWORD
iphlpapi.Icmp6ParseReplies.argtypes = [ctypes.c_void_p, wt.DWORD]
iphlpapi.Icmp6ParseReplies.restype = wt.DWORD


def _payload(size):
    size = max(0, min(int(size), 65000))
    pattern = b"PinggerProbe-abcdefghijklmnopqrstuvwxyz0123456789"
    return (pattern * (size // len(pattern) + 1))[:size]


def _measure(rtt_reported, t0):
    # A API devolve ms inteiros; o relógio local dá precisão sub-ms.
    measured = (time.perf_counter() - t0) * 1000.0
    lo = float(rtt_reported)
    return round(min(max(measured, lo), lo + 0.999), 3)


def ping4(dest, ttl, timeout_ms=3000, size=56, tos=0, dont_fragment=False):
    data = _payload(size)
    buf_size = ctypes.sizeof(ICMP_ECHO_REPLY) + len(data) + 8 + 64
    reply = ctypes.create_string_buffer(buf_size)
    opts = IP_OPTION_INFORMATION(Ttl=max(1, min(255, ttl)), Tos=tos, Flags=0x02 if dont_fragment else 0)
    dest_int = int.from_bytes(socket.inet_aton(dest), "little")
    h = iphlpapi.IcmpCreateFile()
    try:
        t0 = time.perf_counter()
        n = iphlpapi.IcmpSendEcho(h, dest_int, data, len(data), ctypes.byref(opts), reply, buf_size, timeout_ms)
        if n == 0:
            err = ctypes.get_last_error()
            return None, None, err or IP_REQ_TIMED_OUT
        r = ICMP_ECHO_REPLY.from_buffer(reply)
        addr = socket.inet_ntoa(int(r.Address).to_bytes(4, "little"))
        return addr, _measure(r.RoundTripTime, t0), int(r.Status)
    finally:
        iphlpapi.IcmpCloseHandle(h)


def ping6(dest, ttl, timeout_ms=3000, size=56, tos=0, dont_fragment=False):
    data = _payload(size)
    buf_size = ctypes.sizeof(ICMPV6_ECHO_REPLY) + len(data) + 8 + 64
    reply = ctypes.create_string_buffer(buf_size)
    opts = IP_OPTION_INFORMATION(Ttl=max(1, min(255, ttl)), Tos=tos, Flags=0x02 if dont_fragment else 0)
    src = SOCKADDR_IN6(sin6_family=socket.AF_INET6)
    dst = SOCKADDR_IN6(sin6_family=socket.AF_INET6)
    dst.sin6_addr[:] = list(ipaddress.IPv6Address(dest.split("%")[0]).packed)
    h = iphlpapi.Icmp6CreateFile()
    try:
        t0 = time.perf_counter()
        n = iphlpapi.Icmp6SendEcho2(h, None, None, None, ctypes.byref(src), ctypes.byref(dst), data, len(data),
                                    ctypes.byref(opts), reply, buf_size, timeout_ms)
        if n == 0:
            err = ctypes.get_last_error()
            return None, None, err or IP_REQ_TIMED_OUT
        r = ICMPV6_ECHO_REPLY.from_buffer(reply)
        raw = bytes(bytearray(ctypes.string_at(ctypes.addressof(r.Address.sin6_addr), 16)))
        addr = str(ipaddress.IPv6Address(raw))
        return addr, _measure(r.RoundTripTime, t0), int(r.Status)
    finally:
        iphlpapi.IcmpCloseHandle(h)


def ping(dest, ttl, timeout_ms=3000, size=56, tos=0, dont_fragment=False):
    if ":" in dest:
        return ping6(dest, ttl, timeout_ms, size, tos, dont_fragment)
    return ping4(dest, ttl, timeout_ms, size, tos, dont_fragment)


def tcp_ping(dest, port, timeout_ms=3000):
    """Latência de handshake TCP até o destino (apenas último hop)."""
    fam = socket.AF_INET6 if ":" in dest else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_STREAM)
    s.settimeout(timeout_ms / 1000.0)
    t0 = time.perf_counter()
    try:
        s.connect((dest, int(port)))
        return dest, round((time.perf_counter() - t0) * 1000.0, 3), IP_SUCCESS
    except ConnectionRefusedError:
        # RST também prova que o host respondeu.
        return dest, round((time.perf_counter() - t0) * 1000.0, 3), IP_SUCCESS
    except OSError:
        return None, None, IP_REQ_TIMED_OUT
    finally:
        s.close()


def udp_ping(dest, port, timeout_ms=3000, size=56):
    """Probe UDP: resposta (eco/porta fechada via ICMP->ConnectionReset) conta como sucesso."""
    fam = socket.AF_INET6 if ":" in dest else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_DGRAM)
    s.settimeout(timeout_ms / 1000.0)
    t0 = time.perf_counter()
    try:
        s.connect((dest, int(port)))
        s.send(_payload(size))
        s.recv(65535)
        return dest, round((time.perf_counter() - t0) * 1000.0, 3), IP_SUCCESS
    except ConnectionResetError:
        return dest, round((time.perf_counter() - t0) * 1000.0, 3), IP_SUCCESS
    except OSError:
        return None, None, IP_REQ_TIMED_OUT
    finally:
        s.close()
