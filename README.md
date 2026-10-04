# opencode-v2-new-herdr-spaces

Opens a Herdr space from OpenCode V2.

Clone into `~/.config/opencode/plugins/opencode-v2-new-herdr-spaces`.
Add to `~/.config/opencode/cli.json`:

```json
{
  "plugins": [{
    "package": "./plugins/opencode-v2-new-herdr-spaces",
    "options": { "commands": ["opencode2"] }
  }]
}
```

Run `/herdr-new-session` inside Herdr. The new space uses the current session's
directory and runs your configured commands.

Tests: `npm test`.
