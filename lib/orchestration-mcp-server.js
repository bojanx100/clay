var z;
try { z = require("zod"); } catch (e) { z = null; }

function stringField(description, optional) {
  if (!z) return {};
  var field = z.string().describe(description);
  return optional ? field.optional() : field;
}

function coordinatorIdField(description) {
  if (!z) return {};
  return z.union([z.string(), z.number()]).describe(description);
}

// Reference-only, exactly like every other canonical ref: a topic id and
// nothing else, so a task record can never carry topic content. Optional and
// forward-only -- omitting it leaves the existing inference behaviour intact.
function coopTopicRefField() {
  if (!z) return {};
  return z.object({
    topicId: z.string().describe("Stable canonical Coop topic id"),
  }).optional().describe("Optional reference-only canonical Coop TopicRef this work belongs to");
}

function projectExecutionFields() {
  if (!z) return {
    targetProject: {},
    portfolioTaskId: {},
    bindingRevision: {},
    idempotencyKey: {},
    implementationGrantRef: {},
    mode: {},
    controlRole: {},
  };
  // These five are individually optional because the local delegate path needs
  // none of them, but the typed execution binding needs ALL of them together.
  // Say so in every description: a partial set used to fail deep in the binding
  // layer with an opaque "invalid_binding" that named no field.
  return {
    targetProject: z.object({
      projectId: z.string().describe("Stable ProjectRef id for the canonical execution project"),
    }).optional().describe("Explicit canonical ProjectRef for cross-project execution. Required together with portfolioTaskId, bindingRevision, idempotencyKey and mode -- supply all five or none. Project execution is staffed from Coop/Lead only; from an ordinary project session omit all five to delegate a local worker task"),
    portfolioTaskId: z.string().optional()
      .describe("Stable portfolio task id used by the typed execution binding. Required together with targetProject, bindingRevision, idempotencyKey and mode"),
    bindingRevision: z.number().int().min(1).optional()
      .describe("Positive execution-binding revision. Required together with targetProject, portfolioTaskId, idempotencyKey and mode"),
    idempotencyKey: z.string().optional()
      .describe("Stable idempotency key for this binding revision. Required together with targetProject, portfolioTaskId, bindingRevision and mode"),
    implementationGrantRef: z.string().optional()
      .describe("Optional Governance Lifecycle ImplementationGrant reference. When supplied it must exactly bind this project task, revision, project, and idempotency key"),
    mode: z.enum(["project_coordinator", "direct_leaf"]).optional()
      .describe("Canonical project execution mode. Required together with targetProject, portfolioTaskId, bindingRevision and idempotencyKey"),
    controlRole: z.enum(["project_coordinator", "council", "triage"]).optional()
      .describe("Owner-visible Coop control role; Council and Triage executions retain this role across their lifecycle"),
  };
}

function getToolDefs(onDelegate, onMessage, onPlan, onReport, onRetry, onAdopt, onResolve,
  onDismiss, onRequestInput, onSteerProjectCoordinator, onSwitchSessionProvider,
  onListCoopSessions, onMigrateControlPlaneBinding) {
  return [{
    name: "delegate_task",
    description: "Delegate a fully specified bounded task to a visible, durable Clay worker. The first delegation can automatically promote an ordinary top-level conversation to a coordinator. The worker runs independently and its structured result returns automatically.",
    inputSchema: Object.assign({
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      title: stringField("Short task title"),
      objective: stringField("Complete, unambiguous worker objective"),
      context: stringField("Relevant conversation, product, and technical context"),
      acceptanceCriteria: stringField("Observable completion and verification criteria"),
      ownedPaths: stringField("Files, directories, or subsystem this worker may change; use read-only when it must not edit"),
      provider: stringField("Optional installed provider id or exact provider route", true),
      model: stringField("Optional exact model; omit to inherit the coordinator route", true),
      difficulty: z ? z.enum(["routine", "strong"]).optional().describe("Optional routing tier; omit for deterministic classification") : {},
      effort: z ? z.enum(["low", "medium", "high"]).optional().describe("Optional reasoning effort for this local worker only; omit to preserve existing defaults") : {},
      coopTopicRef: coopTopicRefField(),
    }, projectExecutionFields()),
    handler: function (args) {
      return Promise.resolve(onDelegate(args || {}));
    },
  }, {
    name: "send_task_message",
    description: "Send new context, an answer, or a correction to an existing owned worker task. Use this when user input belongs to work already in progress.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      taskId: stringField("Stable task id returned by delegate_task"),
      message: stringField("Context, answer, or correction for the worker"),
    },
    handler: function (args) {
      return Promise.resolve(onMessage(args || {}));
    },
  }, {
    name: "steer_project_coordinator",
    description: "Send an idempotent correction from canonical Coop to an active project-owned coordinator through its explicit ProjectRef and SessionRef. This never creates Lead-local execution.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Canonical Coop session id"),
      targetProject: z ? z.object({ projectId: z.string() }) : {},
      targetCoordinator: z ? z.object({ projectId: z.string(), sessionStorageId: z.string() }) : {},
      portfolioTaskId: stringField("Stable typed portfolio execution binding id"),
      bindingRevision: z ? z.number().int().min(1) : {},
      idempotencyKey: stringField("Stable command id for retry-safe steering"),
      message: stringField("Correction for the active canonical project coordinator"),
    },
    handler: function (args) {
      if (typeof onSteerProjectCoordinator !== "function") {
        return Promise.resolve({ content: [{ type: "text", text: "Error: typed cross-project coordinator steering is not ready yet." }], isError: true });
      }
      return Promise.resolve(onSteerProjectCoordinator(args || {}));
    },
  }, {
    name: "switch_session_provider",
    description: "Switch one Coop-controlled project execution session through its exact durable ProjectRef, SessionRef, and portfolio binding. Only canonical Coop can authorize this operation.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Canonical Coop session id"),
      targetProject: z ? z.object({ projectId: z.string() }) : {},
      targetSession: z ? z.object({ projectId: z.string(), sessionStorageId: z.string() }) : {},
      portfolioTaskId: stringField("Stable typed portfolio execution binding id"),
      bindingRevision: z ? z.number().int().min(1) : {},
      idempotencyKey: stringField("Stable command id for retry-safe provider switching"),
      target: stringField("Exact provider route id, such as codex-openai"),
      model: stringField("Exact verified target model"),
      reason: stringField("Why Coop is switching this controlled session"),
    },
    handler: function (args) {
      if (typeof onSwitchSessionProvider !== "function") {
        return Promise.resolve({ content: [{ type: "text", text: "Error: typed cross-project provider switching is not ready yet." }], isError: true });
      }
      return Promise.resolve(onSwitchSessionProvider(args || {}));
    },
  }, {
    name: "migrate_control_plane_binding",
    description: "Migrate one exact verified legacy project-coordinator execution binding onto Coop's resident control plane (projectId system-lead). Requires the exact ProjectRef, portfolio task, binding revision, prior coordinator identity, and a stable idempotency key; retries are byte-stable, terminal history is never rewritten, and no coordinator, task, claim, session, or fan-in event is ever duplicated. Use this when typed dispatch or steering fails with control_plane_migration_required, then retry the normal dispatch.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Canonical Coop session id"),
      targetProject: z ? z.object({
        projectId: z.string().describe("Exact canonical ProjectRef id the binding targets"),
      }) : {},
      portfolioTaskId: stringField("Stable typed portfolio execution binding id"),
      bindingRevision: z ? z.number().int().min(1)
        .describe("Exact binding revision to migrate; must be the task's latest revision") : {},
      idempotencyKey: stringField("Stable command id for retry-safe, byte-stable migration"),
      priorProjectCoordinator: z ? z.object({
        projectId: z.string(),
        sessionStorageId: z.string(),
      }).nullable().optional().describe("Exact prior coordinator SessionRef this migration replaces; omit or pass null only when no prior routed binding revision ever existed") : {},
    },
    handler: function (args) {
      if (typeof onMigrateControlPlaneBinding !== "function") {
        return Promise.resolve({ content: [{ type: "text", text: "Error: typed control-plane binding migration is not ready yet." }], isError: true });
      }
      return Promise.resolve(onMigrateControlPlaneBinding(args || {}));
    },
  }, {
    name: "list_coop_sessions",
    description: "List authoritative non-hidden top-level Coop-created or Coop-touched sessions for exact projects, with reconciled lifecycle states.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Canonical Coop session id"),
      projectRefs: z ? z.array(z.object({
        projectId: z.string().describe("Stable ProjectRef id to include"),
      })).min(1).max(64).describe("Exact projects whose Coop session inventory should be returned") : {},
    },
    handler: function (args) {
      if (typeof onListCoopSessions !== "function") {
        return Promise.resolve({ content: [{ type: "text", text: "Error: the Coop session ledger is not ready yet." }], isError: true });
      }
      return Promise.resolve(onListCoopSessions(args || {}));
    },
  }, {
    name: "plan_task_graph",
    description: "Create multiple visible, durable worker tasks as one graph. The first plan can automatically promote an ordinary top-level conversation to a coordinator. Independent tasks start in parallel; tasks with dependencies start automatically after their prerequisites complete.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      maxParallel: z ? z.number().min(1).max(10).optional().describe("Maximum concurrent workers for this coordinator") : {},
      tasks: z ? z.array(z.object({
        ref: z.string().optional().describe("Short reference used by dependencies in this batch"),
        title: z.string(),
        objective: z.string(),
        context: z.string().optional(),
        acceptanceCriteria: z.string().optional(),
        ownedPaths: z.string().optional(),
        dependencies: z.array(z.string()).optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        difficulty: z.enum(["routine", "strong"]).optional(),
        effort: z.enum(["low", "medium", "high"]).optional(),
        maxAttempts: z.number().optional(),
        coopTopicRef: coopTopicRefField(),
      })) : {},
    },
    handler: function (args) {
      return Promise.resolve(onPlan(args || {}));
    },
  }, {
    name: "report_task_progress",
    description: "Report a meaningful worker milestone to the owning coordinator task without ending the worker turn.",
    inputSchema: {
      workerSessionId: coordinatorIdField("Stable or local worker session id stated in the worker instructions"),
      taskId: stringField("Owned task id stated in the worker instructions"),
      activity: stringField("Short description of current work or latest milestone"),
      progress: z ? z.number().min(0).max(100).optional() : {},
    },
    handler: function (args) {
      return Promise.resolve(onReport(args || {}));
    },
  }, {
    name: "resolve_task",
    description: "Mark an owned task completed after this coordinator has independently finished and verified the requested outcome. Use this to reconcile a needs-input or failed worker result only after concrete integration and verification; it is not a substitute for worker progress.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      taskId: stringField("Owned task id to reconcile"),
      summary: stringField("Concrete final outcome completed by the coordinator"),
      verification: stringField("Commands, tests, or observable evidence proving the outcome is ready to test"),
      escalationRequired: z ? z.enum(["no"]).describe("Must be no; unresolved work cannot be completed") : {},
    },
    handler: function (args) {
      return Promise.resolve(onResolve(args || {}));
    },
  }, {
    name: "dismiss_task",
    description: "Resolve an owned task as deliberately unnecessary, obsolete, or duplicated. A durable reason is required and remains in the coordinator task graph; use resolve_task instead when the requested outcome was completed.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      taskId: stringField("Owned task id to dismiss"),
      reason: stringField("Concrete reason this work is no longer required"),
    },
    handler: function (args) {
      return Promise.resolve(onDismiss(args || {}));
    },
  }, {
    name: "request_task_input",
    description: "Pause owned tasks for one user decision, stage a non-scheduling approval question, or record one explicit durable plan decision for the canonical Coop owner. A plan decision is typed provenance, never inferred from prose. Use only when human judgment is genuinely unavoidable.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      taskIds: z ? z.array(z.string()).min(1).optional().describe("Affected existing owned task ids; mutually exclusive with approvalScopes and ownerDecisionScope") : {},
      approvalScopes: z ? z.array(z.object({
        portfolioTaskId: z.string().describe("Exact stable portfolio task id awaiting approval"),
        bindingRevision: z.number().int().min(1).describe("Exact binding revision awaiting approval"),
        targetProject: z.object({
          projectId: z.string().describe("Exact canonical target ProjectRef"),
        }),
      })).min(1).max(16).optional().describe("Exact not-yet-delegated portfolio revisions to stage without scheduling; mutually exclusive with taskIds and ownerDecisionScope") : {},
      ownerDecisionScope: z ? z.object({
        targetProject: z.object({ projectId: z.string().describe("Exact ProjectRef the plan governs") }),
        portfolioTaskId: z.string().describe("Exact portfolio task whose plan is being decided"),
        bindingRevision: z.number().int().min(1).describe("Exact implementation binding revision, if eventually approved"),
        planRevision: z.number().int().min(1).describe("Explicit semantic plan revision"),
        planDigest: z.string().regex(/^[a-fA-F0-9]{16,128}$/).describe("Stable hexadecimal digest of that exact plan revision"),
        coopTopicRef: z.object({ topicId: z.string().describe("Canonical TopicRef where the owner decision belongs") }),
      }).optional().describe("One explicit durable non-approval plan decision; mutually exclusive with taskIds and approvalScopes") : {},
      question: stringField("One precise question for existing taskIds or ownerDecisionScope; omitted for approvalScopes because Clay generates the exact staged question", true),
      reason: stringField("Why this requires human judgment instead of autonomous reconciliation"),
    },
    handler: function (args) {
      return Promise.resolve(onRequestInput(args || {}));
    },
  }, {
    name: "retry_task",
    description: "Retry a failed, blocked, or completed task while preserving its stable task identity and graph dependencies. Reuses an idle healthy worker conversation when safe; creates a fresh worker after failures, when reuse is unavailable, or when freshSession is explicitly requested for an independent pass.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      taskId: stringField("Stable task id to retry"),
      freshSession: z ? z.boolean().optional().describe("Create a clean worker conversation only when the retry requires an independent context") : {},
    },
    handler: function (args) {
      return Promise.resolve(onRetry(args || {}));
    },
  }, {
    name: "adopt_session",
    description: "Classify an existing Clay conversation offered to this coordinator. Adopt it as a new/existing task worker, retain it as context only, or mark it unrelated.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      sourceSessionId: coordinatorIdField("Stable source session id stated in the adoption handoff"),
      sourceProjectRef: z ? z.object({
        projectId: z.string().describe("Exact ProjectRef containing the owner-directed source session"),
      }).optional().describe("Required when the source session belongs to another Clay project") : {},
      ownerHandoffIngressId: stringField("Exact owner Coop ingress that offered the cross-project source session", true),
      action: z ? z.enum(["new_task", "existing_task", "context_only", "unrelated"]) : {},
      taskId: stringField("Existing task ID when action is existing_task", true),
      title: stringField("Task title when action is new_task", true),
      objective: stringField("Owned task objective", true),
      context: stringField("Additional task context", true),
      acceptanceCriteria: stringField("Observable completion criteria", true),
      ownedPaths: stringField("Files or subsystem owned by the adopted worker", true),
      message: stringField("Instruction sent into the adopted conversation", true),
    },
    handler: function (args) {
      return Promise.resolve(onAdopt(args || {}));
    },
  }];
}

module.exports = {
  getToolDefs: getToolDefs,
};
