const PINK = "\u001b[38;5;198m";
const GREEN = "\u001b[38;5;34m";
const WHITE = "\u001b[38;5;255m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

const BRAND_MARKER = "···●····●···";
const DEFAULT_TERMINAL_WIDTH = 96;
const MAX_TERMINAL_WIDTH = 140;
const MIN_TERMINAL_WIDTH = 64;
const MAX_CELL_WIDTH = 24;
const TABLE_GAP = "  ";

export type HumanOutputTarget = Readonly<{
  columns?: number;
  isTTY?: boolean;
  write: (chunk: string | Uint8Array) => unknown;
}>;

type WorkbookField = Readonly<{
  fieldId: string;
  label: string;
  width: number;
}>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const objects = (value: unknown): readonly Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).filter(isObject);

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

const clipped = (value: unknown, maxWidth = MAX_CELL_WIDTH): string => {
  const rendered = text(value).replaceAll(/\s+/gu, " ");
  return rendered.length <= maxWidth
    ? rendered
    : `${rendered.slice(0, Math.max(1, maxWidth - 1))}…`;
};

const terminalWidth = (target: HumanOutputTarget): number => {
  const requested = target.columns ?? DEFAULT_TERMINAL_WIDTH;
  return Math.min(MAX_TERMINAL_WIDTH, Math.max(MIN_TERMINAL_WIDTH, requested));
};

const styled = (value: string, sequence: string, color: boolean): string =>
  color ? `${sequence}${value}${RESET}` : value;

const dimmed = (value: string, color: boolean): string =>
  styled(value, DIM, color);

const emphasized = (value: string, color: boolean): string =>
  styled(value, `${BOLD}${WHITE}`, color);

const pink = (value: string, color: boolean): string =>
  styled(value, `${BOLD}${PINK}`, color);

const green = (value: string, color: boolean): string =>
  styled(value, `${BOLD}${GREEN}`, color);

const repeat = (character: string, width: number): string =>
  character.repeat(Math.max(0, width));

const header = (
  target: HumanOutputTarget,
  title: string,
  color: boolean
): void => {
  line(
    target,
    `${emphasized("KUROBARA", color)} ${pink("◆", color)} ${emphasized(title.toUpperCase(), color)}`
  );
  const remainingWidth = Math.max(
    12,
    terminalWidth(target) - 6 - BRAND_MARKER.length
  );
  line(
    target,
    `${dimmed("──────", color)}${pink(BRAND_MARKER, color)}${dimmed(repeat("─", remainingWidth), color)}`
  );
  line(target);
};

const section = (
  target: HumanOutputTarget,
  title: string,
  color: boolean,
  detail?: string
): void => {
  const suffix = detail === undefined ? "" : `  ${dimmed(detail, color)}`;
  line(target, `${emphasized(title.toUpperCase(), color)}${suffix}`);
  line(target, dimmed(repeat("─", terminalWidth(target)), color));
};

const gap = (target: HumanOutputTarget): void => {
  line(target);
};

const keyValue = (
  target: HumanOutputTarget,
  label: string,
  value: unknown,
  color: boolean,
  labelWidth = 12
): void => {
  line(
    target,
    `  ${dimmed(label.padEnd(labelWidth), color)}${TABLE_GAP}${text(value)}`
  );
};

const arrayCount = (value: unknown): number =>
  Array.isArray(value) ? value.length : 0;

const quantity = (
  count: number,
  singular: string,
  plural = `${singular}s`
): string => `${count} ${count === 1 ? singular : plural}`;

const humanized = (value: unknown): string =>
  text(value).replaceAll(/[._-]+/gu, " ");

const statusSymbol = (value: unknown): string => {
  const status = text(value).toLowerCase();
  if (
    [
      "active",
      "applied",
      "approved",
      "completed",
      "ready",
      "succeeded",
    ].includes(status)
  ) {
    return "✓";
  }
  if (["blocked", "cancelled", "failed", "rejected"].includes(status)) {
    return "×";
  }
  if (status === "running") {
    return "●";
  }
  if (status === "paused") {
    return "◆";
  }
  if (["pending", "planned", "queued"].includes(status)) {
    return "○";
  }
  return "·";
};

const statusTone = (
  value: unknown,
  rendered: string,
  color: boolean
): string => {
  const status = text(value).toLowerCase();
  if (
    [
      "active",
      "applied",
      "approved",
      "completed",
      "ready",
      "succeeded",
    ].includes(status)
  ) {
    return green(rendered, color);
  }
  if (
    [
      "blocked",
      "cancelled",
      "failed",
      "paused",
      "rejected",
      "running",
    ].includes(status)
  ) {
    return pink(rendered, color);
  }
  return emphasized(rendered, color);
};

const statusBadge = (value: unknown, color: boolean): string => {
  const label = text(value).toUpperCase();
  return statusTone(value, `${statusSymbol(value)} ${label}`, color);
};

const statusDescription = (value: unknown): string => {
  const status = text(value).toLowerCase();
  const descriptions: Readonly<Record<string, string>> = {
    blocked: "Required input is still unresolved",
    cancelled: "No further work will run",
    completed: "All planned stages reached a terminal state",
    failed: "Execution stopped with a failure",
    paused: "Review boundary reached",
    pending: "Waiting for upstream work",
    queued: "Waiting for a worker",
    ready: "Ready for the next bounded action",
    running: "Execution is in progress",
  };
  return descriptions[status] ?? humanized(value);
};

const renderDominantStatus = (
  target: HumanOutputTarget,
  status: unknown,
  color: boolean
): void => {
  line(
    target,
    `  ${statusBadge(status, color)}  ${dimmed(statusDescription(status), color)}`
  );
};

const formatConfidence = (value: unknown): string => {
  if (typeof value !== "number") {
    return text(value);
  }
  return `${Math.round(value * 100)}%`;
};

const formatCost = (value: unknown): string => {
  if (!isObject(value)) {
    return "—";
  }
  return `${text(value.amount)} ${text(value.unit)} · ${text(value.basis)}`;
};

const formatTimestamp = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return text(value);
  }
  return new Date(value).toISOString();
};

const renderQuestionnaire = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "GTM Context questions", color);
  keyValue(target, "Profile", result.profile, color);
  keyValue(target, "Questionnaire", result.questionnaire_version, color);

  const questions = objects(result.questions);
  let sectionName = "";
  for (const [index, candidate] of questions.entries()) {
    const nextSection = text(candidate.section);
    if (nextSection !== sectionName) {
      sectionName = nextSection;
      gap(target);
      section(target, sectionName, color);
    }
    const humanGate = candidate.requires_human_confirmation === true;
    const identifier = `${String(index + 1).padStart(2, "0")}  ${text(candidate.question_id)}`;
    line(
      target,
      `  ${humanGate ? pink("◆ HUMAN", color) : dimmed("· DRAFTABLE", color)}  ${emphasized(identifier, color)}`
    );
    line(target, `      ${text(candidate.prompt)}`);
    if (isObject(candidate.ask_if)) {
      line(
        target,
        `      ${dimmed(`asked when ${text(candidate.ask_if.question_id)} = ${text(candidate.ask_if.equals)}`, color)}`
      );
    }
    if (index < questions.length - 1) {
      line(target);
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
  section(target, "Status", color);
  renderDominantStatus(target, ready ? "ready" : "blocked", color);
  keyValue(target, "Profile", result.profile, color);
  keyValue(target, "Context", result.business_context, color);
  if (isObject(result.active_context)) {
    keyValue(
      target,
      "Active",
      `${text(result.active_context.context_id)} · revision ${text(result.active_context.revision)}`,
      color
    );
  }

  const blocking = Array.isArray(result.blocking_question_ids)
    ? result.blocking_question_ids
    : [];
  if (blocking.length > 0) {
    gap(target);
    section(target, "Blocking answers", color, `${blocking.length}`);
    for (const questionId of blocking) {
      line(target, `  ${pink("!", color)} ${text(questionId)}`);
    }
  }

  const remediation = Array.isArray(result.remediation)
    ? result.remediation
    : [];
  if (remediation.length > 0) {
    gap(target);
    section(target, "Next", color);
    for (const item of remediation) {
      line(target, `  ${pink("→", color)} ${text(item)}`);
    }
  }
};

const renderContextPlan = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "Context review", color);
  section(target, "Review receipt", color);
  keyValue(target, "Fingerprint", result.fingerprint, color);

  if (isObject(result.ready_for)) {
    gap(target);
    section(target, "Readiness", color);
    for (const [profile, ready] of Object.entries(result.ready_for)) {
      line(
        target,
        `  ${ready === true ? green("✓ READY", color) : pink("× BLOCKED", color)}  ${profile}`
      );
    }
  }

  const issues = objects(result.issues);
  if (issues.length > 0) {
    gap(target);
    section(target, "Issues", color, `${issues.length}`);
    for (const issue of issues) {
      const question =
        issue.question_id === undefined ? "" : `${text(issue.question_id)} · `;
      line(target, `  ${pink("!", color)} ${question}${text(issue.message)}`);
    }
  } else {
    gap(target);
    line(target, `  ${green("✓", color)} No unresolved review issue`);
  }
};

const playCompilation = (
  result: Record<string, unknown>
): Record<string, unknown> | undefined => {
  if (isObject(result.compilation)) {
    return result.compilation;
  }
  if (isObject(result.revision) && isObject(result.revision.compilation)) {
    return result.revision.compilation;
  }
  return undefined;
};

const renderPlayConstraints = (
  target: HumanOutputTarget,
  compilation: Record<string, unknown>,
  color: boolean,
  play?: Record<string, unknown>
): void => {
  section(target, "Constraints", color);
  if (isObject(compilation.budget)) {
    const quote = `${text(compilation.budget.quoted_upper_bound)} ${text(compilation.budget.unit)}`;
    const limit =
      compilation.budget.limit === undefined
        ? ""
        : ` · hard limit ${text(compilation.budget.limit)}`;
    keyValue(target, "Quote", `${quote}${limit}`, color);
  }
  if (isObject(compilation.authority)) {
    const gates = Array.isArray(compilation.authority.human_gates)
      ? compilation.authority.human_gates
      : [];
    keyValue(
      target,
      "Human gates",
      gates.length === 0 ? "none" : gates.join(", "),
      color
    );
  }
  if (play !== undefined && isObject(play.delivery)) {
    keyValue(target, "Delivery", play.delivery.mode, color);
  }
};

const renderStages = (
  target: HumanOutputTarget,
  stagesValue: unknown,
  color: boolean
): void => {
  const stages = objects(stagesValue);
  section(target, "Execution plan", color, quantity(stages.length, "stage"));
  for (const [index, stage] of stages.entries()) {
    const ordinal = text(stage.ordinal).padStart(2, "0");
    line(
      target,
      `  ${pink(ordinal, color)} ${dimmed("─", color)} ${emphasized(text(stage.operation_id), color)}`
    );
    if (index < stages.length - 1) {
      line(target, `     ${dimmed("│", color)}`);
    }
  }
  if (stages.length === 0) {
    line(target, `  ${dimmed("No compiled stage", color)}`);
  }
};

const renderPlay = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "Play review", color);
  const lifecycle = result.lifecycle ?? result.action ?? "review";
  section(target, "Status", color);
  renderDominantStatus(target, lifecycle, color);
  keyValue(target, "Fingerprint", result.fingerprint, color);

  const compilation = playCompilation(result);
  if (compilation !== undefined) {
    gap(target);
    const play = isObject(result.revision) ? result.revision : undefined;
    renderPlayConstraints(target, compilation, color, play);
    gap(target);
    renderStages(target, compilation.stages, color);
  }
  if (isObject(result.run)) {
    gap(target);
    section(target, "Run", color);
    keyValue(
      target,
      "Run",
      `${text(result.run.run_id)} · ${text(result.run.state)}`,
      color
    );
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

const workbookCellHasEvidence = (cell: Record<string, unknown>): boolean =>
  cell.confidence !== null ||
  cell.cost !== null ||
  cell.freshness !== null ||
  cell.error !== null ||
  (Array.isArray(cell.provenance) && cell.provenance.length > 0);

const renderWorkbookEvidence = (
  target: HumanOutputTarget,
  cells: readonly Record<string, unknown>[],
  labelByField: ReadonlyMap<string, string>,
  color: boolean
): void => {
  for (const cell of cells.filter(workbookCellHasEvidence)) {
    const fieldId = text(cell.field_id);
    const label = labelByField.get(fieldId) ?? fieldId;
    const facts: string[] = [];
    if (cell.confidence !== null) {
      facts.push(`confidence ${formatConfidence(cell.confidence)}`);
    }
    if (cell.cost !== null) {
      facts.push(`cost ${formatCost(cell.cost)}`);
    }
    line(
      target,
      `      ${pink("↳", color)} ${emphasized(label, color)}${facts.length === 0 ? "" : ` · ${facts.join(" · ")}`}`
    );
    if (isObject(cell.freshness)) {
      const expiry =
        cell.freshness.expires_at_ms === null
          ? "no expiry"
          : `expires ${formatTimestamp(cell.freshness.expires_at_ms)}`;
      line(
        target,
        `        ${dimmed(`observed ${formatTimestamp(cell.freshness.observed_at_ms)} · ${expiry}`, color)}`
      );
    }
    if (Array.isArray(cell.provenance) && cell.provenance.length > 0) {
      line(
        target,
        `        ${dimmed("source", color)} ${cell.provenance.map(text).join(", ")}`
      );
    }
    if (isObject(cell.error)) {
      line(
        target,
        `        ${pink("!", color)} ${text(cell.error.code)} · ${text(cell.error.message)}`
      );
    }
  }
};

const workbookFieldWidth = (
  field: Record<string, unknown>,
  records: readonly Record<string, unknown>[]
): number => {
  const fieldId = text(field.field_id);
  const values = records.map((record) => {
    const cell = objects(record.cells).find(
      (candidate) => text(candidate.field_id) === fieldId
    );
    return workbookCellValue(cell).length;
  });
  return Math.min(
    MAX_CELL_WIDTH,
    Math.max(clipped(field.label).length, 4, ...values)
  );
};

const visibleWorkbookFields = (
  target: HumanOutputTarget,
  fields: readonly Record<string, unknown>[],
  records: readonly Record<string, unknown>[]
): readonly WorkbookField[] => {
  const availableWidth = terminalWidth(target);
  const ordinalAndStateWidth = 17;
  let usedWidth = ordinalAndStateWidth;
  const visible: WorkbookField[] = [];
  for (const field of fields) {
    const candidate: WorkbookField = {
      fieldId: text(field.field_id),
      label: clipped(field.label),
      width: workbookFieldWidth(field, records),
    };
    const requiredWidth = candidate.width + TABLE_GAP.length;
    if (visible.length > 0 && usedWidth + requiredWidth > availableWidth) {
      break;
    }
    visible.push(candidate);
    usedWidth += requiredWidth;
  }
  return visible;
};

const renderWorkbookTable = (
  target: HumanOutputTarget,
  fields: readonly Record<string, unknown>[],
  records: readonly Record<string, unknown>[],
  color: boolean
): void => {
  const visibleFields = visibleWorkbookFields(target, fields, records);
  const hiddenFieldCount = fields.length - visibleFields.length;
  const ordinalWidth = Math.max(
    1,
    ...records.map((record) => text(record.ordinal).length)
  );
  const labelByField = new Map(
    fields.map((field) => [text(field.field_id), text(field.label)])
  );
  const stateWidth = 11;
  const headerCells = [
    "#".padEnd(ordinalWidth),
    ...visibleFields.map((field) => field.label.padEnd(field.width)),
    "STATE".padEnd(stateWidth),
  ];
  line(target, `  ${emphasized(headerCells.join(TABLE_GAP), color)}`);
  line(
    target,
    `  ${dimmed(
      [
        repeat("─", ordinalWidth),
        ...visibleFields.map((field) => repeat("─", field.width)),
        repeat("─", stateWidth),
      ].join(TABLE_GAP),
      color
    )}`
  );

  for (const [recordIndex, record] of records.entries()) {
    const cells = objects(record.cells);
    const cellByField = new Map(
      cells.map((cell) => [text(cell.field_id), cell])
    );
    const state = workbookRecordState(cells);
    const stateCell = `${statusSymbol(state)} ${state.toUpperCase()}`.padEnd(
      stateWidth
    );
    const row = [
      text(record.ordinal).padEnd(ordinalWidth),
      ...visibleFields.map((field) =>
        workbookCellValue(cellByField.get(field.fieldId)).padEnd(field.width)
      ),
      statusTone(state, stateCell, color),
    ];
    line(target, `  ${row.join(TABLE_GAP)}`);
    if (
      Array.isArray(record.selection_reasons) &&
      record.selection_reasons.length > 0
    ) {
      line(
        target,
        `      ${pink("◆ SELECTED", color)} · ${record.selection_reasons.map(text).join(", ")}`
      );
    }
    renderWorkbookEvidence(target, cells, labelByField, color);
    if (recordIndex < records.length - 1) {
      line(
        target,
        `  ${dimmed(repeat("┄", Math.min(terminalWidth(target) - 2, 88)), color)}`
      );
    }
  }

  if (records.length === 0) {
    line(target, `  ${dimmed("No row in this bounded page", color)}`);
  }
  if (hiddenFieldCount > 0) {
    line(target);
    line(
      target,
      `  ${pink("+", color)} ${quantity(hiddenFieldCount, "column")} hidden at this terminal width · use --json for the full row`
    );
  }
};

const renderWorkbook = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "Workbook", color);
  const fields = objects(result.fields);
  const records = objects(result.records);
  const view = isObject(result.view) ? result.view : undefined;

  if (view !== undefined) {
    line(target, emphasized(text(view.name), color));
    keyValue(
      target,
      "Workbook",
      `${text(view.workbook_id)} · revision ${text(view.revision)}`,
      color
    );
    keyValue(target, "Dataset", view.dataset_id, color);
    if (view.play_id !== undefined) {
      keyValue(
        target,
        "Play",
        `${text(view.play_id)} · revision ${text(view.play_revision)}`,
        color
      );
    }
  }

  gap(target);
  section(target, "Rows", color, `${records.length} shown`);
  renderWorkbookTable(target, fields, records, color);

  gap(target);
  section(target, "Review state", color);
  if (view !== undefined) {
    const selected = arrayCount(view.selected_record_ids);
    const decisions = arrayCount(view.approvals);
    const annotations = arrayCount(view.annotations);
    line(
      target,
      `  ${emphasized(`${selected} selected`, color)}  ${dimmed("·", color)}  ${emphasized(quantity(decisions, "decision"), color)}  ${dimmed("·", color)}  ${emphasized(quantity(annotations, "annotation"), color)}`
    );
  }
  if (result.has_more === true) {
    line(
      target,
      `  ${pink("→", color)} More rows available after ordinal ${text(result.next_after_ordinal)}`
    );
  } else {
    line(target, `  ${green("✓", color)} End of bounded page`);
  }
};

const renderPlayRun = (
  target: HumanOutputTarget,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, "Play run", color);
  const run = isObject(result.run) ? result.run : result;
  section(target, "Status", color);
  renderDominantStatus(target, run.state, color);
  keyValue(target, "Run", run.run_id, color);
  keyValue(
    target,
    "Play",
    `${text(run.play_id)} · revision ${text(run.play_revision)}`,
    color
  );

  if (isObject(run.compilation)) {
    gap(target);
    const play = isObject(run.play) ? run.play : undefined;
    renderPlayConstraints(target, run.compilation, color, play);
    gap(target);
    renderStages(target, run.compilation.stages, color);
  }
};

const workbookUpdateTitle = (command: string): string => {
  if (command === "workbooks.select") {
    return "Selection saved";
  }
  if (command === "workbooks.approve") {
    return "Approval saved";
  }
  if (command === "workbooks.reject") {
    return "Rejection saved";
  }
  return "Workbook saved";
};

const renderWorkbookUpdate = (
  target: HumanOutputTarget,
  command: string,
  result: Record<string, unknown>,
  color: boolean
): void => {
  header(target, workbookUpdateTitle(command), color);
  const view = isObject(result.view) ? result.view : result;

  section(target, "Receipt", color);
  line(
    target,
    `  ${green("✓ SAVED", color)}  ${dimmed("Versioned review state persisted", color)}`
  );
  keyValue(target, "Workbook", view.workbook_id, color);
  keyValue(target, "Revision", `r${text(view.revision)}`, color);

  gap(target);
  section(target, "Review state", color);
  const selectedIds = Array.isArray(view.selected_record_ids)
    ? view.selected_record_ids
    : [];
  const decisions = objects(view.approvals);
  const annotations = arrayCount(view.annotations);
  line(
    target,
    `  ${emphasized(`${selectedIds.length} selected`, color)}  ${dimmed("·", color)}  ${emphasized(quantity(decisions.length, "decision"), color)}  ${dimmed("·", color)}  ${emphasized(quantity(annotations, "annotation"), color)}`
  );
  if (command === "workbooks.select" && selectedIds.length > 0) {
    line(
      target,
      `  ${pink("◆", color)} ${selectedIds.slice(0, 4).map(text).join(", ")}${selectedIds.length > 4 ? ` · +${selectedIds.length - 4} more` : ""}`
    );
  }
  if (
    (command === "workbooks.approve" || command === "workbooks.reject") &&
    decisions.length > 0
  ) {
    const latest = decisions.at(-1);
    if (latest !== undefined) {
      line(
        target,
        `  ${statusBadge(latest.decision, color)}  ${text(latest.record_id)}`
      );
    }
  }
};

export const renderHumanPlayRunProgress = (
  target: HumanOutputTarget,
  result: unknown,
  pollCount: number,
  color: boolean
): void => {
  if (!isObject(result)) {
    return;
  }
  const run = isObject(result.run) ? result.run : result;
  const visible = [
    pink(BRAND_MARKER, color),
    statusBadge(run.state, color),
    dimmed(`poll ${pollCount}`, color),
    clipped(run.run_id, 36),
  ].join("  ");
  target.write(`\r${visible}`);
};

export const clearHumanPlayRunProgress = (target: HumanOutputTarget): void => {
  target.write(`\r${repeat(" ", terminalWidth(target))}\r`);
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
  if (command.startsWith("workbooks.")) {
    renderWorkbookUpdate(target, command, result, color);
    return;
  }
  header(target, command, color);
  line(target, JSON.stringify(result, null, 2));
};
