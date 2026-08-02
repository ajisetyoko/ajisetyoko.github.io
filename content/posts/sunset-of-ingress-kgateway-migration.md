---
title: "The sunset of Ingress: migrating a production cluster to KGateway"
date: 2026-04-06
tags: ["sre", "kubernetes", "networking"]
summary: "A migration story, not a tutorial: moving a production EKS cluster from AWS ALB Ingress to KGateway for native rate limiting, without a risky big-bang cutover."
---

Kubernetes has frozen Ingress — no new features, and Gateway API is the official successor. That alone isn't urgent, but I needed proper rate limiting that wasn't another controller-specific annotation or a bolted-on sidecar, and the cleanest path there was KGateway: Envoy, configured through Kubernetes-native objects instead of a black-box controller.

This is the migration story, not the quickstart: moving a production EKS cluster running NVIDIA Triton behind an ALB Ingress over to KGateway, with HTTP and gRPC on separate routes, native rate limiting backed by Envoy's rate limit service and Redis, and a phased rollout designed so rollback was never more than reversing one change — install and validate internally, prove it against real production traffic on an internal load balancer, then cut DNS over.

The full post covers the conceptual shift from configuring a black-box proxy through annotations to composing the request pipeline out of explicit Kubernetes objects, the full phased migration plan, and the lessons learned — including one load-balancer header bug that silently broke rate limiting in production.

Read the full write-up on the [Verihubs engineering blog →](https://medium.com/@Verihubs/the-sunset-of-ingress-and-how-to-transition-to-kgateway-e550e144d8ec)
