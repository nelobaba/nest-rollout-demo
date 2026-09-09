# Lab: Progressive Delivery & Automatic Rollback with Argo Rollouts on Kind 🚦

**Goal:** on a **Kind** cluster, install **Cilium** (the network), **Argo CD** (GitOps — watches
your GitHub repo), and **Argo Rollouts** (progressive delivery). Then deploy a tiny **NestJS** app
whose image lives on **Docker Hub**, and **watch Argo Rollouts automatically roll back** when you
ship a *bad* image — traffic never lands on the broken version.

This is a **training lab**. The point isn't the app (it returns one line of JSON); it's the
**machinery**: how a canary rollout tests a new version in production-like conditions, how an
**analysis** decides "this version is unhealthy," and how the system **keeps the last good version
serving** instead of taking your service down.

We go: mental model → who does what → words → prerequisites → the big loop → install each piece →
build & push the app → put manifests in Git → let Argo CD watch → ship v1 (happy path) → ship a
**bad v2** and watch the automatic rollback → recover the GitOps way → clean up → troubleshoot.

> Sister doc: [`POSTGRES_MIGRATION_K8S_JOB_LAB.md`](./POSTGRES_MIGRATION_K8S_JOB_LAB.md) — a Job-based
> lab in the same style. That one is "run once to completion"; this one is "keep a service alive
> and upgrade it safely."

---

## Table of Contents

1. [The Mental Model (an analogy)](#1-the-mental-model-an-analogy)
2. [Who Does What (the four tools)](#2-who-does-what-the-four-tools)
3. [Words You Need to Know](#3-words-you-need-to-know)
4. [Prerequisites (do these first)](#4-prerequisites-do-these-first)
5. [The Big Loop (what we're building)](#5-the-big-loop-what-were-building)
6. [Step 1 — Verify (or recreate) the Kind cluster](#step-1--verify-or-recreate-the-kind-cluster)
7. [Step 2 — Install Cilium (the CNI)](#step-2--install-cilium-the-cni)
8. [Step 3 — Install Argo CD (GitOps)](#step-3--install-argo-cd-gitops)
9. [Step 4 — Install Argo Rollouts (controller + kubectl plugin)](#step-4--install-argo-rollouts-controller--kubectl-plugin)
10. [Step 5 — Build the NestJS app and push v1 + v2 to Docker Hub](#step-5--build-the-nestjs-app-and-push-v1--v2-to-docker-hub)
11. [Step 6 — Put the Kubernetes manifests in GitHub](#step-6--put-the-kubernetes-manifests-in-github)
12. [Step 7 — Create the Argo CD Application (watch GitHub)](#step-7--create-the-argo-cd-application-watch-github)
13. [Step 8 — Ship v1 (the happy path)](#step-8--ship-v1-the-happy-path)
14. [Step 9 — Ship a BAD v2 and watch the automatic rollback](#step-9--ship-a-bad-v2-and-watch-the-automatic-rollback)
15. [Step 10 — Recover the GitOps way](#step-10--recover-the-gitops-way)
16. [Step 11 — Clean up](#step-11--clean-up)
17. [Troubleshooting](#troubleshooting)
18. [Production hardening checklist](#production-hardening-checklist)
19. [One-paragraph summary](#one-paragraph-summary)

---

## 1. The Mental Model (an analogy)

Imagine a **restaurant kitchen** that wants to change its signature sauce recipe. 🍝

The reckless way: swap the recipe for **every plate at once**. If the new sauce is bad, *every
customer* gets a ruined meal simultaneously. That's a normal `kubectl set image` on a Deployment —
all pods flip to the new version, and if it's broken, your whole service is broken.

The careful way: the head chef makes the new sauce for **one table out of four**, then a **taster**
(who has one job: taste and judge) checks those plates. If the taster says "this is bad," the chef
**throws out the new batch and keeps serving the old, trusted recipe** to everyone. No customer
riot, no closing the restaurant.

- The **new batch** for one table = the **canary** (a few pods running the new image).
- The **taster** = an **Argo Rollouts *analysis*** — an automated probe that judges the canary's
  health.
- "**Throw out the new batch, keep the old recipe**" = **automatic rollback**: Argo Rollouts
  *aborts* the rollout and keeps the last stable version serving 100% of traffic.

That's the whole lab. Argo Rollouts is the disciplined head chef; the analysis is the taster; the
"bad v2 image" is the ruined sauce.

---

## 2. Who Does What (the four tools)

Four separate tools, four separate jobs. Keeping them straight is half the battle.

| Tool | One-line job | Layer |
|------|--------------|-------|
| **Kind** | Runs a real Kubernetes cluster *inside Docker* on your laptop. | The cluster |
| **Cilium** | The **CNI** — gives pods IPs, routes pod-to-pod traffic, enforces network policy (eBPF-based). Nothing schedules without a working CNI. | Networking |
| **Argo CD** | **GitOps engine.** Watches your **GitHub** repo and makes the cluster match what's in Git. This is the piece that "watches for new versions." | Delivery (what to run) |
| **Argo Rollouts** | **Progressive delivery controller.** Replaces the built-in `Deployment` with a smarter `Rollout` that does canary/blue-green, runs analysis, and **rolls back automatically** when a version is unhealthy. | Deployment strategy (how to roll it out) |

The crucial split most people miss:

- **Argo CD** decides *"the desired image is `:v2` because someone committed that to Git."*
- **Argo Rollouts** decides *"…but `:v2` fails its health analysis, so I will NOT send traffic to
  it — I'm keeping `:v1` live."*

They cooperate: Argo CD delivers the *intent* from Git; Argo Rollouts safely *executes* it and
protects you when the intent turns out to be a mistake.

---

## 3. Words You Need to Know

| Word | Plain version |
|------|---------------|
| **Kind** | "Kubernetes IN Docker." A throwaway local cluster; each node is a Docker container. |
| **CNI** | Container Network Interface — the plugin that wires up pod networking. **Cilium** is ours. |
| **GitOps** | Git is the single source of truth. You change the cluster by committing to a repo, not by typing `kubectl`. Argo CD reconciles the two. |
| **Rollout** | A custom resource from Argo Rollouts. Like a `Deployment`, but with a `strategy` for canary/blue-green and hooks for analysis. |
| **Canary** | A small slice of pods running the *new* version, tested before the rest follow. |
| **Stable** | The pods running the *last known-good* version. Traffic falls back here on abort. |
| **Analysis / AnalysisTemplate** | An automated judge that runs *during* a rollout — queries a metric or probes an endpoint and returns pass/fail. Failure aborts the rollout. |
| **Abort** | Argo Rollouts stops progressing, scales the canary back to zero, and keeps **stable** at 100%. This *is* the automatic rollback. |
| **`progressDeadlineSeconds`** | How long a rollout may make no progress before it's considered failed. |
| **`progressDeadlineAbort`** | If `true`, hitting the deadline **auto-aborts** (instead of just sitting Degraded). |
| **Docker Hub** | The public container registry we push the app image to (`docker.io/<user>/nest-rollout-demo`). |
| **Hubble** | Cilium's observability UI — lets you *see* traffic flows during the rollout (optional but fun). |

---

## 4. Prerequisites (do these first)

Install these CLIs and confirm each one responds. Each missing tool is a classic 20-minutes-lost.

```bash
docker version        # Docker Desktop / Engine running (Kind needs it)
kind version          # >= 0.20
kubectl version --client
helm version          # v3 (used for Cilium + optional installs)
cilium version --client   # Cilium CLI (brew install cilium-cli)
git --version
```

You also need:

- A **Docker Hub account** and a **Docker Hub access token** (Account Settings → Security → New
  Access Token). We push the app image here.
- A **GitHub repo** you control (public is fine for the lab). This holds **both** the app source
  *and* the Kubernetes manifests. Argo CD watches it.
- Node.js 20+ locally *only if* you want to run the app outside Docker; the Docker build doesn't
  need it on your host.

Set these once so the commands below are copy-paste-able:

```bash
export DOCKERHUB_USER="<your-dockerhub-username>"
export GH_USER="<your-github-username>"
export GH_REPO="nest-rollout-demo"                 # the repo you'll create
export IMAGE="docker.io/${DOCKERHUB_USER}/nest-rollout-demo"
```

---

## 5. The Big Loop (what we're building)

```
   You (developer)
     │  git push (new image tag in a manifest, or a new git tag → CI builds image)
     ▼
   ┌───────────────────┐        watches         ┌──────────────────────────────┐
   │  GitHub repo       │  ◀───────────────────  │  Argo CD  (in the cluster)     │
   │  - src/ (NestJS)   │                        │  reconciles Git → cluster      │
   │  - k8s/ (manifests)│                        └──────────────┬─────────────────┘
   └─────────┬──────────┘                                       │ applies the Rollout
             │ CI (GitHub Actions)                              ▼
             │ build + push image            ┌─────────────────────────────────────┐
             ▼                               │  Argo Rollouts controller             │
   ┌───────────────────┐   pulls image       │  runs the canary + the analysis       │
   │  Docker Hub        │  ◀───────────────── │  ┌──────────┐   ┌────────────────┐   │
   │  :v1 (good)        │                     │  │ canary   │   │ AnalysisRun     │   │
   │  :v2 (BAD)         │                     │  │ pods(v2) │◀──│ GET /health ✗   │   │
   └───────────────────┘                     │  └──────────┘   └──────┬─────────┘   │
                                              │        │  FAIL → ABORT │             │
                                              │        ▼               ▼             │
                                              │  scale canary → 0   keep stable(v1)  │
                                              └───────────────┬───────────────────────┘
                                                              ▼
                                              Users only ever hit healthy v1  ✅
                                              (Cilium routes all of this pod traffic)
```

The lab exercises this loop twice: once with a **good** image (v1 → rollout completes) and once
with a **bad** image (v2 → analysis fails → automatic rollback, users unaffected).

---

## Step 1 — Verify (or recreate) the Kind cluster

The lab assumes a Kind cluster **already exists**. One catch: **Cilium must replace the default
CNI**, and that's cleanest when the cluster was created with the default CNI *disabled*. Check what
you have:

```bash
kubectl config current-context          # e.g. kind-kind
kubectl get nodes -o wide                # nodes present?
kubectl -n kube-system get pods | grep -Ei 'kindnet|cilium|calico'
```

- If you see **`kindnet-*`** pods, the cluster is using Kind's default CNI. You *can* migrate to
  Cilium, but for a training lab the reliable path is to **recreate** the cluster with the default
  CNI disabled (below). Recreating a Kind cluster takes ~1 minute and avoids half-migrated
  networking.
- If you see **`cilium-*`** pods already, skip to [Step 3](#step-3--install-argo-cd-gitops).

### Recommended: recreate Kind with the CNI slot open

```yaml
# kind-cilium.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: rollouts-lab
networking:
  disableDefaultCNI: true      # <-- no kindnet; Cilium will fill this slot
  # kubeProxyMode: none        # (advanced) uncomment to let Cilium fully replace kube-proxy
nodes:
  - role: control-plane
  - role: worker
  - role: worker
```

```bash
kind delete cluster --name rollouts-lab 2>/dev/null || true
kind create cluster --config kind-cilium.yaml
```

**Why disable the default CNI:** two CNIs fighting over pod networking is a debugging nightmare.
Starting with the slot empty lets Cilium own networking cleanly. Right after creating the cluster,
**nodes will be `NotReady`** — that's expected and correct; there's no CNI yet. Step 2 fixes it.

```bash
kubectl get nodes
# NAME                          STATUS     ...   <-- NotReady is EXPECTED here (no CNI yet)
```

---

## Step 2 — Install Cilium (the CNI)

Cilium gives every pod an IP and routes traffic between them using **eBPF**. Until it's healthy,
nothing else in this lab can run.

```bash
# The Cilium CLI auto-detects Kind and picks sane defaults.
cilium install

# Wait until the control plane and agents report healthy.
cilium status --wait
```

You should see `Cilium: OK`, `Operator: OK`, and a count of managed pods. Now the nodes flip to
`Ready`:

```bash
kubectl get nodes           # all Ready now
kubectl -n kube-system get pods -l k8s-app=cilium
```

**Optional — verify networking with Cilium's own test** (great confidence check on a fresh CNI):

```bash
cilium connectivity test    # takes a few minutes; spins up test pods, then cleans up
```

**Optional — Hubble (see the traffic during your rollout):**

```bash
cilium hubble enable --ui
cilium hubble ui            # opens a browser UI; watch flows hit v1 vs v2 later
```

> **Alternative (Helm) install** if you prefer not to use the Cilium CLI:
> ```bash
> helm repo add cilium https://helm.cilium.io && helm repo update
> helm install cilium cilium/cilium --namespace kube-system \
>   --set image.pullPolicy=IfNotPresent --set ipam.mode=kubernetes
> kubectl -n kube-system rollout status ds/cilium
> ```

---

## Step 3 — Install Argo CD (GitOps)

Argo CD is the piece that **watches GitHub**. Install it into its own namespace:

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Wait for the core components
kubectl -n argocd rollout status deploy/argocd-server
kubectl -n argocd rollout status deploy/argocd-repo-server
kubectl -n argocd rollout status statefulset/argocd-application-controller
```

Get into the UI (optional but recommended — the rollout is very visual):

```bash
# Initial admin password (username is: admin)
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo

# Expose the UI locally
kubectl -n argocd port-forward svc/argocd-server 8080:443
# then open https://localhost:8080  (accept the self-signed cert)
```

Optionally log in with the CLI too (handy for scripting):

```bash
argocd login localhost:8080 --username admin --password '<the-password-above>' --insecure
```

**Why Argo CD and not just `kubectl apply`?** Because the whole premise of the lab is *"Argo
watches GitHub for new versions."* Argo CD continuously reconciles: whatever is committed to the
repo becomes the cluster's desired state, automatically. You'll change the app by pushing to Git —
not by touching the cluster by hand.

---

## Step 4 — Install Argo Rollouts (controller + kubectl plugin)

This is the progressive-delivery brain. Two parts: the **controller** (runs in-cluster) and the
**kubectl plugin** (your window into rollout status on the CLI).

```bash
# Controller
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts \
  -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
kubectl -n argo-rollouts rollout status deploy/argo-rollouts
```

Install the **kubectl plugin** (macOS shown; see the releases page for Linux/arm):

```bash
# Apple Silicon: use ...-darwin-arm64 ; Intel Mac: ...-darwin-amd64
curl -sSL -o kubectl-argo-rollouts \
  https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-darwin-arm64
chmod +x kubectl-argo-rollouts
sudo mv kubectl-argo-rollouts /usr/local/bin/

kubectl argo rollouts version
```

There's also a **live dashboard** — the clearest way to watch a canary progress and abort:

```bash
kubectl argo rollouts dashboard        # serves http://localhost:3100
```

> **Why a separate `Rollout` type at all?** A stock `Deployment` only knows "replace old pods with
> new ones." It cannot pause at 25%, ask a taster if the new version is healthy, or *undo itself*
> when the answer is no. The `Rollout` CRD adds exactly those abilities. Everything else (Services,
> probes, labels) works the same.

---

## Step 5 — Build the NestJS app and push v1 + v2 to Docker Hub

A deliberately tiny NestJS service. It reports its **version** and exposes **`/health`** — the
endpoint the analysis will probe. We ship **two images**: `:v1` (healthy) and `:v2` (a simulated
regression whose `/health` returns HTTP 500).

Create the repo locally:

```bash
mkdir -p ${GH_REPO}/src ${GH_REPO}/k8s ${GH_REPO}/.github/workflows
cd ${GH_REPO}
```

### 5.1 — App source

`src/main.ts`:

```ts
import 'reflect-metadata';
import {
  Module,
  Controller,
  Get,
  InternalServerErrorException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

// The version is baked in at build time via an env var (see the Dockerfile).
const VERSION = process.env.APP_VERSION ?? 'dev';
// Flip this to make an image "bad" without changing app logic. v2's image sets it to "true".
const FAIL_HEALTH = process.env.FAIL_HEALTH === 'true';

@Controller()
class AppController {
  @Get()
  root() {
    return { app: 'nest-rollout-demo', version: VERSION };
  }

  @Get('health')
  health() {
    // The "taster" (Argo Rollouts analysis) hits this endpoint.
    if (FAIL_HEALTH) {
      // Simulated regression: v2 is broken. Returns HTTP 500.
      throw new InternalServerErrorException({
        status: 'unhealthy',
        version: VERSION,
      });
    }
    return { status: 'ok', version: VERSION };
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`nest-rollout-demo ${VERSION} listening on :3000 (FAIL_HEALTH=${FAIL_HEALTH})`);
}
bootstrap();
```

`package.json`:

```json
{
  "name": "nest-rollout-demo",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@nestjs/common": "^10.3.0",
    "@nestjs/core": "^10.3.0",
    "@nestjs/platform-express": "^10.3.0",
    "reflect-metadata": "^0.2.1",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "outDir": "./dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": false
  },
  "include": ["src/**/*.ts"]
}
```

`Dockerfile`:

```dockerfile
# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# APP_VERSION / FAIL_HEALTH are provided at build or run time (see below).
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
```

`.dockerignore`:

```
node_modules
dist
.git
```

### 5.2 — Build and push both images

We only build **one** codebase. The difference between good and bad is the **`FAIL_HEALTH`**
runtime env var, which we set in the manifest for v2 (Step 6). But to make the demo feel real —
"a bad *image* got rolled back" — we also tag two distinct images so the Rollout literally changes
its `image:` tag. `:v1` is healthy; `:v2` is the "new release" we'll point `FAIL_HEALTH=true` at.

```bash
echo "<your-dockerhub-token>" | docker login -u "${DOCKERHUB_USER}" --password-stdin

# v1 — the stable, good image
docker build --build-arg APP_VERSION=v1 -t ${IMAGE}:v1 .
docker push ${IMAGE}:v1

# v2 — the "new release" (same code; we'll make it misbehave via FAIL_HEALTH in the manifest)
docker build --build-arg APP_VERSION=v2 -t ${IMAGE}:v2 .
docker push ${IMAGE}:v2
```

> **Want a genuinely broken image instead of an env-flag?** Change the `health()` method to always
> `throw`, build that as `:v2`, and skip the `FAIL_HEALTH` env in the manifest. Either way the
> analysis sees HTTP 500 from the canary and aborts. The env-flag approach keeps one codebase, which
> is easier to reason about in a lab.

### 5.3 — (Recommended) CI that pushes on a git tag

So that "push a new version to GitHub" really does produce a Docker Hub image, add
`.github/workflows/docker.yml`:

```yaml
name: build-and-push
on:
  push:
    tags: ['v*']            # pushing tag v3 builds and pushes docker.io/<user>/nest-rollout-demo:v3
jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          build-args: APP_VERSION=${{ github.ref_name }}
          tags: docker.io/${{ secrets.DOCKERHUB_USERNAME }}/nest-rollout-demo:${{ github.ref_name }}
```

Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` as **repository secrets** in GitHub
(Settings → Secrets and variables → Actions). Now `git tag v3 && git push origin v3` builds and
pushes automatically.

---

## Step 6 — Put the Kubernetes manifests in GitHub

These live in `k8s/` in the **same repo**. Argo CD will sync this folder into the cluster.

### 6.1 — Namespace

`k8s/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: demo
```

### 6.2 — Two Services: stable and canary

Argo Rollouts manages the pod-selector on these two Services for you (it injects a per-ReplicaSet
hash), so **stable** traffic and **canary** traffic can be probed separately — **no service mesh
required**.

`k8s/services.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nest-demo-stable      # always points at the last-good (stable) pods
  namespace: demo
spec:
  selector:
    app: nest-demo
  ports:
    - port: 80
      targetPort: 3000
---
apiVersion: v1
kind: Service
metadata:
  name: nest-demo-canary      # points ONLY at canary pods during a rollout
  namespace: demo
spec:
  selector:
    app: nest-demo
  ports:
    - port: 80
      targetPort: 3000
```

### 6.3 — The AnalysisTemplate (the "taster")

This probes the **canary** Service's `/health` and requires the JSON field `status == "ok"`.
A 500 (our bad v2) or any non-`ok` body counts as failure.

`k8s/analysistemplate.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: health-check
  namespace: demo
spec:
  args:
    - name: canary-service          # passed in by the Rollout
  metrics:
    - name: canary-health
      interval: 10s                 # probe every 10s
      count: 5                      # take 5 measurements
      successCondition: 'result == "ok"'
      failureLimit: 1               # a single failed measurement fails the whole analysis
      provider:
        web:
          url: 'http://{{args.canary-service}}.demo.svc.cluster.local/health'
          method: GET
          jsonPath: '{$.status}'    # extract .status from the JSON body → compared above
```

### 6.4 — The Rollout

The heart of the lab. A **canary** strategy: 25% → *analysis* → 50% → 100%, with **automatic
abort** on failure.

`k8s/rollout.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: nest-demo
  namespace: demo
spec:
  replicas: 4
  revisionHistoryLimit: 3
  progressDeadlineSeconds: 120       # if no progress for 120s...
  progressDeadlineAbort: true        # ...auto-abort (don't just sit Degraded)
  selector:
    matchLabels:
      app: nest-demo
  template:
    metadata:
      labels:
        app: nest-demo
    spec:
      containers:
        - name: nest-demo
          image: docker.io/REPLACE_ME/nest-rollout-demo:v1   # <-- edit to your Docker Hub user
          ports:
            - containerPort: 3000
          env:
            - name: FAIL_HEALTH
              value: "false"          # v1 is healthy. Step 9 flips this to "true" for the bad release.
          readinessProbe:             # a pod out of this probe never receives traffic
            httpGet: { path: /health, port: 3000 }
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /health, port: 3000 }
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests: { cpu: "50m", memory: "64Mi" }
            limits:   { cpu: "250m", memory: "128Mi" }
  strategy:
    canary:
      stableService: nest-demo-stable
      canaryService: nest-demo-canary
      steps:
        - setWeight: 25
        - pause: { duration: 30s }
        - analysis:                    # <-- the taster runs here, against the canary
            templates:
              - templateName: health-check
            args:
              - name: canary-service
                value: nest-demo-canary
        - setWeight: 50
        - pause: { duration: 30s }
        - setWeight: 100
```

> **Edit `REPLACE_ME`** to your Docker Hub username before committing. (In real GitOps you'd use
> Kustomize or Helm so the image is a single value — kept literal here for clarity.)

### 6.5 — Commit and push

```bash
git init -b main
git add .
git commit -m "nest-rollout-demo: app + k8s manifests"
git remote add origin git@github.com:${GH_USER}/${GH_REPO}.git
git push -u origin main
```

---

## Step 7 — Create the Argo CD Application (watch GitHub)

Tell Argo CD: *"watch the `k8s/` folder in my GitHub repo and keep the `demo` namespace matching
it."* Apply this to the cluster **once** (this Application object is the only thing you apply by
hand — everything else flows from Git).

`argocd-app.yaml` (apply with `kubectl`, or create it in the Argo CD UI):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: nest-rollout-demo
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/REPLACE_GH_USER/nest-rollout-demo.git   # <-- your repo
    targetRevision: main
    path: k8s                       # the folder Argo CD watches
  destination:
    server: https://kubernetes.default.svc
    namespace: demo
  syncPolicy:
    automated:                      # <-- this is "watch for new versions": auto-sync on every push
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```bash
kubectl apply -f argocd-app.yaml

# Watch Argo CD notice the repo and sync it
argocd app get nest-rollout-demo          # or watch it in the UI at https://localhost:8080
kubectl -n demo get rollout,svc,pods
```

**What just happened:** Argo CD read `k8s/`, created the namespace, the two Services, the
AnalysisTemplate, and the Rollout. Because `automated` sync is on, **any future push** to `main`
that changes these files is applied to the cluster automatically. *That* is Argo "watching for new
versions."

---

## Step 8 — Ship v1 (the happy path)

The Rollout starts at `:v1`. On first creation, Argo Rollouts brings it straight to 100% (there's
no previous stable to canary against). Watch it settle:

```bash
kubectl argo rollouts get rollout nest-demo -n demo --watch
```

You want:

```
Status:        ✔ Healthy
Strategy:      Canary
Images:        docker.io/<user>/nest-rollout-demo:v1 (stable)
```

Prove it serves:

```bash
kubectl -n demo port-forward svc/nest-demo-stable 8081:80
# in another shell:
curl -s localhost:8081/        # {"app":"nest-rollout-demo","version":"v1"}
curl -s localhost:8081/health  # {"status":"ok","version":"v1"}
```

Everything green. Now break it on purpose.

---

## Step 9 — Ship a BAD v2 and watch the automatic rollback

This is the payoff. We change the manifest **in Git** — the GitOps way — to roll out the new
release, and make it unhealthy. Edit `k8s/rollout.yaml`:

1. Change the image tag to `:v2`.
2. Flip `FAIL_HEALTH` to `"true"` (this makes v2's `/health` return HTTP 500 — the "regression").

```yaml
          image: docker.io/<user>/nest-rollout-demo:v2   # was :v1
          env:
            - name: FAIL_HEALTH
              value: "true"                               # was "false" — v2 is now broken
```

Commit and push:

```bash
git commit -am "release v2 (contains a regression: /health fails)"
git push
```

Now **watch**. Argo CD syncs the new spec within a minute (or click *Refresh* in the UI); Argo
Rollouts begins the canary:

```bash
kubectl argo rollouts get rollout nest-demo -n demo --watch
```

The story unfolds:

1. **`setWeight: 25`** — Argo Rollouts spins up canary pods on `:v2` with `FAIL_HEALTH=true`.
   Their `readinessProbe` (`/health`) gets 500 → the pods **never become Ready**.
2. **`analysis`** — the `health-check` template probes `nest-demo-canary/health`, gets 500 (or no
   ready endpoints), records a failed measurement → `failureLimit: 1` is hit → **the AnalysisRun
   fails.**
3. **Automatic rollback** — a failed analysis **aborts** the Rollout. Argo Rollouts scales the
   `:v2` canary back toward zero and keeps the **stable `:v1`** ReplicaSet serving 100%.
   (Even if the analysis somehow stalled, `progressDeadlineAbort: true` would abort at the 120s
   deadline.)

You'll see status transition to **`Degraded`** with a message like *"Rollout aborted update to
revision N: … analysis run failed"*:

```
Status:          ✖ Degraded
Message:         RolloutAborted: ... AnalysisRun 'nest-demo-...' Failed
Images:          nest-rollout-demo:v1 (stable)      <-- traffic still on v1
                 nest-rollout-demo:v2 (canary)      <-- scaled down, not receiving traffic
```

**Critically, users were never affected.** The stable Service keeps answering with v1:

```bash
kubectl -n demo port-forward svc/nest-demo-stable 8081:80
curl -s localhost:8081/health     # STILL {"status":"ok","version":"v1"}
```

Inspect the analysis that made the call:

```bash
kubectl -n demo get analysisrun
kubectl -n demo describe analysisrun <name>     # see the failed measurements (HTTP 500)
```

> **The one-sentence lesson:** a `Deployment` would have replaced all four pods with broken v2 and
> taken the service down. The `Rollout` tested v2 on a slice, the analysis caught the 500s, and it
> **kept v1 live automatically** — no human paged at 3am.

---

## Step 10 — Recover the GitOps way

Here's a subtlety worth understanding, because it trips people up:

- Argo **Rollouts** already protected you — traffic is on v1. ✅
- Argo **CD**, however, still sees Git saying "the desired image is `:v2`." The Application shows
  **Synced** (the cluster spec matches Git) but the Rollout's **health is Degraded**. Argo CD will
  **not** "fix" this for you, because from its point of view the cluster already matches Git.

So the *real* fix is to make Git healthy again — **revert the bad commit**:

```bash
git revert --no-edit HEAD      # undo the v2 change
git push
```

Argo CD syncs the revert; the Rollout returns to `:v1`, re-converges to **Healthy**, and the
aborted v2 ReplicaSet is cleaned up.

```bash
kubectl argo rollouts get rollout nest-demo -n demo --watch     # back to ✔ Healthy on v1
```

> **Imperative alternative (for learning only):** `kubectl argo rollouts undo nest-demo -n demo`
> rolls the *live* Rollout back to the previous revision immediately. But under GitOps, Argo CD's
> `selfHeal` will soon re-apply whatever is in Git — so `undo` is a firefighting tool, not the
> fix. In GitOps, **the fix always ends with a commit.** This tension (imperative undo vs. Git as
> truth) is one of the most important things this lab teaches.

**To make a *good* v3 instead of reverting:** fix the code (or set `FAIL_HEALTH=false`), tag `v3`
(CI builds/pushes the image), bump the manifest to `:v3`, and push. The canary + analysis run
again — and this time it passes, promoting v3 to stable. That's the full, healthy loop.

---

## Step 11 — Clean up

```bash
# Remove the app (Argo CD Application + everything it created)
kubectl delete -f argocd-app.yaml
kubectl delete namespace demo

# Remove the platform pieces (optional — keep them for more experiments)
kubectl delete namespace argocd
kubectl delete namespace argo-rollouts

# Nuke the whole cluster (fastest full reset)
kind delete cluster --name rollouts-lab
```

Docker Hub images and the GitHub repo persist — delete those from their web UIs if you're done.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Nodes stuck `NotReady` after `kind create` | No CNI installed yet | Expected until Step 2 — run `cilium install`; then `cilium status --wait` |
| `cilium install` errors / pods `CrashLoopBackOff` | Cluster was created *with* kindnet (two CNIs) | Recreate Kind with `disableDefaultCNI: true` (Step 1) |
| Pods `Pending`, events say "no CNI" | Cilium not healthy | `cilium status`; `kubectl -n kube-system logs ds/cilium` |
| `kubectl argo rollouts` → "unknown command" | Plugin not on PATH | Re-do Step 4; ensure the binary is named `kubectl-argo-rollouts` in `/usr/local/bin` |
| Argo CD app stuck `OutOfSync` / `Unknown` | Wrong `repoURL`/`path`, or private repo | Fix the URL; for private repos add repo creds in Argo CD (`argocd repo add`) |
| Rollout never leaves the first step | No traffic router *and* you expected % traffic splitting | Without a mesh, weight ≈ replica ratio; that's fine. Analysis still runs against the canary Service |
| Canary pods `CrashLoopBackOff` on v1 | App didn't start / wrong port | `kubectl -n demo logs <pod>`; ensure `containerPort: 3000` matches the app |
| Analysis **passes** on the bad image | `canaryService` not wired, so probe hit stable pods | Confirm `canaryService: nest-demo-canary` in the Rollout and the Service exists; check `describe analysisrun` |
| `web` provider errors: `dial tcp ... connection refused` | Canary has **no Ready pods** (broken v2) | This is *correct* — it counts as a failed measurement → abort. Read it as success of the lab |
| Rollout sits `Degraded` forever, never aborts | Missing auto-abort settings | Ensure `progressDeadlineAbort: true`; a failed analysis also aborts on its own |
| After revert, cluster still on v2 | Argo CD hasn't synced yet | `argocd app get nest-rollout-demo`; click *Sync*/*Refresh*, or check `automated` sync is on |
| `ImagePullBackOff` for `:v2` | Image not pushed / wrong repo path | `docker push ${IMAGE}:v2`; confirm the `image:` matches your Docker Hub user exactly |

Handy diagnostics:

```bash
kubectl argo rollouts get rollout nest-demo -n demo          # rollout state, revisions, images
kubectl -n demo get analysisrun                              # did the taster run? pass/fail?
kubectl -n demo describe analysisrun <name>                  # the actual measurements
kubectl -n demo describe rollout nest-demo                   # events: paused / aborted / promoted
argocd app get nest-rollout-demo                             # Git vs cluster: synced? healthy?
cilium status                                                # CNI health, if pods misbehave
```

---

## Production hardening checklist

- [ ] Manifests are **templated** (Kustomize/Helm) so the image tag is a single value, not a
      literal edited in place — the whole point of GitOps is a clean diff per release.
- [ ] The Rollout uses **immutable, pinned image tags** (or digests), never `:latest`.
- [ ] The **analysis is meaningful** — in prod, back it with **Prometheus** metrics (error rate,
      p99 latency) via a `prometheus` provider, not just a health ping. A canary can be "Ready" yet
      serving 5% 500s; only metrics catch that.
- [ ] **`progressDeadlineSeconds` + `progressDeadlineAbort`** are set so a stuck rollout self-aborts.
- [ ] For real **traffic splitting** (true 25% of requests, not just replica ratio), add a traffic
      router — **Cilium** (via the Gateway API / Ingress), NGINX, or a service mesh — and reference
      it under `strategy.canary.trafficRouting`.
- [ ] **Readiness probes are strict** — a pod that isn't truly serving must not be `Ready`, or the
      canary looks healthier than it is.
- [ ] Argo CD uses **least-privilege repo credentials** and, for prod, **manual sync or PR-gated**
      promotion rather than blind auto-sync to production.
- [ ] **Network policy** (Cilium `CiliumNetworkPolicy`) restricts pod-to-pod traffic — default-deny,
      then allow only what's needed.
- [ ] **Notifications** (Argo Rollouts + Argo CD notifications) alert on `Degraded`/`Aborted` so a
      rollback is visible, not silent.
- [ ] The **recovery path is Git** — reverts/roll-forwards are commits, reviewed like any change;
      `kubectl argo rollouts undo` is for emergencies only.
- [ ] CI **scans and signs** images (Trivy/cosign) before they can be referenced by a Rollout.

---

## One-paragraph summary

On a **Kind** cluster you install **Cilium** (the eBPF CNI that makes pod networking work),
**Argo CD** (which watches your **GitHub** repo and reconciles it into the cluster), and **Argo
Rollouts** (which upgrades your app *progressively* instead of all-at-once). A tiny **NestJS** app
is built into `:v1` (healthy) and `:v2` (a regression whose `/health` returns 500) and pushed to
**Docker Hub**. Both the app source and the Kubernetes manifests live in the GitHub repo; an Argo
CD **Application** with automated sync means *pushing a new version to Git is the deploy*. The
`Rollout` runs a **canary** — 25% of pods on the new image — and an **AnalysisTemplate** probes the
canary's `/health`. Ship the bad `:v2` and the analysis fails, so Argo Rollouts **aborts and keeps
the stable `:v1` serving 100%** — an **automatic rollback** with zero user impact. You then recover
the **GitOps way** by reverting the commit, and Argo CD converges the cluster back to Healthy.

> **Two brains, one more time:** **Argo CD** decides *what* should run (whatever Git says);
> **Argo Rollouts** decides *how safely* to get there and **refuses to send traffic to a version
> that fails its health analysis.** Together they let you deploy by `git push` without deploying
> outages.
