import { type DomainResult, fail, succeed } from "@kurobara/kernel";
import type { BootstrapPlanningInput } from "@kurobara/ports";
import {
  compileWorkflow,
  type WorkflowCompilationFailure,
} from "@kurobara/workflow-engine";

export type ValidatePlanningBundleFailure = Readonly<{
  code: "workflow-rejected";
  failure: WorkflowCompilationFailure;
  workflowSpecId: string;
}>;

export const validatePlanningBundle = (
  input: BootstrapPlanningInput
): DomainResult<undefined, ValidatePlanningBundleFailure> => {
  for (const workflow of input.workflows) {
    const compiled = compileWorkflow({
      allowedCapabilities: workflow.allowedCapabilities,
      compilerVersion: workflow.compilerVersion,
      limits: workflow.compilationLimits,
      spec: workflow.workflow,
    });
    if (!compiled.ok) {
      return fail({
        code: "workflow-rejected",
        failure: compiled.error,
        workflowSpecId: workflow.workflow.workflowSpecId,
      });
    }
  }
  return succeed(undefined);
};
