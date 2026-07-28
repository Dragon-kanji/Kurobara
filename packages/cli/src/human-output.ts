const PINK = "\u001b[38;5;198m";
const GREEN = "\u001b[38;5;34m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const MAX_CELL_WIDTH = 28;

export type HumanOutputTarget = Readonly<{
  isTTY?: boolean;
  write: (chunk: string | Uint8Array) => unknown;
}>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const line = (target: HumanOutputTarget, value = ""): void => {
  target.write(`${value}\n`);
};

const text = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "—";
  }
  if (Array.isArray(value)) {
    return value.map(text).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
};

const clipped = (value: unknown): string => {
  const rendered = text(value).replaceAll(/\s+/gu, " ");
  return rendered.length <= MAX_CELL_WIDTH
    ? rendered
    : `${rendered.slice(0, MAX_CELL_WIDTH - 1)}…`;
};

const header = (
  target: HumanOutputTarget,
  title: string,
  color: boolean
): void => {
  line(
    target,
    `KUROBARA ${color ? PINK : ""}◆${color ? RESET : ""} ${title.toUpperCase()}`
  );
  line(
    target,
    `${color ? DIM : ""}──────${color ? RESET : ""}${color ? PINK : ""}···●····●···${color ? RESET : ""}${color ? DIM : ""}──────────────${color ? RESET : ""}`
  );
};

const renderQuestionnaire = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The TTY renderer mirrors the bounded questionnaire hierarchy without changing business state.
): void => {
  header(target, "GTM Context questions", color);
  line(
    target,
    `Profile ${text(result.profile)} · questionnaire ${text(result.questionnaire_version)}`
  );
  let section = "";
  for (const candidate of Array.isArray(result.questions)
    ? result.questions
    : []) {
    if (!isObject(candidate)) {
      continue;
    }
    const nextSection = text(candidate.section);
    if (nextSection !== section) {
      section = nextSection;
      line(target);
      line(target, section.toUpperCase());
    }
    const gate =
      candidate.requires_human_confirmation === true ? " [HUMAN]" : "";
    line(
      target,
      `${color && gate.length > 0 ? PINK : ""}${text(candidate.question_id)}${gate}${color && gate.length > 0 ? RESET : ""}`
    );
    line(target, `  ${text(candidate.prompt)}`);
    if (isObject(candidate.ask_if)) {
      line(
        target,
        `  ${color ? DIM : ""}ask if ${text(candidate.ask_if.question_id)} = ${text(candidate.ask_if.equals)}${color ? RESET : ""}`
      );
    }
  }
};

const renderContextStatus = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "GTM readiness", color);
  const ready = result.ready === true;
  let statusColor = "";
  if (color) {
    statusColor = ready ? GREEN : PINK;
  }
  line(
    target,
    `${statusColor}${ready ? "READY" : "BLOCKED"}${color ? RESET : ""} · ${text(result.profile)} · ${text(result.business_context)}`
  );
  if (isObject(result.active_context)) {
    line(
      target,
      `Active ${text(result.active_context.context_id)} r${text(result.active_context.revision)}`
    );
  }
  const blocking = Array.isArray(result.blocking_question_ids)
    ? result.blocking_question_ids
    : [];
  for (const questionId of blocking) {
    line(target, `! ${text(questionId)}`);
  }
  for (const remediation of Array.isArray(result.remediation)
    ? result.remediation
    : []) {
    line(target, `→ ${text(remediation)}`);
  }
};

const renderContextPlan = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "Context review", color);
  line(target, `Fingerprint ${text(result.fingerprint)}`);
  if (isObject(result.ready_for)) {
    for (const [profile, ready] of Object.entries(result.ready_for)) {
      line(target, `${ready === true ? "✓" : "·"} ${profile}`);
    }
  }
  for (const issue of Array.isArray(result.issues) ? result.issues : []) {
    if (isObject(issue)) {
      line(
        target,
        `! ${issue.question_id === undefined ? "" : `${text(issue.question_id)} · `}${text(issue.message)}`
      );
    }
  }
};

const renderPlay = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "Play review", color);
  line(
    target,
    `${text(result.lifecycle ?? result.action)} · fingerprint ${text(result.fingerprint)}`
  );
  let compilation: Record<string, unknown> | undefined;
  if (isObject(result.compilation)) {
    compilation = result.compilation;
  } else if (
    isObject(result.revision) &&
    isObject(result.revision.compilation)
  ) {
    compilation = result.revision.compilation;
  }
  if (compilation !== undefined && isObject(compilation.budget)) {
    line(
      target,
      `Quote ≤ ${text(compilation.budget.quoted_upper_bound)} ${text(compilation.budget.unit)}`
    );
  }
  if (compilation !== undefined && isObject(compilation.authority)) {
    line(target, `Human gates: ${text(compilation.authority.human_gates)}`);
  }
  if (compilation !== undefined) {
    line(target);
    for (const stage of Array.isArray(compilation.stages)
      ? compilation.stages
      : []) {
      if (isObject(stage)) {
        line(
          target,
          `${text(stage.ordinal).padStart(2, "0")}  ${text(stage.operation_id)}`
        );
      }
    }
  }
  if (isObject(result.run)) {
    line(target, `Run ${text(result.run.run_id)} · ${text(result.run.state)}`);
  }
};

const workbookCellValue = (
  cell: Record<string, unknown> | undefined
): string => {
  if (cell === undefined) {
    return "—";
  }
  return cell.redacted === true ? "[redacted]" : clipped(cell.value);
};

const workbookRecordState = (
  cells: readonly Record<string, unknown>[]
): string => {
  if (cells.some((cell) => cell.status === "failed")) {
    return "failed";
  }
  if (cells.some((cell) => cell.status === "running")) {
    return "running";
  }
  return cells.every((cell) => cell.status === "succeeded")
    ? "ready"
    : "pending";
};

const renderWorkbookEvidence = (
  target: HumanOutputTarget,
  cells: readonly Record<string, unknown>[]
): void => {
  for (const cell of cells) {
    if (
      cell.confidence !== null ||
      cell.cost !== null ||
      cell.freshness !== null ||
      (Array.isArray(cell.provenance) && cell.provenance.length > 0)
    ) {
      const cost = isObject(cell.cost)
        ? `${text(cell.cost.amount)} ${text(cell.cost.unit)} ${text(cell.cost.basis)}`
        : "—";
      line(
        target,
        `    ${text(cell.field_id)} · confidence ${text(cell.confidence)} · cost ${cost} · provenance ${text(cell.provenance)}`
      );
    }
  }
};

const renderWorkbook = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "Workbook", color);
  const fields = (Array.isArray(result.fields) ? result.fields : []).filter(
    isObject
  );
  const labels = fields.map((field) => clipped(field.label));
  line(target, ["#", ...labels, "STATE"].join("  "));
  line(target, ["—", ...labels.map(() => "────────"), "────────"].join("  "));
  for (const record of (Array.isArray(result.records)
    ? result.records
    : []
  ).filter(isObject)) {
    const cells = (Array.isArray(record.cells) ? record.cells : []).filter(
      isObject
    );
    const cellByField = new Map(
      cells.map((cell) => [text(cell.field_id), cell])
    );
    const values = fields.map((field) =>
      workbookCellValue(cellByField.get(text(field.field_id)))
    );
    const state = workbookRecordState(cells);
    line(target, [text(record.ordinal), ...values, state].join("  "));
    if (
      Array.isArray(record.selection_reasons) &&
      record.selection_reasons.length > 0
    ) {
      line(target, `    selected: ${text(record.selection_reasons)}`);
    }
    renderWorkbookEvidence(target, cells);
  }
  if (isObject(result.view)) {
    line(target);
    line(
      target,
      `View ${text(result.view.workbook_id)} r${text(result.view.revision)} · selected ${Array.isArray(result.view.selected_record_ids) ? result.view.selected_record_ids.length : 0}`
    );
  }
  line(
    target,
    `${result.has_more === true ? "More rows available" : "End of bounded page"}`
  );
};

const renderPlayRun = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "Play run", color);
  const run = isObject(result.run) ? result.run : result;
  line(
    target,
    `${text(run.run_id)} · ${text(run.state)} · Play ${text(run.play_id)} r${text(run.play_revision)}`
  );
  if (isObject(run.compilation)) {
    for (const stage of Array.isArray(run.compilation.stages)
      ? run.compilation.stages
      : []) {
      if (isObject(stage)) {
        line(
          target,
          `${text(stage.ordinal).padStart(2, "0")}  ${text(stage.operation_id)}`
        );
      }
    }
  }
};

const renderWorkbookUpdate = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "Workbook saved", color);
  const view = isObject(result.view) ? result.view : result;
  line(
    target,
    `${text(view.workbook_id)} r${text(view.revision)} · selected ${Array.isArray(view.selected_record_ids) ? view.selected_record_ids.length : 0}`
  );
  line(
    target,
    `Approvals ${Array.isArray(view.approvals) ? view.approvals.length : 0} · annotations ${Array.isArray(view.annotations) ? view.annotations.length : 0}`
  );
};

export const renderHumanCommandResult = (
  target: HumanOutputTarget,
  command: string,
  result: unknown,
  color: boolean
): void => {
  if (!isObject(result)) {
    header(target, command, color);
    line(target, text(result));
    return;
  }
  if (command === "gtm-contexts.questionnaire.get") {
    renderQuestionnaire(target, result, color);
    return;
  }
  if (command === "gtm-contexts.status.get") {
    renderContextStatus(target, result, color);
    return;
  }
  if (command === "gtm-contexts.plan") {
    renderContextPlan(target, result, color);
    return;
  }
  if (command.startsWith("plays.")) {
    renderPlay(target, result, color);
    return;
  }
  if (command === "play-runs.get") {
    renderPlayRun(target, result, color);
    return;
  }
  if (command === "workbooks.get") {
    renderWorkbook(target, result, color);
    return;
  }
  if (command === "workbooks.update") {
    renderWorkbookUpdate(target, result, color);
    return;
  }
  header(target, command, color);
  line(target, JSON.stringify(result, null, 2));
};
