# Utility review — OpenShift Watch 1.2

The monitor already answers "what is down?" and provides useful bounded logs. The biggest remaining cost was switching to a terminal for every supporting fact. This update gathers the common read-only evidence into one investigation view while preserving the local CLI architecture and closed network-flow constraints.

| Gap found | Why it slowed investigation | Improvement implemented |
| --- | --- | --- |
| Health state and logs lacked event evidence | Pending, image, mount, probe and quota failures frequently need Events rather than application logs | Filtered Pod/workload event history with timestamps, repetition counts, search and warning filtering |
| Container state lacked its resource/probe context | OOMKilled and readiness failures need limits, previous exits and probe configuration | Structured container resource requests/limits, last exits and probe targets/timing |
| Running/ready pods could still have routing problems | Service selectors, backend readiness, target-port names and route admission can fail independently | Matching Services, EndpointSlice address readiness, ports/selectors and active Route admission |
| Zero-pod workloads needed controller evidence | No pod logs exist when quotas or controller errors prevent creation | Workload/rollout conditions, generations, quotas and workload Events even with no pod |
| Optional RBAC/API failures could make the diagnostic feature look broken | Most users cannot read every resource or access metrics | Independent checks with partial results and explicit unavailable sections; no new monitoring alerts for optional diagnostics |
| Diagnosis required copying scattered data | Support handoff needed repeated manual collection | A concise local copyable report with evidence and limitations |
| Read-only behavior depended on each call site | A later feature could accidentally introduce a mutation or unsafe flag | Central resource/verb/flag guard before every CLI process; no generic command route |
| Suggested pod deletion conflicted with an investigation-only tool | A diagnostic assistant should remain focused on evidence | Removed disruptive command suggestions; all copyable commands remain read-only |
| Startup errors matched a broad "Error" rule too early | CreateContainerConfigError could be mislabeled as a crash | Specific startup/configuration diagnosis is evaluated before generic crash rules |

The new collector is on demand, bounded and cancellable, with a short in-memory cache. It does not deploy an agent, fetch secret/config-map values, run inside a pod, probe route URLs, or send cluster data to an external model/service. Node dotenv startup and cancellation compatibility fixes are retained.

## Remaining useful additions

These are future options, not implemented features:

1. **Session change timeline:** show when readiness, restarts and replica counts changed, so intermittent failures can be correlated with an incident. Define persistence/retention before adding a disk history.
2. **Cross-pod comparison:** compare images, resource settings and conditions across replicas of a workload. This would help distinguish one bad replica from a shared deployment/configuration failure without displaying environment values.
3. **Saved investigation views:** remember project/status filters and selected diagnostic sections locally, especially for teams watching many projects.
4. **Legacy endpoint support:** where EndpointSlice is absent or inaccessible, optionally support legacy Endpoints reads with clearly different readiness semantics. Current behavior reports EndpointSlice checks as unavailable.
5. **Read-only configuration existence checks:** verify whether referenced ConfigMap/Secret names exist using permission checks or metadata-only reads, while keeping values omitted. This needs a carefully reviewed permission/data boundary and should remain opt-in.

Browser notifications still depend on the server, computer and browser tab staying active. Workload readiness does not prove end-to-end business functionality. API Events expire and resource metrics are snapshots; the tool cannot reconstruct history that the cluster no longer exposes. Incomplete optional evidence must remain visibly incomplete.
