---
title: "Your office GPU in production: EKS hybrid nodes, WireGuard, and cloud failover"
date: 2026-09-20
tags: ["sre", "kubernetes", "aws", "gpu", "cost"]
summary: "An office GPU can serve production as long as production doesn't depend on it. EKS Hybrid Nodes make it a regular node in a cluster whose control plane and spare capacity live in the cloud — here's the failover timeline, the per-vCPU fee that decides the economics, and why the tunnel was WireGuard."
---

*You already own a GPU. Here's how to put it behind real traffic without it becoming a
single point of failure, and when it actually saves money.*

---

We had a GPU server in the office. It was paid for and fast, and mostly used for
experiments. Meanwhile, cloud GPUs for production inference were the biggest line on
our bill.

So: **can the office GPU serve production?** The objection comes right after: *"What if
the office loses power, the internet drops, or the server dies?"*

With EKS Hybrid Nodes the answer is **yes, and production doesn't depend on it.** The
office server joins the production EKS cluster as one more node. It takes the steady
load while it's healthy. When it isn't, the cloud part of the same cluster takes over.

This post covers why that beats running the GPU on its own, what happens during a
failure, and the cost detail that decides whether it's worth it.

---

## Why not just run the GPU standalone?

The simplest option is to run the model server directly on the office box, keep the
cloud deployment as it is, and put a load balancer with health checks in front of both.
No Kubernetes on the box, and no EKS Hybrid Nodes fee.

That works for one model that rarely changes. It falls apart as soon as things move:

- **Two deployments to keep in sync.** Every model version, config change and secret has
  to be shipped twice, through two different paths. Sooner or later the office box runs
  last month's model and nobody notices.
- **No spill-over.** When the office GPU is full, the extra load doesn't move to the
  cloud by itself. You size the cloud side by hand, or it scales on its own signal
  without knowing about the office.
- **Failover is only half there.** A health check can stop sending traffic to a dead
  box, but nothing adds cloud capacity to replace it.
- **Two of everything to run.** Monitoring, logging, access control and on-call for a
  machine that sits outside all your usual tooling.

With Hybrid Nodes, the office server is **just another node**. There's one deployment
and one GitOps repo, and with the right scheduling rules the scheduler decides where
each replica runs: office first, cloud when the office is full or down. Replacing lost
capacity is the scheduler's job, not yours.

---

## How it fits together

```
                        ┌──────────────────────────────┐
                        │   EKS control plane (AWS)    │
                        └──────────────┬───────────────┘
                 ┌─────────────────────┴─────────────────────┐
   ┌─────────────▼──────────────┐              ┌─────────────▼──────────────┐
   │ OFFICE  (hybrid node)      │   WireGuard  │ CLOUD  (EC2, Karpenter)    │
   │ GPU you already own        │◄────────────►│ GPU nodes on demand        │
   │ steady load                │    tunnel    │ bursts + failover          │
   └────────────────────────────┘              └────────────────────────────┘
                                                   ▲
                                 internet traffic ─┘  (load balancer in AWS)
```

- **On-prem first.** Inference pods *prefer* the office node. When it's full, extra
  replicas go Pending and Karpenter adds cloud GPU nodes.
- **Traffic enters in the cloud.** With ALB or NLB in `ip` target mode and routable
  on-prem pod CIDRs, the AWS load balancer can send requests to ready pods in the office
  or in the cloud, so failover needs no DNS changes.
- **Fast on the LAN.** Clients in the office call the GPU directly over the local
  network. Their requests never leave the building.
- **The control plane stays in AWS.** This matters more than anything else here. More on
  that at the end.

---

## What happens when the office goes down

"The cloud takes over" is true, but it isn't instant. Assume every replica runs in the
office and the server, its power or the tunnel fails. To the cluster these look the
same: the node stops reporting.

| time | what happens | traffic |
|---|---|---|
| 0 | The node stops reporting. | requests to office pods fail |
| ~40–50 s | Node marked `NotReady`; its pods leave the Service endpoints. | nothing left to serve |
| 5 min | Pods evicted (default `tolerationSeconds: 300`). Replacements go Pending. | down |
| +1–3 min | Karpenter launches a cloud GPU node. | down |
| +2–5 min | Image pulled, model loaded, readiness passes. | back |

**With default settings, expect roughly 8–12 minutes of outage.** These are typical
Kubernetes and Karpenter timings, not a measurement from our setup. It recovers without
anyone touching it, but it's slow. The exact number depends on health checks, pod
tolerations, Karpenter capacity, image size and model load time. Each step can be
shortened:

1. **Retry and eject at the proxy.** Have the ingress retry failed requests on another
   replica and drop a backend after a few errors. It costs nothing, but it only helps if
   another replica is running somewhere, and you need to be careful with streaming or
   non-idempotent requests.
2. **Evict sooner.** Lower `tolerationSeconds` on the inference pods, for example to
   30 s. The catch: every network blip longer than that now evicts pods and starts a
   cloud GPU. Set it above your normal blip length.
3. **Make the cloud start warm.** The slow part is the image and the model, not the
   instance. Bake the image into the node (a custom AMI or Bottlerocket snapshot) or
   lazy-load it with SOCI, and keep model weights close: S3 in the same region, or
   FSx/EFS.
4. **Keep one replica in the cloud permanently.** Failover then takes seconds, with
   reduced capacity. But in Jakarta a g5.2xlarge costs **~$1.24k a month at 730 hours,
   about the same as the rental the office GPU was meant to save.** It only makes sense
   with several office GPUs.

| options | outage | extra cost |
|---|---|---|
| default | ~8–12 min | none |
| 1 + 2 + 3 *(our pick for one GPU)* | ~2–4 min | a little storage |
| 1 + 4 | seconds (reduced capacity) | one cloud GPU, 24/7 |

**Failing back isn't automatic.** "Prefer on-prem" only applies when a pod is scheduled,
so after an outage the replicas stay on cloud GPUs until you move them back with a
rollout restart or a descheduler. Put that in the runbook, or one outage quietly doubles
your GPU bill.

---

## Is it actually cheaper?

The hardware is already paid for, so the real comparison is the cost of running it in
the cluster against renting the same capacity.

The catch: **EKS Hybrid Nodes are billed per vCPU-hour of your machine**, $0.02 per
vCPU-hour in Jakarta's first tier. Hyperthreads count as vCPUs, and the meter runs every
hour the node is registered, busy or idle.

The important part: **the fee is charged on CPUs and ignores the GPU completely.** So
put it next to what renting the same machine would cost:

| your machine | cloud equivalent | rent it: $/month | hybrid fee: $/month | you keep |
|---|---|---|---|---|
| 1 GPU (A10G) · 4 vCPU | g5.xlarge · Jakarta | $1,028 | $58 | 94% |
| 1 GPU (A10G) · 8 vCPU | g5.2xlarge · Jakarta | $1,238 | $117 | 91% |
| 1 L40S · 8 vCPU | g6e.2xlarge · us-east-1\* | $1,637 | $117 | 93% |
| 8× H100 · 192 vCPU | p5.48xlarge · Jakarta | $55,447 | $2,803 | 95% |
| same 1 GPU, but 48 threads registered | — | $1,238 | $701 | 43% |

Hybrid fee: $0.02 per vCPU-hour (first tier) × 730 hours. Public on-demand Linux prices,
checked 2026-09-19. \*L40S instances are not offered in Jakarta; that row uses the
us-east-1 price.

- **Renting one GPU node costs over a thousand dollars a month. Running the one you
  already own inside the same cluster costs about a hundred.** The stronger the GPU, the
  wider the gap, because the fee never changes: an L40S box with 8 registered vCPUs pays
  the same $117 as a much weaker card.
- **The fee is a knob you control.** It follows registered vCPUs and nothing else: 4 vCPU
  costs $58 a month, 8 costs $117, 16 costs $234, 32 costs $467, 48 costs $701, and 192
  costs $2,803. The same GPU in a server that registers all 48 threads costs six times
  more than one that registers 8. Turn off hyperthreading, or use `maxcpus=`, and leave
  enough CPU for tokenisation, batching and system daemons.
- **Non-GPU work is a different story.** An 8-vCPU compute box rents for about $300 a
  month in Jakarta, and the fee is $117 of that, before power, space, and before Savings
  Plans or Spot make the cloud side cheaper. Memory-heavy stateless work sits in between,
  at roughly $466 rental against the same $117.
- **This assumes the machine earns its keep.** Cloud GPUs can scale to zero, so if yours
  is idle most of the day, compare against that instead.

**Rule of thumb:** hybrid pays off when the GPU is busy most of the day and you register
only the cores the model actually needs.

---

## What it takes to build

At a high level:

1. **Network:** a private, routed link between the office and the VPC. The control plane
   has to reach the node's kubelet, and pods have to reach each other, in both
   directions.
2. **Identity:** an IAM role and an SSM activation give the node AWS credentials, since
   an office server has no EC2 instance role.
3. **Join:** `nodeadm` registers the server. It appears as an `mi-*` node.
4. **CNI:** Cilium on the office node only. The VPC CNI hands out VPC IPs, which can't
   exist in the office.
5. **GPU:** the NVIDIA toolkit, the device plugin, and a taint so only chosen workloads
   land on it.

It took a few days. Most of that went into pitfalls the docs don't mention:

- **`AmazonEKSHybridNodesPolicy` doesn't exist.** The name sounds official, but you have
  to build the node's IAM role yourself.
- **Older AWS Terraform providers replace the cluster.** Before v6.11.0, enabling hybrid
  networking forced a new cluster. Read the plan before you apply.
- **The gateway needs an "allow from VPC" rule.** Without it the node shows `Ready`, but
  `kubectl logs` and `exec` time out.
- **Cilium restarts pods on every cloud node by default.** Its operator treats pods
  managed by the VPC CNI as unmanaged. Set `unmanagedPodWatcher.restart: false`.

### Why WireGuard

AWS documents **Site-to-Site VPN**, **Direct Connect**, or your own VPN connection.
Site-to-Site VPN and Direct Connect did not fit one server. Site-to-Site VPN needs a VPN
device in the office with a static public IP, IPsec and usually BGP, which means changing
the office network. Direct Connect is a physical circuit: weeks to set up, and far more
than one GPU is worth.

Our server sat behind NAT with no inbound access. WireGuard **dials out** to a small
gateway in the VPC, and a 25-second keepalive holds the NAT open so AWS can reach back.
It's one config file per side and a ~$19-a-month t3.small gateway, and no other team has
to be involved.

The price is that **we own the reliability.** One gateway on one internet path dropped
several times a day. The failover design makes that survivable, because a tunnel drop
looks exactly like the office going down, but each drop costs a failover. WireGuard was
good enough for a pilot and a small number of nodes where occasional failover was
acceptable. For stricter production SLOs, use redundant Site-to-Site VPN or Direct
Connect. The Kubernetes design stays the same; only the route becomes more reliable.

---

## When it isn't worth it

- **The GPU would sit idle.** The fee runs every hour. For spiky, low-average load, cloud
  GPUs that scale to zero are cheaper.
- **It's CPU work.** The fee is around 40% of the cloud price before power and upkeep, so
  there's little left.
- **The workload talks across the tunnel constantly**, for example office pods querying a
  database in AWS. Self-contained work like inference fits best.
- **You need seconds-level failover with one GPU.** That needs a permanent cloud replica,
  which cancels most of the saving.

---

## Why not run the control plane in the office too?

Run a self-managed cluster in the office (RKE2, for example) and add EC2 instances as
extra nodes: no hybrid fee and no EKS fee. On paper it's cheaper.

But every step of the recovery above (marking the node down, evicting pods, launching
cloud GPUs) is done **by the control plane**. If it lives in the office and the office
goes down, nothing is left to move the workload. Cloud nodes keep running what they have,
and nothing recovers.

Cheaper on paper, but the failover this whole post relies on stops working. If you go
that way, the control plane has to survive the office going down, and that's a different
design.

---

## Wrapping up

An office GPU can serve production as long as production doesn't depend on it. EKS
Hybrid Nodes make it a regular node in a cluster whose control plane and spare capacity
are in the cloud: the office takes the steady load, and the cloud takes bursts and
failures.

After all of this, I'd recommend hybrid in only two cases.

**First, when the workload runs on GPUs and you want the cloud as a standby.** GPUs are
the one resource where the savings in cost and latency justify the fee and the extra
moving parts. That holds only if your model is tuned to keep the work on the GPU.
CPU-heavy pre- and post-processing puts you back on the per-vCPU meter.

**Second, when you need to cut costs and can accept a few minutes of reduced service
during a failover.** Hybrid trades a little resilience for a lot of savings. Make sure
that trade is a decision, not a surprise.

If neither applies, stay all-cloud.

---

Also published on [Beyond Localhost →](https://medium.com/beyond-localhost/d32d38b6d6a2)
