/**
 * Local git context helpers.
 *
 * v1 generated peer summaries by calling OpenAI's API (which required an
 * OPENAI_API_KEY and a network round-trip at startup). v2 builds the
 * initial summary locally from the directory + branch name, and sessions
 * overwrite it with set_summary once they know what they're doing.
 */

/**
 * Get the current git branch name for a directory.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      const branch = text.trim();
      return branch || null;
    }
  } catch {
    // not a git repo
  }
  return null;
}
