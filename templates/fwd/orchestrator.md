<!--
  Read by the orchestrator skill (sections 0, 1, 4). Fill in each <placeholder>; delete a line that
  does not apply. Add rules here that win over the skill.
-->

# Orchestrator rules

- **Ruling log:** `docs/rulings.md`. Dated, append-only: one entry per decision, who made it, why.
  An orchestrator decision is marked "decided, override if you disagree".
- **Priorities:** `boards/priorities.md` (`run-project` section 2).
- **Roadmap:** none yet. When the project has one, put its link or location here and how to write it.
- **Design routing:** <which UI changes go to Design. If the project has no Design track, write
  "none: engineering owns UI" and delete this note.>
- **Deploy duty:** <who deploys and how production is proven, for example "the orchestrator confirms
  the production domain serves the new deployment and one database-backed request works after
  every merge", or "Vercel deploys on merge; no manual step".>
