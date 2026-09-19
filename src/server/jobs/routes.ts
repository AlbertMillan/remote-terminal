import type { FastifyInstance } from "fastify";
import { createLogger } from "../utils/logger.js";
import { findWorkspaceProject } from "../projects/workspace.js";
import { capabilitiesFor, detectVcs } from "../projects/vcs.js";
import {
  answerQuestion,
  approveGate,
  cancelJob,
  discardJob,
  JobError,
  queueJob,
  retryJob,
} from "./runner.js";
import { getJobWithStages, listJobs, listJobsForProject } from "./store.js";
import { sumUsage } from "./types.js";
import { diffAgainst, diffStat, fileDiff, hasRemote } from "./worktree.js";
import { listJobDocs, readDoc, resolveInWorktree } from "./docs.js";
import { specSlugFor } from "./stages/design.js";
import { COMPANION_DIR } from "../projects/project-store.js";
import { applySelection, readFindings, writeFindings } from "./findings.js";

const logger = createLogger("job-routes");

/** Cap the diff sent to the browser; a huge one would be unreadable anyway. */
const MAX_DIFF_CHARS = 200_000;

export function registerJobRoutes(app: FastifyInstance): void {
  // All jobs, or one project's. `usage` is the total across the jobs returned,
  // summed here so the board and any other caller cannot disagree about it.
  app.get<{ Querystring: { cwd?: string } }>("/api/jobs", async (request) => {
    const cwd = request.query?.cwd;
    const jobs = cwd ? listJobsForProject(cwd) : listJobs();
    return { jobs, usage: sumUsage(jobs) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id",
    async (request, reply) => {
      const job = getJobWithStages(request.params.id);
      if (!job) return reply.status(404).send({ error: "Unknown job" });
      return { job };
    },
  );

  // The job branch's diff against its base, for review before approving a merge.
  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id/diff",
    async (request, reply) => {
      const job = getJobWithStages(request.params.id);
      if (!job) return reply.status(404).send({ error: "Unknown job" });
      if (!job.worktreePath) return { diff: "", stat: null };

      const base = await baseBranchFor(job);
      const [diff, stat] = await Promise.all([
        diffAgainst(job.worktreePath, base),
        diffStat(job.worktreePath, base),
      ]);
      return {
        diff: diff.slice(0, MAX_DIFF_CHARS),
        truncated: diff.length > MAX_DIFF_CHARS,
        stat,
      };
    },
  );

  // The documents behind a job's question: what its branch changed, plus the
  // markdown it could have been reading. Empty — never an error — for a job
  // whose worktree has been torn down, since the board still renders those rows.
  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id/docs",
    async (request, reply) => {
      const job = getJobWithStages(request.params.id);
      if (!job) return reply.status(404).send({ error: "Unknown job" });
      if (!job.worktreePath) return { docs: [] };

      const base = await baseBranchFor(job);
      return {
        docs: await listJobDocs(job.worktreePath, base, specPathOf(job)),
      };
    },
  );

  // One document, as text or as this job's diff for it.
  app.get<{
    Params: { id: string };
    Querystring: { path?: string; mode?: string };
  }>("/api/jobs/:id/file", async (request, reply) => {
    const job = getJobWithStages(request.params.id);
    if (!job) return reply.status(404).send({ error: "Unknown job" });
    const rel = request.query?.path;
    if (!rel) return reply.status(400).send({ error: "path required" });
    if (!job.worktreePath) return { text: null, diff: null, path: rel };

    if (request.query?.mode === "diff") {
      // Resolved first so a path outside the worktree never reaches git, and
      // so an untracked file answers with an empty diff rather than an error.
      if (!resolveInWorktree(job.worktreePath, rel)) {
        return reply.status(400).send({ error: "Path is outside this job" });
      }
      const base = await baseBranchFor(job);
      const diff = await fileDiff(job.worktreePath, base, rel);
      return {
        diff: diff.slice(0, MAX_DIFF_CHARS),
        truncated: diff.length > MAX_DIFF_CHARS,
        path: rel,
      };
    }

    const read = readDoc(job.worktreePath, rel);
    if (!read)
      return reply.status(404).send({ error: "Could not read that file" });
    return { text: read.text, truncated: read.truncated, path: rel };
  });

  // Review findings for the gate. Returns an empty list rather than 404 when a
  // job has not been reviewed yet, so the UI has one code path.
  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id/findings",
    async (request, reply) => {
      const job = getJobWithStages(request.params.id);
      if (!job) return reply.status(404).send({ error: "Unknown job" });
      if (!job.worktreePath) return { findings: [] };
      const file = readFindings(job.worktreePath, job.id);
      return {
        findings: file?.findings ?? [],
        generatedAt: file?.generatedAt ?? null,
      };
    },
  );

  // Record which findings the user ticked. Stored in the findings file itself,
  // so the choice survives a restart and the fix stage reads it directly.
  app.post<{ Params: { id: string }; Body?: { selected?: string[] } }>(
    "/api/jobs/:id/findings/select",
    async (request, reply) => {
      const job = getJobWithStages(request.params.id);
      if (!job) return reply.status(404).send({ error: "Unknown job" });
      if (!job.worktreePath)
        return reply.status(409).send({ error: "This job has no worktree" });

      const selected = Array.isArray(request.body?.selected)
        ? request.body.selected.filter(
            (s): s is string => typeof s === "string",
          )
        : [];

      const file = readFindings(job.worktreePath, job.id);
      if (!file)
        return reply.status(404).send({ error: "No findings for this job" });

      const updated = applySelection(file, selected);
      writeFindings(job.worktreePath, updated);
      return { findings: updated.findings };
    },
  );

  // Queue a job, optionally bound to a PROJECT.md feature.
  app.post<{
    Body?: { cwd?: string; featureId?: string | null; title?: string };
  }>("/api/jobs", async (request, reply) => {
    const body = request.body || {};
    if (!body.cwd || !body.title) {
      return reply.status(400).send({ error: "cwd and title required" });
    }
    return withJob(reply, () => ({
      job: queueJob({
        cwd: body.cwd as string,
        featureId: body.featureId ?? null,
        title: body.title as string,
      }),
    }));
  });

  app.post<{ Params: { id: string } }>(
    "/api/jobs/:id/approve",
    async (request, reply) => {
      return withJob(reply, () => ({ job: approveGate(request.params.id) }));
    },
  );

  app.post<{ Params: { id: string }; Body?: { answer?: string } }>(
    "/api/jobs/:id/answer",
    async (request, reply) => {
      const answer = request.body?.answer;
      if (!answer) return reply.status(400).send({ error: "answer required" });
      return withJob(reply, () => ({
        job: answerQuestion(request.params.id, answer),
      }));
    },
  );

  // Re-run the stage a failed job died on, keeping everything before it.
  app.post<{ Params: { id: string } }>(
    "/api/jobs/:id/retry",
    async (request, reply) => {
      return withJob(reply, () => ({ job: retryJob(request.params.id) }));
    },
  );

  // Stop a live job: aborts the running stage, then tears the worktree down.
  app.post<{ Params: { id: string } }>(
    "/api/jobs/:id/cancel",
    async (request, reply) => {
      try {
        return { job: await cancelJob(request.params.id) };
      } catch (error) {
        if (error instanceof JobError) {
          return reply.status(error.status).send({ error: error.message });
        }
        logger.error({ error }, "job route failed");
        return reply.status(500).send({ error: "Request failed" });
      }
    },
  );

  // Clean up a finished job: remove its worktree and branch and drop the row.
  // `mergeLanded` tells the UI to say that a merged commit was left in place
  // rather than implying the project was fully restored.
  app.post<{ Params: { id: string } }>(
    "/api/jobs/:id/discard",
    async (request, reply) => {
      try {
        return await discardJob(request.params.id);
      } catch (error) {
        if (error instanceof JobError) {
          return reply.status(error.status).send({ error: error.message });
        }
        logger.error({ error }, "job route failed");
        return reply.status(500).send({ error: "Request failed" });
      }
    },
  );

  // Whether a project can be dispatched, so the UI can explain rather than
  // just disable.
  app.get<{ Querystring: { cwd?: string } }>(
    "/api/jobs/capabilities",
    async (request, reply) => {
      const cwd = request.query?.cwd;
      if (!cwd) return reply.status(400).send({ error: "cwd required" });
      const project = findWorkspaceProject(cwd);
      if (!project) return reply.status(404).send({ error: "Unknown project" });

      const caps = capabilitiesFor(detectVcs(project.cwd));
      return {
        capabilities: {
          ...caps,
          hasRemote: caps.canPush && (await hasRemote(project.cwd)),
        },
      };
    },
  );

  logger.info("Job pipeline routes registered");
}

/**
 * Which document is this job's spec.
 *
 * A design that parked on a question records its spec path just as a passed one
 * does — the spec exists (the stage throws without one) and is committed before
 * the park, and it is the document the question is asking about. Whether the
 * spec is APPROVED is a different question, answered by the stage status in
 * runner.ts, which is what gates the implement stage.
 */
export function specPathOf(job: {
  title: string;
  featureId: string | null;
  stages: { name: string; status: string; detail: string | null }[];
}): string | null {
  const design = job.stages.find((s) => s.name === "design");
  if (!design) return null;
  if (design.status !== "passed" && design.status !== "needs_decision")
    return null;

  if (design.detail && design.detail.endsWith(".md")) return design.detail;

  // A job that parked BEFORE the spec path was recorded carries the old label
  // ("Needs a decision") here. Those are exactly the jobs waiting on an answer
  // right now, so fall back to where the design stage puts a spec — computed by
  // the stage's own exported helper, not by a second copy of the rule.
  return `${COMPANION_DIR}/${specSlugFor(job.title, job.featureId)}.md`;
}

/**
 * The branch a job's work is compared and merged against.
 *
 * The branch recorded when the worktree was created, exactly as the runner's
 * baseBranchOf() resolves it. Reading the project's CURRENT branch instead —
 * which this did — means a job that sat parked while the user switched branches
 * is measured against whatever they happen to be on now, so both the diff and
 * the document list report a changed-set that was never this job's.
 */
async function baseBranchFor(job: {
  baseBranch: string | null;
  projectCwd: string;
}): Promise<string> {
  if (job.baseBranch) return job.baseBranch;
  const { currentBranch } = await import("./worktree.js");
  return (await currentBranch(job.projectCwd)) || "main";
}

function withJob<T>(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  fn: () => T,
): T | unknown {
  try {
    return fn();
  } catch (error) {
    if (error instanceof JobError) {
      return reply.status(error.status).send({ error: error.message });
    }
    logger.error({ error }, "job route failed");
    return reply
      .status(500)
      .send({
        error: error instanceof Error ? error.message : "Request failed",
      });
  }
}
