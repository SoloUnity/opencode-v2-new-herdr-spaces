import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { commandChain, openSpace } from "../herdr.js";
import plugin, { openSessionSpace } from "../tui.js";

const result = {
  workspace: { workspace_id: "space-returned-by-herdr" },
  root_pane: { pane_id: "pane-returned-by-herdr", workspace_id: "space-returned-by-herdr" },
};

function harness(responses = [{ stdout: JSON.stringify({ result }) }, { stdout: "" }]) {
  const calls = [];
  return {
    calls,
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/a/specific/session.sock", PATH: "/bin" },
    cwd: "/local/project",
    async exec(file, args, options) {
      calls.push({ file, args, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, "Unexpected Herdr command");
      return response;
    },
  };
}

test("creates and focuses a space, then submits only to its returned root pane", async () => {
  const dependencies = harness();
  const opened = await openSpace({ commands: ["cd '/a path'", "start --auto"] }, dependencies);
  assert.deepEqual(opened, { workspaceID: result.workspace.workspace_id, paneID: result.root_pane.pane_id });
  assert.equal(dependencies.calls.length, 2);
  assert.equal(dependencies.calls[0].file, "herdr");
  assert.deepEqual(dependencies.calls[0].args, ["workspace", "create", "--cwd", "/local/project", "--focus"]);
  assert.deepEqual(dependencies.calls[1].args.slice(0, 3), ["pane", "run", result.root_pane.pane_id]);
  assert.equal(dependencies.calls[1].options.env, dependencies.env);
  assert.equal(dependencies.calls[1].options.shell, undefined);
});

test("passes a configured directory and label as separate arguments", async () => {
  const dependencies = harness();
  await openSpace({ commands: ["start"], cwd: "/another project", label: "My space; literal" }, dependencies);
  assert.deepEqual(dependencies.calls[0].args, [
    "workspace", "create", "--cwd", "/another project", "--focus", "--label", "My space; literal",
  ]);
});

test("uses the active session's latest directory after moves and session switches", async () => {
  let sessionID = "ses_first";
  const directories = { ses_first: "/local/project", ses_second: "/worktrees/second" };
  const requested = [];
  const context = {
    options: { commands: ["devx opencode2 --auto"] },
    ui: { router: { current: () => ({ type: "session", sessionID }) } },
    client: {
      session: {
        async get({ sessionID }) {
          requested.push(sessionID);
          return { location: { directory: directories[sessionID] } };
        },
      },
    },
  };

  for (const [active, directory] of [
    ["ses_first", "/local/project"],
    ["ses_first", "/worktrees/it's a worktree; literal"],
    ["ses_second", "/worktrees/second"],
  ]) {
    sessionID = active;
    directories[active] = directory;
    const dependencies = harness();
    await openSessionSpace(context, dependencies);
    assert.deepEqual(dependencies.calls[0].args, ["workspace", "create", "--cwd", directory, "--focus"]);
    assert.equal(dependencies.calls[1].args[3], commandChain(context.options.commands));
  }
  assert.deepEqual(requested, ["ses_first", "ses_first", "ses_second"]);
});

test("reads a home-directory session directly from the V2 client result", async () => {
  const dependencies = harness();
  await openSessionSpace({
    options: { commands: ["devx opencode2 --auto"] },
    ui: { router: { current: () => ({ type: "session", sessionID: "ses_home" }) } },
    client: {
      session: {
        async get({ sessionID }) {
          assert.equal(sessionID, "ses_home");
          return { id: sessionID, location: { directory: "/Users/example" } };
        },
      },
    },
  }, dependencies);
  assert.deepEqual(dependencies.calls[0].args, ["workspace", "create", "--cwd", "/Users/example", "--focus"]);
});

test("an explicit cwd takes priority over the active session", async () => {
  const dependencies = harness();
  await openSessionSpace({
    options: { commands: ["start"], cwd: "/explicit/project" },
    ui: { router: { current: () => ({ type: "session", sessionID: "ses_active" }) } },
    client: { session: { get: () => assert.fail("The directory override must not depend on session lookup") } },
  }, dependencies);
  assert.deepEqual(dependencies.calls[0].args, ["workspace", "create", "--cwd", "/explicit/project", "--focus"]);
});

test("uses the terminal launch directory when no session is active", async () => {
  const dependencies = harness();
  await openSessionSpace({
    options: { commands: ["start"] },
    ui: { router: { current: () => ({ type: "home" }) } },
  }, dependencies);
  assert.deepEqual(dependencies.calls[0].args, ["workspace", "create", "--cwd", dependencies.cwd, "--focus"]);
});

test("does not create a space if the active session's directory cannot be read", async () => {
  for (const get of [
    async () => { throw new Error("Session unavailable"); },
    async () => ({ location: {} }),
  ]) {
    const dependencies = harness();
    await assert.rejects(openSessionSpace({
      options: { commands: ["start"] },
      ui: { router: { current: () => ({ type: "session", sessionID: "ses_active" }) } },
      client: { session: { get } },
    }, dependencies), /Session unavailable|Cannot read the active session's directory/);
    assert.equal(dependencies.calls.length, 0);
  }
});

test("rejects invalid config before creating a space", async () => {
  for (const options of [
    {}, { commands: [] }, { commands: "start" }, { commands: [" "] },
    { commands: ["start\nnext"] }, { commands: ["start\u0000"] }, { commands: [1] },
    { commands: ["start"], cwd: "relative" }, { commands: ["start"], label: "" },
  ]) {
    const dependencies = harness();
    await assert.rejects(openSpace(options, dependencies), /options\./);
    assert.equal(dependencies.calls.length, 0);
  }
});

test("does not contact Herdr from outside Herdr", async () => {
  const dependencies = harness();
  dependencies.env = {};
  await assert.rejects(openSpace({ commands: ["start"] }, dependencies), /inside Herdr/);
  assert.equal(dependencies.calls.length, 0);
});

test("does not send commands when creation returns invalid or unrelated pane data", async () => {
  for (const stdout of ["", "not JSON", "{}", JSON.stringify({ result: {} }), JSON.stringify({
    result: { ...result, root_pane: { ...result.root_pane, workspace_id: "another-space" } },
  })]) {
    const dependencies = harness([{ stdout }]);
    await assert.rejects(openSpace({ commands: ["start"] }, dependencies));
    assert.equal(dependencies.calls.length, 1);
  }
});

test("reports CLI and API failures without retrying workspace creation", async () => {
  for (const response of [
    Object.assign(new Error("missing"), { code: "ENOENT" }),
    Object.assign(new Error("server"), { stderr: JSON.stringify({ error: { message: "Server unavailable" } }) }),
    { stdout: JSON.stringify({ error: { code: "unavailable" } }) },
  ]) {
    const dependencies = harness([response]);
    await assert.rejects(openSpace({ commands: ["start"] }, dependencies), /Herdr|herdr/);
    assert.equal(dependencies.calls.length, 1);
  }
});

test("keeps a created space and identifies it after an uncertain submission failure", async () => {
  const dependencies = harness([
    { stdout: JSON.stringify({ result }) },
    Object.assign(new Error("timed out"), { killed: true }),
  ]);
  await assert.rejects(openSpace({ commands: ["start"] }, dependencies), /Space space-returned-by-herdr is open.*Check its terminal/);
  assert.equal(dependencies.calls.length, 2);
});

test("runs functions, cd, exports, quotes, and comments in the same real shell", () => {
  const command = commandChain([
    "dev() { cd \"$1\"; }",
    "dev \"$TEST_DIRECTORY\" # this comment must not consume the next entry",
    "export TEST_VALUE=\"it's ready\"",
    "printf '%s\\n%s' \"$PWD\" \"$TEST_VALUE\"",
  ]);
  const cwd = tmpdir();
  const output = execFileSync("/bin/zsh", ["-fc", command], {
    encoding: "utf8", env: { ...process.env, TEST_DIRECTORY: cwd },
  });
  assert.equal(output, `${cwd.replace(/\/$/, "")}\nit's ready`);
});

test("stops the chain when a command fails", () => {
  const command = commandChain(["false", "printf should-not-run"]);
  assert.throws(() => execFileSync("/bin/zsh", ["-fc", command], { encoding: "utf8" }), (error) => {
    assert.equal(error.status, 1);
    assert.equal(error.stdout, "");
    return true;
  });
});

test("registers inside the app provider and reports invalid config without duplicate launches", async () => {
  let layer;
  let slot;
  let mounted = false;
  const dispose = () => {};
  const notifications = [];
  const cleanup = plugin.setup({
    options: {},
    keymap: {
      layer(factory) {
        assert.ok(mounted, "Keymap.Provider is missing before the app slot mounts");
        layer = factory;
      },
    },
    ui: {
      router: { current: () => ({ type: "home" }) },
      slot(contribution) {
        slot = contribution;
        return dispose;
      },
      toast: { show: (notification) => notifications.push(notification) },
    },
  });
  assert.equal(layer, undefined);
  assert.equal(slot.append, "app");
  assert.equal(cleanup, dispose);
  mounted = true;
  assert.equal(slot.render(), null);
  const command = layer().commands[0];
  assert.equal(command.slash.name, "herdr-new-session");
  assert.equal(command.palette, true);
  const first = command.run();
  assert.equal(command.enabled(), false);
  await Promise.all([first, command.run()]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].variant, "error");
  assert.equal(command.enabled(), true);
});
