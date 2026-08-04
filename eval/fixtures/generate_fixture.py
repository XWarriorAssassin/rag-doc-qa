"""
Generates eval/fixtures/aurora-bikes-handbook.pdf — a fictional employee
handbook used ONLY for the retrieval-accuracy eval (see eval/run.ts). Every
fact below is invented; the company doesn't exist. Each page carries one
clearly stated, unambiguous fact so questions.json's expected page numbers
are unarguable ground truth, not a judgment call.

Run once with: python3 generate_fixture.py
(Requires reportlab: pip install reportlab --break-system-packages)
The output PDF is committed to the repo, so this only needs to be re-run if
the fixture content itself changes.
"""

from reportlab.lib.pagesizes import LETTER
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch

OUTPUT_PATH = "aurora-bikes-handbook.pdf"

styles = getSampleStyleSheet()
title_style = styles["Title"]
heading_style = styles["Heading1"]
body_style = styles["BodyText"]
body_style.spaceAfter = 10

PAGES = [
    (
        "Company Overview",
        [
            "Aurora Bikes Inc. is a fictional bicycle manufacturing company used solely as a test "
            "fixture for this project's retrieval-accuracy evaluation.",
            "Aurora Bikes was founded in 2014 and is headquartered in Boulder, Colorado.",
            "The company currently employs approximately 340 people across two facilities.",
        ],
    ),
    (
        "Paid Time Off Policy",
        [
            "Full-time employees accrue 15 days of paid time off (PTO) per calendar year.",
            "PTO accrues monthly at a rate of 1.25 days per month.",
            "Unused PTO may be carried over into the following year, up to a maximum carryover cap "
            "of 5 days. Any balance beyond the cap is forfeited on December 31st.",
        ],
    ),
    (
        "Remote Work Policy",
        [
            "Aurora Bikes operates on a hybrid work model for all corporate (non-manufacturing) staff.",
            "Employees are required to work in the office on Tuesday, Wednesday, and Thursday each "
            "week. Monday and Friday may be worked remotely.",
            "Exceptions to the hybrid schedule require written approval from a director-level manager "
            "or above.",
        ],
    ),
    (
        "Expense Reimbursement",
        [
            "Business expenses must be submitted for reimbursement within 30 days of the expense date. "
            "Submissions after 30 days will not be reimbursed except in extenuating circumstances.",
            "Any single expense exceeding $500 requires prior written approval from the employee's "
            "direct manager before the expense is incurred.",
            "Reimbursements are processed on the 15th and last business day of each month.",
        ],
    ),
    (
        "Parental Leave",
        [
            "Aurora Bikes provides 12 weeks of fully paid parental leave for eligible employees "
            "following the birth, adoption, or foster placement of a child.",
            "Eligibility requires at least 6 months of continuous employment prior to the leave start "
            "date.",
            "Parental leave may be taken in one continuous block or split into two blocks within the "
            "first 12 months after the qualifying event, subject to manager approval.",
        ],
    ),
]


def build():
    doc = SimpleDocTemplate(
        OUTPUT_PATH,
        pagesize=LETTER,
        topMargin=1 * inch,
        bottomMargin=1 * inch,
        leftMargin=1 * inch,
        rightMargin=1 * inch,
    )
    story = []
    story.append(Paragraph("Aurora Bikes Employee Handbook", title_style))
    story.append(Paragraph("(Fictional company — evaluation fixture only)", body_style))
    story.append(PageBreak())

    for i, (heading, paragraphs) in enumerate(PAGES):
        story.append(Paragraph(heading, heading_style))
        story.append(Spacer(1, 12))
        for p in paragraphs:
            story.append(Paragraph(p, body_style))
        if i < len(PAGES) - 1:
            story.append(PageBreak())

    doc.build(story)
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    build()
