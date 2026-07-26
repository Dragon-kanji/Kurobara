import {
  type CompiledWorkflow,
  type DomainResult,
  fail,
  succeed,
  type WorkflowNode,
  type WorkflowSpec,
} from "@kurobara/kernel";

export type WorkflowCompilationLimits = Readonly<{
  maxNodes: number;
  maxDepth: number;
  maxFanOut: number;
}>;

export type WorkflowCompilationFailureCode =
  | "compiler-version-unsupported"
  | "duplicate-node"
  | "node-limit-exceeded"
  | "unresolved-dependency"
  | "capability-not-allowed"
  | "fan-out-limit-exceeded"
  | "cycle-detected"
  | "depth-limit-exceeded";

export type WorkflowCompilationFailure = Readonly<{
  code: WorkflowCompilationFailureCode;
  nodeKey?: string;
  message: string;
}>;

export type CompileWorkflowInput = Readonly<{
  spec: WorkflowSpec;
  allowedCapabilities: readonly string[];
  limits: WorkflowCompilationLimits;
  compilerVersion: string;
}>;

export const WORKFLOW_COMPILER_VERSION = "1.0.0";

type WorkflowGraph = Readonly<{
  dependants: Map<string, string[]>;
  remainingDependencies: Map<string, number>;
}>;

type OrderedGraph = Readonly<{
  depths: Map<string, number>;
  orderedKeys: string[];
}>;

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const validateNodes = (
  spec: WorkflowSpec,
  allowedCapabilities: readonly string[],
  maxNodes: number
): DomainResult<Map<string, WorkflowNode>, WorkflowCompilationFailure> => {
  if (spec.nodes.length > maxNodes) {
    return fail({
      code: "node-limit-exceeded",
      message: `Workflow contains ${spec.nodes.length} nodes; limit is ${maxNodes}.`,
    });
  }

  const nodesByKey = new Map(spec.nodes.map((node) => [node.key, node]));
  if (nodesByKey.size !== spec.nodes.length) {
    return fail({
      code: "duplicate-node",
      message: "Workflow node keys must be unique.",
    });
  }

  const allowlist = new Set(allowedCapabilities);
  for (const node of spec.nodes) {
    if (!allowlist.has(node.capability.capabilityId)) {
      return fail({
        code: "capability-not-allowed",
        message: `Capability ${node.capability.capabilityId} is not in the compilation allowlist.`,
        nodeKey: node.key,
      });
    }
    const unresolved = node.dependsOn.find(
      (dependency) => !nodesByKey.has(dependency)
    );
    if (unresolved !== undefined) {
      return fail({
        code: "unresolved-dependency",
        message: `Dependency ${unresolved} does not exist.`,
        nodeKey: node.key,
      });
    }
  }

  return succeed(nodesByKey);
};

const buildGraph = (spec: WorkflowSpec): WorkflowGraph => {
  const dependants = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const node of spec.nodes) {
    remainingDependencies.set(node.key, node.dependsOn.length);
    for (const dependency of node.dependsOn) {
      const entries = dependants.get(dependency) ?? [];
      entries.push(node.key);
      dependants.set(dependency, entries);
    }
  }
  for (const entries of dependants.values()) {
    entries.sort(compareText);
  }
  return { dependants, remainingDependencies };
};

const validateFanOut = (
  dependants: ReadonlyMap<string, readonly string[]>,
  maxFanOut: number
): DomainResult<undefined, WorkflowCompilationFailure> => {
  for (const [nodeKey, entries] of dependants) {
    if (entries.length > maxFanOut) {
      return fail({
        code: "fan-out-limit-exceeded",
        message: `Node ${nodeKey} has fan-out ${entries.length}; limit is ${maxFanOut}.`,
        nodeKey,
      });
    }
  }
  return succeed(undefined);
};

const calculateDepth = (
  node: WorkflowNode,
  depths: ReadonlyMap<string, number>
): number =>
  node.dependsOn.reduce(
    (maximum, dependency) =>
      Math.max(maximum, (depths.get(dependency) ?? -1) + 1),
    0
  );

const orderGraph = (
  spec: WorkflowSpec,
  nodesByKey: ReadonlyMap<string, WorkflowNode>,
  graph: WorkflowGraph,
  maxDepth: number
): DomainResult<OrderedGraph, WorkflowCompilationFailure> => {
  const ready = spec.nodes
    .filter((node) => node.dependsOn.length === 0)
    .map((node) => node.key)
    .sort(compareText);
  const orderedKeys: string[] = [];
  const depths = new Map<string, number>();

  while (ready.length > 0) {
    const nodeKey = ready.shift();
    const node = nodeKey === undefined ? undefined : nodesByKey.get(nodeKey);
    if (nodeKey === undefined || node === undefined) {
      throw new Error("Compiler invariant violated while ordering nodes.");
    }
    orderedKeys.push(nodeKey);
    const depth = calculateDepth(node, depths);
    if (depth > maxDepth) {
      return fail({
        code: "depth-limit-exceeded",
        message: `Node ${nodeKey} has depth ${depth}; limit is ${maxDepth}.`,
        nodeKey,
      });
    }
    depths.set(nodeKey, depth);

    for (const dependant of graph.dependants.get(nodeKey) ?? []) {
      const nextRemaining =
        (graph.remainingDependencies.get(dependant) ?? 0) - 1;
      graph.remainingDependencies.set(dependant, nextRemaining);
      if (nextRemaining === 0) {
        ready.push(dependant);
        ready.sort(compareText);
      }
    }
  }

  if (orderedKeys.length !== spec.nodes.length) {
    return fail({
      code: "cycle-detected",
      message: "Workflow dependency graph contains a cycle.",
    });
  }
  return succeed({ depths, orderedKeys });
};

const toCompiledNodes = (
  ordered: OrderedGraph,
  nodesByKey: ReadonlyMap<string, WorkflowNode>
) =>
  ordered.orderedKeys.map((key) => {
    const node = nodesByKey.get(key);
    if (node === undefined) {
      throw new Error(`Compiler invariant violated: missing node ${key}.`);
    }
    return {
      capability: node.capability,
      dependsOn: [...node.dependsOn].sort(compareText),
      depth: ordered.depths.get(key) ?? 0,
      ...(node.humanGate === undefined ? {} : { humanGate: node.humanGate }),
      key: node.key,
    };
  });

export const compileWorkflow = ({
  spec,
  allowedCapabilities,
  limits,
  compilerVersion,
}: CompileWorkflowInput): DomainResult<
  CompiledWorkflow,
  WorkflowCompilationFailure
> => {
  if (compilerVersion !== WORKFLOW_COMPILER_VERSION) {
    return fail({
      code: "compiler-version-unsupported",
      message: "The requested workflow compiler version is not supported.",
    });
  }
  const validation = validateNodes(spec, allowedCapabilities, limits.maxNodes);
  if (!validation.ok) {
    return validation;
  }

  const graph = buildGraph(spec);
  const fanOutValidation = validateFanOut(graph.dependants, limits.maxFanOut);
  if (!fanOutValidation.ok) {
    return fanOutValidation;
  }

  const ordering = orderGraph(spec, validation.value, graph, limits.maxDepth);
  if (!ordering.ok) {
    return ordering;
  }

  const nodes = toCompiledNodes(ordering.value, validation.value);
  const fingerprint = nodes
    .map(
      (node) =>
        `${node.key}:${node.capability.capabilityId}@${node.capability.capabilityVersion}:${node.dependsOn.join(",")}:${node.humanGate ?? ""}`
    )
    .join("|");

  return succeed({
    compilerVersion,
    fingerprint,
    nodes,
    workflowContentHash: spec.contentHash,
    workflowRevision: spec.revision,
    workflowSpecId: spec.workflowSpecId,
  });
};
