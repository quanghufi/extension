from __future__ import annotations

from typing import Any


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _confidence_label(value: Any) -> str:
    if isinstance(value, (int, float)):
        clamped = max(0.0, min(float(value), 1.0))
        return f"{clamped:.2f}"
    text = _as_text(value)
    return text or "unknown"


def _location_label(finding: dict[str, Any]) -> str:
    file_path = _as_text(finding.get("file")) or "unknown"
    line_value = finding.get("line")
    if line_value in (None, "", 0):
        return file_path
    return f"{file_path}:{line_value}"


def _finding_title(finding: dict[str, Any]) -> str:
    return (
        _as_text(finding.get("summary"))
        or _as_text(finding.get("title"))
        or "Untitled finding"
    )


def render_review_markdown(review: dict[str, Any]) -> str:
    status = _as_text(review.get("status")) or "has_findings"
    summary = _as_text(review.get("summary")) or "No summary provided."
    findings = list(review.get("findings", []))
    fix_plan = [item for item in review.get("fix_plan", []) if _as_text(item)]
    rerun_review = bool(review.get("rerun_review", False))

    lines = [
        "# Codex Review",
        "",
        "## Overview",
        f"- Status: {status}",
        f"- Summary: {summary}",
        f"- Findings: {len(findings)}",
    ]

    if findings:
        lines.extend(["", "## Key Findings"])
        for index, finding in enumerate(findings, start=1):
            severity = (_as_text(finding.get("severity")) or "medium").upper()
            lines.append("")
            lines.append(f"### {index}. [{severity}] {_finding_title(finding)}")
            lines.append(f"- Location: {_location_label(finding)}")

            why_it_matters = _as_text(finding.get("why_it_matters"))
            if why_it_matters:
                lines.append(f"- Why it matters: {why_it_matters}")

            fix_instructions = _as_text(finding.get("fix_instructions"))
            if fix_instructions:
                lines.append(f"- Recommended fix: {fix_instructions}")

            evidence = _as_text(finding.get("evidence"))
            if evidence:
                lines.append(f"- Evidence: {evidence}")

            lines.append(f"- Confidence: {_confidence_label(finding.get('confidence'))}")
    else:
        lines.extend(["", "## Key Findings", "- No material findings."])

    if fix_plan or rerun_review or status != "clean":
        lines.extend(["", "## Recommendations"])
        if fix_plan:
            for item in fix_plan:
                lines.append(f"- {item}")
        elif status == "clean":
            lines.append("- No follow-up actions.")

        lines.append(f"- Rerun review: {'yes' if rerun_review else 'no'}")

    lines.append("")
    return "\n".join(lines)
