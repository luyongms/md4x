# A Tour of Concurrency, in Eight Languages

A code-heavy walkthrough of how different languages express the same handful of concurrency primitives — the producer/consumer, a worker pool, a debounced channel, and a graceful shutdown — across Rust, Go, Python, TypeScript, Elixir, Java, C++, and Kotlin.

The point is not "which is best" but to show what the *shape* of concurrent code looks like in each. Read it as a side-by-side reference, not a benchmark.

## Producer / Consumer

The classical bounded-buffer problem. A producer pushes items into a fixed-capacity queue; a consumer pulls them out. We use the same naming across languages so the diff between snippets stays small.

### Rust

```rust
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

fn main() {
    let (tx, rx) = mpsc::sync_channel::<u64>(16);

    let producer = thread::spawn(move || {
        for i in 0..1_000 {
            // sync_channel blocks when full → natural backpressure
            tx.send(i).expect("consumer dropped");
            if i % 100 == 0 {
                eprintln!("produced through {i}");
            }
        }
        // drop(tx) closes the channel
    });

    let consumer = thread::spawn(move || {
        let mut sum: u64 = 0;
        while let Ok(v) = rx.recv() {
            sum = sum.wrapping_add(v);
            // simulate work
            thread::sleep(Duration::from_micros(50));
        }
        eprintln!("sum = {sum}");
    });

    producer.join().unwrap();
    consumer.join().unwrap();
}
```

### Go

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

func main() {
    ch := make(chan uint64, 16)
    var wg sync.WaitGroup

    wg.Add(1)
    go func() {
        defer wg.Done()
        defer close(ch) // signal end-of-stream
        for i := uint64(0); i < 1000; i++ {
            ch <- i
            if i%100 == 0 {
                fmt.Fprintf(/* stderr */ nil, "produced through %d\n", i)
            }
        }
    }()

    wg.Add(1)
    go func() {
        defer wg.Done()
        var sum uint64
        for v := range ch {
            sum += v
            time.Sleep(50 * time.Microsecond)
        }
        fmt.Println("sum =", sum)
    }()

    wg.Wait()
}
```

### Python (asyncio)

```python
import asyncio

async def producer(q: asyncio.Queue[int]) -> None:
    for i in range(1000):
        await q.put(i)
        if i % 100 == 0:
            print(f"produced through {i}")
    await q.put(None)  # sentinel

async def consumer(q: asyncio.Queue[int]) -> None:
    total = 0
    while True:
        item = await q.get()
        if item is None:
            break
        total += item
        await asyncio.sleep(50e-6)
    print(f"sum = {total}")

async def main() -> None:
    q: asyncio.Queue[int] = asyncio.Queue(maxsize=16)
    await asyncio.gather(producer(q), consumer(q))

if __name__ == "__main__":
    asyncio.run(main())
```

### TypeScript (Node.js streams)

```ts
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const producer = new Readable({
  objectMode: true,
  read() {
    if (this.i === undefined) this.i = 0;
    if (this.i >= 1000) return this.push(null);
    this.push(this.i);
    if (this.i % 100 === 0) console.error(`produced through ${this.i}`);
    this.i++;
  },
});

let sum = 0n;
const consumer = new Writable({
  objectMode: true,
  async write(chunk, _enc, cb) {
    sum += BigInt(chunk as number);
    await new Promise((r) => setTimeout(r, 0));
    cb();
  },
});

await pipeline(producer, consumer);
console.log("sum =", sum.toString());
```

### Elixir

```elixir
defmodule PC do
  def run do
    {:ok, q} = :queue.new() |> Agent.start_link(fn -> &1 end)
    producer = Task.async(fn -> produce(q) end)
    consumer = Task.async(fn -> consume(q, 0) end)
    Task.await(producer, :infinity)
    sum = Task.await(consumer, :infinity)
    IO.puts("sum = #{sum}")
  end

  defp produce(q) do
    Enum.each(0..999, fn i ->
      Agent.update(q, &:queue.in(i, &1))
      if rem(i, 100) == 0, do: IO.puts(:stderr, "produced through #{i}")
    end)
    Agent.update(q, &:queue.in(:done, &1))
  end

  defp consume(q, total) do
    case Agent.get_and_update(q, &case :queue.out(&1) do
                                  {{:value, v}, q2} -> {v, q2}
                                  {:empty, q2}      -> {nil, q2}
                                end) do
      :done -> total
      nil   -> Process.sleep(0); consume(q, total)
      v     -> consume(q, total + v)
    end
  end
end
```

### Java (BlockingQueue)

```java
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

public class ProducerConsumer {
    private static final Long POISON = -1L;

    public static void main(String[] args) throws InterruptedException {
        BlockingQueue<Long> q = new ArrayBlockingQueue<>(16);

        Thread producer = new Thread(() -> {
            try {
                for (long i = 0; i < 1000; i++) {
                    q.put(i);
                    if (i % 100 == 0) System.err.println("produced through " + i);
                }
                q.put(POISON);
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        });

        Thread consumer = new Thread(() -> {
            try {
                long sum = 0;
                while (true) {
                    Long v = q.take();
                    if (v.equals(POISON)) break;
                    sum += v;
                    TimeUnit.MICROSECONDS.sleep(50);
                }
                System.out.println("sum = " + sum);
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        });

        producer.start();
        consumer.start();
        producer.join();
        consumer.join();
    }
}
```

### C++ (std::thread)

```cpp
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <queue>
#include <thread>

int main() {
    std::queue<uint64_t> q;
    std::mutex m;
    std::condition_variable not_full, not_empty;
    bool done = false;
    constexpr size_t CAP = 16;

    std::thread producer([&] {
        for (uint64_t i = 0; i < 1000; ++i) {
            std::unique_lock lk(m);
            not_full.wait(lk, [&] { return q.size() < CAP; });
            q.push(i);
            lk.unlock();
            not_empty.notify_one();
            if (i % 100 == 0) std::cerr << "produced through " << i << "\n";
        }
        { std::lock_guard lk(m); done = true; }
        not_empty.notify_all();
    });

    std::thread consumer([&] {
        uint64_t sum = 0;
        while (true) {
            std::unique_lock lk(m);
            not_empty.wait(lk, [&] { return !q.empty() || done; });
            if (q.empty() && done) break;
            uint64_t v = q.front(); q.pop();
            lk.unlock();
            not_full.notify_one();
            sum += v;
        }
        std::cout << "sum = " << sum << "\n";
    });

    producer.join();
    consumer.join();
}
```

### Kotlin (coroutines)

```kotlin
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel

fun main() = runBlocking {
    val ch = Channel<Long>(16)

    launch {
        for (i in 0L until 1000L) {
            ch.send(i)
            if (i % 100 == 0L) System.err.println("produced through $i")
        }
        ch.close()
    }

    var sum = 0L
    for (v in ch) {
        sum += v
        delay(0)
    }
    println("sum = $sum")
}
```

## Worker Pool

A worker pool fans incoming jobs out to a fixed number of workers, then collects results. Below: Rust + Go side-by-side.

### Rust (rayon-flavored)

```rust
use std::sync::mpsc;
use std::thread;

fn worker_pool<T: Send + 'static, R: Send + 'static>(
    n: usize,
    jobs: Vec<T>,
    work: impl Fn(T) -> R + Sync + Send + 'static + Clone,
) -> Vec<R> {
    let (job_tx, job_rx) = crossbeam::channel::unbounded::<T>();
    let (res_tx, res_rx) = mpsc::channel::<R>();
    let res_tx_clone = res_tx.clone();

    let workers: Vec<_> = (0..n)
        .map(|_| {
            let rx = job_rx.clone();
            let tx = res_tx_clone.clone();
            let work = work.clone();
            thread::spawn(move || {
                while let Ok(job) = rx.recv() {
                    let _ = tx.send(work(job));
                }
            })
        })
        .collect();

    for j in jobs { job_tx.send(j).unwrap(); }
    drop(job_tx);
    drop(res_tx);
    drop(res_tx_clone);

    let mut out = Vec::new();
    while let Ok(r) = res_rx.recv() { out.push(r); }
    for w in workers { w.join().unwrap(); }
    out
}
```

### Go (errgroup)

```go
import (
    "context"
    "golang.org/x/sync/errgroup"
)

func WorkerPool[T any, R any](
    ctx context.Context,
    n int,
    jobs []T,
    work func(context.Context, T) (R, error),
) ([]R, error) {
    in := make(chan T)
    out := make(chan R, len(jobs))

    g, ctx := errgroup.WithContext(ctx)
    for i := 0; i < n; i++ {
        g.Go(func() error {
            for j := range in {
                r, err := work(ctx, j)
                if err != nil { return err }
                out <- r
            }
            return nil
        })
    }
    g.Go(func() error {
        defer close(in)
        for _, j := range jobs {
            select {
            case in <- j:
            case <-ctx.Done(): return ctx.Err()
            }
        }
        return nil
    })

    err := g.Wait()
    close(out)
    var rs []R
    for r := range out { rs = append(rs, r) }
    return rs, err
}
```

## Debounce

A debounced sink emits at most once per interval, after the input has been quiet.

```rust
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

pub async fn debounced<T: Clone>(
    mut rx: mpsc::Receiver<T>,
    period: Duration,
    mut emit: impl FnMut(T),
) {
    let mut pending: Option<(T, Instant)> = None;
    loop {
        let timeout = pending
            .as_ref()
            .map(|(_, t)| t.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_millis(60_000));

        tokio::select! {
            v = rx.recv() => {
                match v {
                    Some(v) => { pending = Some((v, Instant::now() + period)); }
                    None    => { if let Some((v, _)) = pending.take() { emit(v); } return; }
                }
            }
            _ = tokio::time::sleep(timeout), if pending.is_some() => {
                if let Some((v, _)) = pending.take() { emit(v); }
            }
        }
    }
}
```

## Graceful Shutdown

A common pattern: register a signal handler, broadcast a shutdown token, drain in-flight requests, then exit.

```rust
use tokio::signal;
use tokio::sync::watch;

#[tokio::main]
async fn main() {
    let (tx, rx) = watch::channel(false);

    let server = tokio::spawn(server_loop(rx.clone()));
    let _ = signal::ctrl_c().await;
    eprintln!("ctrl-c received, draining…");
    tx.send(true).ok();

    server.await.ok();
    eprintln!("clean exit");
}

async fn server_loop(mut shutdown: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = shutdown.changed() => return,
            req = next_request() => handle(req).await,
        }
    }
}
```

## A Note on Cancellation

Languages differ on whether cancellation is cooperative (Go's `context`, Rust's `tokio::select!`, Kotlin's `Job.cancel`) or pre-emptive (Java's `Thread.interrupt`, which is delivered at well-defined points). Cooperative cancellation is easier to reason about; pre-emptive cancellation is easier to introduce in legacy code that has no first-class shutdown channel. There's no universally correct answer.

## Closing

Eight languages, one diagram. The shape repeats — produce, queue, consume, signal end-of-stream — and what differs is mostly cosmetic: who closes what, who owns the lifetime, who stops first. The bugs are also the same: stuck producers, lost wake-ups, leaked goroutines, dropped poison pills. Concurrency is concurrency.
