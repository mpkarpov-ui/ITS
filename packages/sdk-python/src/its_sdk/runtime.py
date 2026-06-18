"""ITS plugin SDK runtime: decorator implementations and the asyncio NATS loop.

Plugin authors use the decorators re-exported from __init__.py; this module
implements them and the run loop that wires them to NATS at startup.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import sys
from typing import Any, Callable, TypeVar

import nats
from nats.js.api import StorageType

# Attribute markers stashed by the decorators. Plain setattr, no wrapping, so
# stack traces stay clean and multiple decorators compose without clobbering
# each other's metadata.
_SOURCE_ID = "__its_source_id__"
_PUBLISH_STREAM = "__its_publish_stream__"
_PUBLISH_PATH = "__its_publish_path__"
_EVERY_SECONDS = "__its_every_seconds__"
_SUBSCRIBE_SUBJECT = "__its_subscribe_subject__"
_COMMAND_VERB = "__its_command_verb__"

_PLACEHOLDER_RE = re.compile(r"\{([a-z_][a-z0-9_]*)\}")

# Cross-process uniqueness for instance_key is enforced via a JetStream KV
# bucket. Each plugin claims `<source_id>.<instance_key>` on startup; the
# bucket TTL means crashed plugins free their slot automatically.
_LOCK_BUCKET = "its-locks"
_LOCK_TTL_SECONDS = 30
_LOCK_REFRESH_SECONDS = 10

_C = TypeVar("_C", bound=type)
_F = TypeVar("_F", bound=Callable[..., Any])


def source(*, id: str) -> Callable[[_C], _C]:
    """Mark a class as a source plugin. Attaches .run() for use as entry point."""

    def decorator(cls: _C) -> _C:
        setattr(cls, _SOURCE_ID, id)
        cls.run = _run_blocking  # type: ignore[attr-defined]
        return cls

    return decorator


def publish(stream: str, *, path: str | None = None) -> Callable[[_F], _F]:
    """Mark a method as publishing to `stream`; its return value is the payload.

    Without `path` the subject is `its.<plugin>.<instance_key>.<stream>`. A
    `path` template adds dynamic segments below the instance_key (e.g.
    path="{midas_id}.tlm" yields `its.<plugin>.<instance_key>.<midas_id>.tlm`),
    with placeholders filled from kwargs at call time. For an event-driven
    publisher (no @every, no @subscribe) the runtime wraps the method so calling
    it triggers the publish.
    """

    def decorator(fn: _F) -> _F:
        setattr(fn, _PUBLISH_STREAM, stream)
        if path is not None:
            setattr(fn, _PUBLISH_PATH, path)
        return fn

    return decorator


def every(interval: str) -> Callable[[_F], _F]:
    """Schedule a @publish-decorated method on a periodic interval ('1s', '500ms', '5m')."""
    seconds = _parse_interval(interval)

    def decorator(fn: _F) -> _F:
        setattr(fn, _EVERY_SECONDS, seconds)
        return fn

    return decorator


def command(verb: str) -> Callable[[_F], _F]:
    """Mark a method as a command handler.

    Every verb subscribes to two subjects, and the caller picks the mode by
    which one they send to:
      - per-instance: `its.cmd.<source_id>.<instance_key>.<verb>` (request/reply)
      - broadcast:    `its.cmd.<source_id>.<verb>`               (fire-and-forget)

    The handler body is the same either way. Annotate the second parameter with
    a Pydantic class for inbound validation; return a Pydantic instance for
    typed replies on per-instance calls.
    """
    def decorator(fn: _F) -> _F:
        setattr(fn, _COMMAND_VERB, verb)
        return fn

    return decorator


def subscribe(subject: str) -> Callable[[_F], _F]:
    """Receive messages on a NATS subject. Wildcards (e.g. 'its.foo.*.tick')
    work natively.

    Combine with @publish to transform (the return value is auto-published);
    use alone for a pure consumer. The second parameter (after self) can be
    annotated with a Pydantic model to parse incoming JSON via .model_validate();
    a plain dict is passed if unannotated.
    """
    def decorator(fn: _F) -> _F:
        setattr(fn, _SUBSCRIBE_SUBJECT, subject)
        return fn

    return decorator


def _parse_interval(s: str) -> float:
    s = s.strip().lower()
    for suffix, mult in (("ms", 0.001), ("s", 1.0), ("m", 60.0), ("h", 3600.0)):
        if s.endswith(suffix):
            try:
                return float(s[: -len(suffix)]) * mult
            except ValueError:
                break
    raise ValueError(f"unrecognized interval {s!r}; use '500ms' / '1s' / '5m' / '2h'")


def _run_blocking(self: Any) -> None:
    """Attached to @source classes as .run(). Blocks until cancelled."""
    asyncio.run(_async_main(self))


async def _async_main(self: Any) -> None:
    source_id = getattr(type(self), _SOURCE_ID)

    # Validate config before connecting NATS, so a bad config fails clean with
    # no half-open sockets. Duck-typed so the SDK needn't depend on pydantic.
    config_cls = getattr(type(self), "Config", None)
    if config_cls is not None and hasattr(config_cls, "model_validate_json"):
        config_json = os.environ.get("ITS_CONFIG_JSON")
        if not config_json:
            print(
                f"error: {source_id} declares a Config class but ITS_CONFIG_JSON "
                f"is unset; spawn this plugin via `its dev` or `its connect`.",
                flush=True,
            )
            sys.exit(1)
        try:
            self.config = config_cls.model_validate_json(config_json)
        except Exception as exc:
            print(f"error: {source_id} config validation failed: {exc}", flush=True)
            sys.exit(1)

    instance_key = os.environ.get("ITS_INSTANCE_KEY", "dev")
    nats_url = os.environ.get("ITS_NATS_URL", "nats://127.0.0.1:4222")

    # allow_reconnect=False: exit promptly when the server dies rather than spin
    # in nats-py's reconnect loop (the supervisor kills us shortly after anyway).
    # The loop exception handler swallows transport OSErrors so the supervisor's
    # log relay doesn't carry end-of-life tracebacks.
    loop = asyncio.get_running_loop()
    _default_handler = loop.get_exception_handler()

    def _swallow_conn_drops(loop: asyncio.AbstractEventLoop, context: dict) -> None:
        exc = context.get("exception")
        if isinstance(exc, OSError):
            return
        if _default_handler is not None:
            _default_handler(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(_swallow_conn_drops)

    # Connect failures get a clean one-line error instead of a traceback. The
    # CLI port-probes to fail fast; this is the backstop for direct invocation
    # or a probe race.
    try:
        nc = await nats.connect(nats_url, allow_reconnect=False)
    except Exception as exc:
        print(
            f"error: could not connect to NATS at {nats_url} "
            f"({type(exc).__name__}); is the server running?",
            flush=True,
        )
        sys.exit(1)
    # Plain print, not the platform logger: the supervisor prefixes plugin
    # stdout with [plugin:<id>] on the way out.
    print(f"connected to {nats_url}", flush=True)

    # Claim the instance_key lock before any pub/sub; a second holder exits clean.
    lock: _InstanceLock | None = None
    try:
        lock = await _InstanceLock.claim(nc, source_id, instance_key)
    except _LockHeldError as exc:
        print(f"error: {exc}", flush=True)
        try:
            await nc.drain()
        finally:
            sys.exit(1)

    tasks: list[asyncio.Task[None]] = []
    has_subscriptions = False
    for _, fn in inspect.getmembers(type(self), predicate=inspect.isfunction):
        stream = getattr(fn, _PUBLISH_STREAM, None)
        interval = getattr(fn, _EVERY_SECONDS, None)
        sub_subject = getattr(fn, _SUBSCRIBE_SUBJECT, None)
        publish_path = getattr(fn, _PUBLISH_PATH, None)
        command_verb = getattr(fn, _COMMAND_VERB, None)

        # Command handler: subscribe both the per-instance and broadcast
        # subjects. The handler keys off msg.reply (present = request/reply,
        # absent = fire-and-forget), so the caller picks the mode, not the author.
        if command_verb is not None:
            per_instance = f"its.cmd.{source_id}.{instance_key}.{command_verb}"
            broadcast = f"its.cmd.{source_id}.{command_verb}"
            await _register_command(nc, self, fn, per_instance)
            await _register_command(nc, self, fn, broadcast)
            has_subscriptions = True

        # Periodic publisher (@publish + @every): static subject from stream name.
        if stream is not None and interval is not None:
            if publish_path is not None:
                # A timer loop has no kwargs to fill path placeholders from.
                print(
                    f"warning: @publish('{stream}', path=...) combined with @every "
                    f"is unsupported (path placeholders need kwargs); path ignored.",
                    flush=True,
                )
            pub_subject = f"its.{source_id}.{instance_key}.{stream}"
            tasks.append(
                asyncio.create_task(_periodic_publisher(self, fn, interval, nc, pub_subject))
            )

        # Subscriber, optionally co-decorated with @publish for transforms.
        if sub_subject is not None:
            pub_subject = (
                f"its.{source_id}.{instance_key}.{stream}" if stream is not None else None
            )
            await _register_subscription(nc, self, fn, sub_subject, pub_subject)
            has_subscriptions = True

        # Event-driven publisher (@publish only). Wrap on the instance so a call
        # to self.<fn>(...) extracts placeholder kwargs, renders the subject,
        # runs the body, and publishes.
        if stream is not None and interval is None and sub_subject is None:
            wrapper = _make_event_publisher(
                self, fn, nc, source_id, instance_key, stream, publish_path or stream
            )
            setattr(self, fn.__name__, wrapper)

        # Bare periodic task (@every alone): call on the interval, discard the
        # return. For timed work without a stream, e.g. a watchdog that emits
        # alerts via a separate @publish helper.
        if interval is not None and stream is None and sub_subject is None:
            tasks.append(
                asyncio.create_task(_periodic_caller(self, fn, interval))
            )

    # on_start hook: lets event-driven plugins (MQTT bridges, serial readers)
    # spawn background tasks now that NATS is connected and the lock is held.
    # Runs once; to keep work alive it should create_task() and return.
    on_start = getattr(self, "on_start", None)
    if on_start is not None and inspect.iscoroutinefunction(on_start):
        try:
            await on_start()
        except Exception as exc:
            print(f"warning: on_start raised: {exc!r}", flush=True)

    try:
        if tasks:
            await asyncio.gather(*tasks)
        elif has_subscriptions:
            # No periodic tasks; block so nats-py callbacks keep firing.
            await asyncio.Event().wait()
        else:
            # Source with no loops yet; block so the supervisor sees it running.
            await asyncio.Event().wait()
    except asyncio.CancelledError:
        pass
    except OSError as exc:
        # NATS died or the socket reset. Exit with a one-liner instead of a
        # traceback (ConnectionResetError, BrokenPipeError, etc. all subclass
        # OSError on Windows and Unix).
        print(f"shutdown: bus connection lost ({type(exc).__name__})", flush=True)
    finally:
        # Best-effort drain; termination on Windows (TerminateProcess) is abrupt
        # and may skip this.
        if lock is not None:
            await lock.release()
        try:
            await nc.drain()
        except Exception:
            pass


class _LockHeldError(RuntimeError):
    """Raised when another live instance owns this plugin's instance_key."""


class _InstanceLock:
    """JetStream KV-backed cross-process lock on (source_id, instance_key).

    `kv.create(key, pid)` is atomic, so a second arrival raises and we surface a
    clean error. A refresh task re-touches the key every LOCK_REFRESH_SECONDS so
    the TTL doesn't expire under a live plugin; a crashed plugin loses the key
    within LOCK_TTL_SECONDS and a relaunch reclaims it. Clean shutdown deletes it.
    """

    def __init__(self, kv: Any, key: str, refresh_task: asyncio.Task[None]) -> None:
        self._kv = kv
        self._key = key
        self._refresh_task = refresh_task

    @classmethod
    async def claim(cls, nc: nats.NATS, source_id: str, instance_key: str) -> _InstanceLock:
        js = nc.jetstream()
        # Memory-only storage: the bucket dies with nats-server, so stale lock
        # keys never survive a server restart.
        try:
            kv = await js.create_key_value(
                bucket=_LOCK_BUCKET,
                ttl=_LOCK_TTL_SECONDS,
                storage=StorageType.MEMORY,
            )
        except Exception:
            # Bucket already exists (different config or a race); open it as-is.
            kv = await js.key_value(bucket=_LOCK_BUCKET)

        key = f"{source_id}.{instance_key}"
        payload = str(os.getpid()).encode("utf-8")
        try:
            await kv.create(key, payload)
        except Exception as exc:
            # Surface the nats-py exception type+msg so the user can tell
            # "another instance holds this key" from a broken bucket.
            raise _LockHeldError(
                f"could not claim instance_key={instance_key!r} for "
                f"{source_id!r}: {type(exc).__name__}: {exc}"
            ) from exc

        async def _refresh() -> None:
            while True:
                await asyncio.sleep(_LOCK_REFRESH_SECONDS)
                try:
                    await kv.put(key, payload)
                except Exception:
                    # Warn and let the next refresh retry; if NATS is truly gone
                    # the main loop's OSError path handles shutdown.
                    print(f"warning: lock refresh failed for {key}", flush=True)

        refresh_task = asyncio.create_task(_refresh())
        return cls(kv, key, refresh_task)

    async def release(self) -> None:
        """Best-effort: cancel refresh, delete key. Safe to call after errors."""
        self._refresh_task.cancel()
        try:
            await self._refresh_task
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await self._kv.delete(self._key)
        except Exception:
            pass


def _make_event_publisher(
    instance: Any,
    fn: Callable[..., Any],
    nc: nats.NATS,
    source_id: str,
    instance_key: str,
    stream: str,
    path_template: str,
) -> Callable[..., Any]:
    """Build an async wrapper that publishes when the method is called.

    On call it binds args to the method signature, fills the path placeholders
    from the bound kwargs, renders `its.<plugin>.<instance_key>.<path>`, runs the
    body, serializes the return (Pydantic or json.dumps), and publishes. Wrapped
    per instance so multiple plugin instances don't clobber each other.
    """
    placeholders = _PLACEHOLDER_RE.findall(path_template)
    sig = inspect.signature(fn)

    async def wrapper(*args: Any, **kwargs: Any) -> None:
        bound = sig.bind(instance, *args, **kwargs)
        bound.apply_defaults()
        try:
            segments = {ph: bound.arguments[ph] for ph in placeholders}
        except KeyError as exc:
            raise TypeError(
                f"{fn.__name__}: path placeholder {exc.args[0]!r} not supplied"
            ) from exc
        rendered_path = path_template.format(**segments)
        subject = f"its.{source_id}.{instance_key}.{rendered_path}"

        payload = fn(*bound.args, **bound.kwargs)
        if asyncio.iscoroutine(payload):
            payload = await payload

        if hasattr(payload, "model_dump_json"):
            data = payload.model_dump_json().encode("utf-8")
        else:
            data = json.dumps(payload).encode("utf-8")
        await nc.publish(subject, data)

    return wrapper


def _annotation_validator(fn: Callable[..., Any]) -> Callable[[Any], Any] | None:
    """Return `cls.model_validate` if the handler's second parameter is
    annotated with a Pydantic class, else None.

    Uses typing.get_type_hints so stringified annotations (`from __future__
    import annotations`) still resolve, falling back to the raw annotation when
    get_type_hints can't resolve everything.
    """
    sig = inspect.signature(fn)
    params = list(sig.parameters.values())
    if len(params) < 2:
        return None
    name = params[1].name
    try:
        import typing
        hints = typing.get_type_hints(fn)
    except Exception:
        hints = {}
    ann = hints.get(name, params[1].annotation)
    if ann is inspect.Parameter.empty:
        return None
    if hasattr(ann, "model_validate"):
        return ann.model_validate
    return None


async def _register_subscription(
    nc: nats.NATS,
    self: Any,
    fn: Callable[..., Any],
    sub_subject: str,
    pub_subject: str | None,
) -> None:
    """Register a subscription whose callback parses the payload, calls the user
    method, and publishes the return value if @publish is co-decorated.

    The signature is inspected once at registration. A Pydantic annotation on the
    second parameter drives input parsing. A handler that declares a third
    parameter after (self, data) also receives msg.subject, which wildcard
    subscribers use to extract the instance_key: `on_tlm(self, tlm, subject)`.
    """
    parser = _annotation_validator(fn)
    takes_subject = len(inspect.signature(fn).parameters) >= 3

    async def handler(msg: Any) -> None:
        try:
            data = json.loads(msg.data.decode())
        except (UnicodeDecodeError, json.JSONDecodeError):
            return  # skip malformed payloads silently
        if parser is not None:
            try:
                data = parser(data)
            except Exception:
                return  # validation failed
        if takes_subject:
            result = fn(self, data, msg.subject)
        else:
            result = fn(self, data)
        # Await async user methods (`async def on_tick(...)`).
        if asyncio.iscoroutine(result):
            result = await result
        if pub_subject is not None and result is not None:
            if hasattr(result, "model_dump_json"):
                payload = result.model_dump_json().encode("utf-8")
            else:
                payload = json.dumps(result).encode("utf-8")
            await nc.publish(pub_subject, payload)

    await nc.subscribe(sub_subject, cb=handler)


async def _register_command(
    nc: nats.NATS,
    self: Any,
    fn: Callable[..., Any],
    subject: str,
) -> None:
    """Register a @command handler on one subject.

    Mode is per-message: validate, run the user fn, and reply only if msg.reply
    is set. A Pydantic annotation on the second param validates incoming
    payloads; on per-instance calls a failure replies `{"error": "validation:
    ..."}` so the requester gets a structured error instead of a timeout.
    Broadcast calls drop errors silently (no reply path).
    """
    parser = _annotation_validator(fn)

    async def _reply_error(msg: Any, message: str) -> None:
        if msg.reply:
            err = json.dumps({"error": message}).encode("utf-8")
            await nc.publish(msg.reply, err)

    async def handler(msg: Any) -> None:
        try:
            data: Any = json.loads(msg.data.decode()) if msg.data else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            await _reply_error(msg, f"malformed payload: {exc}")
            return

        if parser is not None:
            try:
                data = parser(data)
            except Exception as exc:
                await _reply_error(msg, f"validation: {exc}")
                return

        try:
            result = fn(self, data)
            if asyncio.iscoroutine(result):
                result = await result
        except Exception as exc:
            if msg.reply:
                await _reply_error(msg, f"{type(exc).__name__}: {exc}")
            else:
                print(f"warning: command handler raised: {exc!r}", flush=True)
            return

        if not msg.reply:
            return  # broadcast invocation, no reply path
        if hasattr(result, "model_dump_json"):
            payload = result.model_dump_json().encode("utf-8")
        elif result is None:
            payload = b"{}"
        else:
            payload = json.dumps(result).encode("utf-8")
        await nc.publish(msg.reply, payload)

    await nc.subscribe(subject, cb=handler)


async def _periodic_publisher(
    self: Any,
    fn: Callable[..., Any],
    interval_seconds: float,
    nc: nats.NATS,
    subject: str,
) -> None:
    while True:
        payload = fn(self)
        if asyncio.iscoroutine(payload):
            payload = await payload
        # Duck-typed Pydantic detection so the SDK needn't depend on pydantic.
        if hasattr(payload, "model_dump_json"):
            data = payload.model_dump_json().encode("utf-8")
        else:
            data = json.dumps(payload).encode("utf-8")
        await nc.publish(subject, data)
        await asyncio.sleep(interval_seconds)


async def _periodic_caller(
    self: Any,
    fn: Callable[..., Any],
    interval_seconds: float,
) -> None:
    """Bare periodic task for @every methods that don't @publish: call, await if
    needed, discard the return, sleep. Used by watchdog-style plugins."""
    while True:
        result = fn(self)
        if asyncio.iscoroutine(result):
            await result
        await asyncio.sleep(interval_seconds)
