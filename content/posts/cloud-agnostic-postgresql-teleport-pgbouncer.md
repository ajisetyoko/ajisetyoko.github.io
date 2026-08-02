---
title: "Cloud-agnostic PostgreSQL access with Teleport and PgBouncer"
date: 2026-03-07
tags: ["sre", "security", "kubernetes"]
summary: "Standardizing secure, auditable PostgreSQL access across multiple clouds by putting PgBouncer in front of every database and having Teleport speak cert-based auth to it everywhere."
---

Multi-cloud and hybrid setups make one problem worse than anything else: giving engineers and workloads secure, auditable access to databases without every cloud provider's IAM quirks turning into its own bespoke integration.

I wrote up an approach I've been using at Verihubs: put PgBouncer in front of every PostgreSQL instance, and have Teleport always speak certificate-based auth to PgBouncer — regardless of which cloud (or on-prem environment) actually hosts the database. PgBouncer then handles the real backend credentials. The result is one consistent access path for `tsh db connect` (humans) and Machine ID / `tbot` (Kubernetes workloads), with full audit logging, instead of a different IAM dance per provider.

The full write-up covers the architecture, certificate setup, Teleport RBAC roles, the application-side `tbot`/sidecar pattern, and a troubleshooting section for the failure modes I actually hit.

Read the full guide on the [Verihubs engineering blog →](https://medium.com/@Verihubs/cloud-agnostic-zero-bastion-postgresql-access-across-clouds-with-teleport-and-pgbouncer-d2a58fdf66dd)
