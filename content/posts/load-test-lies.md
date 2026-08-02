---
title: "Retuning a CPU inference service for a bigger node"
date: 2026-08-02
tags: ["sre", "performance", "kubernetes"]
summary: "Four times the workers and twice the memory bought exactly zero extra throughput — but the harder part was proving the measurement wasn't lying. Five ways a load test looked clean and wasn't."
---

*Worker count, concurrency limits and memory sizing are not properties of a service.
They're properties of a service on a particular machine. Scale the machine and you
re-derive all of them — and the measurement is harder than the tuning.*

**What's in here**

- k6 silently dropped up to 32% of requests, and the ramp still looked like clean saturation
- a 2s probe timeout killed healthy pods; a 5-minute cold start turned that into a cascade
- `--limit-concurrency` counts connections, not requests — keep-alive alone trips it
- forked workers don't share model memory: it stays linear at ~2.5Gi each
- `OMP_NUM_THREADS` was worth 8.8x on p95, from one line
- and after all of it, the throughput ceiling didn't move at all

---

The service was already tuned. Earlier manual load testing had settled the worker
count and the concurrency limit for the node it was running on, and it was stable
there. Then the node got bigger: more cores, more memory. The question was what the
new numbers should be, and the working assumption was the obvious one — more hardware,
more throughput.

That assumption turned out to be wrong. What took longer was establishing it was
*actually* wrong rather than an artefact of how I was measuring — several defects in
the test setup each produced a clean-looking result supporting a different conclusion.

This post is mostly about those, because they're the part nobody writes down. The
tuning took an hour. Trusting it took the rest of the day.

---

## What I was working with

*If you already know k6 and how uvicorn runs multiple workers, skip ahead — nothing
here is surprising.*

**The service.** A Python HTTP service running machine-learning models in
[ONNX](https://onnx.ai/) format — a portable format you export a trained model into so
it can run outside the framework that trained it.

I can't share the specifics, so picture the generic shape, which is accurate enough
for everything that follows: **an image-scoring API.** You `POST` an image, the service
decodes it, runs one model forward pass, returns a small JSON result. No batching, no
streaming, no queue in between. Each request is tens to hundreds of milliseconds of
real numerical work rather than a database lookup, and the model sits in memory for the
life of the process.

If you hold that picture, every number in this post has somewhere to land.

**And it runs on CPU, not GPU** — the first thing people ask. Plenty of deployments
can't assume accelerators: you're shipping into an environment someone else operates,
or an edge site with no GPUs, or the quota isn't there, or the cost only works at a
utilisation you'll never hit. Needing a GPU-shaped workload to be acceptable on CPU is
common, not exotic.

That constraint is why this post exists. On a GPU most of what follows would be someone
else's problem. On CPU, throughput is decided by how many processes you run, how many
threads each spawns, and how much memory each costs — all three of which change when
the machine does.

**How it's served.** FastAPI behind uvicorn, with `--workers N`. Python's GIL means one
process gives no CPU parallelism for this kind of work, so uvicorn forks N worker
processes accepting from a shared socket. **Concurrency here comes from processes, not
threads** — hold onto that, it's the root of two findings below.

**Where it runs.** Kubernetes, one pod on a node with 16 CPU cores and 64GB of memory.
Kubernetes writes CPU in *millicores*, so `14,000m` is 14 cores, and memory in
`Mi`/`Gi`.

**How I generated load.** [k6](https://k6.io/), in *constant arrival rate* mode:
rather than "run as fast as you can," you tell it "send exactly 10 requests per second
for 30 seconds" and it holds that rate however slow responses get. It does this from a
pool of **virtual users** (VUs) — independent workers each holding one in-flight
request. That pool is the subject of §1.

**The two numbers that matter.** *RPS*, requests per second successfully completed.
And *p95 latency*, the response time 95% of requests came in under — better than an
average, which hides the slow tail where users actually notice.

---

## First: three properties that decide what a load test can tell you

None of these are visible from the outside, and each one constrains what a throughput
number actually means. Worth establishing before any load is generated.

### Resource usage is decoupled from load

Here's what the pod *reserves* versus what it ever actually *used*, measured at and
past its throughput ceiling:

| | requested | share of node | peak measured | share of node |
|---|---|---|---|---|
| CPU | 14,000m | 88% | 8,334m | 52% |
| memory | 36,000Mi | 56% | 20,337Mi | 32% |

The pod asks for 88% of the machine and never touches more than half of it, at any
load. Push past the ceiling and that number doesn't climb — it sits flat while latency
degrades.

Both reservations are sized for the worst moment rather than the normal one. Model
loading at startup is the CPU-hungry part and already takes four to five minutes;
starve it and that gets worse. Memory has request equal to limit because an OOM-killed
worker doesn't surface as a clean container restart — it surfaces as connection resets,
since the uvicorn master survives and the container never exits.

The consequence is structural, and it's a cost problem rather than a performance one.
**Kubernetes schedules on requests, not on usage.** A request is a booking, not a bill
— like reserving a table for fourteen and turning up with eight. The restaurant can see
the six empty chairs and still can't seat anyone in them, because you booked them.

So those ~6 idle cores aren't spare capacity another service can borrow; they stay
stranded for the lifetime of the pod. Autoscaling on CPU is out for the same reason: a
horizontal autoscaler sees a flat, unremarkable line while the service degrades on
latency.

Which separates two questions that look like one. *What is the ceiling* and *what does
this cost us* have different levers. Tuning moves the first. Nothing in this post moves
the second.

### Cost per request is set by something the edge can't inspect

The service takes an image, so the instinct is to reason about payload *size* — cap
the body at the ingress and you've bounded the work.

Size isn't what drives cost here. **Resolution is.** A 720×960 test image costs roughly
one core per request and the service tops out near 7.8 RPS. A higher-resolution image
from the real workload costs about two cores and saturates the same node at around
5 RPS — a third less throughput, same service, same hardware, comparable file size.

This is hard to guard. You can enforce a `Content-Length` limit at the ingress; you
can't enforce *pixel dimensions* there, because reading them means decoding the image,
and decoding is the expensive operation you were trying to gate. Compression widens the
gap — a small, heavily-compressed file can decode into an enormous bitmap.

So the choice of test payload silently sets the answer. Benchmark with a lighter image
than production traffic and the capacity number is optimistic by a third, with nothing
in the output to indicate it. Test payloads have to come from the real traffic
distribution, not from whatever file is convenient.

### Cold start is four to five minutes

Model loading at startup. This number quietly determines several other decisions:

- Anything that kills a pod removes capacity for five minutes, which makes probe
  configuration much higher-stakes than it looks — see §2.
- Horizontal scaling is not a real-time lever. By the time a new pod is serving, the
  spike is over.
- Every config change costs a five-minute round trip, which sets the pace of the
  entire investigation.

---

## Then: knowing a tool is not the same as knowing how it fails

I've used k6 for years. That didn't help with §1, because the failure there is
*silent* — no error, no warning, no red output. The tool did exactly what it was
designed to do, recorded it in a field that isn't in the default summary, and produced
a graph that looked entirely reasonable.

Familiarity tells you how to drive a tool. It doesn't tell you how it misreports, and
that second thing is mostly acquired by getting burned. The practical version: be most
suspicious of the instruments you're most confident about, because that's where you
stop checking.

Four of the five findings below produced no error at all — just clean-looking graphs
with wrong numbers in them, which is harder to catch.

---

## 1. The load generator was not sending the requested load

The first ramp looked right. Offered rate stepped 6 → 8 → 10 → 12 → 15 → 18 RPS,
throughput flattened around 7-something, latency climbed, no pods restarted. A textbook
saturation curve.

The field that contradicts it is `dropped_iterations`:

```
rps=8    reqs=210   dropped=30    (12% never sent)
rps=10   reqs=240   dropped=60    (20% never sent)
rps=12   reqs=280   dropped=81    (22% never sent)
rps=15   reqs=312   dropped=139   (31% never sent)
rps=18   reqs=367   dropped=174   (32% never sent)
```

At the top of the ramp, a third of the requests were never sent.

This is a property of the executor, not a misconfiguration you can spot by reading the
script. As responses slow, each VU stays occupied longer, so holding a fixed arrival
rate requires more of them. The run had 50 preallocated. k6 grows the pool on demand,
but not fast enough inside a 30-second step, so it drops what it can't place and
records the count.

So the service was never offered 18 RPS. It was offered about 12 — meaning the
flattening at the top of that curve is partly k6 running out of headroom rather than
the service running out of capacity. The saturation being measured was partly the
generator's own.

Re-running with 600 VUs preallocated gives 100% delivery at every step:

```
rps=8    reqs=240   dropped=0
rps=12   reqs=361   dropped=0
rps=16   reqs=480   dropped=0
rps=20   reqs=600   dropped=0
```

The corrected ceiling came out at 7.73 RPS, within noise of the original 7.77. In this
case the defect didn't move the headline number — but that's not knowable in advance,
because the size of the error depends on the shape of the latency curve. A steeper
curve would have distorted it badly.

Every load tool has this counter. k6 calls it `dropped_iterations`. JMeter exposes it
as the gap between scheduled and actual sample time. Locust reports it as spawn-rate
warnings. Whichever you use: find the number that tells you whether the load left the
machine, and read it before reading anything else.

### a related failure mode: the generator dies before the service does

A run reported zero requests. The k6 pod had been OOM-killed — exit code 137, the
kernel's out-of-memory killer — on a 1Gi limit, holding a ~1MB base64 body across
hundreds of VUs.

Two things worth knowing. Kubernetes replaced the dead pod and the replacement started
clean, wiping the test scripts copied into `/tmp`, so the symptom was an empty directory
rather than an obvious crash. And from the outside, a dead generator and a dead service
look identical: no requests, no results, no data.

Size the generator's memory against payload size × VU count, and check its own liveness
before concluding anything about the service.

---

## 2. The health probe was killing pods that were busy, not broken

Pods began restarting under load — which reads as the service failing at high RPS.

It wasn't. It was being killed.

A *liveness probe* is Kubernetes asking a container on a fixed interval whether it's
alive, and restarting it when the answer doesn't arrive.

This one ran a script with a 2-second HTTP timeout against the app's own health
endpoint — served by the same uvicorn workers that serve request traffic. Under load
every worker is mid-inference, so the health request queues behind real work. A probe
configured that way isn't measuring liveness; it's measuring queue depth, and it fails
precisely when the service is busiest rather than when it's broken.

This is where the four-to-five minute cold start stops being trivia. The probe removes
a pod when the system is under most pressure and doesn't return it for five minutes.
Traffic shifts to the remaining pods, they get busier, their probes start timing out
too.

Timeout 2s → 8s, `periodSeconds: 15`, `failureThreshold: 4`. Zero restarts in every
subsequent run at every load level.

The general rule: if a health endpoint shares a thread pool with request traffic, size
its timeout against worst-case queueing delay, and size `failureThreshold` against
recovery time rather than request time. For anything with a multi-minute cold start, an
aggressive probe is far more dangerous than a slow one.

---

## 3. `--limit-concurrency` counts connections, not requests

Under overload, a service that queues everything makes every request slower until they
all time out. The alternative is *load shedding*: past some limit, refuse new work
immediately with a 503 so accepted requests still finish fast. uvicorn does this with
`--limit-concurrency`, and pairing it with a health check that treats 503 as *healthy*
— up, just full — gives you a reasonable shedding setup.

The limit was 4, carried over from the previous node size. At **3 RPS** — nowhere near
capacity — 14% of requests were being rejected, with the pod averaging 2.2 of its 16
cores. About 14% busy, and turning work away.

`--limit-concurrency` caps *connections*, not in-flight requests. HTTP keep-alive means
a client holds its TCP connection open between requests, so a completely idle
connection still counts against the limit. The generator's connection pool alone was
enough to trip a limit of 4 before any real concurrency existed.

Raising it to 16 removed the false rejections. But the comparison is more interesting
than "bigger is better":

| limit | failures @ 3 RPS | p95 @ 3 RPS |
|-------|------------------|-------------|
| `4` | 14% | 3,654 ms |
| `16` | 0% | 9,015 ms |

The tight limit wasn't simply wrong — it was trading latency for errors. Shedding early
kept the survivors fast; the loose limit accepted everything and made everyone wait
almost three times as long. Which behaviour you want is a product decision, not a
tuning one. But you can't have that conversation until you know what the knob counts,
and connections, in-flight requests, queued requests and worker slots are four
different numbers that frameworks are inconsistent about.

---

## 4. Forked workers don't share model memory the way you'd expect

The intuitive model here is appealing and wrong, so it's worth stating precisely.

uvicorn forks its workers *after* the parent process loads the model. Forked processes
share memory copy-on-write, and model weights are read-mostly. That reasoning predicts
per-worker memory should flatten out substantially as worker count rises.

It doesn't. Measured across a 4x range, against limits high enough that nothing was
being clipped:

| workers | memory limit | peak used | per worker |
|---------|--------------|-----------|------------|
| 8 | 48,000Mi | 20,337Mi | 2.48 Gi |
| 16 | 52,000Mi | 39,616Mi | 2.42 Gi |
| 32 | 90,000Mi | 80,910Mi | 2.47 Gi |

Linear, essentially flat per-worker cost. Copy-on-write is real, it just doesn't help
much here: the ONNX runtime allocates per-worker arenas and scratch buffers *after* the
fork, and those dominate the footprint. The genuinely shared portion is small.

So size memory linearly in worker count, and treat "forked model servers share the
model" as an assumption to measure rather than rely on. Here, 16 → 32 workers meant
roughly doubling memory — which is what decides whether a worker count fits a machine
at all.

---

## 5. One environment variable was worth 8.8x

This one was new to me, and it's the finding I'd most want to pass on.

Tail latency at moderate load was poor. Same hardware, same code, same request rate —
the only difference is `OMP_NUM_THREADS`:

| | p95 @ 5 RPS | p99 @ 5 RPS |
|---|---|---|
| unset | 5,436 ms | 7,062 ms |
| `OMP_NUM_THREADS=2` | 619 ms | 632 ms |

This is thread oversubscription, and it follows directly from the thing I flagged
earlier: concurrency here comes from *processes*. Numerical libraries don't know that.
Left unset, OpenMP sizes its thread pool to the number of cores it can see — and each
of the 8 worker processes sees all 16, because none of them knows the others exist.
Eight crews, each hiring enough people to fill the same sixteen desks.

Each worker was spawning around 84 threads. Roughly 677 threads across 16 cores. The
CPU looked fully busy; it was busy context switching.

If you run numpy, PyTorch, ONNX Runtime or scikit-learn under multiple worker
processes, pin the thread count. `OMP_NUM_THREADS = cores / workers`, floored at 1, is
the right starting point, and set the siblings too — `MKL_NUM_THREADS`,
`OPENBLAS_NUM_THREADS`, `NUMEXPR_NUM_THREADS`.

One caveat, because it limits the finding. `OMP_NUM_THREADS` is not reliably the knob
for ONNX Runtime specifically: default ORT builds don't use OpenMP at all, sizing their
own pools per session via `intra_op_num_threads` (threads splitting one operator) and
`inter_op_num_threads` (operators in parallel). Only ORT builds compiled with OpenMP
respond to the environment variable.

So I can't cleanly attribute the 8.8x to one library — it could be an OpenMP-enabled ORT
build, or BLAS threads in the numpy pre- and post-processing around the model call,
plausibly both. I didn't isolate it further. Set `intra_op_num_threads` explicitly on
the ORT session *as well as* the environment variables rather than assuming either
covers the other.

---

## Platform friction worth knowing about

Two things that cost time and aren't really findings, but will cost you time too:

- The node pool for this test depends on a ComputeClass that isn't managed in GitOps.
  Delete it and pods stay `Pending` indefinitely with no useful event explaining why —
  a plain instance-type selector can't be satisfied by node autoprovisioning on its own.
- uvicorn's multi-worker boot writes one startup banner per worker, so logs at startup
  look very similar to a crash loop. Worth recognising before reading anything into it.

---

## The ceiling didn't move

With the generator delivering full load, the probes sized correctly, the concurrency
limit understood, memory measured and threads pinned, the numbers were finally
trustworthy. Back to the original question — what does a bigger node buy?

| configuration | machine | peak sustained |
|---|---|---|
| 8 workers | 16 vCPU / 64GB | 7.77 RPS |
| 16 workers | 16 vCPU / 64GB | 7.80 RPS |
| 32 workers | 16 vCPU / 128GB | 7.67 RPS |

Four times the workers, twice the memory, a different machine family. The same number.

And at that ceiling, with p95 pinned at 30 seconds, nothing was working hard:

| component | usage | allocated |
|---|---|---|
| inference service | ~50% CPU | 16 cores |
| API backend | 264m | 2,000m |
| Postgres | 166m | 4,000m |
| load generator | 42m | 2,000m |

Nothing starved, everything slow. That combination points at serialization rather than
capacity — somewhere in the request path there's a lock, a pool, or a queue with a fixed
width, and until it's found, more hardware buys nothing. Which is itself a useful
result: it rules out the entire class of fixes that involve spending money.

The remaining suspects are inside application images I don't control — the backend's
HTTP client pool to the inference service, its database pool, or a lock in the
inference path. That's where this stops for now, and I'll write a follow-up if I get
access and find it.

The broader point is the one I started with. The tuning question — what worker count,
what concurrency limit, what memory — took an hour to answer once the measurements were
sound. Getting the measurements sound took the rest of the day, and every defect along
the way produced output that looked completely reasonable. A load test is easy to run
and expensive to trust, and the gap between those two is where the actual work is.
