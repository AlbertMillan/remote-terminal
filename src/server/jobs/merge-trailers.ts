/**
 * Who a job's merge commit belongs to, written into the commit itself.
 *
 * The subject `Merge job: <title>` is shared by any two jobs with the same
 * title, and a job's `merge_sha` is deleted with its row when the job is
 * discarded, which is the normal end of a job's life. Trailers survive both,
 * and a lost database or a re-clone too, so Delete track can tie a merge to
 * its feature exactly instead of by title.
 */

export const JOB_ID_TRAILER = 'Job-Id';
export const FEATURE_TRAILER = 'Feature';

/** The `-m` arguments for a job's merge: the subject, then a trailer paragraph. */
export function jobMergeMessageArgs(title: string, ids: { jobId: string; featureId: string | null }): string[] {
  const trailers = [`${JOB_ID_TRAILER}: ${ids.jobId}`];
  if (ids.featureId) trailers.push(`${FEATURE_TRAILER}: ${ids.featureId}`);
  return ['-m', `Merge job: ${title}`, '-m', trailers.join('\n')];
}

export interface MergeCommit {
  sha: string;
  subject: string;
  jobId: string | null;
  featureId: string | null;
}

/** `git log --format` for `parseMergeLog`: one line per commit, tab-separated. */
export const MERGE_LOG_FORMAT =
  `%H%x09%s` +
  `%x09%(trailers:key=${JOB_ID_TRAILER},valueonly,separator=%x2C)` +
  `%x09%(trailers:key=${FEATURE_TRAILER},valueonly,separator=%x2C)`;

export function parseMergeLog(out: string): MergeCommit[] {
  const commits: MergeCommit[] = [];
  for (const line of out.split('\n')) {
    const [sha, subject = '', jobId = '', featureId = ''] = line.split('\t');
    if (!sha?.trim()) continue;
    commits.push({
      sha: sha.trim(),
      subject: subject.trim(),
      // A hand-amended merge could carry the key twice; the first one wins.
      jobId: jobId.split(',')[0].trim() || null,
      featureId: featureId.split(',')[0].trim() || null,
    });
  }
  return commits;
}
