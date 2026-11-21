"""Independent, bounded FortiPi public-wire example. No third-party imports."""

import argparse
import base64
from collections import OrderedDict
from dataclasses import dataclass, field
import hashlib
import http.client
import json
import math
import os
import re
import secrets
import socket
import ssl
import struct
import sys
import threading
import time
from urllib.parse import quote, urlencode, urlsplit


MAX_JSON = 1048576  # Public protocol 1.0 bootstrap ceiling, not account capacity.
MAX_SAFE = 9007199254740991
SCHEMA_BASE = "https://fortipi.dev/schemas/1.0.0/"


class WireError(Exception):
    """Only a bounded local code: never response text, URLs, tickets or tokens."""


def require(condition, code="invalid_wire"):
    if not condition:
        raise WireError(code)


def json_bytes(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8", "strict")
    except (ValueError, UnicodeError, RecursionError):
        raise WireError("invalid_json") from None


def parse_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    def constant(_value):
        raise WireError("invalid_json")

    def floating(value):
        number = float(value)
        require(math.isfinite(number), "invalid_json")
        return number

    try:
        return json.loads(data.decode("utf-8", "strict"),
                          object_pairs_hook=pairs, parse_constant=constant,
                          parse_float=floating)
    except (ValueError, UnicodeError, RecursionError):
        raise WireError("invalid_json") from None


def equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


class Schemas:
    """The keyword subset actually used by the discovered 1.0.0 public schemas.

    References resolve only in the already fetched registry, never the network.
    This is not a general-purpose JSON Schema implementation.
    """

    def __init__(self, documents):
        self.documents = documents
        self.definitions = {}
        for document in documents.values():
            for name, definition in document.get("$defs", {}).items():
                require(name not in self.definitions, "duplicate_schema")
                self.definitions[name] = (definition, document["$id"])

    def check(self, name, value):
        require(name in self.definitions, "missing_schema")
        rule, document = self.definitions[name]
        try:
            self.validate(rule, value, document)
        except (TypeError, ValueError, KeyError, RecursionError, re.error):
            raise WireError("invalid_wire") from None
        return value

    def matches(self, rule, value, document, depth):
        try:
            self.validate(rule, value, document, depth)
            return True
        except WireError:
            return False

    def validate(self, rule, value, document, depth=0):
        require(depth <= 128, "json_depth_limit")
        if isinstance(rule, bool):
            require(rule)
            return
        supported = {"$defs", "$id", "$ref", "$schema", "title", "description",
                     "type", "const", "enum", "oneOf", "anyOf", "not",
                     "properties", "required", "additionalProperties", "items",
                     "dependentSchemas", "maxProperties", "minItems", "maxItems",
                     "uniqueItems", "minLength", "maxLength", "pattern", "minimum",
                     "maximum", "exclusiveMaximum"}
        require(set(rule) <= supported, "unsupported_schema_keyword")
        if "$ref" in rule:
            reference = rule["$ref"]
            source, fragment = reference.split("#", 1)
            source = source or document
            require(source in self.documents and fragment.startswith("/"))
            target = self.documents[source]
            for part in fragment[1:].split("/"):
                target = target[part.replace("~1", "/").replace("~0", "~")]
            self.validate(target, value, source, depth + 1)
        if "const" in rule:
            require(equal(value, rule["const"]))
        if "enum" in rule:
            require(any(equal(value, item) for item in rule["enum"]))
        for kind in ("oneOf", "anyOf"):
            if kind in rule:
                matches = sum(self.matches(r, value, document, depth + 1)
                              for r in rule[kind])
                require(matches == 1 if kind == "oneOf" else matches > 0)
        if "not" in rule:
            require(not self.matches(rule["not"], value, document, depth + 1))
        types = {"object": isinstance(value, dict),
                 "array": isinstance(value, list),
                 "string": isinstance(value, str),
                 "boolean": type(value) is bool, "null": value is None,
                 "integer": type(value) is int,
                 "number": type(value) is int or
                 (type(value) is float and math.isfinite(value))}
        if "type" in rule:
            require(types.get(rule["type"], False))
        if isinstance(value, dict):
            require(set(rule.get("required", [])) <= value.keys())
            require(len(value) <= rule.get("maxProperties", MAX_SAFE))
            properties = rule.get("properties", {})
            for key, item in value.items():
                key.encode("utf-8", "strict")
                if key in properties:
                    self.validate(properties[key], item, document, depth + 1)
                elif "additionalProperties" in rule:
                    self.validate(rule["additionalProperties"], item,
                                  document, depth + 1)
            for key, dependency in rule.get("dependentSchemas", {}).items():
                if key in value:
                    self.validate(dependency, value, document, depth + 1)
        elif isinstance(value, list):
            require(rule.get("minItems", 0) <= len(value) <=
                    rule.get("maxItems", MAX_SAFE))
            if rule.get("uniqueItems"):
                encoded = [json.dumps(v, sort_keys=True) for v in value]
                require(len(set(encoded)) == len(encoded))
            for item in value:
                self.validate(rule.get("items", True), item, document, depth + 1)
        elif isinstance(value, str):
            value.encode("utf-8", "strict")
            require(rule.get("minLength", 0) <= len(value) <=
                    rule.get("maxLength", MAX_SAFE))
            if "pattern" in rule:
                require(re.search(rule["pattern"], value) is not None)
        elif type(value) in (int, float):
            require(type(value) is int or math.isfinite(value))
            require(rule.get("minimum", -math.inf) <= value <=
                    rule.get("maximum", math.inf))
            require(value < rule.get("exclusiveMaximum", math.inf))


class Client:
    def __init__(self, endpoint, token, *, allow_loopback_http=False, timeout=30):
        require(isinstance(endpoint, str) and
                all(ord(c) > 32 and ord(c) != 127 for c in endpoint), "invalid_endpoint")
        try:
            url = urlsplit(endpoint)
            port = url.port
        except ValueError:
            raise WireError("invalid_endpoint") from None
        require(url.scheme in ("https", "http") and url.hostname and
                not url.username and not url.password and not url.query and
                not url.fragment and url.path in ("", "/"), "invalid_endpoint")
        require(url.scheme == "https" or
                (allow_loopback_http and url.hostname in
                 ("localhost", "127.0.0.1", "::1")), "tls_required")
        require(isinstance(token, str) and 0 < len(token) <= 16384 and
                all(33 <= ord(c) <= 126 for c in token), "invalid_credential")
        require(0 < timeout <= 120, "invalid_timeout")
        self.origin = endpoint.rstrip("/")
        self.host, self.port = url.hostname, port or (443 if url.scheme == "https" else 80)
        self.tls, self.timeout, self._token = url.scheme == "https", timeout, token
        self.cancelled = threading.Event()
        self._connection = None
        self._network = None
        self.protocol = self.openapi = self.schemas = None

    def cancel(self):
        self.cancelled.set()
        if self._network:
            self._shutdown(self._network)
        if self._connection:
            self._connection.close()

    @staticmethod
    def _shutdown(network):
        try:
            network.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        network.close()

    def _check(self):
        require(not self.cancelled.is_set(), "cancelled")

    def _json(self, method, path, *, body=None, auth=True, status=200):
        self._check()
        require(path.startswith("/v1/") and not path.startswith("//") and
                "\r" not in path and "\n" not in path, "unsafe_reference")
        maximum = self.protocol["limits"]["jsonBytes"] if self.protocol else MAX_JSON
        payload = None if body is None else json_bytes(body)
        require(payload is None or len(payload) <= maximum, "payload_too_large")
        connection = (http.client.HTTPSConnection(
            self.host, self.port, timeout=self.timeout,
            context=ssl.create_default_context()) if self.tls else
            http.client.HTTPConnection(self.host, self.port, timeout=self.timeout))
        self._connection = connection
        headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
        if auth:
            headers["Authorization"] = "Bearer " + self._token
        if payload is not None:
            headers["Content-Type"] = "application/json"
        timer = None
        expired = threading.Event()
        started = time.monotonic()
        try:
            connection.connect()
            self._network = connection.sock
            network = connection.sock
            remaining = self.timeout - (time.monotonic() - started)
            require(remaining > 0, "timeout")
            def expire():
                expired.set()
                self._shutdown(network)
            timer = threading.Timer(remaining, expire)
            timer.daemon = True
            timer.start()
            connection.request(method, path, payload, headers)
            response = connection.getresponse()
            require(not 300 <= response.status < 400, "redirect_rejected")
            require(response.getheader("Content-Encoding", "identity") == "identity",
                    "unsupported_content_encoding")
            length = response.getheader("Content-Length")
            if length is not None:
                require(length.isascii() and length.isdigit() and
                        int(length) <= maximum, "payload_too_large")
            chunks, total = [], 0
            while True:
                self._check()
                chunk = response.read(min(65536, maximum + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                require(total <= maximum, "payload_too_large")
            self._check()
            require(length is None or total == int(length), "truncated_transport")
            require(not expired.is_set(), "timeout")
            value = parse_json(b"".join(chunks))
            if response.status != status:
                if self.schemas:
                    self.schemas.check("ErrorBody", value)
                raise WireError("http_" + str(response.status))
            return value
        except (OSError, http.client.HTTPException):
            raise WireError("cancelled" if self.cancelled.is_set() else "timeout"
                            if expired.is_set() else "transport_failed_or_uncertain") from None
        finally:
            if timer:
                timer.cancel()
            connection.close()
            self._connection = None
            self._network = None

    def discover(self):
        self.protocol = self.openapi = self.schemas = None
        try:
            return self._discover()
        except BaseException:
            self.protocol = self.openapi = self.schemas = None
            raise

    def _discover(self):
        protocol = self._json("GET", "/v1/protocol", auth=False)
        require(isinstance(protocol, dict) and protocol.get("protocolVersion") == "1.0" and
                protocol.get("schemaVersion") == "1.0.0" and
                "1.0" in protocol.get("supportedVersions", []), "incompatible_protocol")
        limits = protocol.get("limits", {})
        for key, ceiling in (("jsonBytes", MAX_JSON), ("socketBufferBytes", MAX_JSON),
                             ("socketBufferFrames", 256), ("replayPage", 100),
                             ("outputFrameBytes", 16384)):
            require(type(limits.get(key)) is int and 0 < limits[key] <= ceiling)
        self.protocol = protocol
        documents = {}
        references = protocol.get("schemas", [])
        require(isinstance(references, list) and 0 < len(references) <= 15)
        for reference in references:
            path = reference.get("url", "")
            require(re.fullmatch(r"/v1/schemas/[a-z-]+\.schema\.json", path),
                    "unsafe_schema_reference")
            document = self._json("GET", path, auth=False)
            identity = SCHEMA_BASE + path.rsplit("/", 1)[1]
            require(document.get("$id") == identity and identity not in documents)
            documents[identity] = document
        self.schemas = Schemas(documents)
        self.schemas.check("Protocol", protocol)
        self.openapi = self._json("GET", "/v1/openapi.json", auth=False)
        require(self.openapi.get("openapi") == "3.1.0" and
                self.openapi.get("info", {}).get("version") == "1.0.0")
        return protocol

    def request(self, operation, *, path=None, query=None, body=None):
        if self.schemas is None:
            self.discover()
        matches = [(p, m.upper(), r) for p, methods in self.openapi["paths"].items()
                   for m, r in methods.items() if isinstance(r, dict) and
                   r.get("operationId") == operation]
        require(len(matches) == 1, "missing_public_operation")
        route, method, definition = matches[0]
        require(definition.get("x-audience") in ("public", "application", "admin"),
                "unsupported_operation")
        parameters = path or {}
        require(set(parameters) == set(re.findall(r"\{(\w+)\}", route)), "invalid_path")
        for key in re.findall(r"\{(\w+)\}", route):
            self.schemas.check("Id", parameters.get(key))
            route = route.replace("{" + key + "}", quote(parameters[key], safe=""))
        allowed = {p["name"]: p for p in definition.get("parameters", [])
                   if p["in"] == "query"}
        require(set(query or {}) <= allowed.keys(), "invalid_query")
        for key, parameter in allowed.items():
            require(not parameter.get("required") or key in (query or {}), "invalid_query")
            if key in (query or {}):
                self.schemas.validate(parameter["schema"], query[key], SCHEMA_BASE + "common.schema.json")
        if body is not None:
            reference = definition["requestBody"]["content"]["application/json"]["schema"]
            self.schemas.validate(reference, body, SCHEMA_BASE + "common.schema.json")
        responses = definition["responses"]
        success = [int(s) for s in responses if s.isdigit() and 200 <= int(s) < 300]
        require(len(success) == 1)
        target = route + ("?" + urlencode(query) if query else "")
        value = self._json(method, target, body=body,
                           auth=definition["x-audience"] != "public", status=success[0])
        reference = responses[str(success[0])]["content"]["application/json"]["schema"]
        self.schemas.validate(reference, value, SCHEMA_BASE + "common.schema.json")
        return value

    def agents(self, **query):
        return self.request("listAgents", query=query)

    def create_agent(self, request_id, name, model):
        return self.request("createAgent", body={"requestId": request_id, "name": name,
                                                  "model": model})

    def conversations(self, agent_id, **query):
        return self.request("listConversations", path={"agentId": agent_id}, query=query)

    def create(self, agent_id, request_id, title=None):
        body = {"requestId": request_id}
        if title is not None:
            body["title"] = title
        return self.request("createConversation", path={"agentId": agent_id},
                            body=body)

    def snapshot(self, conversation_id):
        return self.request("getConversation", path={"id": conversation_id})

    def send(self, conversation_id, client_request_id, content, *,
             busy_behavior="followUp", expected_revision=None):
        body = {"clientRequestId": client_request_id, "content": content,
                "busyBehavior": busy_behavior}
        if expected_revision is not None:
            body["expectedConversationRevision"] = expected_revision
        return self.request("submitMessage", path={"id": conversation_id}, body=body)

    def replay(self, conversation_id, after, *, through=None):
        if self.protocol is None:
            self.discover()
        query = {"after": after, "limit": self.protocol["limits"]["replayPage"]}
        if through is not None:
            query["through"] = through
        self.schemas.check("ReplayQuery", query)
        return self.request("replayEvents", path={"id": conversation_id}, query=query)


class WebSocket:
    """RFC6455 without extensions. One synchronous reader; masked client frames."""

    def __init__(self, client, ticket):
        self.client = client
        self.socket = None
        self.pending = b""
        self.closed = False
        self.close_sent = False
        limits = client.protocol["limits"]
        self.maximum = min(limits["jsonBytes"], limits["socketBufferBytes"])
        self.fragment_limit = limits["socketBufferFrames"]
        try:
            raw = socket.create_connection((client.host, client.port), client.timeout)
            self.socket = raw
            if client.tls:
                self.socket = ssl.create_default_context().wrap_socket(
                    raw, server_hostname=client.host)
            self.socket.settimeout(client.timeout)
            key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
            hostname = "[" + client.host + "]" if ":" in client.host else client.host
            host = hostname + ":" + str(client.port)
            # Native ticket redemption carries neither bearer Authorization nor Origin.
            request = ("GET /v1/stream?" + urlencode({"ticket": ticket}) +
                       " HTTP/1.1\r\nHost: " + host +
                       "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n\r\n")
            self.socket.sendall(request.encode("ascii"))
            header = bytearray()
            deadline = time.monotonic() + client.timeout
            end = -1
            while end < 0:
                client._check()
                self.socket.settimeout(max(0.001, deadline - time.monotonic()))
                chunk = self.socket.recv(4096)
                require(chunk, "truncated_handshake")
                old = len(header)
                header.extend(chunk)
                end = header.find(b"\r\n\r\n", max(0, old - 3))
                require((end + 4 if end >= 0 else len(header)) <= 16384,
                        "handshake_too_large")
            self.pending = bytes(header[end + 4:])
            lines = bytes(header[:end]).decode("ascii", "strict").split("\r\n")
            require(lines[0].startswith("HTTP/1.1 101 "), "upgrade_rejected")
            headers = {}
            for line in lines[1:]:
                name, separator, value = line.partition(":")
                require(separator and name.lower() not in headers, "invalid_handshake")
                headers[name.lower()] = value.strip()
            expected = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
            ).digest()).decode("ascii")
            require(headers.get("sec-websocket-accept") == expected, "invalid_accept")
            require(headers.get("upgrade", "").lower() == "websocket" and
                    "upgrade" in [v.strip().lower() for v in
                                  headers.get("connection", "").split(",")],
                    "invalid_handshake")
            require("sec-websocket-extensions" not in headers and
                    "sec-websocket-protocol" not in headers, "unexpected_extension")
        except (OSError, UnicodeError, WireError):
            self.close(send=False)
            raise WireError("handshake_failed") from None

    def close(self, *, send=True):
        if self.closed:
            return
        if self.socket:
            try:
                if send and not self.close_sent:
                    self.close_sent = True
                    self._send(8, struct.pack("!H", 1000))
                    deadline = time.monotonic() + min(self.client.timeout, 1)
                    for _ in range(self.fragment_limit):
                        if self.receive(deadline=deadline) is None:
                            break
            except (OSError, WireError):
                pass
            finally:
                self.closed = True
                self.socket.close()

    def _send(self, opcode, data):
        self.client._check()
        maximum = 125 if opcode >= 8 else self.maximum
        require(len(data) <= maximum, "frame_too_large")
        mask = secrets.token_bytes(4)
        length = len(data)
        extension = b""
        if length < 126:
            encoded = length
        elif length < 65536:
            encoded, extension = 126, struct.pack("!H", length)
        else:
            encoded, extension = 127, struct.pack("!Q", length)
        masked = bytes(value ^ mask[i % 4] for i, value in enumerate(data))
        self.socket.settimeout(self.client.timeout)
        self.socket.sendall(bytes((0x80 | opcode, 0x80 | encoded)) + extension + mask + masked)

    def send(self, message):
        self._send(1, json_bytes(message))

    def _read(self, length, deadline, *, eof=False):
        chunks, total = [], 0
        if self.pending:
            chunk, self.pending = self.pending[:length], self.pending[length:]
            chunks.append(chunk)
            total = len(chunk)
        while total < length:
            self.client._check()
            remaining = deadline - time.monotonic()
            require(remaining > 0, "timeout")
            self.socket.settimeout(min(remaining, 0.25))
            try:
                chunk = self.socket.recv(length - total)
            except socket.timeout:
                continue
            if not chunk:
                if eof and not total:
                    return None
                raise WireError("truncated_transport")
            chunks.append(chunk)
            total += len(chunk)
        return b"".join(chunks)

    def receive(self, *, deadline=None):
        deadline = deadline or time.monotonic() + self.client.timeout
        fragments, total, active = [], 0, False
        while True:
            header = self._read(2, deadline, eof=True)
            if header is None:
                require(not active, "truncated_transport")
                self.close(send=False)
                return None  # EOF never stands in for a committed completion.
            first, second = header
            final, opcode = bool(first & 128), first & 15
            require(not first & 112 and not second & 128, "invalid_frame")
            require(opcode in (0, 1, 2, 8, 9, 10), "invalid_opcode")
            length = second & 127
            if opcode >= 8:
                require(final and length <= 125, "invalid_control_frame")
            elif length == 126:
                length = struct.unpack("!H", self._read(2, deadline))[0]
                require(length >= 126, "nonminimal_length")
            elif length == 127:
                length = struct.unpack("!Q", self._read(8, deadline))[0]
                require(65536 <= length < 2 ** 63, "nonminimal_length")
            require(length <= (125 if opcode >= 8 else self.maximum), "frame_too_large")
            data = self._read(length, deadline)
            if opcode == 9:
                self._send(10, data)
                continue
            if opcode == 10:
                continue
            if opcode == 8:
                require(len(data) != 1, "invalid_close")
                if data:
                    code = struct.unpack("!H", data[:2])[0]
                    require(code in (1000, 1001, 1002, 1003, 1007, 1008, 1009,
                                     1010, 1011, 1012, 1013, 1014) or
                            3000 <= code < 5000, "invalid_close")
                    try:
                        data[2:].decode("utf-8", "strict")
                    except UnicodeError:
                        raise WireError("invalid_utf8") from None
                if not self.close_sent:
                    self.close_sent = True
                    self._send(8, data)
                self.close(send=False)
                return None
            require((opcode == 0) == active, "invalid_fragment_sequence")
            active = not final
            total += length
            require(total <= self.maximum and len(fragments) < self.fragment_limit,
                    "message_too_large")
            fragments.append(data)
            if final:
                encoded = b"".join(fragments)
                message = parse_json(encoded)
                return message, len(encoded)


@dataclass(repr=False)
class Checkpoint:
    """Retain with the consumer's already-applied projection; contains no bearer."""
    scope: dict
    cursor: int
    seen: OrderedDict = field(default_factory=OrderedDict)


class Subscription:
    def __init__(self, client, agent_id, conversation_id, *, on_snapshot,
                 on_event, checkpoint=None):
        self.client, self.on_event = client, on_event
        self.agent_id, self.conversation_id = agent_id, conversation_id
        self.wire = None
        self.replayed = 0
        if client.schemas is None:
            client.discover()
        client.schemas.check("Id", agent_id)
        client.schemas.check("Id", conversation_id)
        resources = {key: [] for key in ("agentIds", "conversationIds", "workspaceIds",
                                         "actions", "tools", "executorIds", "backendIds")}
        resources.update(agentIds=[agent_id], conversationIds=[conversation_id],
                         actions=["events.read"])
        ticket = client.request("mintConnectionTicket", body={
            "requestId": secrets.token_hex(16), "audience": "client-stream",
            "resources": resources, "originMode": {"kind": "native"}})
        require(ticket["audience"] == "client-stream" and
                ticket["expiresAt"] > time.time() * 1000, "invalid_ticket")
        identity = ticket["identity"]
        require(identity["role"] == "client", "client_role_required")
        require(identity["deploymentId"] == client.protocol["deploymentId"], "scope_changed")
        require(identity["credentialExpiresAt"] is None or
                identity["credentialExpiresAt"] > time.time() * 1000, "credential_expired")
        scope = {"origin": client.origin, "agentId": agent_id,
                 "conversationId": conversation_id, "identity": identity}
        if checkpoint is None:
            snapshot = client.snapshot(conversation_id)
            require(snapshot["conversation"]["agentId"] == agent_id and
                    snapshot["conversation"]["conversationId"] == conversation_id and
                    snapshot["retainedFloor"] <= snapshot["lastEventSeq"])
            on_snapshot(snapshot)  # Application completes before checkpoint moves.
            self.checkpoint = Checkpoint(scope, snapshot["lastEventSeq"])
        else:
            require(isinstance(checkpoint, Checkpoint) and checkpoint.scope == scope,
                    "scope_changed")
            require(type(checkpoint.cursor) is int and 0 <= checkpoint.cursor <= MAX_SAFE)
            self.checkpoint = checkpoint
        self.catch_up()
        require(ticket["expiresAt"] > time.time() * 1000, "ticket_expired")
        request_id = secrets.token_hex(16)
        try:
            self.wire = WebSocket(client, ticket["ticket"])
            self.wire.send({"type": "conversation.subscribe", "requestId": request_id,
                            "input": {"operationId": "replayEvents",
                                      "path": {"id": conversation_id},
                                      "query": {"after": self.cursor,
                                                "limit": client.protocol["limits"]["replayPage"]}}})
            buffered, size = [], 0
            while True:
                received = self.wire.receive()
                require(received is not None, "subscription_not_acknowledged")
                frame, count = received
                self.validate_frame(frame, count)
                if frame.get("type") == "ack":
                    require(frame["requestId"] == request_id and
                            frame["operationId"] == "replayEvents", "unexpected_ack")
                    self.apply_page(frame["receipt"], self.cursor)
                    break
                require("durability" in frame, "unexpected_frame")
                size += count
                buffered.append(frame)
                require(size <= client.protocol["limits"]["socketBufferBytes"] and
                        len(buffered) <= client.protocol["limits"]["socketBufferFrames"],
                        "stream_overflow")
            for event in buffered:
                self.apply(event)
        except BaseException:
            self.close()
            raise

    @property
    def cursor(self):
        return self.checkpoint.cursor

    def close(self):
        if self.wire:
            self.wire.close()

    def validate_frame(self, frame, encoded_size):
        require(isinstance(frame, dict))
        if "durability" in frame:
            self.client.schemas.check("ClientEvent", frame)
            if frame["durability"] == "volatile" and frame["type"] in (
                    "message.delta", "tool.execution.output"):
                require(encoded_size <= self.client.protocol["limits"]["outputFrameBytes"],
                        "output_too_large")
            return
        name = {"ack": "ClientAck", "error": "ClientError",
                "resync_required": "ResyncRequired"}.get(frame.get("type"))
        require(name, "unknown_server_frame")
        self.client.schemas.check(name, frame)
        require(frame["type"] not in ("error", "resync_required"),
                "subscription_failed_or_resync_required")

    def apply(self, event):
        require(event["conversationId"] == self.conversation_id and
                event["deploymentId"] == self.checkpoint.scope["identity"]["deploymentId"],
                "scope_changed")
        if event["durability"] == "volatile":
            self.on_event(event)
            return
        seq = event["eventSeq"]
        identity = hashlib.sha256(json_bytes(event)).digest()
        if seq <= self.cursor:
            require(self.checkpoint.seen.get(seq) == identity, "duplicate_or_resync_required")
            return
        require(seq == self.cursor + 1, "cursor_gap")
        self.on_event(event)  # Failures leave the committed cursor unchanged.
        self.client._check()
        self.checkpoint.cursor = seq
        self.checkpoint.seen[seq] = identity
        if len(self.checkpoint.seen) > self.client.protocol["limits"]["socketBufferFrames"]:
            self.checkpoint.seen.popitem(last=False)

    def apply_page(self, page, after, through=None):
        require(page["after"] == after and page["retainedFloor"] <= after and
                after <= page["nextAfter"] <= page["through"] <= page["lastEventSeq"])
        require(through is None or page["through"] == through, "replay_high_water_changed")
        for event in page["events"]:
            self.apply(event)
            self.replayed += 1
        require(page["nextAfter"] == self.cursor and
                page["hasMore"] == (page["nextAfter"] < page["through"]), "invalid_replay")
        return page["through"]

    def catch_up(self, max_pages=64):
        through = None
        for _ in range(max_pages):
            after = self.cursor
            page = self.client.replay(self.conversation_id, after, through=through)
            through = self.apply_page(page, after, through)
            if not page["hasMore"]:
                return
            require(self.cursor > after, "invalid_replay")
        raise WireError("replay_page_limit")

    def next(self):
        received = self.wire.receive()
        if received is None:
            return None
        frame, size = received
        self.validate_frame(frame, size)
        require("durability" in frame, "unexpected_ack")
        self.apply(frame)
        return frame

    def wait_completion(self, task_id, max_events=256):
        self.client.schemas.check("Id", task_id)
        for _ in range(max_events):
            event = self.next()
            require(event is not None, "completion_not_observed")
            if event["durability"] == "durable" and event["type"] == "task.completed":
                if event["payload"]["taskId"] == task_id:
                    require(event["payload"]["conversationId"] == self.conversation_id and
                            event.get("taskId", task_id) == task_id, "scope_changed")
                    require(event["payload"]["status"]["state"] == "completed")
                    return event
        raise WireError("completion_event_limit")


def main():
    class Parser(argparse.ArgumentParser):
        def error(self, _message):
            raise WireError("invalid_cli")
    parser = Parser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--allow-loopback-http", action="store_true")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    client = Client(args.endpoint, os.environ.get("FORTIPI_CLIENT_TOKEN", ""),
                    allow_loopback_http=args.allow_loopback_http, timeout=args.timeout)
    subscription, checkpoint = None, None
    try:
        for _ in range(1000):
            line = sys.stdin.buffer.readline(MAX_JSON + 1)
            if not line:
                return
            require(len(line) <= MAX_JSON and line.endswith(b"\n"), "command_too_large")
            command = parse_json(line)
            operation = command.get("op")
            result = {}
            if operation == "discover":
                protocol = client.discover()
                result = {"protocolVersion": protocol["protocolVersion"],
                          "schemaVersion": protocol["schemaVersion"],
                          "schemas": len(client.schemas.documents)}
            elif operation == "agents":
                page = client.agents(**command.get("query", {}))
                result = {"agentIds": [a["agentId"] for a in page["items"]],
                          "nextPageToken": page.get("nextPageToken")}
            elif operation == "create-agent":
                agent = client.create_agent(command["requestId"], command["name"], command["model"])
                result = {"agentId": agent["agentId"]}
            elif operation == "conversations":
                page = client.conversations(command["agentId"], **command.get("query", {}))
                result = {"conversationIds": [c["conversationId"] for c in page["items"]],
                          "nextPageToken": page.get("nextPageToken")}
            elif operation == "create":
                value = client.create(command["agentId"], command["requestId"], command.get("title"))
                result = {"conversationId": value["conversationId"], "agentId": value["agentId"]}
            elif operation == "snapshot":
                value = client.snapshot(command["conversationId"])
                result = {"conversationId": value["conversation"]["conversationId"],
                          "lastEventSeq": value["lastEventSeq"], "messages": len(value["messages"])}
            elif operation == "send":
                result = client.send(command["conversationId"], command["clientRequestId"],
                                     command["content"], expected_revision=command.get("expectedRevision"))
            elif operation == "subscribe":
                require(subscription is None, "disconnect_first")
                subscription = Subscription(client, command["agentId"], command["conversationId"],
                                            on_snapshot=lambda _snapshot: None,
                                            on_event=lambda _event: None,
                                            checkpoint=checkpoint if command.get("resume") else None)
                result = {"cursor": subscription.cursor, "replayed": subscription.replayed}
            elif operation in ("next", "completion"):
                require(subscription is not None, "subscribe_first")
                value = (subscription.next() if operation == "next" else
                         subscription.wait_completion(command["taskId"]))
                result = {"cursor": subscription.cursor, "closed": value is None}
                if value:
                    result.update(eventType=value["type"], durability=value["durability"])
            elif operation == "replay":
                require(checkpoint is not None and subscription is None, "disconnect_first")
                page = client.replay(checkpoint.scope["conversationId"], checkpoint.cursor)
                result = {"after": page["after"], "nextAfter": page["nextAfter"],
                          "events": len(page["events"]), "applied": False,
                          "cursor": checkpoint.cursor}
            elif operation == "disconnect":
                require(subscription is not None, "subscribe_first")
                checkpoint = subscription.checkpoint
                subscription.close()
                subscription = None
                result = {"cursor": checkpoint.cursor}
            elif operation == "close":
                return
            else:
                raise WireError("unknown_command")
            sys.stdout.write(json_bytes({"ok": True, **result}).decode("utf-8") + "\n")
            sys.stdout.flush()
        raise WireError("command_limit")
    finally:
        if subscription:
            subscription.close()
        client.cancel()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print('{"ok":false,"error":"cancelled"}', flush=True)
        sys.exit(130)
    except Exception as error:
        code = str(error) if isinstance(error, WireError) else "client_failed"
        print(json_bytes({"ok": False, "error": code}).decode("utf-8"), flush=True)
        sys.exit(1)
