import unittest

from src.mcp.review_markdown import render_review_markdown


class ReviewMarkdownTests(unittest.TestCase):
    def test_renders_concise_review_sections(self) -> None:
        review = {
            "status": "has_findings",
            "summary": "Found one correctness bug.",
            "findings": [
                {
                    "summary": "Missing null guard before property access",
                    "severity": "high",
                    "file": "src/server.js",
                    "line": 42,
                    "why_it_matters": "Can crash the request path.",
                    "fix_instructions": "Add a null check before reading the property.",
                    "evidence": "user may be undefined on unauthenticated requests",
                    "confidence": 0.93,
                }
            ],
            "fix_plan": ["Patch the null guard.", "Add a regression test."],
            "rerun_review": True,
        }

        markdown = render_review_markdown(review)

        self.assertIn("## Overview", markdown)
        self.assertIn("## Key Findings", markdown)
        self.assertIn("## Recommendations", markdown)
        self.assertIn("[HIGH] Missing null guard before property access", markdown)
        self.assertIn("Location: src/server.js:42", markdown)
        self.assertNotIn("## Summary", markdown)
        self.assertNotIn("## Fix Plan", markdown)

    def test_omits_empty_noise_sections_for_clean_review(self) -> None:
        review = {
            "status": "clean",
            "summary": "No material issues found.",
            "findings": [],
            "fix_plan": [],
            "rerun_review": False,
        }

        markdown = render_review_markdown(review)

        self.assertIn("- No material findings.", markdown)
        self.assertNotIn("## Recommendations", markdown)


if __name__ == "__main__":
    unittest.main()
