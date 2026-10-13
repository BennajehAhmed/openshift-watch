# OpenShift Watch

A local **Express.js + Handlebars** application that runs read-only `oc` commands to monitor your OpenShift projects. Nothing is deployed in OpenShift. There are no CDNs, telemetry, webhooks, or external notification services. The only cluster traffic comes from the existing `oc` CLI on the computer running this application.

## Start in demo mode

Prerequisite: an approved **Node.js 22.9 or newer** installation. The ZIP download includes JavaScript dependencies in `node_modules`, so it can start without contacting npm or downloading a runtime. A GitHub checkout contains the complete source and lockfile; install its dependencies using your approved npm registry/mirror first:

```sh
npm ci --ignore-scripts
```

Extract the ZIP or clone this repository, open a terminal inside `openshift-watch`, then:

```sh
npm run demo
```

Open **http://localhost:3100**. Use the demo scenario selector to simulate an outage, partial replica loss, or lost access. Click **Check now** a second time to confirm an incident. Select **All healthy** to see recovery. Demo mode neither calls `oc` nor writes incident/settings files.

## Connect your real projects

1. Use your existing approved `oc` CLI and login procedure. The application inherits your terminal's environment and kubeconfig. It never collects or stores your password or token.
2. Check access from that same terminal:

   ```sh
   oc config current-context
   oc get pods -n YOUR_PROJECT
   oc get deployments.apps -n YOUR_PROJECT
   ```

3. Optionally copy `.env.example` to `.env`. On Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   On Linux/macOS:

   ```sh
   cp .env.example .env
   ```

4. Set `NAMESPACES=project-a,project-b` in `.env`, or select them in the dashboard after startup. Use actual project names rather than display names.
5. Start live monitoring:

   ```sh
   npm start
   ```

6. Open **http://localhost:3100**, click **Manage projects**, and then **Load accessible projects**. If listing projects is forbidden, enter project names directly. Click **Save & start monitoring**.
7. Click **Enable notifications** and allow notifications for localhost. Optionally check **Alert sound**; that click enables browser audio. The page title also shows the number of active incidents.

The server binds to **127.0.0.1 only**. Use it locally on the workstation or an approved machine that already has cluster access. It does not bypass closed flows or create access that `oc` does not already have.

The context is pinned when the monitor initializes. Changing your CLI's current context afterward does not silently move the monitor to a different cluster. To switch clusters, stop the application, set `OC_CONTEXT` or switch context in your terminal, then restart. Keep the same authenticated kubeconfig available to the server process. Logging in with a different terminal environment or kubeconfig will not update this process's configuration.

## Notifications and persistence

- Workload health updates immediately after each completed check. By default, an outage or degradation needs **two consecutive bad observations** before an incident opens. An unknown observation interrupts confirmation.
- Confirmed problems produce an in-page incident, a desktop browser notification if allowed, and an optional sound. Recovery and escalation from degraded to down also produce notifications.
- Incidents do not repeatedly notify on every poll. A new tab/reconnection can surface an unacknowledged incident. **Acknowledge** suppresses further problem notifications for that incident; it does not mark the application healthy.
- Open incidents and up to 200 resolved incidents are kept locally in `data/incidents.json`. Selected projects are in `data/settings.json`. Demo mode is isolated from those files. No kubeconfig, tokens, environment variables, pod logs, or raw CLI stderr are written there.
- **Keep the Node server running and a dashboard tab open**, including in the background. Browser and operating-system notification policies, sleeping/discarded tabs, a sleeping laptop, and browser exit can prevent desktop alerts. This version has no independent OS service or background push channel. The server continues collecting and recording incidents while no tab is open, as long as its process and computer remain running.
- Polling happens again `POLL_SECONDS` after the previous check completes. Confirmation time includes CLI/network latency and the number of projects. Brief outages that occur entirely between checks cannot be observed.
- CLI/RBAC/network failures create separate monitor incidents. Previous application rows become **Unknown** when their current observation is missing. Unknown observations never resolve an active outage. If the browser loses the live stream or checks become delayed, all displayed application statuses are temporarily shown as Unknown.
- Removing a project stops monitoring it. Open incidents from removed projects remain marked as having no current observation; they are not reported as recovered. A disappeared previously seen controller with desired replicas above zero remains Down on a successful complete check. To intentionally stop tracking it, remove its project or restart the monitor after checking the planned change. The application cannot know about a workload deleted before its first observation.

## What counts as an application?

Each Deployment, DeploymentConfig, StatefulSet, or DaemonSet is shown as a workload. Pods are connected using ownership chains through ReplicaSets/ReplicationControllers; workload selectors are a fallback if ownership data cannot be read. Jobs, builds, and standalone pods are shown separately by owner or pod name. Multiple workloads belonging to the same business application are shown as separate rows.

| Status | Meaning |
| --- | --- |
| Healthy | All desired replicas have ready pods; the controller has observed the current generation; available replica counts, when present, meet the desired count. |
| Degraded | Some replicas are ready, but desired capacity, pod health, controller conditions, or rollout availability is incomplete. |
| Down | Desired replicas are above zero but no pods are ready; or an active standalone/job/build pod group has no ready pods. Includes CrashLoopBackOff, image pull failures, Pending, Failed, and no pods. |
| Scaled to zero | A controller intentionally requests zero replicas, or a DaemonSet has no eligible scheduled nodes. No outage alert is created. |
| Completed | A one-off pod group finished successfully. No outage alert is created. |
| Unknown | Current information is unavailable/incomplete. Last known rows may be retained for context. |

**Running is not sufficient:** readiness conditions and container state are checked. Terminating pods cannot count as ready. Restarts, including init-container restarts, are shown but historical restarts alone do not mark an otherwise ready app unhealthy. A rollout can briefly appear degraded; tune confirmation checks for your rollout duration. Active jobs/builds may be Pending and therefore create an incident if they stay unready long enough.

This monitors **Kubernetes workload readiness**, not end-to-end business functionality. A pod can be ready while an API has a functional problem; appropriate readiness probes determine what the cluster reports.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3100` | Local dashboard port, 1024–65535. |
| `OC_BIN` | `oc` | Approved CLI binary name or absolute path to `oc.exe`/`oc`. Use the executable, not a `.bat`/shell wrapper. |
| `OC_CONTEXT` | current at startup | Pin a kubeconfig context. |
| `KUBECONFIG` | existing environment/default | Optional path to an existing approved kubeconfig. Standard `oc` behavior. |
| `NAMESPACES` | none | Comma-separated project names. Nonempty environment setting overrides saved selection at startup. Otherwise use saved selection or choose in the UI. |
| `POLL_SECONDS` | `30` | Delay after a check completes, 5–3600 seconds. |
| `COMMAND_TIMEOUT_SECONDS` | `15` | Timeout for each CLI process/request, 2–120 seconds. |
| `ALERT_AFTER_CHECKS` | `2` | Consecutive bad observations before opening an incident, 1–20. |
| `ALERT_ON_DEGRADED` | `true` | Set to `false` to alert for complete outages and monitor access failures only. Degraded status remains visible. |

Example:

```dotenv
NAMESPACES=project-a,project-b
POLL_SECONDS=30
ALERT_AFTER_CHECKS=2
ALERT_ON_DEGRADED=true
OC_BIN=C:\Tools\OpenShift\oc.exe
```

If you edit `.env`, restart the server. No commands or credentials are accepted through the dashboard. Namespace input is validated; `oc` executes via `child_process.execFile()` with argument arrays and `shell: false`, timeouts, and bounded output. Calls are limited to four CLI processes at a time, checking one namespace after another. Saving/refresh operations are serialized.

## Read-only permissions / exact commands

The monitor does not create Roles, service accounts, workloads, secrets, or other cluster resources. Its existing identity needs `list` access for these resources in selected projects:

```sh
oc --context=YOUR_CONTEXT get pods --namespace=YOUR_PROJECT -o json --request-timeout=15s
oc --context=YOUR_CONTEXT get deployments.apps --namespace=YOUR_PROJECT -o json --request-timeout=15s
oc --context=YOUR_CONTEXT get statefulsets.apps --namespace=YOUR_PROJECT -o json --request-timeout=15s
oc --context=YOUR_CONTEXT get daemonsets.apps --namespace=YOUR_PROJECT -o json --request-timeout=15s
oc --context=YOUR_CONTEXT get replicasets.apps --namespace=YOUR_PROJECT -o json --request-timeout=15s
oc --context=YOUR_CONTEXT get replicationcontrollers --namespace=YOUR_PROJECT -o json --request-timeout=15s
oc --context=YOUR_CONTEXT get deploymentconfigs.apps.openshift.io --namespace=YOUR_PROJECT -o json --request-timeout=15s
```

It also uses `oc config current-context` when no explicit context was supplied. **Load accessible projects** runs `oc get projects -o json` with the pinned context and timeout. Project listing is optional. Each resource is requested independently, so a forbidden kind does not hide all other data. A missing DeploymentConfig API is tolerated on clusters that do not support it. Other permission failures are visible as an incomplete-monitoring incident.

No mutation commands, pod exec, port-forwarding, log collection, shell pipelines, cluster token endpoints, email, Slack, or outbound webhooks are used. The HTTP server checks local Host/Origin headers and requires a startup-specific CSRF token for state changes. It is intended for a local user, not shared hosting; local processes with access to the same account can also reach the dashboard.

## Troubleshooting

- **oc not found:** ensure it is available in the terminal's PATH, or set `OC_BIN` to its approved absolute executable path.
- **Expired login:** use your standard `oc login` procedure in the terminal with the same kubeconfig, then click Check now. Do not paste tokens into this dashboard.
- **Forbidden:** verify the listed read permissions with your platform team; other workload types remain visible. Enter namespaces directly if only project listing is forbidden.
- **Timeout/network:** verify the usual VPN/cluster connection and `oc get pods`. The monitor requires the same authorized network path as the CLI.
- **Notifications blocked:** check browser permissions for localhost and the OS notification/Focus Assist settings. Managed browsers may prohibit them; in-page incidents remain available.
- **Port in use:** change `PORT` in `.env` and restart.
- **History cannot save:** check permissions on `data/`. A damaged JSON file gives a startup error; keep a copy and rename it before restarting.
- **Very large namespaces:** JSON output is bounded at 32 MiB per resource request. Split monitoring across separate instances/projects if that limit is exceeded.
- **Reset selected projects/history:** stop the server, keep a backup if needed, then remove the relevant file from `data/`. That only affects the local monitor.

## Develop and verify

```sh
npm test
```

Tests cover replica loss, no pods, scale-to-zero, readiness, init failures, completed jobs, legacy DC ownership, rollout generations, confirmation streaks, escalation, recovery, stale observations, disappearing workloads, CLI arguments/error redaction, and HTTP protections. Live-cluster behavior must be checked using your own approved account; no real OpenShift credentials are included.

If obtaining dependencies yourself rather than using the included folder, use your approved npm registry/mirror:

```sh
npm ci --ignore-scripts
```

`package-lock.json` pins the tested dependency tree. The application includes source under `src/`, Handlebars templates under `views/`, and local CSS/JavaScript under `public/`. There are no native application binaries or runtime installers in this project.

References: [Node.js child processes](https://nodejs.org/api/child_process.html), [Kubernetes readiness probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/), [Kubernetes deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [OpenShift CLI](https://docs.redhat.com/en/documentation/openshift_container_platform/4.14/html/cli_tools/openshift-cli-oc).
