"""In-process ring buffer for the broker's order / deal push events (084 D1, FR-003).

The push callbacks land on the SDK's own receive thread; the reader is a waitress
worker thread serving `GET /trade/events`. Nothing else in this process touches
the rows, so one `threading.Lock` around **every** operation is both necessary and
sufficient — a lock-free deque would still leave `seq` assignment and the snapshot
read racing each other.

**Two identifiers, two different jobs.** `seq` is monotonic per process, so a
consumer can tell "nothing new" from "I missed some". `epoch` is minted at
construction, so a consumer can tell **"the sequence restarted" from "the sequence
broke"** — after a shim restart `seq` legitimately goes back to 1, and without
`epoch` that is indistinguishable from the buffer having wrapped past the
consumer's cursor (FR-003).

🚨 **Capacity is a signal-quality knob, not a memory knob.** One event row is one
or two KB, so even a few thousand rows is a few MB on a host that runs a pandas-
laden SDK — memory is not what bounds this. What capacity buys is the meaning of
`dropped`: a buffer too small to cover one ordinary server restart window wraps on
**every routine deploy**, each wrap produces a gap-compensation trace on the server
side, and that stream of routine traces drowns the very signal FR-014 uses to judge
whether the push channel is healthy. Size it so a wrap means something went wrong.
"""

from __future__ import annotations

import threading
import uuid
from collections import deque
from typing import Any

from . import config


class TradeEventBuffer:
    """Bounded FIFO of push events, addressed by `(epoch, seq)`.

    Rows are opaque here: the vendor-row mapping (leg expansion, id widening,
    account-id removal) is the push handler's job, and this module deliberately
    knows none of it — it only stamps `seq` and hands rows back in order.
    """

    def __init__(self, maxlen: int | None = None) -> None:
        self._lock = threading.Lock()
        self._rows: deque[dict[str, Any]] = deque(
            maxlen=config.trade_event_buffer_size() if maxlen is None else maxlen
        )
        # Minted per instance, i.e. per process: a restart MUST change it (FR-003).
        self._epoch = uuid.uuid4().hex
        self._last_seq = 0

    @property
    def epoch(self) -> str:
        """Generation id of this buffer. Immutable, but read under the lock all the same."""
        with self._lock:
            return self._epoch

    def append(self, row: dict[str, Any]) -> int:
        """Stamp `row` with the next `seq` and store it; returns the assigned `seq`.

        The row is copied, so a caller reusing its dict cannot mutate what a reader
        will later see. `seq` is assigned here and nowhere else — a `seq` key in the
        incoming row is overwritten rather than trusted.

        Complexity O(1) (deque append; eviction of the oldest row is O(1) too).
        """
        with self._lock:
            self._last_seq += 1
            self._rows.append({**row, "seq": self._last_seq})
            return self._last_seq

    def read(self, after_seq: int = 0) -> dict[str, Any]:
        """Every retained row with `seq > after_seq`, plus the cursor to send back.

        Returns `{epoch, rows, next_seq, dropped}`:

        - `next_seq` — what the consumer passes as `after_seq` next time: the last
          returned row's `seq`, or `after_seq` unchanged when nothing is new.
        - `dropped` — the requested cursor is **older than the oldest retained row**,
          i.e. rows between the two were evicted. This is the wrap-around signal the
          server turns into gap compensation (FR-009); reporting it late or not at
          all makes the lost events simply never appear, with nothing raising.
          🚨 Wrapping is not by itself a gap: a cursor that is still inside the
          buffer reads `dropped=False` even though older rows were evicted long ago.

        Non-blocking by construction — no waiting, no long-polling. Hanging here
        would hold one of waitress's four worker threads hostage and starve the
        quote routes (FR-004).

        Complexity O(n) over the retained rows.
        """
        cursor = max(0, int(after_seq))
        with self._lock:
            rows = [row for row in self._rows if row["seq"] > cursor]
            oldest = self._rows[0]["seq"] if self._rows else None
            return {
                "epoch": self._epoch,
                "rows": rows,
                "next_seq": rows[-1]["seq"] if rows else cursor,
                "dropped": oldest is not None and cursor + 1 < oldest,
            }
