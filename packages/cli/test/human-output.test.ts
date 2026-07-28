import assert from "node:assert/strict";
import test from "node:test";

import {
  clearHumanPlayRunProgress,
  type HumanOutputTarget,
  renderHumanCommandResult,
  renderHumanPlayRunProgress,
} from "../src/human-output.ts";

const BOLD = "\u001b[1m";
const GREEN = "\u001b[38;5;34m";
const PINK = "\u001b[38;5;198m";
const RESET = "\u001b[0m";
const styled = (sequence: string, value: string): string =>
  `${sequence}${value}${RESET}`;

const capture = (columns = 112) => {
  const chunks: string[] = [];
  const target: HumanOutputTarget = {
    columns,
    isTTY: true,
    write: (chunk) => {
      chunks.push(String(chunk));
    },
  };
  return {
    target,
    value: () => chunks.join(""),
  };
};

const contains = (rendered: string, expected: string): boolean =>
  rendered.includes(expected);

const playRun = {
  run: {
    compilation: {
      authority: {
        human_gates: ["provider_spend", "reveal"],
      },
      budget: {
        limit: 18,
        quoted_upper_bound: 12.4,
        unit: "credits",
      },
      stages: [
        { operation_id: "organizations.discover", ordinal: 1 },
        { operation_id: "contacts.discover", ordinal: 2 },
      ],
    },
    play: {
      delivery: {
        mode: "no_send",
      },
    },
    play_id: "outbound-fr-saas",
    play_revision: 3,
    run_id: "play-run-outbound-2026-07-28",
    state: "paused",
  },
} as const;

const workbook = {
  fields: [
    {
      field_id: "field-domain",
      key: "domain",
      label: "Domain",
      value_type: "string",
    },
    {
      field_id: "field-email",
      key: "work_email",
      label: "Work email",
      value_type: "string",
    },
  ],
  has_more: true,
  next_after_ordinal: 2,
  records: [
    {
      cells: [
        {
          confidence: null,
          cost: null,
          error: null,
          field_id: "field-domain",
          freshness: null,
          provenance: [],
          redacted: false,
          status: "succeeded",
          value: "northstar.invalid",
        },
        {
          confidence: 0.96,
          cost: { amount: 0.42, basis: "exact", unit: "credits" },
          error: null,
          field_id: "field-email",
          freshness: null,
          provenance: ["provider-neutral:email-resolution"],
          redacted: false,
          status: "succeeded",
          value: "ari@northstar.invalid",
        },
      ],
      ordinal: 1,
      record_id: "record-001",
      selection_reasons: ["ICP fit 92"],
    },
    {
      cells: [
        {
          confidence: null,
          cost: null,
          error: null,
          field_id: "field-domain",
          freshness: null,
          provenance: [],
          redacted: false,
          status: "succeeded",
          value: "cedarstack.invalid",
        },
        {
          confidence: null,
          cost: null,
          error: null,
          field_id: "field-email",
          freshness: null,
          provenance: [],
          redacted: true,
          status: "pending",
          value: null,
        },
      ],
      ordinal: 2,
      record_id: "record-002",
      selection_reasons: [],
    },
  ],
  view: {
    annotations: [],
    approvals: [],
    column_order: ["domain", "work_email"],
    dataset_id: "dataset-outbound-fr",
    filters: [],
    materialization_id: "materialization-2026-07-28",
    name: "France SaaS outbound review",
    play_id: "outbound-fr-saas",
    play_revision: 3,
    revision: 0,
    selection_reasons: [],
    selected_record_ids: ["record-001"],
    workbook_id: "wb-outbound-fr-2026-07-28",
    workspace_id: "workspace-synthetic",
  },
} as const;

test("play run receipt makes status, constraints, and stages scannable", () => {
  const output = capture();

  renderHumanCommandResult(output.target, "play-runs.get", playRun, false);

  const rendered = output.value();
  assert.ok(contains(rendered, "KUROBARA ◆ PLAY RUN"));
  assert.ok(contains(rendered, "──[ STATUS ]"));
  assert.ok(contains(rendered, "◆ PAUSED  Review boundary reached"));
  assert.ok(contains(rendered, "──[ CONSTRAINTS ]"));
  assert.ok(contains(rendered, "12.4 credits · hard limit 18"));
  assert.ok(contains(rendered, "provider_spend, reveal"));
  assert.ok(contains(rendered, "no_send"));
  assert.ok(contains(rendered, "──[ EXECUTION PLAN ] 2 stages"));
  assert.ok(contains(rendered, "01 ─ organizations.discover\n     ┃"));
  assert.equal(rendered.includes("\u001b["), false);
});

test("colored play run receipt carries the Kurobara terminal identity", () => {
  const output = capture();

  renderHumanCommandResult(output.target, "play-runs.get", playRun, true);

  const rendered = output.value();
  assert.ok(contains(rendered, styled(`${BOLD}${PINK}`, "◆ PLAY RUN")));
  assert.ok(contains(rendered, styled(`${BOLD}${PINK}`, "···●····●···")));
  assert.ok(contains(rendered, styled(`${BOLD}${PINK}`, "[ STATUS ]")));
  assert.ok(contains(rendered, styled(`${BOLD}${PINK}`, "◆ PAUSED")));
  assert.ok(contains(rendered, styled(`${BOLD}${PINK}`, "01")));
});

test("workbook receipt separates rows and surfaces review evidence", () => {
  const output = capture();

  renderHumanCommandResult(output.target, "workbooks.get", workbook, false);

  const rendered = output.value();
  assert.ok(contains(rendered, "France SaaS outbound review"));
  assert.ok(contains(rendered, "──[ ROWS ] 2 shown"));
  assert.ok(contains(rendered, "1  northstar.invalid"));
  assert.ok(contains(rendered, "ari@northstar.invalid"));
  assert.ok(contains(rendered, "✓ READY"));
  assert.ok(contains(rendered, "◆ SELECTED · ICP fit 92"));
  assert.ok(
    contains(
      rendered,
      "↳ Work email · confidence 96% · cost 0.42 credits · exact"
    )
  );
  assert.ok(contains(rendered, "source provider-neutral:email-resolution"));
  assert.ok(contains(rendered, "┄"));
  assert.ok(contains(rendered, "2  cedarstack.invalid"));
  assert.ok(contains(rendered, "[redacted]"));
  assert.ok(contains(rendered, "○ PENDING"));
  assert.ok(contains(rendered, "──[ REVIEW STATE ]"));
  assert.ok(contains(rendered, "1 selected  ·  0 decisions  ·  0 annotations"));
  assert.ok(contains(rendered, "More rows available after ordinal 2"));
});

test("colored workbook receipt reserves green for success", () => {
  const output = capture();

  renderHumanCommandResult(output.target, "workbooks.get", workbook, true);

  const rendered = output.value();
  assert.ok(contains(rendered, styled(`${BOLD}${PINK}`, "◆ WORKBOOK")));
  assert.ok(contains(rendered, styled(`${BOLD}${PINK}`, "[ ROWS ]")));
  assert.ok(contains(rendered, styled(`${BOLD}${PINK}`, "◆ SELECTED")));
  assert.ok(contains(rendered, `${BOLD}${GREEN}✓ READY`));
});

test("workbook decisions name the action and emphasize the latest decision", () => {
  const response = {
    view: {
      annotations: [],
      approvals: [
        {
          created_at_ms: 1,
          created_by_actor_id: "human:operator",
          decision: "approved",
          record_id: "record-001",
        },
      ],
      revision: 2,
      selected_record_ids: ["record-001"],
      workbook_id: "wb-outbound-fr-2026-07-28",
    },
  } as const;
  const output = capture();

  renderHumanCommandResult(output.target, "workbooks.approve", response, false);

  const rendered = output.value();
  assert.ok(contains(rendered, "KUROBARA ◆ APPROVAL SAVED"));
  assert.ok(contains(rendered, "✓ SAVED  Versioned review state persisted"));
  assert.ok(contains(rendered, "Revision      r2"));
  assert.ok(contains(rendered, "1 selected  ·  1 decision  ·  0 annotations"));
  assert.ok(contains(rendered, "✓ APPROVED  record-001"));
});

test("play watch progress stays on one replaceable line", () => {
  const output = capture(80);
  const running = {
    ...playRun,
    run: {
      ...playRun.run,
      state: "running",
    },
  };

  renderHumanPlayRunProgress(output.target, running, 3, false);
  clearHumanPlayRunProgress(output.target);

  const rendered = output.value();
  assert.ok(
    rendered.startsWith(
      "\r···●····●···  ● RUNNING  poll 3  play-run-outbound-2026-07-28"
    )
  );
  assert.ok(rendered.endsWith(`\r${" ".repeat(80)}\r`));
});
