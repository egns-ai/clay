// worktree-utils.js — pure helpers for git worktree parsing and slug lookup

var path = require("path");

/**
 * Parse `git worktree list --porcelain` output into an array of worktree objects.
 * Filters out bare worktrees.
 */
function parseWorktreeOutput(output) {
  var worktrees = [];
  var current = {};
  var lines = output.split("\n");
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9) };
      current.dirName = path.basename(current.path);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).split("/").pop();
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  if (current.path) worktrees.push(current);
  return worktrees.filter(function (w) { return !w.bare; });
}

/**
 * Find the parent slug that contains a given worktree slug.
 * Returns the parent slug string, or null if not found.
 */
function findWorktreeParent(worktreeSlugs, slug) {
  for (var wpk in worktreeSlugs) {
    if (!worktreeSlugs.hasOwnProperty(wpk)) continue;
    if (worktreeSlugs[wpk].indexOf(slug) !== -1) {
      return wpk;
    }
  }
  return null;
}

module.exports = {
  parseWorktreeOutput: parseWorktreeOutput,
  findWorktreeParent: findWorktreeParent,
};
