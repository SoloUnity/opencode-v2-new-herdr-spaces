import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const controlCharacters = /[\u0000-\u001f\u007f]/;

function text(value) {
  return typeof value === "string" && value.trim() !== "" && !controlCharacters.test(value);
}

export function commandChain(commands) {
  if (!Array.isArray(commands) || commands.length === 0 || !commands.every(text)) {
    throw new Error("Set options.commands to a nonempty array of single-line shell commands in cli.json.");
  }

  // Evaluate each entry in the SAME shell. This preserves cd, functions, and
  // exports, and keeps a trailing comment from consuming the next command.
  return commands.map((command) => `eval '${command.replaceAll("'", "'\\''")}'`).join(" && ");
}

function apiError(output) {
  try {
    const error = JSON.parse(output).error;
    return error?.message || error?.code;
  } catch {
    return undefined;
  }
}

export async function openSpace(options = {}, {
  env = process.env,
  cwd = process.cwd(),
  exec = execFileAsync,
} = {}) {
  if (env.HERDR_ENV !== "1") {
    throw new Error("Run /herdr-new-session from OpenCode inside Herdr.");
  }

  const command = commandChain(options.commands);
  const directory = options.cwd ?? cwd;
  if (!text(directory) || !isAbsolute(directory)) {
    throw new Error("Set options.cwd to an absolute directory path.");
  }
  if (options.label !== undefined && !text(options.label)) {
    throw new Error("Set options.label to a nonempty, single-line space name.");
  }

  const run = async (args, requireResult = false) => {
    let stdout;
    try {
      ({ stdout } = await exec("herdr", args, {
        env,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }));
    } catch (cause) {
      const detail = apiError(cause.stderr);
      if (cause.code === "ENOENT") {
        throw new Error("Cannot find herdr. Add the Herdr executable to PATH.", { cause });
      }
      throw new Error(`Herdr ${args[0]} ${args[1]} failed${detail ? `: ${detail}` : "."}`, { cause });
    }

    // `pane run` can return no output after it submits the command.
    if (!requireResult && !stdout.trim()) return;
    let response;
    try {
      response = JSON.parse(stdout);
    } catch {
      throw new Error("Herdr returned invalid JSON.");
    }
    if (response?.error) {
      throw new Error(`Herdr: ${response.error.message || response.error.code || "request failed"}`);
    }
    if (!response?.result || typeof response.result !== "object") {
      throw new Error("Herdr returned no result.");
    }
    return response.result;
  };

  const args = ["workspace", "create", "--cwd", directory, "--focus"];
  if (options.label !== undefined) args.push("--label", options.label);
  const created = await run(args, true);
  const workspaceID = created.workspace?.workspace_id;
  const paneID = created.root_pane?.pane_id;
  if (!text(workspaceID) || !text(paneID) || created.root_pane.workspace_id !== workspaceID) {
    throw new Error("Herdr did not return the new space and its root pane. No command was sent.");
  }

  try {
    await run(["pane", "run", paneID, command]);
  } catch (cause) {
    // Keep the space available for inspection. Do not repeat terminal input:
    // a timeout does not prove that Herdr failed to submit the command.
    throw new Error(`Space ${workspaceID} is open. ${cause.message} Check its terminal before you try again.`, { cause });
  }
  return { workspaceID, paneID };
}
