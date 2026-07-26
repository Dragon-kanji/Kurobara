import {
  type Dataset,
  type DomainResult,
  type EnrichmentRecipe,
  type Field,
  type FieldId,
  fail,
  succeed,
  validateDatasetFields,
} from "@kurobara/kernel";

export const RECIPE_FIELD_GRAPH_COMPILER_VERSION = "1.0.0";

export type RecipeFieldGraphCompilationLimits = Readonly<{
  maxDepth: number;
  maxFanOut: number;
  maxNodes: number;
}>;

export type CompiledRecipeFieldNode = Readonly<{
  dependsOn: readonly FieldId[];
  depth: number;
  recipe: EnrichmentRecipe;
  targetFieldId: FieldId;
}>;

export type CompiledRecipeFieldGraph = Readonly<{
  compilerVersion: typeof RECIPE_FIELD_GRAPH_COMPILER_VERSION;
  datasetId: Dataset["datasetId"];
  fingerprint: string;
  nodes: readonly CompiledRecipeFieldNode[];
  sourceFieldIds: readonly FieldId[];
  workspaceId: Dataset["workspaceId"];
}>;

export type RecipeFieldGraphCompilationFailureCode =
  | "cycle-detected"
  | "depth-limit-exceeded"
  | "duplicate-input-field"
  | "duplicate-recipe-identity"
  | "duplicate-target-field"
  | "fan-out-limit-exceeded"
  | "field-collection-invalid"
  | "invalid-limits"
  | "node-limit-exceeded"
  | "recipe-scope-mismatch"
  | "self-dependency"
  | "unknown-input-field"
  | "unknown-target-field";

export type RecipeFieldGraphCompilationFailure = Readonly<{
  code: RecipeFieldGraphCompilationFailureCode;
  message: string;
  recipeId?: string;
  targetFieldId?: string;
}>;

export type CompileRecipeFieldGraphInput = Readonly<{
  dataset: Dataset;
  fields: readonly Field[];
  limits: RecipeFieldGraphCompilationLimits;
  recipes: readonly EnrichmentRecipe[];
}>;

type RecipeNodeDraft = Readonly<{
  dependsOn: readonly FieldId[];
  recipe: EnrichmentRecipe;
}>;

type RecipeGraph = Readonly<{
  dependants: ReadonlyMap<FieldId, readonly FieldId[]>;
  remainingDependencies: Map<FieldId, number>;
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

const reject = (
  code: RecipeFieldGraphCompilationFailureCode,
  message: string,
  context: Readonly<{ recipeId?: string; targetFieldId?: string }> = {}
): DomainResult<never, RecipeFieldGraphCompilationFailure> =>
  fail({ code, message, ...context });

const limitsAreValid = (limits: RecipeFieldGraphCompilationLimits): boolean =>
  Number.isSafeInteger(limits.maxNodes) &&
  limits.maxNodes > 0 &&
  Number.isSafeInteger(limits.maxDepth) &&
  limits.maxDepth >= 0 &&
  Number.isSafeInteger(limits.maxFanOut) &&
  limits.maxFanOut >= 0;

const validateRecipes = (
  input: CompileRecipeFieldGraphInput,
  fieldsById: ReadonlyMap<FieldId, Field>
): DomainResult<
  ReadonlyMap<FieldId, EnrichmentRecipe>,
  RecipeFieldGraphCompilationFailure
> => {
  if (input.recipes.length > input.limits.maxNodes) {
    return reject(
      "node-limit-exceeded",
      `Recipe field graph contains ${input.recipes.length} nodes; limit is ${input.limits.maxNodes}.`
    );
  }
  const recipesByTarget = new Map<FieldId, EnrichmentRecipe>();
  const recipeIds = new Set<string>();
  for (const recipe of input.recipes) {
    const context = {
      recipeId: recipe.enrichmentRecipeId,
      targetFieldId: recipe.targetFieldId,
    };
    if (
      recipe.workspaceId !== input.dataset.workspaceId ||
      recipe.datasetId !== input.dataset.datasetId
    ) {
      return reject(
        "recipe-scope-mismatch",
        "Every recipe in a field graph must belong to its dataset scope.",
        context
      );
    }
    if (recipeIds.has(recipe.enrichmentRecipeId)) {
      return reject(
        "duplicate-recipe-identity",
        "A field graph can select only one revision of each recipe identity.",
        context
      );
    }
    recipeIds.add(recipe.enrichmentRecipeId);
    if (recipesByTarget.has(recipe.targetFieldId)) {
      return reject(
        "duplicate-target-field",
        "A field graph can contain only one recipe producer for each target field.",
        context
      );
    }
    if (!fieldsById.has(recipe.targetFieldId)) {
      return reject(
        "unknown-target-field",
        "A recipe target must be a field in the graph dataset.",
        context
      );
    }
    const inputs = new Set(recipe.inputFieldIds);
    if (inputs.size !== recipe.inputFieldIds.length) {
      return reject(
        "duplicate-input-field",
        "A recipe input field can appear only once in the field graph.",
        context
      );
    }
    if (inputs.has(recipe.targetFieldId)) {
      return reject(
        "self-dependency",
        "A recipe cannot depend on its own target field.",
        context
      );
    }
    if (recipe.inputFieldIds.some((fieldId) => !fieldsById.has(fieldId))) {
      return reject(
        "unknown-input-field",
        "Every recipe input must be a field in the graph dataset.",
        context
      );
    }
    recipesByTarget.set(recipe.targetFieldId, recipe);
  }
  return succeed(recipesByTarget);
};

const draftNodes = (
  recipesByTarget: ReadonlyMap<FieldId, EnrichmentRecipe>
): ReadonlyMap<FieldId, RecipeNodeDraft> => {
  const nodes = new Map<FieldId, RecipeNodeDraft>();
  for (const [targetFieldId, recipe] of recipesByTarget) {
    const dependsOn = recipe.inputFieldIds
      .filter((fieldId) => recipesByTarget.has(fieldId))
      .sort(compareText);
    nodes.set(targetFieldId, { dependsOn, recipe });
  }
  return nodes;
};

const buildGraph = (
  nodes: ReadonlyMap<FieldId, RecipeNodeDraft>
): RecipeGraph => {
  const dependants = new Map<FieldId, FieldId[]>();
  const remainingDependencies = new Map<FieldId, number>();
  for (const [targetFieldId, node] of nodes) {
    remainingDependencies.set(targetFieldId, node.dependsOn.length);
    for (const inputFieldId of node.recipe.inputFieldIds) {
      const entries = dependants.get(inputFieldId) ?? [];
      entries.push(targetFieldId);
      dependants.set(inputFieldId, entries);
    }
  }
  for (const entries of dependants.values()) {
    entries.sort(compareText);
  }
  return { dependants, remainingDependencies };
};

const validateFanOut = (
  graph: RecipeGraph,
  maximum: number
): DomainResult<undefined, RecipeFieldGraphCompilationFailure> => {
  for (const [targetFieldId, dependants] of graph.dependants) {
    if (dependants.length > maximum) {
      return reject(
        "fan-out-limit-exceeded",
        `Recipe input field ${targetFieldId} has fan-out ${dependants.length}; limit is ${maximum}.`,
        { targetFieldId }
      );
    }
  }
  return succeed(undefined);
};

const orderNodes = (
  nodes: ReadonlyMap<FieldId, RecipeNodeDraft>,
  graph: RecipeGraph,
  maximumDepth: number
): DomainResult<
  readonly CompiledRecipeFieldNode[],
  RecipeFieldGraphCompilationFailure
> => {
  const ready = [...nodes]
    .filter((entry) => entry[1].dependsOn.length === 0)
    .map((entry) => entry[0])
    .sort(compareText);
  const depths = new Map<FieldId, number>();
  const ordered: CompiledRecipeFieldNode[] = [];

  while (ready.length > 0) {
    const targetFieldId = ready.shift();
    const node =
      targetFieldId === undefined ? undefined : nodes.get(targetFieldId);
    if (targetFieldId === undefined || node === undefined) {
      throw new Error(
        "Recipe graph compiler invariant violated while ordering nodes."
      );
    }
    const depth = node.dependsOn.reduce(
      (maximum, dependency) =>
        Math.max(maximum, (depths.get(dependency) ?? -1) + 1),
      0
    );
    if (depth > maximumDepth) {
      return reject(
        "depth-limit-exceeded",
        `Recipe target ${targetFieldId} has depth ${depth}; limit is ${maximumDepth}.`,
        {
          recipeId: node.recipe.enrichmentRecipeId,
          targetFieldId,
        }
      );
    }
    depths.set(targetFieldId, depth);
    ordered.push({
      dependsOn: [...node.dependsOn],
      depth,
      recipe: { ...node.recipe, inputFieldIds: [...node.recipe.inputFieldIds] },
      targetFieldId,
    });
    for (const dependant of graph.dependants.get(targetFieldId) ?? []) {
      const nextRemaining =
        (graph.remainingDependencies.get(dependant) ?? 0) - 1;
      graph.remainingDependencies.set(dependant, nextRemaining);
      if (nextRemaining === 0) {
        ready.push(dependant);
        ready.sort(compareText);
      }
    }
  }
  if (ordered.length !== nodes.size) {
    return reject(
      "cycle-detected",
      "Recipe field dependencies contain a cycle."
    );
  }
  return succeed(ordered);
};

const sourceFields = (
  nodes: readonly CompiledRecipeFieldNode[],
  recipesByTarget: ReadonlyMap<FieldId, EnrichmentRecipe>
): readonly FieldId[] =>
  [
    ...new Set(
      nodes.flatMap((node) =>
        node.recipe.inputFieldIds.filter(
          (fieldId) => !recipesByTarget.has(fieldId)
        )
      )
    ),
  ].sort(compareText);

const fingerprintFor = (
  input: CompileRecipeFieldGraphInput,
  nodes: readonly CompiledRecipeFieldNode[],
  sourceFieldIds: readonly FieldId[]
): string =>
  JSON.stringify({
    compilerVersion: RECIPE_FIELD_GRAPH_COMPILER_VERSION,
    datasetId: input.dataset.datasetId,
    nodes: nodes.map((node) => ({
      dependsOn: node.dependsOn,
      depth: node.depth,
      inputFieldIds: node.recipe.inputFieldIds,
      recipeId: node.recipe.enrichmentRecipeId,
      recipeRevision: node.recipe.recipeRevision,
      targetFieldId: node.targetFieldId,
      workflowContentHash: node.recipe.workflowContentHash,
      workflowRevision: node.recipe.workflowRevision,
      workflowSpecId: node.recipe.workflowSpecId,
    })),
    sourceFieldIds,
    workspaceId: input.dataset.workspaceId,
  });

export const compileRecipeFieldGraph = (
  input: CompileRecipeFieldGraphInput
): DomainResult<
  CompiledRecipeFieldGraph,
  RecipeFieldGraphCompilationFailure
> => {
  if (!limitsAreValid(input.limits)) {
    return reject(
      "invalid-limits",
      "Recipe field graph limits must be bounded non-negative integers with at least one allowed node."
    );
  }
  if (
    input.fields.some(
      (field) =>
        field.workspaceId !== input.dataset.workspaceId ||
        field.datasetId !== input.dataset.datasetId
    ) ||
    !validateDatasetFields(input.dataset, input.fields).ok
  ) {
    return reject(
      "field-collection-invalid",
      "Recipe field graph fields must form the exact valid dataset field collection."
    );
  }
  const fieldsById = new Map(
    input.fields.map((field) => [field.fieldId, field])
  );
  const recipes = validateRecipes(input, fieldsById);
  if (!recipes.ok) {
    return recipes;
  }
  const nodes = draftNodes(recipes.value);
  const graph = buildGraph(nodes);
  const fanOut = validateFanOut(graph, input.limits.maxFanOut);
  if (!fanOut.ok) {
    return fanOut;
  }
  const ordered = orderNodes(nodes, graph, input.limits.maxDepth);
  if (!ordered.ok) {
    return ordered;
  }
  const sourceFieldIds = sourceFields(ordered.value, recipes.value);
  return succeed({
    compilerVersion: RECIPE_FIELD_GRAPH_COMPILER_VERSION,
    datasetId: input.dataset.datasetId,
    fingerprint: fingerprintFor(input, ordered.value, sourceFieldIds),
    nodes: ordered.value,
    sourceFieldIds,
    workspaceId: input.dataset.workspaceId,
  });
};
