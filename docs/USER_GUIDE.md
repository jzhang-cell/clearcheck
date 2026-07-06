# SOC 2 ClearCheck — User Guide

*A plain-English guide for auditors. No technical knowledge needed.*

---

## 1. What is SOC 2 ClearCheck?

SOC 2 ClearCheck is an **AI assistant for auditors**. It helps you check whether a
company is following its own security controls — the promises a company makes about how
it keeps data safe (things like "only approved people can access our systems" or "we use
two-factor login").

Normally, an auditor has to open lots of evidence files (screenshots, spreadsheets, PDFs,
policy documents), read through them, and decide whether each control is being followed.
That takes a long time.

**ClearCheck does the reading for you.** For each control, it:

1. Collects the evidence files,
2. Reads and understands them using AI,
3. Decides whether the control is being met, and
4. Writes up its finding — like a first-draft audit note — with its reasoning.

You stay in control. ClearCheck gives you a **starting verdict and a write-up**, and you
review it, accept it, or push back with more evidence. It saves hours of reading; it does
not replace your judgment.

---

## 2. Where you work: Airtable

You do everything from **Airtable** — a familiar spreadsheet-style screen. You don't need
to touch any code, servers, or settings. There is one main table called
**Company Controls**, where each row is one control you're auditing.

The important columns you'll use:

| Column | What it's for |
|---|---|
| **Company Control** | The control being checked (its code + description). |
| **Run V3 Audit** | A checkbox — **tick it to start an audit** on that control. |
| **ClearCheck 💬** | The live status + final result. This is where you watch progress and read the verdict. |
| **V3_Evidence** | The evidence files ClearCheck used (attached automatically). |
| **V3_Conformity_Level** | The final rating (e.g. "No Deviation", "Observation", "Deviation"). |
| **V3_Results** | The full written-up audit note (the workpaper). |
| **Re-run Audit 🤖** | Used to re-check a control after you add more evidence (see Section 6). |

---

## 3. Before you start: put the evidence in place

ClearCheck reads evidence from a **Google Drive folder** — one folder per control, named
with the control's code (for example, a folder starting with `CC.06.05-…`).

**So before running a control, make sure that control's evidence files are in its Google
Drive folder.** ClearCheck can read:

- PDFs (including long, many-page ones)
- Spreadsheets / CSV files
- Images and screenshots (PNG, JPG)
- Word documents

It **cannot** read a **ZIP** file — if evidence is zipped, unzip it and upload the real
files. ClearCheck will tell you if it finds a zip.

---

## 4. Running an audit (the normal flow)

1. Find the control's row in the **Company Controls** table.
2. **Tick the "Run V3 Audit" checkbox.**
3. Watch the **ClearCheck 💬** column. It updates itself as it works, so you always know
   what's happening:

| You'll see | It means |
|---|---|
| 🤓 Reading control details… | Getting the control ready. |
| ⏳ Polishing control description… | Tidying up the control's wording. |
| 🔎 Pulling evidence from Google Drive… | Fetching the evidence files. |
| 📄 Reading your evidence… 🟩🟩🟩⬜⬜⬜ 3 of 9 files | Reading each file (the bar fills up as it goes). |
| ✅ Evidence read — starting the audit… | Done reading; the audit is beginning. |
| 🧠 ClearCheck is auditing the evidence | The AI is making its judgment (the main step). |
| 🥳 Audit complete — No Deviation | **Finished!** The verdict is shown right here. |

That's it. When you see **"🥳 Audit complete"**, the audit is done and the results columns
are filled in.

> **Tip:** You don't need to keep the page open or wait around. The work continues on its
> own in the background. Come back later and the result will be there.

---

## 5. Reading the result

When an audit finishes, look at these columns:

- **ClearCheck 💬** — shows the headline verdict, e.g. `🥳 Audit complete — No Deviation`.
- **V3_Conformity_Level** — the rating in more detail. The three main outcomes are:
  - **No Deviation** — the control is being followed. ✅
  - **Observation** — mostly fine, but something is worth noting or a bit more evidence
    would help.
  - **Deviation** — the control is **not** being met based on the evidence. ⚠️
- **V3_Results** — the full written explanation (the workpaper): what evidence was used,
  what ClearCheck concluded, and why. **This is the part you review.**
- **V3_Evidence** — the actual files ClearCheck read, attached for easy reference.

Read the write-up, check it against the evidence, and decide whether you agree. If you do,
you're done. If you think ClearCheck missed something or judged too harshly, use a re-run.

---

## 6. Re-running after you add evidence or notes

Sometimes the first result isn't the final word — maybe a file was missing, the wrong file
was uploaded, or ClearCheck needs context it didn't have. You can **re-check the control
without starting over** using the **Re-run Audit 🤖** column.

On the same control row:

1. Add what's needed:
   - **Additional Evidence** — attach the missing or corrected file(s), **or**
   - **Additional Notes** — type an explanation (e.g. "the access list in file X supersedes
     the older one").
2. In **Re-run Audit 🤖**, pick the matching option:
   - *Run with Additional Evidence*, or
   - *Run with Additional Notes*, or
   - *Run* (a full fresh re-check).
3. ClearCheck re-checks the control, taking your new input into account, and updates the
   verdict.

A re-run only looks at what changed — it doesn't re-do the whole audit from scratch — so
it's quick and doesn't waste effort.

---

## 7. When something needs your attention

ClearCheck always tells you **what went wrong and what to do** — it won't just say
"failed." Here are the messages you might see and how to fix them:

| Message | What to do |
|---|---|
| 📁 No evidence found for `<control>` — please upload the evidence into the Additional Evidence field and re-run. | The control's Google Drive folder is missing or empty. Add the evidence and re-run. |
| 📭 Evidence folder is empty | Add the evidence files to that control's Drive folder, then re-run. |
| 📦 Only zip file(s) found | Unzip the evidence in Google Drive and re-run — ClearCheck can't read inside a zip. |
| ✅ Evidence ready (3 files). ⚠️ 1 file failed. | Most files were read; one couldn't be. Check that one file and re-run if it matters. |
| ❌ Audit failed | Something went wrong during the audit. Try again; if it keeps happening, tell your technical contact. |

---

## 8. Good habits

- **One folder per control**, named with the control's code, holding just that control's
  evidence.
- **Unzip** anything zipped before uploading.
- **Prefer clear, direct evidence** (the actual access list, the real config screenshot)
  over long mixed documents where possible.
- **Always review the write-up.** ClearCheck gives you a strong first draft — your sign-off
  is what makes it an audit.

---

## 9. Quick FAQ

**Do I need to wait while it runs?**
No. It works in the background. You can close the tab and check back later.

**How long does one control take?**
Usually about a minute or two, depending on how many (and how large) the evidence files are.

**Can it read a 100-page PDF?**
Yes. Large PDFs take a little longer but are handled automatically.

**What if I disagree with the verdict?**
Add evidence or notes and use **Re-run Audit 🤖** (Section 6). You always have the final say.

**Is my data safe?**
Yes. Each client engagement is kept separate, and every action is logged. Your technical
contact can share the security details.
