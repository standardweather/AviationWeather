"""Connect to an FAA SWIM Cloud Distribution Service (SCDS) queue and drain messages.

Shared by the one-off capture script (itws_capture.py) and the scheduled collector.
Connection details come from environment variables, which in GitHub Actions are
repository secrets — they are never written to the repo or the published site:

    SCDS_HOST      e.g. tcps://ems2.swim.faa.gov:55443   (from your SCDS subscription)
    SCDS_VPN       message VPN name
    SCDS_USERNAME
    SCDS_PASSWORD
    SCDS_QUEUE     queue name
"""

import gzip
import os
import tempfile
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path

FIELDS = ["SCDS_HOST", "SCDS_VPN", "SCDS_USERNAME", "SCDS_PASSWORD", "SCDS_QUEUE"]


@dataclass
class Message:
    payload: bytes
    properties: dict = field(default_factory=dict)
    destination: str = ""
    received: float = 0.0

    def text(self):
        return self.payload.decode("utf-8", "replace")


def _trust_store_dir():
    """Solace wants a directory of CA certificates; build one from a PEM bundle."""
    candidates = []
    try:
        import certifi
        candidates.append(certifi.where())
    except ImportError:
        pass
    candidates += ["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem", "/etc/pki/tls/certs/ca-bundle.crt"]
    bundle = next((c for c in candidates if os.path.exists(c)), None)
    if not bundle:
        return None
    out = Path(tempfile.mkdtemp(prefix="scds-ca-"))
    pem = Path(bundle).read_text()
    for i, block in enumerate(pem.split("-----END CERTIFICATE-----")):
        if "-----BEGIN CERTIFICATE-----" in block:
            (out / f"ca{i:04d}.pem").write_text(block.strip() + "\n-----END CERTIFICATE-----\n")
    return str(out)


def _unpack(data):
    """Some SWIM feeds gzip or zlib-compress payloads."""
    if data[:2] == b"\x1f\x8b":
        return gzip.decompress(data)
    if data[:1] == b"\x78":
        try:
            return zlib.decompress(data)
        except zlib.error:
            pass
    return data


def drain(config, seconds=60, max_messages=5000, insecure=False, on_message=None):
    """Receive and acknowledge messages for up to `seconds`; returns a list of Message."""
    from solace.messaging.config.solace_properties import authentication_properties as A
    from solace.messaging.config.solace_properties import service_properties as S
    from solace.messaging.config.solace_properties import transport_layer_properties as T
    from solace.messaging.config.transport_security_strategy import TLS
    from solace.messaging.messaging_service import MessagingService
    from solace.messaging.resources.queue import Queue

    props = {
        T.HOST: config["SCDS_HOST"],
        S.VPN_NAME: config["SCDS_VPN"],
        A.SCHEME_BASIC_USER_NAME: config["SCDS_USERNAME"],
        A.SCHEME_BASIC_PASSWORD: config["SCDS_PASSWORD"],
    }
    if insecure:
        tls = TLS.create().without_certificate_validation()
    else:
        tls = TLS.create().with_certificate_validation(ignore_expiration=False, validate_server_name=True, trust_store_file_path=_trust_store_dir())

    service = MessagingService.builder().from_properties(props).with_transport_security_strategy(tls).build()
    service.connect()
    receiver = None
    out = []
    try:
        queue = Queue.durable_exclusive_queue(config["SCDS_QUEUE"])
        receiver = service.create_persistent_message_receiver_builder().with_message_auto_acknowledgement().build(queue)
        receiver.start()
        deadline = time.time() + seconds
        while time.time() < deadline and len(out) < max_messages:
            msg = receiver.receive_message(timeout=1000)
            if msg is None:
                continue
            raw = msg.get_payload_as_bytes()
            if raw is None:
                s = msg.get_payload_as_string()
                raw = s.encode("utf-8") if s else b""
            m = Message(payload=_unpack(raw), properties=dict(msg.get_properties() or {}),
                        destination=str(msg.get_destination_name() or ""), received=time.time())
            out.append(m)
            if on_message:
                on_message(m)
    finally:
        if receiver:
            receiver.terminate()
        service.disconnect()
    return out
