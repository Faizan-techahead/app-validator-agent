import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineEval } from "@grok/agent-sdk/evals";

const brief = JSON.parse(
  readFileSync(resolve("evals/fixtures/sample-brief.json"), "utf8"),
) as { app_name: string; base_url: string };

export default defineEval({
  tags: ["smoke"],
  description:
    "Fixture brief + Excel sheet → import, catalog, Chrome check with logs/fail screenshot, suite, PDF.",
  async test(t) {
    await t.send(
      [
        "Validate the Demo Catalog App using the fixture brief and Excel sheet.",
        `Brief app_name=${brief.app_name}, base_url=${brief.base_url}.`,
        "1) Call normalize_brief with the fixture brief from evals/fixtures/sample-brief.json.",
        "2) Call import_excel_cases with path evals/fixtures/sample-cases.xlsx.",
        "3) Call generate_test_catalog with the imported cases (no invented gap UI).",
        "4) Call run_web_chrome for the catalog against the base_url (capture logs; screenshot on Fail).",
        "5) Call run_validation_suite, then render_pdf_report (same PDF must include logs and any failure screenshots).",
        "Reply with pass/fail/blocked/not_run counts, whether logs were included, and the PDF path. Do not invent APIs or secrets.",
      ].join(" "),
    );
    t.succeeded();
    t.calledTool("normalize_brief");
    t.calledTool("import_excel_cases");
    t.calledTool("generate_test_catalog");
    t.calledTool("run_web_chrome");
    t.calledTool("run_validation_suite");
    t.calledTool("render_pdf_report");
  },
});
