---
title: "Your infrastructure baseline is now your AI leverage"
date: 2026-08-04
tags: ["sre", "kubernetes", "terraform", "ai"]
summary: "A production EKS cluster — Karpenter, ArgoCD, Argo Rollouts, full GitOps — stood up in 22 hours instead of two weeks. The speedup came from the reference implementations we already had, not from the model."
---

We brought up a production Kubernetes cluster in 22 hours and 14 minutes — EKS with Karpenter, ArgoCD, Argo Rollouts — and had GitOps fully wired about two days later. The quality was what I'd expect from two weeks of careful work.

The interesting part isn't the speed. It's what the speed depended on: two existing Terraform repositories that were well documented and opinionated. Not a module library — concrete implementations with clear conventions, good enough to point at and say "use this as the basis." Without that baseline, the same tooling would have produced something much worse, much faster.

That inverts the usual economics. Careful, thorough implementation used to be the expensive option and abstraction was how you amortized it; when adaptation gets cheap, the case for building abstract reusable modules gets a lot weaker. Verification changes too — less line-by-line auditing, more asking whether a resource configuration makes sense at all, which is a judgment call you can only make if you already know what right looks like.

Which is the limit. This only stays safe with a senior reviewer in the loop. Remove that and the same velocity gives you confident, plausible, subtly wrong infrastructure — the model authors, but somebody experienced still has to adjudicate, especially around security boundaries and blast radius.

The full post covers the timeline, what made the reference repos usable, how the review process actually worked, and what I'd tell a platform team to build first.

Read the full write-up on the [Verihubs engineering blog →](https://medium.com/@Verihubs/your-infrastructure-baseline-is-now-your-ai-leverage-573c4a118996)
