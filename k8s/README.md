# Kubernetes deployment

Kustomize-based manifests (no Helm, no extra binary beyond `kubectl` — every
recent `kubectl` has `kustomize` built in via `kubectl apply -k`).

```
k8s/
  base/          namespace, app Deployment+Service+HPA+PDB, Redis, Postgres
                 (StatefulSet), Kafka (StatefulSet, KRaft single-broker),
                 NetworkPolicy, ConfigMap/Secret
  overlays/
    dev/         1 replica, minimal resources, HPA effectively off — for kind/minikube
    prod/        3 replicas, higher resource ceilings, wider HPA range, bigger PVCs
  monitoring/
    servicemonitor.yaml   optional, requires the Prometheus Operator's CRDs
```

## Try it locally (kind)

```bash
# 1. Build the image and load it into a local kind cluster
docker build -t supply-chain-saga:dev .
kind create cluster --name supply-chain-saga
kind load docker-image supply-chain-saga:dev --name supply-chain-saga

# 2. Deploy the dev overlay
kubectl apply -k k8s/overlays/dev

# 3. Watch it come up
kubectl -n supply-chain-saga get pods -w

# 4. Reach the API
kubectl -n supply-chain-saga port-forward svc/app 3000:80
curl localhost:3000/healthz
```

For a production-shaped profile: `kubectl apply -k k8s/overlays/prod` (bump
the image tag in that overlay's `images:` block to a real tag you've pushed
first — `stable` is a placeholder).

## What's actually demonstrated here

- **Liveness vs. readiness done correctly**: `/healthz` never touches Redis
  (so a flaky dependency can't cause a restart-loop); `/readyz` does check
  Redis with a timeout, so Kubernetes pulls an unready pod out of the
  Service's rotation instead of restarting a perfectly healthy process.
- **HorizontalPodAutoscaler + PodDisruptionBudget together**: the app scales
  out under load and always keeps at least one (dev) / two (prod) pods
  available during a voluntary node drain.
- **StatefulSets with volumeClaimTemplates** for Postgres and Kafka, vs. a
  plain Deployment for the stateless app tier — the manifests reflect an
  actual understanding of when each workload type is appropriate, not a
  copy-pasted Deployment for everything.
- **NetworkPolicy micro-segmentation**: Redis/Postgres/Kafka only accept
  traffic from the app tier (or, for Kafka, from its own broker pods),
  not from every pod in the namespace.
- **Kustomize base + overlays**: one source of truth (`base/`) with
  environment-specific sizing expressed as small, explicit JSON-patch diffs
  (`overlays/dev`, `overlays/prod`) rather than duplicated YAML.
- **This is exactly what the app is for**: `app-deployment.yaml` defaults to
  2 replicas specifically because InventoryService's no-oversell guarantee
  has to hold *across* multiple concurrently-running pods, not just within
  one process — deploying this with `replicas: 1` would quietly undersell
  the whole point of the project.

## Honest limitations (say these in an interview before you're asked)

- Redis and Kafka here are single instances for demo simplicity — see the
  comments in `k8s/base/redis.yaml` and `k8s/base/kafka.yaml` for what a real
  HA setup would use instead (Sentinel/Cluster; the Strimzi operator).
- No Ingress/TLS termination included — add one (or a Gateway API resource)
  in front of the `app` Service for anything beyond `port-forward`.
- `k8s/base/app-secret.yaml` is a plain committed Secret for local demo
  convenience only. Don't do this with real credentials — use `kubectl
  create secret` out-of-band, or Sealed Secrets / an External Secrets
  Operator, in anything real.
- These manifests were written and YAML-syntax-validated (`python -c
  "import yaml; ..."` over every file) in an environment without `kubectl`
  or `kind` available to actually run `kubectl apply` end-to-end — validate
  the full deploy on your own cluster before relying on it, the same way
  you should re-run `npm run verify` before quoting its numbers.
