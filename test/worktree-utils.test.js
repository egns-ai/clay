var test = require("node:test");
var assert = require("node:assert");

var { parseWorktreeOutput, findWorktreeParent } = require("../lib/worktree-utils");

// ============================================================
// 1. parseWorktreeOutput
// ============================================================

test("parseWorktreeOutput parses standard porcelain output", function () {
  var output = [
    "worktree /home/user/project",
    "HEAD abc1234",
    "branch refs/heads/main",
    "",
    "worktree /home/user/project-feature",
    "HEAD def5678",
    "branch refs/heads/feat/my-feature",
    "",
  ].join("\n");

  var result = parseWorktreeOutput(output);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].path, "/home/user/project");
  assert.strictEqual(result[0].branch, "main");
  assert.strictEqual(result[0].dirName, "project");
  assert.strictEqual(result[1].path, "/home/user/project-feature");
  assert.strictEqual(result[1].branch, "my-feature");
});

test("parseWorktreeOutput filters out bare worktrees", function () {
  var output = [
    "worktree /home/user/project.git",
    "bare",
    "",
    "worktree /home/user/project-wt",
    "HEAD abc1234",
    "branch refs/heads/develop",
    "",
  ].join("\n");

  var result = parseWorktreeOutput(output);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].path, "/home/user/project-wt");
});

test("parseWorktreeOutput handles detached HEAD", function () {
  var output = [
    "worktree /home/user/project-detached",
    "HEAD abc1234",
    "detached",
    "",
  ].join("\n");

  var result = parseWorktreeOutput(output);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].detached, true);
  assert.strictEqual(result[0].branch, undefined);
});

test("parseWorktreeOutput returns empty array for empty input", function () {
  var result = parseWorktreeOutput("");
  assert.strictEqual(result.length, 0);
});

test("parseWorktreeOutput extracts last segment of branch ref", function () {
  var output = [
    "worktree /home/user/wt",
    "HEAD abc1234",
    "branch refs/heads/feat/deep/nested/branch",
    "",
  ].join("\n");

  var result = parseWorktreeOutput(output);
  assert.strictEqual(result[0].branch, "branch");
});

// ============================================================
// 2. findWorktreeParent
// ============================================================

test("findWorktreeParent returns parent slug when child is found", function () {
  var slugs = {
    "myproject": ["myproject--feat-login", "myproject--feat-signup"],
  };
  var result = findWorktreeParent(slugs, "myproject--feat-login");
  assert.strictEqual(result, "myproject");
});

test("findWorktreeParent returns null when slug is not found", function () {
  var slugs = {
    "myproject": ["myproject--feat-login"],
  };
  var result = findWorktreeParent(slugs, "myproject--feat-unknown");
  assert.strictEqual(result, null);
});

test("findWorktreeParent returns null for empty worktreeSlugs", function () {
  var result = findWorktreeParent({}, "any-slug");
  assert.strictEqual(result, null);
});

test("findWorktreeParent finds correct parent among multiple parents", function () {
  var slugs = {
    "project-a": ["project-a--wt1"],
    "project-b": ["project-b--wt1", "project-b--wt2"],
  };
  assert.strictEqual(findWorktreeParent(slugs, "project-b--wt2"), "project-b");
  assert.strictEqual(findWorktreeParent(slugs, "project-a--wt1"), "project-a");
});

test("findWorktreeParent handles slugs with slashes in branch name", function () {
  var slugs = {
    "myproject": ["myproject--feat-auth-login", "myproject--fix-bug-123"],
  };
  var result = findWorktreeParent(slugs, "myproject--feat-auth-login");
  assert.strictEqual(result, "myproject");
});

test("findWorktreeParent does not match partial slug strings", function () {
  var slugs = {
    "myproject": ["myproject--feat"],
  };
  // "myproject--feat-extra" should NOT match "myproject--feat"
  var result = findWorktreeParent(slugs, "myproject--feat-extra");
  assert.strictEqual(result, null);
});
