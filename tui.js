import { openSpace } from "./herdr.js";

export async function openSessionSpace(context, dependencies = {}) {
  let cwd = dependencies.cwd;
  if (context.options.cwd == null) {
    const route = context.ui.router.current();
    if (route.type === "session") {
      const session = await context.client.session.get({ sessionID: route.sessionID });
      cwd = session?.location?.directory;
      if (!cwd) throw new Error("Cannot read the active session's directory.");
    }
  }
  return openSpace(context.options, { ...dependencies, cwd });
}

export default {
  id: "opencode-v2-new-herdr-spaces",
  setup(context) {
    let opening = false;

    // Plugin setup runs before Keymap.Provider is available. The app slot
    // mounts inside that provider and owns the command layer's cleanup.
    return context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "herdr.new-session",
              title: "Open a new Herdr space",
              group: "Herdr",
              palette: true,
              slash: { name: "herdr-new-session" },
              enabled: () => !opening,
              async run() {
                if (opening) return;
                opening = true;
                try {
                  await openSessionSpace(context);
                } catch (error) {
                  context.ui.toast.show({
                    title: "New Herdr space",
                    message: error instanceof Error ? error.message : String(error),
                    variant: "error",
                    duration: 8_000,
                  });
                } finally {
                  opening = false;
                }
              },
            },
          ],
        }));
        return null;
      },
    });
  },
};
