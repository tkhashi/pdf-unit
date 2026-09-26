"""処理区間の所要時間と件数を1リクエスト分集める計測の仕組み(ADR 0023)。

エンドポイント関数の中で `collect()` を開始し、各処理で `stage()` / `metric()` を呼ぶ。収集器は
contextvars で持つので、スレッドプールで並行に動く同期エンドポイントでもリクエストごとに分かれる。
収集器が無いとき(単体での関数呼び出し)は何もしない。計測は処理内容・出力に影響させない。

区間名は `calib.render` のように `.` で内訳を表す。`.` を含まない区間の合計が関数全体の時間の目安になる
(`lock_wait` は他の区間の中で計られる場合がある)。
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field


@dataclass
class Timings:
    stages: dict[str, float] = field(default_factory=dict)  # 区間名 -> 秒(同名は加算)
    metrics: dict[str, int | float | str] = field(default_factory=dict)


_current: ContextVar[Timings | None] = ContextVar("pdf_unit_timings", default=None)


@contextmanager
def collect() -> Iterator[Timings]:
    timings = Timings()
    token = _current.set(timings)
    try:
        yield timings
    finally:
        _current.reset(token)


@contextmanager
def stage(name: str) -> Iterator[None]:
    timings = _current.get()
    if timings is None:
        yield
        return
    start = time.perf_counter()
    try:
        yield
    finally:
        timings.stages[name] = timings.stages.get(name, 0.0) + time.perf_counter() - start


def metric(name: str, value: int | float | str) -> None:
    timings = _current.get()
    if timings is not None:
        timings.metrics[name] = value


def add_metric(name: str, value: int | float) -> None:
    """同名の値に加算する(描画の試行回数など)。"""
    timings = _current.get()
    if timings is not None:
        timings.metrics[name] = timings.metrics.get(name, 0) + value


def server_timing_header(timings: Timings) -> str:
    """Server-Timing ヘッダーの値(`parse;dur=12.3, vectors;dur=4.5`、ミリ秒)。"""
    return ", ".join(f"{name};dur={sec * 1000:.1f}" for name, sec in timings.stages.items())
